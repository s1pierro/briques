import * as THREE from 'three';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';

// ─── Constantes ───────────────────────────────────────────────────────────────
const CELL   = 130;   // px — taille d'une cellule (carré)
const GAP    = 6;     // px — espacement entre cellules

// Couleurs (même thème Industrial que l'Assembler)
const C = {
  bgCell : 'rgba(30,30,30,0.82)',
  border : '#555',
  dim    : '#888',
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
    this._families  = [];   // [{ name, bricks:[{id,data}] }]
    this._famIdx    = 0;
    this._cells     = [];   // cellules actives
    this._scrollPx  = 0;
    this._el        = null;
    this._talonEl   = null;
    this._cellsEl   = null;
    this._animId    = null;
    this._onPickBrick = null;

    this._buildDOM();
    this._startLoop();
  }

  // ── API ────────────────────────────────────────────────────────────────────

  onPickBrick(fn) { this._onPickBrick = fn; }

  async load(bricksData) {
    this._buildFamilies(bricksData);
    if (this._families.length) await this._showFamily(0);
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
    ['left','right','top','bottom','transform'].forEach(p => el.style.removeProperty(p));

    switch (this._edge) {
      case 'bottom':
        el.style.bottom = '0';
        if (this._align === 'center') { el.style.left = '50%'; el.style.transform = 'translateX(-50%)'; }
        else if (this._align === 'start') el.style.left = '0';
        else el.style.right = '0';
        break;
      case 'top':
        el.style.top = '0';
        if (this._align === 'center') { el.style.left = '50%'; el.style.transform = 'translateX(-50%)'; }
        else if (this._align === 'start') el.style.left = '0';
        else el.style.right = '0';
        break;
      case 'left':
        el.style.left = '0';
        if (this._align === 'center') { el.style.top = '50%'; el.style.transform = 'translateY(-50%)'; }
        else if (this._align === 'start') el.style.top = '0';
        else el.style.bottom = '0';
        break;
      case 'right':
        el.style.right = '0';
        if (this._align === 'center') { el.style.top = '50%'; el.style.transform = 'translateY(-50%)'; }
        else if (this._align === 'start') el.style.top = '0';
        else el.style.bottom = '0';
        break;
    }
  }

  _applyFlexDirections() {
    const isVert = this._edge === 'left' || this._edge === 'right';

    // Conteneur principal : column pour top/bottom, row pour left/right
    this._el.style.flexDirection = isVert ? 'row' : 'column';

    // Cellules : row ou column selon l'orientation du dock
    this._cellsEl.style.flexDirection = isVert ? 'column' : 'row';

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
  }

  async _showFamily(idx) {
    if (!this._families.length) return;
    this._famIdx = ((idx % this._families.length) + this._families.length) % this._families.length;
    const fam = this._families[this._famIdx];

    this._talonEl.textContent = fam.name;
    this._disposeCells();
    this._scrollPx = 0;
    this._cellsEl.style.transform = '';

    for (const { id, data } of fam.bricks) {
      const cell = await this._createCell(id, data);
      this._cells.push(cell);
      this._cellsEl.appendChild(cell.el);
    }
  }

  // ── Cellule ────────────────────────────────────────────────────────────────

  async _createCell(brickId, brickData) {
    const el = document.createElement('div');
    el.style.cssText = [
      `width:${CELL}px`, `height:${CELL}px`, 'flex-shrink:0',
      `background:${C.bgCell}`, `border:1px solid ${C.border}`,
      'border-radius:4px', 'overflow:hidden', 'position:relative',
      'pointer-events:auto', 'touch-action:none',
    ].join(';');

    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(CELL * devicePixelRatio);
    canvas.height = Math.round(CELL * devicePixelRatio);
    canvas.style.cssText = `width:${CELL}px;height:${CELL}px;display:block;`;
    el.appendChild(canvas);

    // Nom de la brique
    const label = document.createElement('div');
    label.textContent = brickData.name || brickId;
    label.style.cssText = [
      'position:absolute', 'bottom:0', 'left:0', 'right:0',
      'padding:2px 5px', 'background:rgba(10,10,15,0.75)',
      `color:${C.dim}`, 'font:8px sans-serif',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      'pointer-events:none',
    ].join(';');
    el.appendChild(label);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(CELL, CELL);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    camera.position.set(0, 0, 3);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(2, 4, 3);
    scene.add(sun);

    const cell = { el, canvas, renderer, scene, camera, brickId, brickData, mesh: null };
    await this._loadCellGeometry(cell);
    this._bindCellGestures(cell);
    return cell;
  }

  async _loadCellGeometry(cell) {
    try {
      const shapes = this._loadStore('rbang_shapes');
      const bricks = this._loadStore('rbang_bricks');
      const brick  = bricks[cell.brickId] || cell.brickData;
      const data   = shapes[brick.shapeRef];
      if (!data?.steps || !data.rootId) return;
      const M    = await getManifold();
      const mf   = buildCache(data.steps, M).get(data.rootId);
      if (!mf) return;
      const { geo } = manifoldToGeometry(mf);
      const color    = parseInt((brick.color || '#888888').replace('#', ''), 16);
      const mesh     = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
      const box      = new THREE.Box3().setFromObject(mesh);
      mesh.position.sub(box.getCenter(new THREE.Vector3()));
      const size = box.getSize(new THREE.Vector3()).length();
      cell.camera.position.set(0, 0, size * 1.5);
      cell.scene.add(mesh);
      cell.mesh = mesh;
    } catch (e) { console.warn('[BrickDock] geometry', e); }
  }

  // ── Gestes sur cellule ─────────────────────────────────────────────────────

  _bindCellGestures(cell) {
    const el = cell.canvas;
    let startX = 0, startY = 0, resolved = false, intent = null;

    // Détermine si le delta pointe vers le bord d'écran du dock
    const isTowardEdge = (dx, dy) => {
      switch (this._edge) {
        case 'bottom': return dy > 0;
        case 'top':    return dy < 0;
        case 'left':   return dx < 0;
        case 'right':  return dx > 0;
      }
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      resolved = false; intent = null;

      if (!cell.mesh || !this._hitsBrick(cell, e.clientX, e.clientY)) {
        // Hors brique → transmettre à la caméra
        this._forwardToEngine(e);
        return;
      }
      el.setPointerCapture(e.pointerId);
    }, { passive: false });

    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      if (resolved) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) < 15) return;
      resolved = true;

      if (isTowardEdge(dx, dy)) {
        // Swipe vers le bord → famille suivante (cyclique), libérer
        el.releasePointerCapture(e.pointerId);
        this._showFamily(this._famIdx + 1);
      } else {
        // Swipe vers la scène → intention d'assemblage (résolu au pointerup)
        intent = 'assemble';
      }
    }, { passive: false });

    el.addEventListener('pointerup', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);

      if ((intent === 'assemble' || !resolved) && this._onPickBrick) {
        const nearSlots = this._nearSlotsForBrick(cell, startX, startY);
        this._onPickBrick(cell.brickId, {
          brickId : cell.brickId,
          nearSlots,
          startX, startY,
          endX    : e.clientX,
          endY    : e.clientY,
          moved   : resolved,
        });
      }
    });

    el.addEventListener('pointercancel', (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
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
    return brick.slots
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

  // ── Boucle de rendu — rotation auto lente ──────────────────────────────────

  _startLoop() {
    const step = () => {
      this._animId = requestAnimationFrame(step);
      for (const cell of this._cells) {
        if (!cell.mesh) continue;
        cell.mesh.rotation.y += 0.007;
        cell.renderer.render(cell.scene, cell.camera);
      }
    };
    step();
  }

  // ── Nettoyage ──────────────────────────────────────────────────────────────

  _disposeCells() {
    for (const cell of this._cells) {
      cell.renderer.dispose();
      if (cell.mesh) { cell.mesh.geometry.dispose(); cell.mesh.material.dispose(); }
      cell.el.remove();
    }
    this._cells = [];
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
}
