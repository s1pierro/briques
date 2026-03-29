import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';
import { expandSlots } from '../slot-utils.js';

// ─── Constantes ───────────────────────────────────────────────────────────────
const CELL        = 110;  // px — cellule inactive
const CELL_ACTIVE = 190;  // px — cellule active
const GAP         = 6;    // px — espacement entre cellules
const STACK_KEY   = 'rbang_dock_stack';

// Couleurs (même thème Industrial que l'Assembler)
const C = {
  bgCell : 'rgba(30,30,30,0.82)',
  border : '#555',
  dim    : '#888',
};

function _hexRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const CELL_STYLES_DEFAULTS = {
  bg                  : C.bgCell,
  borderWidth         : 1,
  borderColor         : C.border,
  activeBg            : C.bgCell,
  activeBorderWidth   : 1,
  activeBorderColor   : '#7aafc8',
  borderRadius        : 4,
  labelBg             : 'rgba(10,10,15,0.75)',
  labelColor          : C.dim,
  labelFontSize       : 8,
  labelVisible        : true,
};

// ─────────────────────────────────────────────────────────────────────────────
// BrickDock
// Palette de briques ancrée sur un bord d'écran, groupée par famille.
//
//  edge  : 'bottom'|'top'|'left'|'right'
//  align : 'start'|'center'|'end'
//
// Structure DOM (exemple edge=bottom) :
//   [cellsEl (flex-row)]  ← briques
//   [talonEl (1.75em)]    ← bande entre cellules et bord écran
// ─────────────────────────────────────────────────────────────────────────────
export class BrickDock {

  constructor(engine, { edge = 'bottom', align = 'center' } = {}) {
    this._engine    = engine;
    this._edge      = edge;
    this._align     = align;
    this._insets    = { top: 0, bottom: 0, left: 0, right: 0 };
    this._families  = [];   // [{ name, bricks:[{id,data}] }]
    this._famIdx    = 0;
    this._cells     = [];   // cellules actives
    this._scrollPx  = 0;
    this._el        = null;
    this._talonEl   = null;
    this._cellsEl   = null;
    this._animId    = null;
    this._onPickBrick    = null;
    this._onDragBrick    = null;
    this._onCancelDrag   = null;
    this._activeCell     = null;
    this._activateOnOutsideTap = true;
    this._stackPersist = false;
    this._stackFamily = { name: '(tmp)Stack', bricks: [] };
    this._cellStyles = { ...CELL_STYLES_DEFAULTS };

    // Renderer WebGL UNIQUE partagé par toutes les cellules
    // → évite d'épuiser la limite de contextes WebGL du navigateur (~8-16 sur mobile)
    this._sharedCanvas   = document.createElement('canvas');
    this._sharedRenderer = new THREE.WebGLRenderer({
      canvas: this._sharedCanvas, antialias: true, alpha: true,
      // preserveDrawingBuffer non nécessaire : render + drawImage sont synchrones dans le même rAF
    });
    this._sharedRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this._sharedRenderer.setSize(CELL_ACTIVE, CELL_ACTIVE);

    this._buildDOM();
    this._startLoop();
  }

  // ── API ────────────────────────────────────────────────────────────────────

  onPickBrick(fn)   { this._onPickBrick  = fn; }
  onDragBrick(fn)   { this._onDragBrick  = fn; }
  onCancelDrag(fn)  { this._onCancelDrag = fn; }

  async load(bricksData) {
    this._buildFamilies(bricksData);
    if (this._families.length) await this._showFamily(0);
  }

  setInsets(insets) {
    Object.assign(this._insets, insets);
    this._applyContainerPosition();
  }

  setActivateOnOutsideTap(val) { this._activateOnOutsideTap = val; }

  setCellStyles(cfg) {
    const {
      cellBgColor = '#1e1e1e', cellBgOpacity = 0.82,
      cellBorderVisible = true, cellBorderColor = '#555555', cellBorderWidth = 1,
      cellActiveBgColor = '#1e1e1e', cellActiveBgOpacity = 0.82,
      cellActiveBorderVisible = true, cellActiveBorderColor = '#7aafc8', cellActiveBorderWidth = 1,
      cellLabelBgColor = '#0a0a0f', cellLabelBgOpacity = 0.75,
      cellLabelColor = '#888888', cellLabelFontSize = 8, cellLabelVisible = true,
      cellBorderRadius = 4,
      cellRotateSpeed = 1.5,
    } = cfg;
    this._cellStyles = {
      bg                : _hexRgba(cellBgColor, cellBgOpacity),
      borderWidth       : cellBorderVisible ? cellBorderWidth : 0,
      borderColor       : cellBorderColor,
      activeBg          : _hexRgba(cellActiveBgColor, cellActiveBgOpacity),
      activeBorderWidth : cellActiveBorderVisible ? cellActiveBorderWidth : 0,
      activeBorderColor : cellActiveBorderColor,
      borderRadius      : cellBorderRadius,
      labelBg           : _hexRgba(cellLabelBgColor, cellLabelBgOpacity),
      labelColor        : cellLabelColor,
      labelFontSize     : cellLabelFontSize,
      labelVisible      : cellLabelVisible,
      rotateSpeed       : cellRotateSpeed,
    };
    this._cells.forEach(cell => {
      this._applyCellStyle(cell, cell === this._activeCell);
      if (cell.tb) cell.tb.rotateSpeed = cellRotateSpeed;
    });
  }

  _applyCellStyle(cell, active) {
    const s = this._cellStyles;
    cell.el.style.background        = active ? s.activeBg          : s.bg;
    cell.el.style.borderWidth       = (active ? s.activeBorderWidth : s.borderWidth) + 'px';
    cell.el.style.borderColor       = active ? s.activeBorderColor  : s.borderColor;
    cell.el.style.borderRadius      = s.borderRadius + 'px';
    if (cell.label) {
      cell.label.style.display    = s.labelVisible ? '' : 'none';
      cell.label.style.background = s.labelBg;
      cell.label.style.color      = s.labelColor;
      cell.label.style.fontSize   = s.labelFontSize + 'px';
    }
  }

  showStack() {
    const idx = this._families.indexOf(this._stackFamily);
    if (idx >= 0) this._showFamily(idx);
  }

  pushToStack(brickId, brickData) {
    const alreadyIn = this._stackFamily.bricks.some(b => b.id === brickId);
    if (alreadyIn) { this.showStack(); return; }
    this._stackFamily.bricks.unshift({ id: brickId, data: brickData });
    if (this._stackPersist) this._saveStack();
    this.showStack();
  }

  setStackPersist(enabled) {
    this._stackPersist = enabled;
    if (enabled) {
      try {
        const saved = JSON.parse(localStorage.getItem(STACK_KEY) || '[]');
        if (Array.isArray(saved)) this._stackFamily.bricks = saved;
      } catch { /* ignore */ }
    }
  }

  clearStack() {
    this._stackFamily.bricks = [];
    if (this._stackPersist) localStorage.removeItem(STACK_KEY);
    // Si on affiche actuellement la stack, revenir à la première famille
    if (this._families[this._famIdx] === this._stackFamily) {
      this._showFamily(0);
    }
  }

  _saveStack() {
    localStorage.setItem(STACK_KEY, JSON.stringify(this._stackFamily.bricks));
  }

  setPosition(edge, align = 'center') {
    this._edge  = edge;
    this._align = align;
    this._applyContainerPosition();
    this._applyFlexDirections();
  }

  destroy() {
    cancelAnimationFrame(this._animId);
    this._disposeCells();
    this._sharedRenderer.dispose();
    this._el?.remove();
  }

  get el() { return this._el; }

  // ── Construction DOM ───────────────────────────────────────────────────────

  _buildDOM() {
    this._el = document.createElement('div');
    this._el.className = 'brick-dock';

    this._cellsEl = document.createElement('div');
    this._cellsEl.className = 'brick-dock__cells';

    this._talonEl = document.createElement('div');
    this._talonEl.className = 'brick-dock__talon';

    // Le talon est toujours côté bord d'écran
    // bottom/right : cells → talon (talon en bas/droite)
    // top/left     : talon → cells (talon en haut/gauche)
    if (this._edge === 'bottom' || this._edge === 'right') {
      this._el.append(this._cellsEl, this._talonEl);
    } else {
      this._el.append(this._talonEl, this._cellsEl);
    }

    this._el.style.cssText = [
      'position:fixed', 'display:flex', 'z-index:55', 'pointer-events:none',
    ].join(';');

    this._cellsEl.style.cssText = [
      'display:flex', `gap:${GAP}px`, `padding:${GAP}px`,
      'overflow:hidden', 'pointer-events:none',
    ].join(';');

    this._talonEl.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(20,20,20,0.88)',
      `border:1px solid ${C.border}`,
      `color:${C.dim}`, 'font:11px sans-serif',
      'letter-spacing:.08em', 'text-transform:uppercase',
      'pointer-events:auto', 'touch-action:none', 'cursor:grab',
      'user-select:none',
    ].join(';');

    this._applyContainerPosition();
    this._applyFlexDirections();
    this._bindTalonGesture();

    document.body.appendChild(this._el);
  }

  _applyContainerPosition() {
    const el = this._el;
    const { top: it = 0, bottom: ib = 0, left: il = 0, right: ir = 0 } = this._insets;
    ['left','right','top','bottom','transform'].forEach(p => el.style.removeProperty(p));

    switch (this._edge) {
      case 'bottom':
        el.style.bottom = ib + 'px';
        if (this._align === 'center') { el.style.left = '50%'; el.style.transform = 'translateX(-50%)'; }
        else if (this._align === 'start') el.style.left = il + 'px';
        else el.style.right = ir + 'px';
        break;
      case 'top':
        el.style.top = it + 'px';
        if (this._align === 'center') { el.style.left = '50%'; el.style.transform = 'translateX(-50%)'; }
        else if (this._align === 'start') el.style.left = il + 'px';
        else el.style.right = ir + 'px';
        break;
      case 'left':
        el.style.left = il + 'px';
        if (this._align === 'center') {
          el.style.top = `calc(50% + ${(it - ib) / 2}px)`;
          el.style.transform = 'translateY(-50%)';
        }
        else if (this._align === 'start') el.style.top = it + 'px';
        else el.style.bottom = ib + 'px';
        break;
      case 'right':
        el.style.right = ir + 'px';
        if (this._align === 'center') {
          el.style.top = `calc(50% + ${(it - ib) / 2}px)`;
          el.style.transform = 'translateY(-50%)';
        }
        else if (this._align === 'start') el.style.top = it + 'px';
        else el.style.bottom = ib + 'px';
        break;
    }
  }

  _applyFlexDirections() {
    const isVert = this._edge === 'left' || this._edge === 'right';

    // Ordre DOM : talon côté bord d'écran
    // bottom/right → cells avant talon ; top/left → talon avant cells
    if (this._edge === 'bottom' || this._edge === 'right') {
      this._el.append(this._cellsEl, this._talonEl);
    } else {
      this._el.append(this._talonEl, this._cellsEl);
    }

    // Conteneur principal : column pour top/bottom, row pour left/right
    this._el.style.flexDirection = isVert ? 'row' : 'column';

    // Cellules : row ou column selon l'orientation du dock
    this._cellsEl.style.flexDirection = isVert ? 'column' : 'row';

    // Alignement : cellules inactives toujours flush côté talon
    // bottom/right → talon en bas/droite → flex-end
    // top/left     → talon en haut/gauche → flex-start
    this._cellsEl.style.alignItems =
      (this._edge === 'bottom' || this._edge === 'right') ? 'flex-end' : 'flex-start';

    // Talon : dimensions + texte vertical si gauche/droite
    if (isVert) {
      this._talonEl.style.width  = '1.75em';
      this._talonEl.style.height = '';
      this._talonEl.style.writingMode = 'vertical-rl';
      this._talonEl.style.transform   = this._edge === 'left' ? 'rotate(180deg)' : 'none';
    } else {
      this._talonEl.style.height = '1.75em';
      this._talonEl.style.width  = '';
      this._talonEl.style.writingMode = 'horizontal-tb';
      this._talonEl.style.transform   = 'none';
    }
  }

  // ── Familles ───────────────────────────────────────────────────────────────

  _buildFamilies(bricksData) {
    const map = new Map();
    for (const [id, data] of Object.entries(bricksData)) {
      // Utilise brick.family si défini, sinon premier mot du nom
      const raw = (data.family || '').trim() ||
                  (data.name || '').split(/\s+/)[0]?.toLowerCase() ||
                  'général';
      const fam = raw.toLowerCase();
      if (!map.has(fam)) map.set(fam, []);
      map.get(fam).push({ id, data });
    }
    this._families = [...map.entries()].map(([name, bricks]) => ({ name, bricks }));
    if (!this._families.includes(this._stackFamily))
      this._families.push(this._stackFamily); // famille virtuelle toujours en dernier
  }

  async _showFamily(idx) {
    if (!this._families.length) return;
    // Familles visibles : exclut la stack si elle est vide
    const visible = this._families.filter(f => f !== this._stackFamily || f.bricks.length > 0);
    if (!visible.length) return;
    const normIdx = ((idx % visible.length) + visible.length) % visible.length;
    this._famIdx  = this._families.indexOf(visible[normIdx]);
    const fam = this._families[this._famIdx];

    this._talonEl.textContent = fam.name;
    this._disposeCells();
    this._scrollPx = 0;
    this._cellsEl.style.transform = '';

    for (const { id, data } of fam.bricks) {
      const cell = await this._createCell(id, data);
      this._cells.push(cell);
      this._cellsEl.appendChild(cell.el);
      // handleResize() doit être appelé après insertion dans le DOM
      // → getBoundingClientRect() retourne des valeurs valides (screen.width ≠ 0)
      cell.tb.handleResize();
    }
  }

  // ── Cellule ────────────────────────────────────────────────────────────────

  async _createCell(brickId, brickData) {
    const el = document.createElement('div');
    const s = this._cellStyles;
    el.style.cssText = [
      `width:${CELL}px`, `height:${CELL}px`, 'flex-shrink:0',
      `background:${s.bg}`,
      `border-style:solid`, `border-width:${s.borderWidth}px`, `border-color:${s.borderColor}`,
      `border-radius:${s.borderRadius}px`, 'overflow:hidden', 'position:relative',
      'pointer-events:auto', 'touch-action:none',
      'transition:width 0.18s ease, height 0.18s ease, border-color 0.18s ease',
    ].join(';');

    // Canvas 2D — réceptacle de l'image rendue par le renderer partagé
    const pxSize = Math.round(CELL_ACTIVE * Math.min(devicePixelRatio, 2));
    const canvas = document.createElement('canvas');
    canvas.width  = pxSize;
    canvas.height = pxSize;
    canvas.style.cssText = `width:${CELL}px;height:${CELL}px;display:block;touch-action:none;transition:width 0.18s ease, height 0.18s ease;`;
    el.appendChild(canvas);
    const ctx2d = canvas.getContext('2d');

    // Nom de la brique
    const label = document.createElement('div');
    label.textContent = brickData.name || brickId;
    const ls = this._cellStyles;
    label.style.cssText = [
      'position:absolute', 'bottom:0', 'left:0', 'right:0',
      'padding:2px 5px', `background:${ls.labelBg}`,
      `color:${ls.labelColor}`, `font:${ls.labelFontSize}px sans-serif`,
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      'text-align:center', 'pointer-events:none',
    ].join(';');
    if (!ls.labelVisible) label.style.display = 'none';
    el.appendChild(label);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(2, 4, 3);
    scene.add(sun);

    // État sphérique de la caméra — orbite autour du centre de la brique
    // Position initiale (vue 3/4 identique à l'ancienne theta=0.4, phi=1.1)
    camera.position.set(
      3 * Math.sin(1.1) * Math.sin(0.4),
      3 * Math.cos(1.1),
      3 * Math.sin(1.1) * Math.cos(0.4),
    );
    camera.lookAt(0, 0, 0);

    // Bouton de rotation caméra — affiché uniquement sur la cellule active
    const camHandle = document.createElement('div');
    camHandle.textContent = '↻';
    camHandle.style.cssText = [
      'position:absolute', 'top:4px', 'right:4px',
      'width:32px', 'height:32px',
      'display:none',
      'pointer-events:auto', 'touch-action:none', 'cursor:grab',
      'color:#7aafc8', 'font-size:20px', 'line-height:32px', 'text-align:center',
      'background:rgba(20,20,20,0.65)', 'border-radius:6px',
      'border:1px solid rgba(120,160,200,0.4)',
      'user-select:none',
    ].join(';');
    el.appendChild(camHandle);

    // TrackballControls attaché au handle ↻ uniquement
    const tb = new TrackballControls(camera, camHandle);
    tb.rotateSpeed          = this._cellStyles.rotateSpeed ?? 1.5;
    tb.noZoom               = true;
    tb.noPan                = true;
    tb.dynamicDampingFactor = 0.18;
    tb.target.set(0, 0, 0);
    tb.update();

    const cell = {
      el, canvas, ctx2d, label, camHandle, scene, camera, tb,
      brickId, brickData, mesh: null,
      _camRadius : 3,    // ajusté après chargement géométrie
      _dirty     : true, // déclenche un re-render au prochain frame
    };

    tb.addEventListener('change', () => { cell._dirty = true; });

    await this._loadCellGeometry(cell);
    this._bindCellGestures(cell);
    return cell;
  }

  async _loadCellGeometry(cell) {
    try {
      const shapes = this._loadStore('rbang_shapes');
      const bricks = this._loadStore('rbang_bricks');
      const brick  = bricks[cell.brickId] || cell.brickData;
      console.log('[BrickDock] cell', cell.brickId, 'brick=', brick,
        'hasCsgTree=', !!(brick?.csgTree?.steps), 'shapeRef=', brick?.shapeRef);

      // Résolution de la géométrie : csgTree embarqué > shapeRef
      let geo;
      if (brick.csgTree?.steps && brick.csgTree?.rootId) {
        console.log('[BrickDock] using csgTree, steps=', brick.csgTree.steps.length);
        const M  = await getManifold();
        const mf = buildCache(brick.csgTree.steps, M).get(brick.csgTree.rootId);
        console.log('[BrickDock] mf=', mf);
        if (!mf) return;
        ({ geo } = manifoldToGeometry(mf));
      } else {
        const data = shapes[brick.shapeRef];
        console.log('[BrickDock] using shapeRef', brick.shapeRef, 'data=', data);
        if (!data?.steps || !data.rootId) return;
        const M  = await getManifold();
        const mf = buildCache(data.steps, M).get(data.rootId);
        if (!mf) return;
        ({ geo } = manifoldToGeometry(mf));
      }
      console.log('[BrickDock] geo ok', geo);
      const color    = parseInt((brick.color || '#888888').replace('#', ''), 16);
      const mesh     = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
      const box    = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      mesh.position.sub(center);         // brique centrée à l'origine = pivot d'orbite
      const size = box.getSize(new THREE.Vector3()).length();
      const dist = size * 1.5;
      cell._camRadius = dist;
      // Repositionner la caméra à la bonne distance, TrackballControls prend le relais
      const dir = cell.camera.position.clone().normalize();
      cell.camera.position.copy(dir.multiplyScalar(dist));
      cell.tb.update();
      cell.scene.add(mesh);
      cell.mesh = mesh;
      cell._dirty = true;
    } catch (e) { console.warn('[BrickDock] geometry ERROR', e); }
  }

  // ── Activation de cellule ──────────────────────────────────────────────────

  _activateCell(cell) {
    if (this._activeCell === cell) return;
    this._deactivateCell();
    this._activeCell = cell;
    cell.canvas.style.width  = CELL_ACTIVE + 'px';
    cell.canvas.style.height = CELL_ACTIVE + 'px';
    cell.el.style.width      = CELL_ACTIVE + 'px';
    cell.el.style.height     = CELL_ACTIVE + 'px';
    cell.camHandle.style.display = '';
    this._applyCellStyle(cell, true);
    cell.tb.handleResize();
    cell._dirty = true;
  }

  _deactivateCell() {
    if (!this._activeCell) return;
    const cell = this._activeCell;
    this._activeCell = null;
    cell.tb.enabled = false;
    cell.camHandle.style.display = 'none';
    cell.canvas.style.width  = CELL + 'px';
    cell.canvas.style.height = CELL + 'px';
    cell.el.style.width      = CELL + 'px';
    cell.el.style.height     = CELL + 'px';
    this._applyCellStyle(cell, false);
    cell.tb.handleResize();
    cell._dirty = true;
  }

  // ── Gestes sur cellule ─────────────────────────────────────────────────────

  _bindCellGestures(cell) {
    // TB est sur cell.canvas — nos listeners aussi pour recevoir les events à la source
    const cv = cell.canvas;
    let startX = 0, startY = 0;
    let mode = null; // 'assemble' | 'trackball' | null

    const isTowardEdge = (dx, dy) => {
      switch (this._edge) {
        case 'bottom': return dy > 0;
        case 'top':    return dy < 0;
        case 'left':   return dx < 0;
        case 'right':  return dx > 0;
      }
    };

    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      mode = null;

      const onBrick  = cell.mesh && this._hitsBrick(cell, e.clientX, e.clientY);
      const isActive = this._activeCell === cell;

      if (!isActive) {
        if (onBrick || this._activateOnOutsideTap) {
          this._activateCell(cell);
        } else {
          this._forwardToEngine(e);
          return;
        }
      }

      if (onBrick) {
        mode = 'assemble';
        cv.setPointerCapture(e.pointerId);
      }
    }, { passive: false });

    cv.addEventListener('pointermove', (e) => {
      if (mode !== 'assemble') return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 15 && isTowardEdge(dx, dy)) {
        cv.releasePointerCapture(e.pointerId);
        mode = null;
        this._showFamily(this._famIdx + 1);
      } else if (dist >= 8 && this._onDragBrick) {
        const nearSlots = this._nearSlotsForBrick(cell, startX, startY);
        this._onDragBrick(cell.brickId, { x: e.clientX, y: e.clientY, nearSlots });
      }
    }, { passive: false });

    cv.addEventListener('pointerup', (e) => {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const moved = Math.sqrt(dx * dx + dy * dy) >= 15;

      if (mode === 'assemble') {
        if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
        if (this._onPickBrick) {
          const nearSlots = this._nearSlotsForBrick(cell, startX, startY);
          this._onPickBrick(cell.brickId, {
            brickId: cell.brickId, nearSlots,
            startX, startY,
            endX: e.clientX, endY: e.clientY,
            moved,
          });
        }
      }
      mode = null;
    });

    cv.addEventListener('pointercancel', (e) => {
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      if (mode === 'assemble') this._onCancelDrag?.();
      mode = null;
    });
  }

  // Renvoie l'événement au canvas du moteur (pour que OrbitControls le traite)
  _forwardToEngine(e) {
    const target = this._engine.renderer.domElement;
    target.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: false, cancelable: true,
      clientX: e.clientX, clientY: e.clientY,
      pointerId: e.pointerId, pointerType: e.pointerType,
      pressure: e.pressure, isPrimary: e.isPrimary,
      button: e.button, buttons: e.buttons,
    }));
  }

  // Heuristique : le touch est-il sur la brique (cercle central du canvas) ?
  _hitsBrick(cell, cx, cy) {
    const rect = cell.canvas.getBoundingClientRect();
    const lx = cx - rect.left, ly = cy - rect.top;
    const mx = rect.width / 2, my = rect.height / 2;
    const r  = Math.min(rect.width, rect.height) * 0.42;
    return Math.sqrt((lx - mx) ** 2 + (ly - my) ** 2) < r;
  }

  // Slots triés par proximité au point de contact
  _nearSlotsForBrick(cell, cx, cy) {
    const bricks = this._loadStore('rbang_bricks');
    const brick  = bricks[cell.brickId] || cell.brickData;
    if (!brick?.slots?.length) return [];
    const rect   = cell.canvas.getBoundingClientRect();
    const ndcX   =  ((cx - rect.left) / rect.width)  * 2 - 1;
    const ndcY   = -((cy - rect.top)  / rect.height) * 2 + 1;
    const touch  = new THREE.Vector2(ndcX, ndcY);
    const offset = cell.mesh ? cell.mesh.position : new THREE.Vector3();
    return expandSlots(brick.slots)
      .map(s => {
        const p = new THREE.Vector3(...s.position).add(offset);
        p.project(cell.camera);
        const corrected = {
          ...s,
          position: [s.position[0] + offset.x, s.position[1] + offset.y, s.position[2] + offset.z],
        };
        return { slot: corrected, dist: touch.distanceTo(new THREE.Vector2(p.x, p.y)) };
      })
      .sort((a, b) => a.dist - b.dist)
      .map(x => x.slot);
  }

  // ── Talon — scroll de l'overflow ───────────────────────────────────────────

  _bindTalonGesture() {
    const isVert = () => this._edge === 'left' || this._edge === 'right';
    let startVal = 0, startCoord = 0;

    this._talonEl.addEventListener('pointerdown', (e) => {
      this._talonEl.setPointerCapture(e.pointerId);
      startVal   = this._scrollPx;
      startCoord = isVert() ? e.clientY : e.clientX;
    });

    this._talonEl.addEventListener('pointermove', (e) => {
      if (!this._talonEl.hasPointerCapture(e.pointerId)) return;
      const delta = (isVert() ? e.clientY : e.clientX) - startCoord;
      this._setScroll(startVal - delta);
    });

    this._talonEl.addEventListener('pointerup', () => {});
    this._talonEl.addEventListener('pointercancel', () => {});
  }

  _setScroll(px) {
    const isVert   = this._edge === 'left' || this._edge === 'right';
    const n        = this._cells.length;
    const total    = n * (CELL + GAP) + GAP;
    const viewport = isVert ? innerHeight : innerWidth;
    const max      = Math.max(0, total - viewport + CELL); // laisser au moins une cellule visible
    this._scrollPx = Math.max(0, Math.min(px, max));
    const axis     = isVert ? 'translateY' : 'translateX';
    this._cellsEl.style.transform = `${axis}(-${this._scrollPx}px)`;
  }

  // ── Boucle de rendu ────────────────────────────────────────────────────────

  _startLoop() {
    let _rendererSize = CELL_ACTIVE; // taille CSS courante du renderer partagé
    const step = () => {
      this._animId = requestAnimationFrame(step);
      const r = this._sharedRenderer;
      for (const cell of this._cells) {
        cell.tb.update(); // nécessaire pour l'amortissement dynamique
        if (!cell._dirty) continue;
        cell._dirty = false;
        const size = cell === this._activeCell ? CELL_ACTIVE : CELL;
        if (_rendererSize !== size) { r.setSize(size, size); _rendererSize = size; }
        r.render(cell.scene, cell.camera);
        cell.ctx2d.clearRect(0, 0, cell.canvas.width, cell.canvas.height);
        cell.ctx2d.drawImage(this._sharedCanvas, 0, 0, cell.canvas.width, cell.canvas.height);
      }
    };
    step();
  }

  // ── Nettoyage ──────────────────────────────────────────────────────────────

  _disposeCells() {
    this._activeCell = null;
    for (const cell of this._cells) {
      cell.tb.dispose();
      if (cell.mesh) { cell.mesh.geometry.dispose(); cell.mesh.material.dispose(); }
      cell.el.remove();
    }
    this._cells = [];
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
}
