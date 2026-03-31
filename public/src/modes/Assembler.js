import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { BrickDock } from './BrickDock.js';
import { AsmHandlers } from './AsmDofHandler.js';
import { AsmVerse } from './AsmVerse.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { idb } from '../idb-store.js';

// ─── Couleurs thème Industrial ────────────────────────────────────────────────
const C = {
  bg:        '#2e2e2e',
  bgDark:    '#1e1e1e',
  border:    '#555',
  fg:        '#d0d0d0',
  dim:       '#888',
  accent:    '#7aafc8',
  worldSlot:    0x7aafc8,
  snapRing:     0x00ff88,
  jointExplicit: 0x00ccff,
  liaisonPicker: 0xffcc44,   // sphères de sélection de liaison (état intermédiaire)
};

// Hauteur de la barre de titre — rogne le viewport rendu et le dock
const BAR_H       = 32;
const BAR_ARTIC_H = 28;   // hauteur de la barre secondaire (mode articuler)

// Persistance de la configuration de l'Assembler
const CFG_KEY      = 'rbang_asm_cfg';
const SCENE_KEY    = 'rbang_asm_scene';
const CATALOGUE_KEY = 'rbang_asm_catalogue'; // { [id]: { id, name, createdAt, data } }

function _catalogueLoad() {
  try { return JSON.parse(localStorage.getItem(CATALOGUE_KEY) || '{}'); } catch { return {}; }
}
function _catalogueSave(store) {
  localStorage.setItem(CATALOGUE_KEY, JSON.stringify(store));
}
function _uid() { return 'sc-' + Math.random().toString(36).slice(2, 9); }
const CFG_DEFAULTS = {
  dockEdge             : 'bottom',
  dockAlign            : 'center',
  activateOnOutsideTap : true,
  planY                : 0.25,
  snapR                : 1.2,
  planVisible          : true,
  accent               : '#7aafc8',
  stackPersist         : false,
  asmHelperStepsRot    : 16,   // nombre de divisions sur 360°
  asmHelperStepsTrans  : 20,   // nombre de divisions sur la plage
  involvedBricksSolver : 'physics', // 'physics' | 'asm'
  connectionTolerance  : 0.12,      // distance max coïncidence slots (unités scène)
  // ── Apparence des cellules dock ───────────────────────────────────────────
  cellBgColor            : '#1e1e1e',
  cellBgOpacity          : 0.82,
  cellBorderVisible      : true,
  cellBorderColor        : '#555555',
  cellBorderWidth        : 1,
  cellActiveBgColor      : '#1e1e1e',
  cellActiveBgOpacity    : 0.82,
  cellActiveBorderVisible: true,
  cellActiveBorderColor  : '#7aafc8',
  cellActiveBorderWidth  : 1,
  cellBorderRadius       : 4,
  // ── Label des cellules ────────────────────────────────────────────────────
  cellLabelBgColor       : '#0a0a0f',
  cellLabelBgOpacity     : 0.75,
  cellLabelColor         : '#888888',
  cellLabelFontSize      : 8,
  cellLabelVisible       : true,
  floorVisible           : true,
  // ── Piqueurs de liaison ───────────────────────────────────────────────────
  pickerDiam             : 0.32,      // diamètre brique/composant (0.1 – 1)
  articulatePickerDiam   : 0.6,       // diamètre articuler (0.5 – 2)
  // ── Bandeau DOF (strips) ──────────────────────────────────────────────────
  stripBgColor           : '#121218',
  stripBgOpacity         : 0.6,
  stripFontColor         : '#cccccc',
  // ── Trackball cellule dock ────────────────────────────────────────────────
  cellRotateSpeed        : 1.5,
  // ── LOD (Level of Detail) ─────────────────────────────────────────────────
  lodDistLow             : 12,    // au-delà → low poly
  lodDistHigh            : 3,     // en-deçà → high poly
};

// ═══════════════════════════════════════════════════════════════════════════════
// Assembler
// ─── Utilitaire picker ────────────────────────────────────────────────────────

/** Retourne la position monde du picker pour une connexion.
 *  Si la connexion est synthétique (_sourceConns), calcule le centroïde
 *  des positions slotA de toutes les connexions sources. */
function _pickerWorldPos(conn) {
  const srcs = conn._sourceConns;
  if (srcs?.length > 1) {
    const sum = new THREE.Vector3();
    for (const sc of srcs) sum.add(sc.instA.worldSlotPos(sc.slotA));
    return sum.divideScalar(srcs.length);
  }
  return conn.instA.worldSlotPos(conn.slotA);
}

/** Position monde du pivot d'une connexion (centroïde des slotB si _sourceConns). */
function _connPivotWorld(conn) {
  const srcs = conn._sourceConns;
  if (srcs?.length > 1) {
    const sum = new THREE.Vector3();
    for (const sc of srcs) {
      sum.add(
        new THREE.Vector3(...sc.slotB.position)
          .applyQuaternion(sc.instB.mesh.quaternion)
          .add(sc.instB.mesh.position)
      );
    }
    return sum.divideScalar(srcs.length);
  }
  const { instB, slotB } = conn;
  return new THREE.Vector3(...slotB.position)
    .applyQuaternion(instB.mesh.quaternion)
    .add(instB.mesh.position);
}

/** Axe monde d'un DOF pour la connexion donnée. */
function _dofWorldAxis(dof, conn) {
  const { instB, slotB } = conn;
  const [ax, ay, az] = dof.axis ?? [0, 0, 1];
  const slotBQ = new THREE.Quaternion(...(slotB.quaternion ?? [0, 0, 0, 1]));
  const worldQ = slotBQ.clone().premultiply(instB.mesh.quaternion.clone());
  return new THREE.Vector3(ax, ay, az).normalize().applyQuaternion(worldQ).normalize();
}

// ═══════════════════════════════════════════════════════════════════════════════

export class Assembler {

  constructor(engine) {
    this.engine       = engine;
    this._ui          = [];
    this._asmVerse    = null;
    this._dock        = null; // BrickDock
    this._configOverlay = null; // modale configuration
    this._raycaster   = new THREE.Raycaster();
    this._mouse       = new THREE.Vector2(-9999, -9999);
    this._snapHelpers = [];
    this._stackCandidate  = null; // { inst, startX, startY } — brique saisie en cours de drag
    this._tapStart        = null; // { x, y } — début de geste en zone vide (pour détecter un tap)
    this._liaisonPickers  = [];   // [{ mesh, conn }] — helpers sélection de liaison
    this._pickerCandidate = null; // { conn, startX, startY } — picker en cours de tap
    this._asmHandlers   = null; // AsmHandlers actifs (DOF d'assemblage)

    // ── État global des modes ──────────────────────────────────────────────────
    this._mode               = 'brick';  // 'brick' | 'component' | 'articulate'
    this._articulateState    = null;     // { components, colorMap, refClass, savedColors, selectedClass }
    this._articulateRefIds   = null;     // Set<string> — IDs des briques de la ref, persiste entre les modes
    this._process            = 'idle';   // 'idle' | 'dragging' | 'trackball' | 'assembling'
    this._selectedBrick      = null;     // AsmBrick | null
    this._selectedComponent  = null;     // AsmEquivalenceClass | null
    this._previewHelper      = null;     // THREE.Mesh — anneau de preview snap
    this._dockGhost          = null;     // { brick } — brique fantôme durant drag depuis dock
    this._dockGhostSpawning  = false;    // verrou anti-double spawn
    this._linkedMove         = false;    // mode déplacement ensemble lié (type touche L)
    this._gizmo              = null;     // THREE.Group — gizmo de translation monde
    this._gizmoDrag          = null;     // { axis, s0, restoreStates } — drag gizmo en cours
    this._grabState          = null;     // { grabBrick, grabPtLocal, grabPlane, chain } — grab IK articuler

    // ── Persistance des préférences du mode articuler ─────────────────────────
    this._articulateShowPickers  = true;  // afficher les sélecteurs de liaison
    this._articulateShowColoring = true;  // coloriser les classes d'équivalence
    this._articulateCcdIter      = 3;     // itérations CCD (1–8)
    this._articBar               = null;  // barre secondaire mode articuler
    this._articPickersBtn        = null;
    this._articColoringBtn       = null;
  }

  // ─── Cycle de vie ──────────────────────────────────────────────────────────

  async start() {
    const loader = this._showLoader();
    loader.step('Scène');
    this._setupScene();
    loader.complete();
    loader.step('Gestionnaires');
    await this._ensureDefaults();
    this._setupManagers();
    this._applyConfig();
    loader.complete();
    loader.step('Interface');
    this._setupUI();
    this._setupEvents();
    loader.complete();
    loader.step('Moteur');
    this.engine.start();
    loader.complete();
    loader.step('Restauration scène');
    await this._restoreScene((done, total) => loader.progress(done / total));
    loader.complete();
    this._centerViewOnSelection();
    loader.done();
  }

  _showLoader() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:200',
      'display:flex', 'flex-direction:column',
      'background:rgba(0,0,0,0.65)', 'color:#fff',
      'border-radius:6px', 'padding:14px 18px',
      'backdrop-filter:blur(4px)',
      "font-family:'Segoe UI',system-ui,sans-serif",
      'transition:opacity 0.4s',
    ].join(';');
    const title = document.createElement('div');
    title.textContent = 'Assembleur';
    title.style.cssText = 'font-size:0.9rem;font-weight:700;letter-spacing:0.12em;color:#7aafc8;margin-bottom:8px;';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:220px;';
    el.append(title, list);
    document.body.appendChild(el);
    const items = [];
    let current = null;
    return {
      step(label) {
        const row = document.createElement('div');
        row.style.cssText = 'transition:opacity 0.2s,color 0.2s;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.95rem;';
        const icon = document.createElement('span');
        icon.textContent = '⟳';
        icon.style.cssText = 'width:1.2rem;text-align:center;';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'flex:1;';
        const pct = document.createElement('span');
        pct.style.cssText = 'font-size:0.75rem;opacity:0.5;font-variant-numeric:tabular-nums;';
        header.append(icon, lbl, pct);

        const barBg = document.createElement('div');
        barBg.style.cssText = 'height:3px;background:rgba(255,255,255,0.1);border-radius:2px;margin-top:3px;overflow:hidden;';
        const barFill = document.createElement('div');
        barFill.style.cssText = 'height:100%;width:0%;background:#7aafc8;border-radius:2px;transition:width 0.15s;';
        barBg.appendChild(barFill);

        row.append(header, barBg);
        list.appendChild(row);
        current = { row, icon, pct, barFill };
        items.push(current);
      },
      progress(ratio) {
        if (!current) return;
        const p = Math.min(1, Math.max(0, ratio));
        current.barFill.style.width = (p * 100).toFixed(1) + '%';
        current.pct.textContent = Math.round(p * 100) + '%';
      },
      complete() {
        if (!current) return;
        current.barFill.style.width = '100%';
        current.pct.textContent = '';
        current.icon.textContent = '✓';
        current.row.style.color = '#aaffcc';
      },
      done() {
        setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => el.remove(), 400);
        }, 300);
      },
    };
  }

  _loadConfig() {
    try { return { ...CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
    catch { return { ...CFG_DEFAULTS }; }
  }

  _saveConfig(patch) {
    const cfg = this._loadConfig();
    localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign(cfg, patch)));
  }

  _applyStripStyle() {
    if (!this._asmHandlers) return;
    const cfg = this._loadConfig();
    const sbgHex   = cfg.stripBgColor   ?? '#121218';
    const sbgAlpha = Math.round((cfg.stripBgOpacity ?? 0.6) * 255).toString(16).padStart(2, '0');
    const stripBg    = sbgHex + sbgAlpha;
    const stripFont  = cfg.stripFontColor ?? '#cccccc';
    this._asmHandlers.updateStripStyle(stripBg, stripFont);
  }

  _applyConfig() {
    const cfg = this._loadConfig();
    this._dock.setPosition(cfg.dockEdge, cfg.dockAlign);
    this._dock.setActivateOnOutsideTap(cfg.activateOnOutsideTap);
    this._dock.setStackPersist(cfg.stackPersist);
    this._dock.setCellStyles(cfg);
    this._dock.setCellSizes(cfg.cellSize ?? 110, cfg.cellActiveSize ?? 190);
    this._asmVerse.worldSlots.planY = cfg.planY;
    this._asmVerse.worldSlots.snapR = cfg.snapR;
    if (this._asmVerse.worldSlots.planMesh) this._asmVerse.worldSlots.planMesh.visible = cfg.planVisible;
    this._asmVerse.slots.clipDist   = cfg.connectionTolerance ?? 0.12;
    this._lodDistLow  = cfg.lodDistLow  ?? 12;
    this._lodDistHigh = cfg.lodDistHigh ?? 3;
  }

  // ─── Persistance de la scène ───────────────────────────────────────────────

  _saveScene() {
    try {
      localStorage.setItem(SCENE_KEY, JSON.stringify(this._asmVerse.serialize()));
    } catch { /* quota exceeded */ }
  }

  async _restoreScene(onProgress = null) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(SCENE_KEY) || 'null'); } catch { return; }
    if (!saved?.instances?.length) return;
    const bricksStore   = this._loadStore('rbang_bricks');
    const shapesStore   = this._loadStore('rbang_shapes');
    const liaisonsStore = this._loadStore('rbang_liaisons');
    await this._asmVerse.restore(saved, bricksStore, shapesStore, liaisonsStore, onProgress);
    this._updateCount();
  }

  async _serializeSceneJSON() {
    const data         = this._asmVerse.serialize();
    const bricksStore  = this._loadStore('rbang_bricks');
    const shapesStore  = this._loadStore('rbang_shapes');
    const liaisonsStore = this._loadStore('rbang_liaisons');

    const bricks   = {};
    const shapes   = {};
    const liaisons = { ...liaisonsStore };

    for (const inst of data.instances) {
      const bd = bricksStore[inst.brickTypeId];
      if (!bd) continue;
      bricks[inst.brickTypeId] = { ...bd };
      if (bd.shapeRef && shapesStore[bd.shapeRef])
        shapes[bd.shapeRef] = shapesStore[bd.shapeRef];
    }

    // Embarquer les OBJ depuis IndexedDB pour la portabilité
    for (const [typeId, bd] of Object.entries(bricks)) {
      for (const suffix of ['geoLow', 'geoMedium', 'geoHigh']) {
        const obj = await idb.get(`brick:${typeId}:${suffix}`);
        if (obj) bd[suffix] = obj;
      }
    }

    return JSON.stringify({ ...data, bricks, shapes, liaisons }, null, 2);
  }

  async _exportScene() {
    this._toast('Préparation export…');
    const json = await this._serializeSceneJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `rbang-scene-${Date.now()}.json`;
    a.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this._toast('Export téléchargé');
  }

  _toast(msg, duration = 2000) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      `background:${C.bgDark ?? '#1a1a1a'}cc`, `color:${C.fg ?? '#ccc'}`,
      'padding:6px 14px', 'border-radius:4px', 'font-size:11px',
      'pointer-events:none', 'z-index:99999',
      'transition:opacity 0.4s',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, duration);
  }

  _importScene() {
    const input = document.createElement('input');
    input.type  = 'file';
    input.accept = '.json,application/json';
    input.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(input);

    const cleanup = () => { if (input.parentNode) document.body.removeChild(input); };

    input.addEventListener('change', async () => {
      cleanup();
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        // Valider le JSON et le format avant de toucher à la scène
        const data = JSON.parse(text);
        if (!Array.isArray(data?.instances)) throw new Error('format invalide');
        console.log('[import] instances:', data.instances.length,
          '| bricks embarqués:', Object.keys(data.bricks ?? {}).length,
          '| shapes embarquées:', Object.keys(data.shapes ?? {}).length,
          '| liaisons embarquées:', Object.keys(data.liaisons ?? {}).length);

        // Détecte les conflits (clé présente localement avec données différentes)
        const conflicts = (storeKey, incoming) => {
          if (!incoming || typeof incoming !== 'object') return [];
          const local = this._loadStore(storeKey);
          return Object.entries(incoming)
            .filter(([k, v]) => k in local && JSON.stringify(local[k]) !== JSON.stringify(v))
            .map(([k]) => k);
        };

        const brickConflicts   = conflicts('rbang_bricks',   data.bricks);
        const liaisonConflicts = conflicts('rbang_liaisons', data.liaisons);
        const all = [...brickConflicts, ...liaisonConflicts];

        if (all.length > 0) {
          const list = all.slice(0, 6).join(', ') + (all.length > 6 ? ` … (+${all.length - 6})` : '');
          const go = confirm(
            `Import : ${all.length} entrée(s) locale(s) seraient écrasées :\n${list}\n\nContinuer et écraser ?`
          );
          if (!go) return;
        }

        // Extraire les OBJ des briques → IndexedDB, puis injecter le reste dans localStorage
        if (data.bricks && typeof data.bricks === 'object') {
          const idbEntries = [];
          for (const [typeId, bd] of Object.entries(data.bricks)) {
            for (const suffix of ['geoLow', 'geoMedium', 'geoHigh']) {
              if (bd[suffix]) {
                idbEntries.push([`brick:${typeId}:${suffix}`, bd[suffix]]);
                delete bd[suffix];
              }
            }
            if (idbEntries.length) bd._hasOBJ = true;
          }
          if (idbEntries.length) await idb.setMany(idbEntries);
        }

        const inject = (key, field) => {
          if (data[field] && typeof data[field] === 'object') {
            const store = this._loadStore(key);
            Object.assign(store, data[field]);
            localStorage.setItem(key, JSON.stringify(store));
          }
        };
        inject('rbang_bricks',   'bricks');
        inject('rbang_shapes',   'shapes');
        inject('rbang_liaisons', 'liaisons');
        // Effacer la scène courante, puis restaurer depuis les données importées
        // sans passer par localStorage (pour éviter le quota exceeded sur les grandes scènes)
        this._clearAll();
        const sceneOnly = { instances: data.instances, connections: data.connections };
        // Persister dans localStorage si possible (pour la prochaine session)
        try { localStorage.setItem(SCENE_KEY, JSON.stringify(sceneOnly)); } catch { /* quota */ }
        // Restaurer directement depuis data (sans relire localStorage)
        const bricksStore   = this._loadStore('rbang_bricks');
        const shapesStore   = this._loadStore('rbang_shapes');
        const liaisonsStore = this._loadStore('rbang_liaisons');
        await this._asmVerse.restore(sceneOnly, bricksStore, shapesStore, liaisonsStore);
        this._updateCount();
        const n = this._asmVerse.bricks.size;
        if (n === 0 && data.instances.length > 0)
          alert('Import : aucune brique chargée — les types de briques sont absents du store local.');
      } catch (e) {
        console.error('[Assembler] import échoué :', e.message);
        alert(`Import échoué : ${e.message}`);
      }
    });

    // Nettoyage si l'utilisateur annule le sélecteur de fichier
    window.addEventListener('focus', () => setTimeout(cleanup, 500), { once: true });

    input.click();
  }

  stop() {
    this._removeDockGhost();
    this._clearLiaisonPickers();
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    if (this._gizmo) {
      this.engine.scene.remove(this._gizmo);
      this._gizmo.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
      this._gizmo = null;
    }
    this.engine.resizeViewport(0, 0, 0);
    this._asmVerse.dispose();
    this._dock?.destroy();
    if (this._previewHelper) {
      this.engine.scene.remove(this._previewHelper);
      this._previewHelper.geometry.dispose();
      this._previewHelper.material.dispose();
      this._previewHelper = null;
    }
    this._clearSnapHelpers();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup',   this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMoveStack, { capture: true });
    window.removeEventListener('pointerup',   this._onPointerUpStack,   { capture: true });
    this.engine.controls.enabled = true;
    this._stackCandidate = null;
  }

  // ─── Scène ─────────────────────────────────────────────────────────────────

  _setupScene() {
    const e = this.engine;
    this._floor = e.addStaticBox(24, 0.5, 24, 0, 0, 0, 0x2a3a2a); // dessus à Y = 0.25
    const cfg = this._loadConfig();
    if (cfg.floorVisible === false) this._floor.mesh.visible = false;
    e.camera.position.set(0, 8, 14);
    e.controls.target.set(0, 0, 0);
    e.controls.update();
  }

  // ─── Données par défaut ────────────────────────────────────────────────────

  async _ensureDefaults() {
    const bricks = this._loadStore('rbang_bricks');
    if (Object.keys(bricks).length > 0) return;
    try {
      const base = window.RBANG_BASE + 'assets/rbang-bricks-base.json';
      const meca = window.RBANG_BASE + 'assets/rbang-meca.json';
      const [bricksData, mecaData] = await Promise.all([
        fetch(base).then(r => r.ok ? r.json() : null),
        fetch(meca).then(r => r.ok ? r.json() : null),
      ]);
      if (bricksData) localStorage.setItem('rbang_bricks', JSON.stringify(bricksData));
      if (mecaData?.slotTypes) localStorage.setItem('rbang_slot_types', JSON.stringify(mecaData.slotTypes));
      if (mecaData?.liaisons)  localStorage.setItem('rbang_liaisons',   JSON.stringify(mecaData.liaisons));
    } catch { /* silencieux */ }
  }

  // ─── Managers ──────────────────────────────────────────────────────────────

  _setupManagers() {
    this._asmVerse = new AsmVerse(this.engine.scene);
    // Lors d'un ajout ou déplacement de brique, si une nouvelle liaison est créée,
    // activer les AsmHandlers DOF. Retourner true empêche la création du disque marqueur
    // (les handlers le remplacent). Retourner false (liaison rigide) → disque créé.
    this._asmVerse.joints.onConnect = (conn) => this._activateAsmHandlers(conn);
    this._buildGizmo();
    this._dock = new BrickDock(this.engine, { edge: 'bottom', align: 'center' });
    this._dock.setCellStyles(this._loadConfig());
    this._dock.onPickBrick((brickId, gesture) => {
      this._activeGesture = null;
      this._removeDockGhost();
      this._handleScreenSlotDrop(gesture);
    });
    this._dock.onDragBrick((brickId, { x, y, nearSlots }) =>
      this._onDockDrag(brickId, x, y, nearSlots));
    this._dock.onCancelDrag(() => this._removeDockGhost());
    const bricks = this._loadStore('rbang_bricks');
    this._dock.load(bricks);
  }

  // ─── Gestion du drop depuis un screen slot ──────────────────────────────────

  async _handleScreenSlotDrop(gesture) {
    const { brickId, nearSlots, endX, endY } = gesture;

    if (this._isOverScreenSlot(endX, endY)) return;

    this._mouse.x =  (endX / innerWidth)  * 2 - 1;
    this._mouse.y = -(endY / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    const meshes = [...this._asmVerse.bricks.values()].map(i => i.mesh);
    const hits   = this._raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      const targetMesh = hits[0].object;
      const targetInst = [...this._asmVerse.bricks.values()].find(i => i.mesh === targetMesh);
      if (targetInst) {
        await this._assembleTo(brickId, nearSlots, targetInst, endX, endY);
        return;
      }
    }

    const pt = this._asmVerse.worldSlots.raycastPlane(this._raycaster);
    if (pt) {
      const brickData = this._loadStore('rbang_bricks')[brickId];
      if (!brickData) return;
      const wslot = this._asmVerse.worldSlots.addWorldSlot(pt);
      const brick = await this._asmVerse.spawnBrick(brickId, brickData, wslot.position);
      if (brick) {
        this._asmVerse.bindWorldSlot(wslot, brick, (gesture.nearSlots || [])[0] ?? null);
        this._updateCount();
      }
    }
  }

  // ─── Assembler une brique sur une instance existante ────────────────────────

  async _assembleTo(brickId, nearSlotsA, targetInst, endX, endY) {
    const nearSlotsB = this._asmVerse.slots.nearSlotsOf(targetInst, endX, endY, this.engine.camera, true);
    const result = this._asmVerse.worldSlots.resolve(nearSlotsA, nearSlotsB);
    const brickData = this._loadStore('rbang_bricks')[brickId];
    if (!brickData) return;

    if (result) {
      const snap = this._asmVerse.worldSlots.computeSnap(result.slotA, result.slotB, targetInst);
      const brick = await this._asmVerse.spawnBrick(brickId, brickData, null, snap);
      if (brick) {
        this._asmVerse.joints.observe(this._asmVerse.slots, true, brick);
        this._showSnapHelper(brick.mesh.position.clone());
        this._updateCount();
      }
    } else {
      this._asmVerse._solver.diagnose(nearSlotsA, nearSlotsB, this._asmVerse.slots.typeIds);
      const pos = targetInst.mesh.position.clone().add(new THREE.Vector3(2, 0, 0));
      await this._spawnBrick(brickId, pos);
    }
  }

  // ─── Spawn d'une brique dans la scène ───────────────────────────────────────

  async _spawnBrick(brickId, pos, snapTransform = null) {
    const brickData = this._loadStore('rbang_bricks')[brickId];
    if (!brickData) return null;
    const brick = await this._asmVerse.spawnBrick(brickId, brickData, pos, snapTransform);
    if (brick) this._updateCount();
    return brick;
  }

  // ─── Ghost dock — preview semi-transparent durant le drag depuis le dock ────

  async _onDockDrag(brickId, x, y, nearSlots) {
    // Spawn du ghost au premier appel
    if (!this._dockGhost) {
      if (this._dockGhostSpawning) return;
      this._dockGhostSpawning = true;
      const brickData = this._loadStore('rbang_bricks')[brickId];
      if (!brickData) { this._dockGhostSpawning = false; return; }
      const brick = await this._asmVerse.spawnBrick(brickId, brickData,
        new THREE.Vector3(0, -1000, 0)); // hors champ le temps du spawn
      this._dockGhostSpawning = false;
      if (!brick) return;
      brick.mesh.material.transparent = true;
      brick.mesh.material.opacity     = 0.4;
      brick.mesh.material.needsUpdate = true;
      this._dockGhost = { brick, brickId, nearSlots };
      this._asmVerse.worldSlots.showGrid();
    }

    const { brick } = this._dockGhost;

    this._mouse.x =  (x / innerWidth)  * 2 - 1;
    this._mouse.y = -(y / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    // Cherche une brique cible sous le pointeur (sans le ghost)
    const meshes = [...this._asmVerse.bricks.values()]
      .filter(i => i !== brick)
      .map(i => i.mesh);
    const hits = this._raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      const targetInst = [...this._asmVerse.bricks.values()].find(i => i.mesh === hits[0].object);
      if (targetInst) {
        const nearSlotsB = this._asmVerse.slots.nearSlotsOf(targetInst, x, y, this.engine.camera, true);
        const result = this._asmVerse.worldSlots.resolve(nearSlots, nearSlotsB);
        if (result) {
          const snap = this._asmVerse.worldSlots.computeSnap(result.slotA, result.slotB, targetInst);
          brick.mesh.position.copy(snap.position);
          brick.mesh.quaternion.copy(snap.quaternion);
          this._showPreviewHelper(snap.position);
          return;
        }
      }
    }

    // Pas de snap brique → snapper sur la cellule grille
    const pt = this._asmVerse.worldSlots.raycastPlane(this._raycaster);
    if (pt) {
      const { gx, gz } = this._asmVerse.worldSlots.worldToGrid(pt);
      const cellY = this._asmVerse.worldSlots.planY;
      brick.mesh.position.set(gx, cellY, gz);
      brick.mesh.quaternion.identity();
      const free = this._asmVerse.worldSlots.isFree(gx, gz);
      this._showPreviewHelper(new THREE.Vector3(gx, cellY, gz), free);
    }
  }

  _removeDockGhost() {
    if (!this._dockGhost) return;
    this._asmVerse.removeBrick(this._dockGhost.brick); // pas de _updateCount
    this._dockGhost = null;
    this._dockGhostSpawning = false;
    this._hidePreviewHelper();
    this._asmVerse.worldSlots.hideGrid();
  }

  // ─── Trackball sur un world slot ─────────────────────────────────────────────

  _startWorldSlotTrackball(wslot, e) {
    const pivot   = wslot.position.clone();
    const startX  = e.clientX;
    let   lastX   = startX;

    const onMove = (ev) => {
      const dx   = ev.clientX - lastX;
      lastX      = ev.clientX;
      const angle = dx * 0.01;
      if (wslot.brickInstanceId) {
        const inst = this._asmVerse.bricks.get(wslot.brickInstanceId);
        if (inst) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), angle);
          inst.mesh.position.sub(pivot).applyQuaternion(q).add(pivot);
          inst.mesh.quaternion.premultiply(q);
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      this._setProcess('idle');
    };
    this._setProcess('trackball');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
  }

  // ─── Événements principaux ───────────────────────────────────────────────────

  _setupEvents() {
    this._onPointerDown = (e) => {
      if (this._isOverScreenSlot(e.clientX, e.clientY)) return;
      if (this._isOverUI(e.target)) return;

      this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
      this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
      this._raycaster.setFromCamera(this._mouse, this.engine.camera);

      // Priorité 0a : handles du gizmo de translation
      if (this._gizmo?.visible) {
        const handles = [];
        this._gizmo.traverse(c => { if (c.userData.isGizmoHandle) handles.push(c); });
        const gHits = this._raycaster.intersectObjects(handles, false);
        if (gHits.length > 0) {
          const axis = gHits[0].object.userData.worldAxis.clone();
          const linkedSet = this._selectedComponent
            ? this._linkedBrickSet([...this._selectedComponent.bricks][0])
            : new Set();
          const gizmoOrigin = this._gizmo.position.clone();
          const s0 = this._rayAxisParam(this._raycaster.ray, gizmoOrigin, axis);
          this._gizmoDrag = {
            axis, s0, gizmoOrigin,
            restoreStates: [...linkedSet].map(b => ({ brick: b, pos: b.mesh.position.clone() })),
          };
          this._setProcess('gizmo');
          this.engine.controls.enabled = false;
          return;
        }
      }

      // Priorité 0b : pickers de sélection de liaison (état intermédiaire)
      if (this._liaisonPickers.length > 0) {
        const pickerHits = this._raycaster.intersectObjects(
          this._liaisonPickers.map(p => p.mesh), false);
        if (pickerHits.length > 0) {
          const picker = this._liaisonPickers.find(p => p.mesh === pickerHits[0].object);
          if (picker) {
            this._pickerCandidate = { conn: picker.conn, mobileInst: picker.mobileInst, startX: e.clientX, startY: e.clientY };
            this.engine.controls.enabled = false;
            return;
          }
        }
      }

      // Priorité 1 : brique existante
      const meshes = [...this._asmVerse.bricks.values()].map(i => i.mesh);
      const hits   = this._raycaster.intersectObjects(meshes, false);
      if (hits.length > 0) {
        const hitMesh = hits[0].object;
        const hitInst = [...this._asmVerse.bricks.values()].find(i => i.mesh === hitMesh);
        if (hitInst) {
          if (this._mode === 'articulate') {
            this._tapStart = { x: e.clientX, y: e.clientY, inst: hitInst, hitPt: hits[0].point.clone() };
            this.engine.controls.enabled = false;
            return;
          }
          // Sélection différée au pointerup (clic confirmé, sans drag)
          this._stackCandidate = { inst: hitInst, startX: e.clientX, startY: e.clientY, grabPt: hits[0].point.clone() };
          this.engine.controls.enabled = false;
        }
        return;
      }

      // Zone vide — enregistrer pour détecter un tap (désélection différée au pointerup)
      this._tapStart = { x: e.clientX, y: e.clientY };

      // Priorité 2 : world slot proche
      const pt = this._asmVerse.worldSlots.raycastPlane(this._raycaster);
      if (pt) {
        const nearest = this._asmVerse.worldSlots.nearest(pt, this._asmVerse.worldSlots.snapR);
        if (nearest) {
          e.stopPropagation();
          this._startWorldSlotTrackball(nearest, e);
          return;
        }
      }
      // Sinon : OrbitControls gère la caméra
    };

    this._onPointerMoveStack = (e) => {
      // Gizmo drag — priorité absolue
      if (this._gizmoDrag) {
        this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
        this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this.engine.camera);
        const { axis, s0, gizmoOrigin, restoreStates } = this._gizmoDrag;
        const s1    = this._rayAxisParam(this._raycaster.ray, gizmoOrigin, axis);
        const delta = axis.clone().multiplyScalar(s1 - s0);
        for (const { brick, pos } of restoreStates) {
          brick.mesh.position.copy(pos).add(delta);
        }
        this._gizmo.position.copy(gizmoOrigin).add(delta);
        return;
      }
      // Mode articuler — grab IK
      if (this._mode === 'articulate') {
        if (this._grabState) {
          this._updateArticulateGrab(e);
        } else if (this._tapStart?.inst) {
          const dx = e.clientX - this._tapStart.x, dy = e.clientY - this._tapStart.y;
          if (Math.sqrt(dx * dx + dy * dy) >= 12) this._startArticulateGrab(e);
        }
        return;
      }
      if (!this._stackCandidate) return;
      const { inst, startX, startY } = this._stackCandidate;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) >= 12) {
        if (this._process !== 'dragging') {
          if (this._mode === 'component') {
            let brickSet;
            if (this._linkedMove) {
              brickSet = this._linkedBrickSet(inst);
              if (this._isGrounded(brickSet)) {
                this.engine.controls.enabled = true;
                this._stackCandidate = null;
                this._toast('Ensemble ancré au sol — déplacement impossible');
                return;
              }
            } else {
              const comp = this._findComponent(inst);
              this._stackCandidate.comp = comp;
              brickSet = comp.bricks;
            }
            this._stackCandidate.restoreStates = [...brickSet].map(b => ({
              brick: b, pos: b.mesh.position.clone(), quat: b.mesh.quaternion.clone(),
            }));
            for (const b of brickSet) {
              b.mesh.material.transparent = true;
              b.mesh.material.opacity     = 0.4;
              b.mesh.material.needsUpdate = true;
            }
          } else {
            this._stackCandidate.restorePos  = inst.mesh.position.clone();
            this._stackCandidate.restoreQuat = inst.mesh.quaternion.clone();
            inst.mesh.material.transparent = true;
            inst.mesh.material.opacity     = 0.4;
            inst.mesh.material.needsUpdate = true;
          }
          this._setProcess('dragging');
        }
        if (this._mode === 'component') {
          this._dragCompTo(e.clientX, e.clientY);
        } else {
          this._updateSnapPreview(inst, startX, startY, e.clientX, e.clientY);
        }
      }
    };

    this._onPointerUpStack = (e) => {
      // Fin du drag gizmo
      if (this._gizmoDrag) {
        this._gizmoDrag = null;
        this._setProcess('idle');
        this.engine.controls.enabled = true;
        this._asmVerse.joints.observe(this._asmVerse.slots);
        return;
      }
      if (!this._stackCandidate) {
        // Fin du grab IK articuler
        if (this._grabState) {
          this._grabState = null;
          this._setProcess('idle');
          this.engine.controls.enabled = true;
          this._asmVerse.joints.observe(this._asmVerse.slots);
          this._updateArticulatePickers();
          this._tapStart = null;
          return;
        }
        // Tap sur un picker → activer la liaison choisie
        if (this._pickerCandidate) {
          const { conn, mobileInst, startX, startY } = this._pickerCandidate;
          this._pickerCandidate = null;
          this.engine.controls.enabled = true;
          const dx = e.clientX - startX, dy = e.clientY - startY;
          if (Math.sqrt(dx * dx + dy * dy) < 12) {
            if (this._mode === 'articulate') {
              // Mode articuler : les pickers restent visibles, on active le handler orienté
              this._activateArticulateHandler(conn);
            } else {
              this._clearLiaisonPickers();
              this._activateAsmHandlers(conn, mobileInst ?? this._selectedBrick);
            }
          }
          return;
        }
        // Tap en zone vide ou sur brique (mode articuler)
        if (this._tapStart) {
          const dx = e.clientX - this._tapStart.x, dy = e.clientY - this._tapStart.y;
          if (Math.sqrt(dx * dx + dy * dy) < 12) {
            if (this._mode === 'articulate') {
              // Tap sur une brique → sélection de sa classe d'équivalence
              if (this._tapStart.inst) {
                const comp = this._articulateState?.components?.find(c => c.contains(this._tapStart.inst));
                if (comp && comp === this._articulateState?.selectedClass) {
                  this._selectArticulateClass(null); // toggle off
                } else {
                  this._selectArticulateClass(comp);
                }
              } else {
                this._selectArticulateClass(null);
              }
            } else if (this._mode === 'component') {
              this._selectComponent(null);
            } else {
              this._selectBrick(null);
            }
          }
          this._tapStart = null;
          this.engine.controls.enabled = true;
        }
        return;
      }

      const wasDragging = this._process === 'dragging';
      this._setProcess('idle');
      const { inst, startX, startY } = this._stackCandidate;

      const under  = document.elementFromPoint(e.clientX, e.clientY);
      const onDock = under?.closest?.('.brick-dock');

      this._hidePreviewHelper();

      if (onDock) {
        // ── Drop sur le dock → empiler
        this._removeFromScene(inst);
        this._dock.pushToStack(inst.brickTypeId, inst.brickData);
        e.stopPropagation();
      } else if (this._mode === 'component') {
        if (!wasDragging) {
          this._selectComponent(this._findComponent(inst));
        } else {
          for (const { brick } of (this._stackCandidate.restoreStates ?? [])) {
            brick.mesh.material.transparent = false;
            brick.mesh.material.opacity     = 1;
            brick.mesh.material.needsUpdate = true;
          }
          this._asmVerse.joints.observe(this._asmVerse.slots);
        }
      } else {
        // ── Tap sans drag → sélection confirmée
        if (!wasDragging) {
          this._selectBrick(inst);
        } else {
          // ── Drop sur une autre brique → assembler
          this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
          this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
          this._raycaster.setFromCamera(this._mouse, this.engine.camera);
          const others = [...this._asmVerse.bricks.values()].filter(i => i !== inst);
          const hits   = this._raycaster.intersectObjects(others.map(i => i.mesh), false);
          let connected = false;
          if (hits.length > 0) {
            const target = others.find(i => i.mesh === hits[0].object);
            if (target) connected = this._connectDrag(inst, startX, startY, target, e.clientX, e.clientY);
          }
          if (connected) {
            this._setBrickSelected(inst);
          } else if (this._stackCandidate?.restorePos) {
            inst.mesh.position.copy(this._stackCandidate.restorePos);
            inst.mesh.quaternion.copy(this._stackCandidate.restoreQuat);
            this._asmVerse.joints.observe(this._asmVerse.slots);
          }
        }
        // Restaurer opacité dans tous les cas (drag ou tap)
        inst.mesh.material.transparent = false;
        inst.mesh.material.opacity     = 1;
        inst.mesh.material.needsUpdate = true;
      }

      this.engine.controls.enabled = true;
      this._stackCandidate = null;
    };

    window.addEventListener('pointercancel', () => {
      this._tapStart        = null;
      this._pickerCandidate = null;
      this._grabState       = null;
      if (this._gizmoDrag) {
        // Restaurer les positions initiales
        for (const { brick, pos } of this._gizmoDrag.restoreStates) {
          brick.mesh.position.copy(pos);
        }
        this._gizmo.position.copy(this._gizmoDrag.gizmoOrigin);
        this._gizmoDrag = null;
        this._setProcess('idle');
        this.engine.controls.enabled = true;
        return;
      }
      if (this._stackCandidate) {
        if (this._mode === 'component') {
          for (const { brick, pos, quat } of (this._stackCandidate.restoreStates ?? [])) {
            brick.mesh.position.copy(pos);
            brick.mesh.quaternion.copy(quat);
            brick.mesh.material.transparent = false;
            brick.mesh.material.opacity     = 1;
            brick.mesh.material.needsUpdate = true;
          }
          if (this._stackCandidate.restoreStates?.length)
            this._asmVerse.joints.observe(this._asmVerse.slots);
        } else {
          const { inst, restorePos, restoreQuat } = this._stackCandidate;
          if (inst?.mesh) {
            if (restorePos) {
              inst.mesh.position.copy(restorePos);
              inst.mesh.quaternion.copy(restoreQuat);
              this._asmVerse.joints.observe(this._asmVerse.slots);
            }
            inst.mesh.material.transparent = false;
            inst.mesh.material.opacity     = 1;
            inst.mesh.material.needsUpdate = true;
          }
        }
        this._stackCandidate = null;
        this._setProcess('idle');
      }
      this._hidePreviewHelper();
      this.engine.controls.enabled = true;
    }, { capture: true });

    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointermove', this._onPointerMoveStack, { capture: true });
    window.addEventListener('pointerup',   this._onPointerUpStack,   { capture: true });
  }

  // ─── DOF assemblage ───────────────────────────────────────────────────────────

  _activateAsmHandlers(conn, mobileInst = null) {
    this._asmHandlers?.detach();
    this._asmHandlers = null;

    // instA doit être la brique mobile (initiatrice ou sélectionnée).
    // coincidentPairs() retourne les briques dans l'ordre d'insertion,
    // pas forcément dans l'ordre mobile/pivot — on réoriente si besoin.
    const mobile = mobileInst ?? this._asmVerse.joints.lastInitiator;
    const oriented = (mobile && conn.instB === mobile)
      ? { ...conn, instA: conn.instB, slotA: conn.slotB, instB: conn.instA, slotB: conn.slotA }
      : conn;

    const cfg        = this._loadConfig();
    const stepsRot   = cfg.asmHelperStepsRot   ?? 16;
    const stepsTrans = cfg.asmHelperStepsTrans  ?? 20;
    // En mode Composante : toujours InvolvedComponentsSolver (cohérent avec computeComponents)
    const solver = this._mode === 'component' ? 'component' : 'asm';
    const connections = this._asmVerse.joints.connections;
    const xray    = true;
    const sbgHex   = cfg.stripBgColor   ?? '#121218';
    const sbgAlpha = Math.round((cfg.stripBgOpacity ?? 0.6) * 255).toString(16).padStart(2, '0');
    const stripBg    = sbgHex + sbgAlpha;
    const stripFont  = cfg.stripFontColor  ?? '#cccccc';
    const handlers = new AsmHandlers({ conn: oriented, engine: this.engine, topOffset: BAR_H, stepsRot, stepsTrans, connections, solver, xray, stripBg, stripFont });
    if (handlers.active) {
      handlers.onRelease = () => this._asmVerse.joints.observe(this._asmVerse.slots);
      handlers.attach();
      this._asmHandlers = handlers;
      return true; // AsmHandlers remplace le disque marqueur
    }
    return false; // liaison rigide → le disque marqueur sera créé
  }

  // ─── Preview de snap ─────────────────────────────────────────────────────────

  /**
   * Met à jour le preview en temps réel pendant le drag d'une brique.
   * Déplace inst.mesh vers la position snappée si une cible est trouvée,
   * sinon la rétablit à la position de départ du drag (_stackCandidate.restorePos).
   */
  _updateSnapPreview(inst, grabX, grabY, cx, cy) {
    this._mouse.x =  (cx / innerWidth)  * 2 - 1;
    this._mouse.y = -(cy / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    const others = [...this._asmVerse.bricks.values()].filter(i => i !== inst);
    const hits   = this._raycaster.intersectObjects(others.map(i => i.mesh), false);

    if (hits.length > 0) {
      const target = others.find(i => i.mesh === hits[0].object);
      if (target) {
        const snap = this._asmVerse.previewSnap(inst, grabX, grabY, target, cx, cy, this.engine.camera, this._stackCandidate?.grabPt);
        if (snap) {
          inst.mesh.position.copy(snap.position);
          inst.mesh.quaternion.copy(snap.quaternion);
          this._showPreviewHelper(snap.position);
          return;
        }
      }
    }
    // Pas de snap candidat → brique revient à sa position de départ du drag
    const sc = this._stackCandidate;
    if (sc?.restorePos) {
      inst.mesh.position.copy(sc.restorePos);
      inst.mesh.quaternion.copy(sc.restoreQuat);
    }
    this._hidePreviewHelper();
  }

  _showPreviewHelper(pos) {
    if (!this._previewHelper) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.18, 0.28, 32),
        new THREE.MeshBasicMaterial({ color: C.snapRing, side: THREE.DoubleSide, depthWrite: false })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 999;
      this.engine.scene.add(mesh);
      this._previewHelper = mesh;
    }
    this._previewHelper.position.copy(pos);
    this._previewHelper.visible = true;
  }

  _hidePreviewHelper() {
    if (this._previewHelper) this._previewHelper.visible = false;
  }

  // ─── Pickers de sélection de liaison ─────────────────────────────────────────

  /** Affiche une sphère 3D raycastable par connexion DOF — état intermédiaire
   *  quand la brique sélectionnée possède plusieurs liaisons. */
  _showLiaisonPickers(entries, radius = 0.16) {
    for (const entry of entries) {
      const conn       = entry.conn ?? entry;   // accepte {conn,mobileInst} ou conn direct
      const mobileInst = entry.mobileInst ?? null;
      const pos = _pickerWorldPos(conn);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 12, 10),
        new THREE.MeshBasicMaterial({
          color: C.liaisonPicker, transparent: true, opacity: 0.90,
          depthTest: false, depthWrite: false,
        }),
      );
      mesh.position.copy(pos);
      mesh.renderOrder = 999;
      this.engine.scene.add(mesh);
      this._liaisonPickers.push({ mesh, conn, mobileInst });
    }
  }

  _clearLiaisonPickers() {
    for (const p of this._liaisonPickers) {
      this.engine.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    }
    this._liaisonPickers = [];
    this._pickerCandidate = null;
  }

  // ─── Helpers visuels ─────────────────────────────────────────────────────────

  _showSnapHelper(pos) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.22, 24),
      new THREE.MeshBasicMaterial({ color: C.snapRing, side: THREE.DoubleSide, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(pos);
    this.engine.scene.add(mesh);
    this._snapHelpers.push(mesh);
    setTimeout(() => {
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose(); mesh.material.dispose();
      const i = this._snapHelpers.indexOf(mesh);
      if (i !== -1) this._snapHelpers.splice(i, 1);
    }, 1200);
  }

  _clearSnapHelpers() {
    for (const h of this._snapHelpers) {
      this.engine.scene.remove(h);
      h.geometry.dispose(); h.material.dispose();
    }
    this._snapHelpers = [];
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────

  _setupUI() {
    const style = document.createElement('style');
    style.textContent = `
      :root { --asm-accent: ${C.accent}; }
      .asm-bar {
        position:fixed; top:0; left:0; right:0; height:${BAR_H}px;
        background:${C.bgDark}ee; border-bottom:1px solid ${C.border};
        display:flex; align-items:center; padding:0 6px;
        z-index:56; pointer-events:auto;
        font:10px sans-serif; color:${C.dim};
      }
      .asm-bar-btn {
        background:transparent; border:none; color:${C.dim};
        font-size:16px; cursor:pointer; padding:0 8px; height:100%;
        line-height:1; flex-shrink:0;
      }
      .asm-bar-btn:active { color:${C.fg}; }
      .asm-artic-bar {
        position:fixed; top:${BAR_H}px; left:0; right:0; height:${BAR_ARTIC_H}px;
        background:${C.bgDark}dd; border-bottom:1px solid ${C.border}44;
        display:none; align-items:center; padding:0 10px; gap:4px;
        z-index:55; pointer-events:auto;
        font:10px sans-serif; color:${C.dim};
      }
      .asm-artic-btn {
        background:transparent; border:1px solid ${C.border}; border-radius:3px;
        color:${C.dim}; font-size:11px; cursor:pointer; padding:1px 8px;
        height:20px; line-height:1; flex-shrink:0; white-space:nowrap;
      }
      .asm-artic-btn.on  { color:${C.accent}; border-color:${C.accent}44; background:${C.accent}18; }
      .asm-artic-btn:active { color:${C.fg}; }
      .asm-artic-sep {
        width:1px; height:16px; background:${C.border}; flex-shrink:0; margin:0 4px;
      }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // ── Barre du haut ─────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'asm-bar';

    const fsBtn = document.createElement('button');
    fsBtn.className = 'asm-bar-btn';
    fsBtn.title = 'Plein écran';
    fsBtn.textContent = '⛶';
    fsBtn.addEventListener('click', () => this._toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      fsBtn.textContent = document.fullscreenElement ? '⊡' : '⛶';
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'asm-bar-btn';
    reloadBtn.title = 'Recharger (vide le cache)';
    reloadBtn.textContent = '↺';
    reloadBtn.addEventListener('click', async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      location.reload();
    });

    // ── Sélecteur de mode ────────────────────────────────────────────────────────
    const modeStrip = document.createElement('div');
    modeStrip.style.cssText = [
      'display:flex', 'align-items:center', `border:1px solid ${C.border}`, 'border-radius:3px',
      'overflow:hidden', 'flex-shrink:0', 'margin:0 4px',
    ].join(';');
    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'Interactions';
    modeLbl.style.cssText = `color:${C.dim};font-size:9px;padding:0 6px;white-space:nowrap;`;
    const _modeBtn = (icon, label, title, key) => {
      const btn = document.createElement('button');
      btn.dataset.modeKey = key;
      btn.title = title;
      btn.innerHTML = `${icon} <span style="font-size:9px">${label}</span>`;
      btn.style.cssText = [
        'background:transparent', 'border:none', `color:${C.dim}`,
        'font-size:13px', 'cursor:pointer', 'padding:0 7px', 'height:100%', 'line-height:1',
        'display:flex', 'align-items:center', 'gap:3px',
      ].join(';');
      btn.addEventListener('click', () => this._setMode(key));
      return btn;
    };
    const _brickModeBtn  = _modeBtn('▦', 'Brique',     'Mode Brique',     'brick');
    const _compModeBtn   = _modeBtn('⬡', 'Composant',  'Mode Composante', 'component');
    const _articModeBtn  = _modeBtn('⚙', 'Articuler',  'Mode Articuler',  'articulate');
    modeStrip.append(modeLbl, _brickModeBtn, _compModeBtn, _articModeBtn);

    this._updateModeBtns = () => {
      for (const btn of modeStrip.querySelectorAll('button')) {
        const active = btn.dataset.modeKey === this._mode;
        btn.style.color      = active ? C.accent : C.dim;
        btn.style.background = active ? `${C.bg}` : 'transparent';
      }
    };
    this._updateModeBtns();

    // ── Toggle déplacement ensemble lié (mode composante uniquement) ─────────
    const linkedMoveBtn = document.createElement('button');
    linkedMoveBtn.className = 'asm-bar-btn';
    linkedMoveBtn.title = 'Déplacer l\'ensemble lié (⛓)';
    linkedMoveBtn.textContent = '⛓';
    linkedMoveBtn.style.display = 'none'; // visible seulement en mode composante
    linkedMoveBtn.addEventListener('click', () => {
      this._linkedMove = !this._linkedMove;
      linkedMoveBtn.style.color      = this._linkedMove ? C.accent : C.dim;
      linkedMoveBtn.style.background = this._linkedMove ? `${C.bg}` : 'transparent';
      this._updateGizmoForSelection();
    });
    this._linkedMoveBtn = linkedMoveBtn;

    // ── Bouton ancre (mode articuler uniquement) ──────────────────────────────
    const anchorBtn = document.createElement('button');
    anchorBtn.className = 'asm-bar-btn';
    anchorBtn.title = 'Définir comme classe de référence (⚓)';
    anchorBtn.textContent = '⚓';
    anchorBtn.style.display = 'none';
    anchorBtn.addEventListener('click', () => {
      if (this._mode === 'articulate' && this._articulateState?.selectedClass) {
        this._setReferenceClass(this._articulateState.selectedClass);
      }
    });
    this._anchorBtn = anchorBtn;

    // ── Bouton centrer la vue ─────────────────────────────────────────────────
    const centerViewBtn = document.createElement('button');
    centerViewBtn.className = 'asm-bar-btn';
    centerViewBtn.title = 'Centrer la vue sur la sélection';
    centerViewBtn.textContent = '◎';
    centerViewBtn.addEventListener('click', () => this._centerViewOnSelection());

    this._countEl = document.createElement('span');
    this._countEl.style.cssText = 'flex:1;text-align:center;pointer-events:none;';

    const catalogueBtn = document.createElement('button');
    catalogueBtn.className = 'asm-bar-btn';
    catalogueBtn.title = 'Catalogue de constructions';
    catalogueBtn.textContent = '⊟';
    catalogueBtn.addEventListener('click', () => this._togglePanel('catalogue'));

    const bricksBtn = document.createElement('button');
    bricksBtn.className = 'asm-bar-btn';
    bricksBtn.title = 'Liste des briques';
    bricksBtn.textContent = '⊞';
    bricksBtn.addEventListener('click', () => this._togglePanel('bricks'));

    const compBtn = document.createElement('button');
    compBtn.className = 'asm-bar-btn';
    compBtn.title = 'Classes d\'équivalence';
    compBtn.textContent = '⬡';
    compBtn.addEventListener('click', () => this._togglePanel('components'));

    const jointsBtn = document.createElement('button');
    jointsBtn.className = 'asm-bar-btn';
    jointsBtn.title = 'Liaisons';
    jointsBtn.textContent = '⇄';
    jointsBtn.addEventListener('click', () => this._togglePanel('joints'));

    const bomBtn = document.createElement('button');
    bomBtn.className = 'asm-bar-btn';
    bomBtn.title = 'Nomenclature';
    bomBtn.textContent = '☰';
    bomBtn.addEventListener('click', () => this._togglePanel('bom'));

    const stateBtn = document.createElement('button');
    stateBtn.className = 'asm-bar-btn';
    stateBtn.title = 'État interne';
    stateBtn.textContent = '◉';
    stateBtn.addEventListener('click', () => this._togglePanel('state'));

    const exportBtn = document.createElement('button');
    exportBtn.className = 'asm-bar-btn';
    exportBtn.title = 'Exporter GLB';
    exportBtn.textContent = '⤓';
    exportBtn.addEventListener('click', () => this._exportGLB());

    const jsonBtn = document.createElement('button');
    jsonBtn.className = 'asm-bar-btn';
    jsonBtn.title = 'Exporter scène JSON';
    jsonBtn.textContent = '{}';
    jsonBtn.style.fontSize = '11px';
    jsonBtn.addEventListener('click', () => this._exportScene());

    const importBtn = document.createElement('button');
    importBtn.className = 'asm-bar-btn';
    importBtn.title = 'Importer scène JSON';
    importBtn.textContent = '↑';
    importBtn.addEventListener('click', () => this._importScene());

    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'asm-bar-btn';
    cfgBtn.title = 'Configuration';
    cfgBtn.textContent = '⚙';
    cfgBtn.addEventListener('click', () => this._openConfigModal());

    bar.append(fsBtn, reloadBtn, modeStrip, linkedMoveBtn, centerViewBtn, this._countEl, catalogueBtn, bomBtn, bricksBtn, compBtn, jointsBtn, stateBtn, importBtn, exportBtn, jsonBtn, cfgBtn);
    document.body.appendChild(bar);
    this._ui.push(bar);

    // ── Barre secondaire — mode articuler ─────────────────────────────────────
    const articBar = document.createElement('div');
    articBar.className = 'asm-artic-bar';

    // Bouton ancre (était dans la barre principale)
    anchorBtn.className = 'asm-artic-btn';
    anchorBtn.style.display = '';

    // Séparateur
    const mkSep = () => { const s = document.createElement('div'); s.className = 'asm-artic-sep'; return s; };

    // Toggle sélecteurs de liaison
    const articPickersBtn = document.createElement('button');
    articPickersBtn.className = 'asm-artic-btn';
    articPickersBtn.title = 'Afficher / masquer les sélecteurs et handler de liaison';
    const _updatePickersBtn = () => {
      articPickersBtn.textContent = '⊙ Sélecteurs';
      articPickersBtn.classList.toggle('on', this._articulateShowPickers);
    };
    articPickersBtn.addEventListener('click', () => {
      this._articulateShowPickers = !this._articulateShowPickers;
      _updatePickersBtn();
      if (this._articulateState) {
        for (const p of this._liaisonPickers) p.mesh.visible = this._articulateShowPickers;
        if (!this._articulateShowPickers) { this._asmHandlers?.detach(); this._asmHandlers = null; }
      }
    });
    _updatePickersBtn();
    this._articPickersBtn = articPickersBtn;

    // Toggle coloration par classe
    const articColoringBtn = document.createElement('button');
    articColoringBtn.className = 'asm-artic-btn';
    articColoringBtn.title = 'Afficher / masquer la coloration par classe d\'équivalence';
    const _updateColoringBtn = () => {
      articColoringBtn.textContent = '⬡ Couleurs';
      articColoringBtn.classList.toggle('on', this._articulateShowColoring);
    };
    articColoringBtn.addEventListener('click', () => {
      this._articulateShowColoring = !this._articulateShowColoring;
      _updateColoringBtn();
      const st = this._articulateState;
      if (st) {
        if (this._articulateShowColoring) {
          for (const [comp, ci] of st.colorMap) {
            const hex = Assembler.ARTIC_PALETTE[ci % Assembler.ARTIC_PALETTE.length];
            for (const b of comp.bricks) b.mesh.material.color.setHex(hex);
          }
          if (st.refClass) for (const b of st.refClass.bricks) b.mesh.material.color.setHex(0xeeeeee);
        } else {
          for (const [brick, hex] of st.savedColors) brick.mesh.material.color.setHex(hex);
        }
      }
    });
    _updateColoringBtn();
    this._articColoringBtn = articColoringBtn;

    // Itérations CCD
    const ccdLbl = document.createElement('span');
    ccdLbl.style.cssText = `color:${C.dim};white-space:nowrap;`;
    ccdLbl.textContent = 'CCD';
    const ccdValEl = document.createElement('span');
    ccdValEl.style.cssText = `color:${C.fg};min-width:14px;text-align:center;display:inline-block;`;
    ccdValEl.textContent = this._articulateCcdIter;
    const mkCcdBtn = (delta) => {
      const b = document.createElement('button');
      b.className = 'asm-artic-btn';
      b.style.padding = '1px 5px';
      b.textContent = delta > 0 ? '+' : '−';
      b.addEventListener('click', () => {
        this._articulateCcdIter = Math.max(1, Math.min(8, this._articulateCcdIter + delta));
        ccdValEl.textContent = this._articulateCcdIter;
      });
      return b;
    };

    const kinGraphBtn = document.createElement('button');
    kinGraphBtn.className = 'asm-artic-btn';
    kinGraphBtn.title = 'Graphe cinématique des liaisons';
    kinGraphBtn.textContent = '⬡ Graphe';
    kinGraphBtn.addEventListener('click', () => this._togglePanel('kingraph'));

    articBar.append(anchorBtn, mkSep(), articPickersBtn, articColoringBtn, mkSep(), kinGraphBtn, mkSep(), ccdLbl, mkCcdBtn(-1), ccdValEl, mkCcdBtn(1));
    document.body.appendChild(articBar);
    this._articBar = articBar;
    this._ui.push(articBar);

    // ── Modale de configuration ───────────────────────────────────────────────
    this._setupConfigModal();

    // ── Rogner le viewport rendu + dock sous la barre ─────────────────────────
    this.engine.resizeViewport(0, 0, BAR_H);
    this._dock.setInsets({ top: BAR_H });

    // ── onUpdate ──────────────────────────────────────────────────────────────
    this.engine.onUpdate = () => {
      const n = this._asmVerse.bricks.size;
      const c = n ? this._asmVerse.componentCount() : 0;
      const nConn = this._asmVerse.joints.connections.length;
      this._countEl.textContent = `Briques : ${n}` + (n ? `  |  Liaisons : ${nConn}  |  Composants : ${c}` : '');
      // Scaling du gizmo pour garder une taille constante à l'écran
      if (this._gizmo?.visible) {
        const dist = this._gizmo.position.distanceTo(this.engine.camera.position);
        this._gizmo.scale.setScalar(dist * 0.22);
      }
      // LOD — ajuster la définition des briques selon la distance caméra
      this._asmVerse.updateLOD(this.engine.camera, this._lodDistLow, this._lodDistHigh);
    };
  }

  _setupConfigModal() {
    // ── Overlay ──────────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'asm-modal-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0',
      'background:rgba(0,0,0,.65)',
      'backdrop-filter:blur(4px)',
      'display:none', 'align-items:center', 'justify-content:center',
      'z-index:200',
    ].join(';');
    overlay.addEventListener('pointerdown', e => {
      if (e.target === overlay) this._closeConfigModal();
    });

    // ── Modal ────────────────────────────────────────────────────────────────
    const modal = document.createElement('div');
    modal.style.cssText = [
      'width:80vw', 'max-height:80vh',
      `background:${C.bgDark}`, `border:1px solid ${C.border}`,
      'border-radius:4px',
      'display:flex', 'flex-direction:column',
      'overflow:hidden',
      'box-shadow:0 8px 32px rgba(0,0,0,.7)',
    ].join(';');

    // ── En-tête ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:10px 16px',
      `border-bottom:1px solid ${C.border}`,
      'flex-shrink:0',
    ].join(';');
    const htitle = document.createElement('span');
    htitle.textContent = 'Configuration';
    htitle.style.cssText = `color:${C.fg};font:bold 13px sans-serif;letter-spacing:.05em;`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `background:transparent;border:none;color:${C.dim};font-size:18px;cursor:pointer;padding:0 4px;line-height:1;`;
    closeBtn.addEventListener('click', () => this._closeConfigModal());
    header.append(htitle, closeBtn);

    // ── Corps (colonnes masonry) ─────────────────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = [
      'display:flex', 'flex-direction:row',
      'gap:14px', 'padding:16px',
      'overflow-y:auto', 'flex:1',
      'align-items:flex-start',
    ].join(';');
    this._configBody  = body;
    this._configCards = [];

    const cfg = this._loadConfig();

    // Helpers locaux
    const makeCard = label => {
      const card = document.createElement('div');
      card.style.cssText = [
        `background:${C.bg}`, `border:1px solid ${C.border}`,
        'border-radius:3px', 'padding:14px 16px',
        'min-width:220px', 'flex:1 1 220px',
      ].join(';');
      const h = document.createElement('div');
      h.textContent = label;
      h.style.cssText = `font-size:9px;color:${C.dim};text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;`;
      card.appendChild(h);
      return card;
    };

    const makeSelect = (label, options, value, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex-shrink:0;min-width:70px;`;
      const sel = document.createElement('select');
      sel.style.cssText = [
        'flex:1', `background:${C.bgDark}`, `color:${C.fg}`,
        `border:1px solid ${C.border}`, 'border-radius:2px',
        'padding:4px 6px', 'font-size:11px', 'cursor:pointer',
      ].join(';');
      for (const [val, txt] of options) {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = txt;
        if (val === value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      row.append(lbl, sel);
      return row;
    };

    const makeSlider = (label, min, max, step, init, onChange) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;`;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const sl = document.createElement('input');
      sl.type = 'range';
      sl.min = String(min); sl.max = String(max); sl.step = String(step);
      sl.value = String(init);
      sl.style.cssText = 'flex:1;cursor:pointer;accent-color:var(--asm-accent);';
      const fmt = v => Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2);
      const val = document.createElement('span');
      val.textContent = fmt(init);
      val.style.cssText = `color:var(--asm-accent);min-width:34px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;`;
      sl.addEventListener('input', () => { const v = parseFloat(sl.value); val.textContent = fmt(v); onChange(v); });
      row.append(sl, val);
      wrap.append(lbl, row);
      return wrap;
    };

    // ── Carte : Dock ─────────────────────────────────────────────────────────
    const dockCard = makeCard('Dock');

    const makeToggle = (label, init, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
      const track = document.createElement('div');
      let on = init;
      const update = () => {
        track.style.background = on ? C.accent : C.border;
        thumb.style.transform = on ? 'translateX(14px)' : 'translateX(0)';
      };
      track.style.cssText = [
        'width:28px', 'height:14px', 'border-radius:7px',
        'position:relative', 'cursor:pointer', 'flex-shrink:0',
        'transition:background .15s',
      ].join(';');
      const thumb = document.createElement('div');
      thumb.style.cssText = [
        'position:absolute', 'top:1px', 'left:1px',
        'width:12px', 'height:12px', 'border-radius:50%',
        'background:#fff', 'transition:transform .15s',
      ].join(';');
      track.appendChild(thumb);
      update();
      track.addEventListener('click', () => { on = !on; update(); onChange(on); });
      row.append(lbl, track);
      return row;
    };

    dockCard.append(
      makeSelect('Bord', [
        ['bottom','Bas'], ['top','Haut'], ['left','Gauche'], ['right','Droite'],
      ], this._dock._edge, v => { this._dock.setPosition(v, this._dock._align); this._dock.setInsets({ top: BAR_H }); this._saveConfig({ dockEdge: v }); }),
      makeSelect('Alignement', [
        ['center','Centre'], ['start','Début'], ['end','Fin'],
      ], this._dock._align, v => { this._dock.setPosition(this._dock._edge, v); this._dock.setInsets({ top: BAR_H }); this._saveConfig({ dockAlign: v }); }),
      makeToggle('Activer au tap extérieur', this._dock._activateOnOutsideTap,
        v => { this._dock.setActivateOnOutsideTap(v); this._saveConfig({ activateOnOutsideTap: v }); }),
    );
        this._configCards.push(dockCard);

    // ── Carte : Cellules ──────────────────────────────────────────────────────
    const cellCard = makeCard('Cellules');

    const makeColorRow = (label, init, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = init;
      inp.style.cssText = 'width:36px;height:24px;border:none;background:none;cursor:pointer;padding:0;';
      inp.addEventListener('input', () => onChange(inp.value));
      row.append(lbl, inp);
      return row;
    };

    const makeSectionLabel = txt => {
      const s = document.createElement('div');
      s.textContent = txt;
      s.style.cssText = [
        'font-size:9px', `color:${C.dim}`,
        'text-transform:uppercase', 'letter-spacing:.08em',
        'margin:8px 0 6px',
      ].join(';');
      return s;
    };

    const cellCfg = this._loadConfig();

    cellCard.append(makeSectionLabel('Inactif'));
    cellCard.append(makeColorRow('Fond', cellCfg.cellBgColor,
      v => { this._saveConfig({ cellBgColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Opacité fond', 0, 1, 0.05, cellCfg.cellBgOpacity,
      v => { this._saveConfig({ cellBgOpacity: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeToggle('Bordure', cellCfg.cellBorderVisible,
      v => { this._saveConfig({ cellBorderVisible: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Couleur bordure', cellCfg.cellBorderColor,
      v => { this._saveConfig({ cellBorderColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Épaisseur bordure', 0, 6, 0.5, cellCfg.cellBorderWidth,
      v => { this._saveConfig({ cellBorderWidth: v }); this._dock.setCellStyles(this._loadConfig()); }));

    cellCard.append(makeSectionLabel('Actif'));
    cellCard.append(makeColorRow('Fond', cellCfg.cellActiveBgColor,
      v => { this._saveConfig({ cellActiveBgColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Opacité fond', 0, 1, 0.05, cellCfg.cellActiveBgOpacity,
      v => { this._saveConfig({ cellActiveBgOpacity: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeToggle('Bordure', cellCfg.cellActiveBorderVisible,
      v => { this._saveConfig({ cellActiveBorderVisible: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Couleur bordure', cellCfg.cellActiveBorderColor,
      v => { this._saveConfig({ cellActiveBorderColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Épaisseur bordure', 0, 6, 0.5, cellCfg.cellActiveBorderWidth,
      v => { this._saveConfig({ cellActiveBorderWidth: v }); this._dock.setCellStyles(this._loadConfig()); }));

    cellCard.append(makeSectionLabel('Forme'));
    cellCard.append(makeSlider('Border radius', 0, 30, 1, cellCfg.cellBorderRadius,
      v => { this._saveConfig({ cellBorderRadius: v }); this._dock.setCellStyles(this._loadConfig()); }));

    cellCard.append(makeSectionLabel('Label'));
    cellCard.append(makeToggle('Visible', cellCfg.cellLabelVisible,
      v => { this._saveConfig({ cellLabelVisible: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Fond', cellCfg.cellLabelBgColor,
      v => { this._saveConfig({ cellLabelBgColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Opacité fond', 0, 1, 0.05, cellCfg.cellLabelBgOpacity,
      v => { this._saveConfig({ cellLabelBgOpacity: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Couleur police', cellCfg.cellLabelColor,
      v => { this._saveConfig({ cellLabelColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Taille police', 5, 20, 1, cellCfg.cellLabelFontSize,
      v => { this._saveConfig({ cellLabelFontSize: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Sensibilité rotation', 0.1, 5, 0.1, cellCfg.cellRotateSpeed ?? 1.5,
      v => { this._saveConfig({ cellRotateSpeed: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Cellule inactive (px)', 60, 200, 5, cellCfg.cellSize ?? 110,
      v => { this._saveConfig({ cellSize: v }); this._dock.setCellSizes(v, this._loadConfig().cellActiveSize ?? 190); }));
    cellCard.append(makeSlider('Cellule active (px)', 100, 320, 5, cellCfg.cellActiveSize ?? 190,
      v => { this._saveConfig({ cellActiveSize: v }); this._dock.setCellSizes(this._loadConfig().cellSize ?? 110, v); }));

        this._configCards.push(cellCard);

    // ── Carte : Stack ─────────────────────────────────────────────────────────
    const stackCard = makeCard('Stack');
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Vider la pile';
    clearBtn.style.cssText = [
      'width:100%', 'padding:6px 10px', 'margin-top:4px',
      `background:${C.bgDark}`, `border:1px solid ${C.border}`,
      `color:${C.dim}`, 'border-radius:2px', 'font-size:10px',
      'cursor:pointer', 'text-align:center',
    ].join(';');
    clearBtn.addEventListener('click', () => this._dock.clearStack());
    stackCard.append(
      makeToggle('Persistance', this._loadConfig().stackPersist,
        v => { this._dock.setStackPersist(v); this._saveConfig({ stackPersist: v }); }),
      clearBtn,
    );
        this._configCards.push(stackCard);

    // ── Carte : World Slots ───────────────────────────────────────────────────
    const wsCard = makeCard('World Slots');
    wsCard.append(
      makeSlider('Plan Y', -2, 5, 0.05, this._asmVerse.worldSlots.planY, v => { this._asmVerse.worldSlots.planY = v; this._saveConfig({ planY: v }); }),
      makeSlider('Rayon snap', 0.3, 4, 0.1, this._asmVerse.worldSlots.snapR, v => { this._asmVerse.worldSlots.snapR = v; this._saveConfig({ snapR: v }); }),
      makeToggle('Plan visible', this._asmVerse.worldSlots.planMesh?.visible ?? true,
        v => { if (this._asmVerse.worldSlots.planMesh) this._asmVerse.worldSlots.planMesh.visible = v; this._saveConfig({ planVisible: v }); }),
      makeToggle('Sol visible', this._floor?.mesh.visible ?? true,
        v => { if (this._floor) this._floor.mesh.visible = v; this._saveConfig({ floorVisible: v }); }),
    );
        this._configCards.push(wsCard);

    // ── Carte : LOD ──────────────────────────────────────────────────────────
    const lodCard = makeCard('LOD (Level of Detail)');
    lodCard.append(makeSlider('Dist. high → med', 1, 20, 0.5, cfg.lodDistHigh ?? 3,
      v => { this._saveConfig({ lodDistHigh: v }); this._lodDistHigh = v; }));
    lodCard.append(makeSlider('Dist. med → low', 5, 50, 1, cfg.lodDistLow ?? 12,
      v => { this._saveConfig({ lodDistLow: v }); this._lodDistLow = v; }));
        this._configCards.push(lodCard);

    // ── Carte : Asm Helpers ───────────────────────────────────────────────────
    const helpersCard = makeCard('Asm Helpers');

    const makeStepsInput = (label, hint, initSteps, onHint, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
      const hintEl = document.createElement('span');
      hintEl.textContent = onHint(initSteps);
      hintEl.style.cssText = `color:${C.dim};font-size:9px;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;`;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.step = '1';
      inp.value = String(initSteps);
      inp.style.cssText = [
        'width:52px', `background:${C.bgDark}`, `color:${C.fg}`,
        `border:1px solid ${C.border}`, 'border-radius:2px',
        'padding:3px 6px', 'font-size:11px', 'text-align:right',
        'font-variant-numeric:tabular-nums',
      ].join(';');
      inp.addEventListener('change', () => {
        const v = Math.max(1, parseInt(inp.value) || 1);
        inp.value = String(v);
        hintEl.textContent = onHint(v);
        onChange(v);
      });
      row.append(lbl, hintEl, inp);
      return row;
    };

    // ── Sélecteur solveur ─────────────────────────────────────────────────────
    const solverRow = document.createElement('div');
    solverRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const solverLbl = document.createElement('span');
    solverLbl.textContent = 'Solveur briques';
    solverLbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
    const solverSel = document.createElement('select');
    solverSel.style.cssText = [
      `background:${C.bgDark}`, `color:${C.fg}`,
      `border:1px solid ${C.border}`, 'border-radius:2px',
      'padding:3px 6px', 'font-size:11px',
    ].join(';');
    [['physics', 'Physique'], ['asm', 'Assemblage']].forEach(([val, txt]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = txt;
      if ((cfg.involvedBricksSolver ?? 'physics') === val) opt.selected = true;
      solverSel.appendChild(opt);
    });
    solverSel.addEventListener('change', () =>
      this._saveConfig({ involvedBricksSolver: solverSel.value }));
    solverRow.append(solverLbl, solverSel);

    // ── Tolérance de connexion ────────────────────────────────────────────────
    const tolRow = document.createElement('div');
    tolRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const tolLbl = document.createElement('span');
    tolLbl.textContent = 'Tolérance connexion';
    tolLbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
    const tolInp = document.createElement('input');
    tolInp.type = 'number'; tolInp.min = '0.01'; tolInp.max = '2'; tolInp.step = '0.01';
    tolInp.value = String(cfg.connectionTolerance ?? 0.12);
    tolInp.style.cssText = [
      'width:60px', `background:${C.bgDark}`, `color:${C.fg}`,
      `border:1px solid ${C.border}`, 'border-radius:2px',
      'padding:3px 6px', 'font-size:11px', 'text-align:right',
      'font-variant-numeric:tabular-nums',
    ].join(';');
    const tolUnit = document.createElement('span');
    tolUnit.textContent = 'm';
    tolUnit.style.cssText = `color:${C.dim};font-size:9px;`;
    tolInp.addEventListener('change', () => {
      const v = Math.max(0.01, Math.min(2, parseFloat(tolInp.value) || 0.12));
      tolInp.value = v.toFixed(2);
      this._saveConfig({ connectionTolerance: v });
      this._asmVerse.slots.clipDist = v;
    });
    tolRow.append(tolLbl, tolInp, tolUnit);

    // ── Couleur fond bandeau DOF ────────────────────────────────────────────
    const stripBgRow = document.createElement('div');
    stripBgRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const stripBgLbl = document.createElement('span');
    stripBgLbl.textContent = 'Fond bandeau';
    stripBgLbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
    const stripBgInp = document.createElement('input');
    stripBgInp.type = 'color';
    stripBgInp.value = cfg.stripBgColor ?? '#121218';
    stripBgInp.style.cssText = 'width:32px;height:24px;border:none;cursor:pointer;background:transparent;';
    stripBgInp.addEventListener('input', () => {
      this._saveConfig({ stripBgColor: stripBgInp.value });
      this._applyStripStyle();
    });
    stripBgRow.append(stripBgLbl, stripBgInp);

    // ── Opacité fond bandeau DOF ─────────────────────────────────────────────
    const stripOpRow = document.createElement('div');
    stripOpRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const stripOpLbl = document.createElement('span');
    stripOpLbl.textContent = 'Opacité fond';
    stripOpLbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
    const stripOpVal = document.createElement('span');
    stripOpVal.style.cssText = `color:${C.dim};font-size:9px;min-width:30px;text-align:right;`;
    stripOpVal.textContent = Math.round((cfg.stripBgOpacity ?? 0.6) * 100) + '%';
    const stripOpInp = document.createElement('input');
    stripOpInp.type = 'range'; stripOpInp.min = '0'; stripOpInp.max = '100'; stripOpInp.step = '5';
    stripOpInp.value = String(Math.round((cfg.stripBgOpacity ?? 0.6) * 100));
    stripOpInp.style.cssText = 'width:80px;cursor:pointer;';
    stripOpInp.addEventListener('input', () => {
      const v = parseInt(stripOpInp.value) / 100;
      stripOpVal.textContent = stripOpInp.value + '%';
      this._saveConfig({ stripBgOpacity: v });
      this._applyStripStyle();
    });
    stripOpRow.append(stripOpLbl, stripOpInp, stripOpVal);

    // ── Couleur police bandeau DOF ───────────────────────────────────────────
    const stripFontRow = document.createElement('div');
    stripFontRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const stripFontLbl = document.createElement('span');
    stripFontLbl.textContent = 'Police bandeau';
    stripFontLbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
    const stripFontInp = document.createElement('input');
    stripFontInp.type = 'color';
    stripFontInp.value = cfg.stripFontColor ?? '#cccccc';
    stripFontInp.style.cssText = 'width:32px;height:24px;border:none;cursor:pointer;background:transparent;';
    stripFontInp.addEventListener('input', () => {
      this._saveConfig({ stripFontColor: stripFontInp.value });
      this._applyStripStyle();
    });
    stripFontRow.append(stripFontLbl, stripFontInp);

    helpersCard.append(
      makeStepsInput(
        'Rotation (étapes)', '',
        cfg.asmHelperStepsRot ?? 16,
        n => `${(360 / n).toFixed(2)}°`,
        v => this._saveConfig({ asmHelperStepsRot: v }),
      ),
      makeStepsInput(
        'Translation (étapes)', '',
        cfg.asmHelperStepsTrans ?? 20,
        n => `÷ ${n}`,
        v => this._saveConfig({ asmHelperStepsTrans: v }),
      ),
      makeSlider('Piqueurs Brique/Composant (⌀)', 0.1, 1, 0.02, cfg.pickerDiam ?? 0.32, v => {
        this._saveConfig({ pickerDiam: v });
      }),
      makeSlider('Piqueurs Articuler (⌀)', 0.5, 2, 0.05, cfg.articulatePickerDiam ?? 0.6, v => {
        this._saveConfig({ articulatePickerDiam: v });
        // Mettre à jour les sphères si le mode articuler est actif
        if (this._mode === 'articulate' && this._articulateState) {
          const r = v / 2;
          for (const p of this._liaisonPickers) {
            p.mesh.geometry.dispose();
            p.mesh.geometry = new THREE.SphereGeometry(r, 12, 10);
          }
        }
      }),
      solverRow,
      tolRow,
      stripBgRow,
      stripOpRow,
      stripFontRow,
    );
        this._configCards.push(helpersCard);

    // ── Carte : Thème ────────────────────────────────────────────────────────
    const themeCard = makeCard('Thème');
    const themeStyle = document.createElement('style');
    document.head.appendChild(themeStyle);
    this._ui.push(themeStyle);

    const accents = [
      ['#7aafc8', 'Acier'],
      ['#6abf8a', 'Jade'],
      ['#d4884a', 'Forge'],
      ['#9b7fc8', 'Violet'],
      ['#c87a7a', 'Brique'],
    ];
    const swatchRow = document.createElement('div');
    swatchRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';
    let currentAccent = this._loadConfig().accent;
    if (currentAccent !== C.accent) themeStyle.textContent = `:root { --asm-accent: ${currentAccent}; }`;
    for (const [color, name] of accents) {
      const sw = document.createElement('button');
      sw.title = name;
      sw.style.cssText = [
        `background:${color}`, 'width:32px', 'height:32px',
        'border-radius:50%', 'cursor:pointer',
        `border:2px solid ${color === currentAccent ? '#fff' : 'transparent'}`,
        'transition:border-color .15s',
      ].join(';');
      sw.addEventListener('click', () => {
        currentAccent = color;
        themeStyle.textContent = `:root { --asm-accent: ${color}; }`;
        swatchRow.querySelectorAll('button').forEach(b => { b.style.borderColor = 'transparent'; });
        sw.style.borderColor = '#fff';
        this._saveConfig({ accent: color });
      });
      swatchRow.append(sw);
    }
    themeCard.append(swatchRow);
        this._configCards.push(themeCard);

    // ── Carte : Scène ─────────────────────────────────────────────────────────
    const sceneCard = makeCard('Scène');
    const makeActionBtn = (label, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = [
        'width:100%', 'padding:6px 10px', 'margin-bottom:6px',
        `background:${C.bgDark}`, `border:1px solid ${C.border}`,
        `color:${C.fg}`, 'border-radius:2px', 'font-size:10px',
        'cursor:pointer', 'text-align:left',
      ].join(';');
      btn.addEventListener('click', onClick);
      return btn;
    };
    const resetBtn = makeActionBtn('Réinitialiser la scène', () => {
      this._closeConfigModal();
      this._clearAll();
    });
    resetBtn.style.color = '#e07070';
    resetBtn.style.borderColor = '#884444';
    sceneCard.append(
      makeActionBtn('Exporter (.json)', () => { this._closeConfigModal(); this._exportScene(); }),
      makeActionBtn('Importer (.json)', () => { this._closeConfigModal(); this._importScene(); }),
      resetBtn,
    );
        this._configCards.push(sceneCard);

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._ui.push(overlay);
    this._configOverlay = overlay;

    // Re-layout si le corps est redimensionné (rotation écran, resize fenêtre)
    new ResizeObserver(() => {
      if (overlay.style.display !== 'none') this._layoutConfigCards();
    }).observe(body);
  }

  /** Masonry greedy : répartit les cartes dans N colonnes, la plus courte en premier. */
  _layoutConfigCards() {
    const body  = this._configBody;
    const cards = this._configCards;
    if (!body || !cards?.length) return;

    const GAP       = 14;
    const MIN_COL_W = 240;
    const colCount  = Math.max(1, Math.floor((body.clientWidth + GAP) / (MIN_COL_W + GAP)));

    body.innerHTML = '';
    const cols = Array.from({ length: colCount }, () => {
      const col = document.createElement('div');
      col.style.cssText = `display:flex;flex-direction:column;gap:${GAP}px;flex:1;min-width:0;`;
      body.appendChild(col);
      return col;
    });

    // Greedy : chaque carte va dans la colonne la plus courte à cet instant
    for (const card of cards) {
      let minH = Infinity, target = cols[0];
      for (const col of cols) {
        if (col.scrollHeight < minH) { minH = col.scrollHeight; target = col; }
      }
      target.appendChild(card);
    }
  }

  _openConfigModal() {
    if (!this._configOverlay) return;
    this._configOverlay.style.display = 'flex';
    // Layout après affichage (clientWidth disponible seulement une fois visible)
    requestAnimationFrame(() => this._layoutConfigCards());
  }

  _closeConfigModal() {
    if (this._configOverlay) this._configOverlay.style.display = 'none';
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  _clearAll() {
    this._removeDockGhost();
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    this._asmVerse.clear();
    this._updateCount();
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────────────

  // Assemble instA (brique saisie) sur instB (brique cible) après un drag-drop scène→scène
  _connectDrag(instA, grabX, grabY, instB, dropX, dropY) {
    const grabPt = this._stackCandidate?.grabPt ?? null;
    const conn = this._asmVerse.connectDrag(instA, grabX, grabY, instB, dropX, dropY, this.engine.camera, grabPt);
    if (conn) {
      this._showSnapHelper(instA.mesh.position.clone());
      this._updateCount();
      return true;
    }
    this._asmVerse._solver.diagnose(
      this._asmVerse.slots.nearSlotsOf(instA, grabX, grabY, this.engine.camera, false, null, grabPt),
      this._asmVerse.slots.nearSlotsOf(instB, dropX, dropY, this.engine.camera),
      this._asmVerse.slots.typeIds
    );
    return false;
  }

  _removeFromScene(inst) {
    // Nettoyage AsmHandlers (UI, reste dans l'Assembler)
    if (this._asmHandlers) {
      const conn = this._asmHandlers.conn;
      if (conn && (conn.instA === inst || conn.instB === inst)) {
        this._asmHandlers.detach();
        this._asmHandlers = null;
      }
    }
    if (this._selectedBrick === inst) this._selectBrick(null);
    this._asmVerse.removeBrick(inst);
    this._updateCount();
  }

  _isOverScreenSlot(cx, cy) {
    if (!this._dock?.el) return false;
    const rect = this._dock.el.getBoundingClientRect();
    return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
  }

  _isOverUI(target) {
    return target.closest?.('.brick-dock, .asm-bar, .asm-artic-bar, .asm-modal-overlay, .asm-panel, .asm-dof-strip');
  }

  _updateCount() {
    if (this._countEl) this._countEl.textContent = `Briques : ${this._asmVerse.bricks.size}`;
    this._saveScene();
    for (const name of ['bricks', 'components', 'joints', 'state']) {
      const p = this._panels?.[name];
      if (p?.style.display === 'flex') this._refreshPanel(name);
    }
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }

  // ─── Panels flottants (briques / composantes) ─────────────────────────────

  _togglePanel(name) {
    if (!this._panels) this._panels = {};
    if (!this._panels[name]) {
      this._panels[name] = this._createPanel(name);
      if (name === 'joints') this._initJointsHeaderToggle(this._panels[name]);
    }
    const p = this._panels[name];
    const open = p.style.display === 'none' || !p.style.display;
    p.style.display = open ? 'flex' : 'none';
    if (open) this._refreshPanel(name);
  }

  _createPanel(name) {
    const widths = { state: 'min(240px,85vw)', bricks: 'min(320px,90vw)', components: 'min(320px,90vw)' };
    const panel = document.createElement('div');
    panel.className = 'asm-panel';
    if (name === 'kingraph') {
      panel.style.cssText = [
        'position:fixed', `top:${BAR_H + BAR_ARTIC_H}px`, 'bottom:0', 'left:0', 'right:0',
        `background:${C.bgDark}f2`,
        `border-top:1px solid ${C.border}`,
        'display:none', 'flex-direction:column',
        'z-index:52', 'pointer-events:auto',
        'font:11px sans-serif',
      ].join(';');
    } else {
      panel.style.cssText = [
        'position:fixed',
        `top:${BAR_H}px`, 'right:0',
        `width:${widths[name] || 'min(320px,90vw)'}`, 'max-height:calc(100dvh - ' + BAR_H + 'px)',
        `background:${C.bgDark}ee`,
        `border-left:1px solid ${C.border}`,
        `border-bottom:1px solid ${C.border}`,
        'display:none', 'flex-direction:column',
        'z-index:52', 'pointer-events:auto',
        'font:11px sans-serif',
      ].join(';');
    }

    // En-tête
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:6px 10px', 'flex-shrink:0',
      `border-bottom:1px solid ${C.border}`,
    ].join(';');
    const title = document.createElement('span');
    title.style.cssText = `color:${C.dim};font-size:9px;text-transform:uppercase;letter-spacing:.1em;`;
    const panelTitles = { bricks: 'Briques', components: 'Composantes', joints: 'Liaisons', state: 'État interne', catalogue: 'Catalogue', bom: 'Nomenclature', kingraph: 'Graphe cinématique' };
    title.textContent = panelTitles[name] ?? name;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `background:transparent;border:none;color:${C.dim};font-size:14px;cursor:pointer;padding:0 2px;line-height:1;`;
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    header.append(title, closeBtn);
    panel._header = header;

    // Corps scrollable
    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;padding:8px 0;';
    panel._body = body;

    panel.append(header, body);
    document.body.appendChild(panel);
    this._ui.push(panel);
    return panel;
  }

  _refreshPanel(name) {
    const panel = this._panels?.[name];
    if (!panel) return;
    const body = panel._body;
    body.innerHTML = '';

    if (name === 'bricks')           this._fillBricksPanel(body);
    else if (name === 'joints')    { this._syncJointsHeaderToggle(panel); this._fillJointsPanel(body); }
    else if (name === 'state')       this._fillStatePanel(body);
    else if (name === 'catalogue')   this._fillCataloguePanel(body);
    else if (name === 'bom')         this._fillBomPanel(body);
    else if (name === 'kingraph')    this._fillKinGraphPanel(body);
    else                             this._fillComponentsPanel(body);
  }

  _fillBricksPanel(body) {
    if (!this._asmVerse.bricks.size) {
      body.appendChild(this._panelEmpty('Aucune brique dans la scène'));
      return;
    }
    for (const inst of this._asmVerse.bricks.values()) {
      const conns = inst.connections.length;
      const isSelected = inst === this._selectedBrick;
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:5px 12px',
        `border-bottom:1px solid ${C.border}22`,
        `background:${isSelected ? C.accent + '22' : 'transparent'}`,
        `border-left:2px solid ${isSelected ? C.accent : 'transparent'}`,
      ].join(';');

      // Pastille couleur brique
      const swatch = document.createElement('span');
      swatch.style.cssText = [
        'width:10px', 'height:10px', 'border-radius:2px', 'flex-shrink:0',
        `background:${inst.brickData.color || '#888'}`,
        `border:1px solid ${C.border}`,
      ].join(';');

      // Nom + id
      const info = document.createElement('span');
      info.style.cssText = `flex:1;color:${C.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      info.textContent = inst.brickData.name || inst.brickTypeId;

      // Compteur de connexions
      const badge = document.createElement('span');
      badge.style.cssText = `color:${conns ? C.accent : C.dim};flex-shrink:0;`;
      badge.textContent = conns ? `${conns} ⇄` : '—';

      row.append(swatch, info, badge);
      body.appendChild(row);
    }
  }

  _fillBomPanel(body) {
    if (!this._asmVerse.bricks.size) {
      body.appendChild(this._panelEmpty('Aucune brique dans la scène'));
      return;
    }
    // Compter les occurrences par type
    const counts = new Map(); // brickTypeId → { name, color, count, ng }
    for (const inst of this._asmVerse.bricks.values()) {
      const id = inst.brickTypeId;
      if (!counts.has(id)) {
        counts.set(id, { name: inst.brickData.name || id, color: inst.brickData.color || '#888', count: 0, ng: inst.ng });
      }
      counts.get(id).count++;
    }
    // Trier par count décroissant puis par nom
    const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
    const total = this._asmVerse.bricks.size;

    for (const [, entry] of sorted) {
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:5px 12px',
        `border-bottom:1px solid ${C.border}22`,
      ].join(';');

      const swatch = document.createElement('span');
      swatch.style.cssText = [
        'width:10px', 'height:10px', 'border-radius:2px', 'flex-shrink:0',
        `background:${entry.color}`,
        `border:1px solid ${C.border}`,
      ].join(';');

      const name = document.createElement('span');
      name.style.cssText = `flex:1;color:${C.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      name.textContent = entry.name;

      const count = document.createElement('span');
      count.style.cssText = `color:${C.accent};flex-shrink:0;font-variant-numeric:tabular-nums;`;
      count.textContent = `×${entry.count}`;

      if (entry.ng) {
        const badge = document.createElement('span');
        badge.style.cssText = `font:700 8px sans-serif;color:#2e2e2e;background:#88cc88;border-radius:2px;padding:1px 4px;flex-shrink:0;letter-spacing:.04em;`;
        badge.textContent = 'NG';
        badge.title = 'Nouvelle génération — CSG embarqué';
        row.append(swatch, name, badge, count);
      } else {
        row.append(swatch, name, count);
      }
      body.appendChild(row);
    }

    // Ligne total
    const totalRow = document.createElement('div');
    totalRow.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:6px 12px',
      `border-top:1px solid ${C.border}`,
      `color:${C.dim}`, 'font-size:10px',
    ].join(';');
    totalRow.innerHTML = `<span>${sorted.length} type${sorted.length > 1 ? 's' : ''}</span><span style="color:${C.accent}">${total} pièce${total > 1 ? 's' : ''}</span>`;
    body.appendChild(totalRow);
  }

  _fillKinGraphPanel(body) {
    // ── Données ───────────────────────────────────────────────────────────────
    const components = this._articulateState?.components
      ?? this._asmVerse.computeComponents();

    if (components.length === 0) {
      body.appendChild(this._panelEmpty('Aucune classe dans la scène'));
      return;
    }

    const palette = Assembler.ARTIC_PALETTE;
    const colorMap = this._articulateState?.colorMap ?? this._graphColor(components);

    // Nœuds
    const nodes = components.map((comp, i) => {
      const ci  = colorMap.get(comp) ?? 0;
      const hex = palette[ci % palette.length];
      const rv  = ((hex >> 16) & 255), gv = ((hex >> 8) & 255), bv = (hex & 255);
      const names = [...comp.bricks].map(br => br.brickData?.name || br.brickTypeId);
      const label = names.length === 1 ? (names[0] || '?') : `${names.length} br.`;
      return { comp, i, x: 0, y: 0, color: `rgb(${rv},${gv},${bv})`, label };
    });
    const nodeFor = comp => nodes.find(n => n.comp === comp);

    // Arêtes dédupliquées (1 entrée par paire, DOF abrégé)
    const edgeMap = new Map();
    const dofAbbr = dof => (dof || []).map(d => {
      const t = d.type;
      if (t === 'rotation')    return 'R';
      if (t === 'translation') return 'T';
      if (t === 'ball')        return 'Rot';
      if (t === 'cylindrical') return 'Cyl';
      return (t?.[0] ?? '?').toUpperCase();
    }).join('+') || '?';

    for (const comp of components) {
      const nA = nodeFor(comp);
      for (const { connection: conn, other } of comp.links) {
        const nB = nodeFor(other);
        if (!nA || !nB) continue;
        const key = nA.i < nB.i ? `${nA.i}-${nB.i}` : `${nB.i}-${nA.i}`;
        if (!edgeMap.has(key)) edgeMap.set(key, { source: nA, target: nB, dofs: [], fullName: '' });
        const abbr = dofAbbr(conn.liaison?.dof);
        if (!edgeMap.get(key).dofs.includes(abbr)) edgeMap.get(key).dofs.push(abbr);
        if (!edgeMap.get(key).fullName) edgeMap.get(key).fullName = conn.liaison?.name || '';
      }
    }
    const edges = [...edgeMap.values()];

    // ── Détection de cycles (DFS, non-orienté) ────────────────────────────────
    const cycleEdgeKeys = new Set();
    {
      const visited = new Set(), inStack = new Set();
      const dfs = (node, parentKey) => {
        visited.add(node.i); inStack.add(node.i);
        for (const e of edges) {
          const nb = e.source === node ? e.target : e.target === node ? e.source : null;
          if (!nb) continue;
          const eKey = node.i < nb.i ? `${node.i}-${nb.i}` : `${nb.i}-${node.i}`;
          if (eKey === parentKey) continue;
          if (inStack.has(nb.i)) cycleEdgeKeys.add(eKey);
          else if (!visited.has(nb.i)) dfs(nb, eKey);
        }
        inStack.delete(node.i);
      };
      for (const n of nodes) if (!visited.has(n.i)) dfs(n, null);
    }

    // ── Layout BFS hiérarchique ───────────────────────────────────────────────
    // Racine = classe de référence, ou nœud de degré max, ou extrémité de chaîne (degré 1)
    const degOf = nd => edges.filter(e => e.source === nd || e.target === nd).length;
    const refNode = nodes.find(n => n.comp === this._articulateState?.refClass);
    const leafNode = nodes.find(n => degOf(n) <= 1) ?? nodes[0];
    const bfsRoot = refNode ?? leafNode;

    const levelOf  = new Map(); // node.i → level index
    const bfsRows  = [];        // bfsRows[level] = [node, ...]
    const bfsVisit = new Set([bfsRoot.i]);
    let bfsQueue   = [bfsRoot];
    while (bfsQueue.length) {
      const lvl = bfsRows.length;
      bfsRows.push([...bfsQueue]);
      bfsQueue.forEach(n => levelOf.set(n.i, lvl));
      const next = [];
      for (const nd of bfsQueue) {
        for (const e of edges) {
          const nb = e.source === nd ? e.target : e.target === nd ? e.source : null;
          if (nb && !bfsVisit.has(nb.i)) { bfsVisit.add(nb.i); next.push(nb); }
        }
      }
      bfsQueue = next;
    }
    // Nœuds non atteints (composantes déconnectées)
    for (const nd of nodes) {
      if (!bfsVisit.has(nd.i)) { bfsRows.push([nd]); levelOf.set(nd.i, bfsRows.length - 1); }
    }

    // Dimensions adaptatives
    const W        = window.innerWidth;
    const availH   = window.innerHeight - BAR_H - BAR_ARTIC_H - 44; // 44 = header panel + résumé
    const NR       = Math.max(22, Math.min(42, Math.floor(W / Math.max(nodes.length, 1) / 1.8)));
    const PAD_X    = NR + 6;
    const PAD_Y    = NR + 10;
    const STEP_X   = NR * 2.6;

    // Pour chaque niveau, si trop de nœuds → déborder sur plusieurs lignes de rendu
    const maxPerRow  = Math.max(1, Math.floor((W - PAD_X * 2) / STEP_X));
    const renderRows = bfsRows.flatMap(lvlNodes => {
      const rows = [];
      for (let i = 0; i < lvlNodes.length; i += maxPerRow) rows.push(lvlNodes.slice(i, i + maxPerRow));
      return rows;
    });

    // STEP_Y : étirer pour occuper toute la hauteur disponible (plafonné à NR*5 pour ne pas être absurde)
    const nGaps  = Math.max(1, renderRows.length - 1);
    const STEP_Y = renderRows.length <= 1
      ? NR * 3.4
      : Math.min(NR * 5, Math.max(NR * 3.0, (availH - PAD_Y * 2) / nGaps));
    const H      = PAD_Y * 2 + nGaps * STEP_Y;

    // Placer les nœuds
    renderRows.forEach((row, ri) => {
      const rowW = row.length * STEP_X;
      const x0   = (W - rowW) / 2 + STEP_X / 2;
      row.forEach((nd, ci) => {
        nd.x = x0 + ci * STEP_X;
        nd.y = PAD_Y + ri * STEP_Y;
      });
    });

    // ── SVG ──────────────────────────────────────────────────────────────────
    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.cssText = `width:100%;height:${H}px;min-height:100%;display:block;flex-shrink:0;`;

    const mk = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };

    // Defs
    const defs = mk('defs', {});
    const mkMarker = (id, color) => {
      const m = mk('marker', { id, markerWidth: '7', markerHeight: '5', refX: '6', refY: '2.5', orient: 'auto' });
      m.appendChild(mk('path', { d: 'M0,0 L7,2.5 L0,5 Z', fill: color }));
      return m;
    };
    defs.appendChild(mkMarker('arr-n', '#777777'));
    defs.appendChild(mkMarker('arr-c', '#f06292'));
    // Halo texte
    const flt = mk('filter', { id: 'halo', x: '-30%', y: '-50%', width: '160%', height: '200%' });
    const feM = mk('feMorphology', { operator: 'dilate', radius: '1.5', in: 'SourceGraphic', result: 'exp' });
    const feF = mk('feFlood', { 'flood-color': C.bgDark, 'flood-opacity': '0.9', result: 'col' });
    const feC = mk('feComposite', { in: 'col', in2: 'exp', operator: 'in', result: 'h' });
    const feMe = mk('feMerge', {});
    feMe.append(mk('feMergeNode', { in: 'h' }), mk('feMergeNode', { in: 'SourceGraphic' }));
    flt.append(feM, feF, feC, feMe);
    defs.appendChild(flt);
    svg.appendChild(defs);

    svg.appendChild(mk('rect', { x: 0, y: 0, width: W, height: H, fill: C.bgDark + 'dd' }));

    // ── Arêtes ────────────────────────────────────────────────────────────────
    const edgeLabels = [];
    for (const e of edges) {
      const key     = e.source.i < e.target.i ? `${e.source.i}-${e.target.i}` : `${e.target.i}-${e.source.i}`;
      const isCycle = cycleEdgeKeys.has(key);
      const stroke  = isCycle ? '#f06292' : '#666666';

      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const x1 = e.source.x + NR * dx / d, y1 = e.source.y + NR * dy / d;
      const x2 = e.target.x - (NR + 4) * dx / d, y2 = e.target.y - (NR + 4) * dy / d;

      // Courber les arêtes de cycle vers l'extérieur pour éviter le chevauchement
      const perp = isCycle ? 0.28 : 0;
      const cx   = (x1 + x2) / 2 - perp * dy;
      const cy_  = (y1 + y2) / 2 + perp * dx;
      const pathD = perp
        ? `M ${x1} ${y1} Q ${cx} ${cy_} ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x2} ${y2}`;

      svg.appendChild(mk('path', {
        d: pathD, stroke, 'stroke-width': isCycle ? 2.5 : 1.8, fill: 'none',
        'stroke-dasharray': isCycle ? '6 3' : 'none',
        'marker-end': `url(#${isCycle ? 'arr-c' : 'arr-n'})`,
      }));
      // Position du label = milieu du chemin
      const lx = perp ? cx : (x1 + x2) / 2;
      const ly = perp ? cy_ : (y1 + y2) / 2;
      edgeLabels.push({ e, key, isCycle, stroke, lx, ly });
    }

    // ── Nœuds ─────────────────────────────────────────────────────────────────
    const FS    = Math.max(9, Math.min(13, NR * 0.44));
    const FSSub = Math.max(8, Math.min(10, NR * 0.32));

    for (const nd of nodes) {
      const isRef = this._articulateState?.refClass === nd.comp;
      const cnt   = nd.comp.bricks.size;

      if (isRef) svg.appendChild(mk('circle', { cx: nd.x, cy: nd.y, r: NR + 7, fill: 'none', stroke: '#ffffff', 'stroke-width': '2', opacity: '0.3' }));

      svg.appendChild(mk('circle', {
        cx: nd.x, cy: nd.y, r: NR,
        fill: nd.color, stroke: isRef ? '#ffffff' : '#00000033', 'stroke-width': isRef ? 2 : 1, opacity: '0.95',
      }));

      if (cnt > 1) svg.appendChild(mk('circle', { cx: nd.x, cy: nd.y, r: NR - 5, fill: 'none', stroke: '#ffffff33', 'stroke-width': '1.5' }));

      if (isRef) {
        const a = mk('text', { x: nd.x + NR - 1, y: nd.y - NR + 7, 'font-size': String(FSSub + 1), 'text-anchor': 'middle', fill: '#fff' });
        a.textContent = '⚓'; svg.appendChild(a);
      }

      // Label (1 ou 2 lignes)
      const maxCh = Math.max(5, Math.floor(NR * 1.5 / (FS * 0.55)));
      const short = nd.label.length > maxCh ? nd.label.slice(0, maxCh - 1) + '…' : nd.label;
      const yBase = cnt > 1 ? nd.y - FS * 0.4 : nd.y;
      const tName = mk('text', {
        x: nd.x, y: yBase, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': String(FS), 'font-weight': 'bold', fill: '#fff',
        style: 'pointer-events:none', filter: 'url(#halo)',
      });
      tName.textContent = short;
      svg.appendChild(tName);

      if (cnt > 1) {
        const tCnt = mk('text', {
          x: nd.x, y: nd.y + FS * 0.8,
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': String(FSSub), fill: '#ffffffbb', style: 'pointer-events:none',
        });
        tCnt.textContent = `×${cnt}`;
        svg.appendChild(tCnt);
      }
    }

    // ── Labels d'arêtes (DOF abrégé, nom complet en title) ────────────────────
    const FSE = Math.max(8, Math.min(11, NR * 0.34));
    for (const { e, isCycle, stroke, lx, ly } of edgeLabels) {
      const shortDof = e.dofs.join(' | ');
      const grp = mk('g', {});
      // Fond pill
      const pill = mk('rect', {
        x: lx - shortDof.length * FSE * 0.32 - 4, y: ly - FSE * 0.7 - 1,
        width: shortDof.length * FSE * 0.64 + 8, height: FSE * 1.5,
        rx: '3', fill: isCycle ? '#f0629222' : C.bgDark + 'cc',
        stroke: isCycle ? '#f06292' : '#44444488', 'stroke-width': '0.8',
      });
      grp.appendChild(pill);
      const t = mk('text', {
        x: lx, y: ly, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': String(FSE), fill: isCycle ? '#f06292' : '#aaaaaa',
        style: 'pointer-events:none',
      });
      t.textContent = shortDof;
      // Tooltip : nom complet
      if (e.fullName) { const title = mk('title', {}); title.textContent = e.fullName; t.appendChild(title); }
      grp.appendChild(t);
      svg.appendChild(grp);
    }

    body.style.cssText = 'overflow-y:auto;flex:1;display:flex;flex-direction:column;';
    body.appendChild(svg);

    // ── Résumé ────────────────────────────────────────────────────────────────
    const summary = document.createElement('div');
    summary.style.cssText = `padding:5px 14px;flex-shrink:0;border-top:1px solid ${C.border}33;color:${C.dim};font-size:10px;display:flex;gap:20px;flex-wrap:wrap;align-items:center;`;
    const totalDof = edges.reduce((s, e) => s + e.dofs.length, 0);
    summary.innerHTML = [
      `<span>Classes : <b style="color:${C.fg}">${nodes.length}</b></span>`,
      `<span>Liaisons : <b style="color:${C.accent}">${totalDof}</b></span>`,
      cycleEdgeKeys.size
        ? `<span style="color:#f06292">⬡ ${cycleEdgeKeys.size} boucle${cycleEdgeKeys.size > 1 ? 's' : ''} fermée${cycleEdgeKeys.size > 1 ? 's' : ''}</span>`
        : `<span>Chaîne ouverte</span>`,
    ].join('');
    body.appendChild(summary);
  }

  _initJointsHeaderToggle(panel) {
    const btn = document.createElement('button');
    btn.style.cssText = [
      'background:transparent', 'border:none', 'cursor:pointer',
      'font-size:13px', 'padding:0 4px', 'line-height:1',
    ].join(';');
    // Insérer avant le bouton ✕ (dernier enfant du header)
    panel._header.insertBefore(btn, panel._header.lastChild);
    panel._globalToggleBtn = btn;
    this._syncJointsHeaderToggle(panel);
  }

  _syncJointsHeaderToggle(panel) {
    const btn = panel._globalToggleBtn;
    if (!btn) return;
    const visible = this._asmVerse?.joints.allMarkersVisible ?? true;
    btn.textContent = '◉';
    btn.title = visible ? 'Masquer tous les helpers' : 'Afficher tous les helpers';
    btn.style.color = visible ? C.accent : C.dim;
    btn.onclick = () => {
      this._asmVerse.joints.setAllMarkersVisible(!this._asmVerse.joints.allMarkersVisible);
      this._refreshPanel('joints');
    };
  }

  _fillJointsPanel(body) {
    const conns = this._asmVerse.joints.connections;
    if (!conns.length) {
      body.appendChild(this._panelEmpty('Aucune liaison'));
      return;
    }
    for (const conn of conns) {
      const { instA, instB, liaison } = conn;
      const involvesSel = instA === this._selectedBrick || instB === this._selectedBrick;
      const dofs  = liaison?.dof ?? [];
      const label = liaison?.name || liaison?.id || '—';

      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'flex-direction:column', 'gap:3px',
        'padding:5px 12px',
        `border-bottom:1px solid ${C.border}22`,
        `background:${involvesSel ? C.accent + '22' : 'transparent'}`,
        `border-left:2px solid ${involvesSel ? C.accent : 'transparent'}`,
      ].join(';');

      // Ligne brique A → brique B
      const bricks = document.createElement('div');
      bricks.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const mkDot = (inst) => {
        const dot = document.createElement('span');
        dot.style.cssText = [
          'display:inline-block', 'width:8px', 'height:8px',
          'border-radius:2px', 'flex-shrink:0',
          `background:${inst.brickData.color || '#888'}`,
        ].join(';');
        return dot;
      };
      const nameA = document.createElement('span');
      nameA.style.color = C.fg;
      nameA.textContent = instA.brickData.name || instA.brickTypeId;
      const arrow = document.createElement('span');
      arrow.style.cssText = `color:${C.dim};flex-shrink:0;`;
      arrow.textContent = '⇄';
      const nameB = document.createElement('span');
      nameB.style.cssText = `color:${C.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      nameB.textContent = instB.brickData.name || instB.brickTypeId;
      bricks.append(mkDot(instA), nameA, arrow, mkDot(instB), nameB);

      // Ligne liaison + DOF + toggle marqueur
      const meta = document.createElement('div');
      meta.style.cssText = `display:flex;align-items:center;gap:6px;padding-left:14px;`;
      const liaisonLabel = document.createElement('span');
      liaisonLabel.style.cssText = `color:${dofs.length ? C.accent : C.dim};font-size:10px;flex:1;`;
      liaisonLabel.textContent = label;
      meta.appendChild(liaisonLabel);
      if (dofs.length) {
        const dofBadge = document.createElement('span');
        dofBadge.style.cssText = `color:${C.dim};font-size:10px;`;
        dofBadge.textContent = dofs.map(d => d.type).join(' · ');
        meta.appendChild(dofBadge);
      }

      // Bouton toggle rendu 3D
      const visible = this._asmVerse.joints.isMarkerVisible(conn);
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = '◉';
      toggleBtn.title = visible ? 'Masquer le helper' : 'Afficher le helper';
      toggleBtn.style.cssText = [
        'background:transparent', 'border:none', 'cursor:pointer',
        'font-size:12px', 'padding:0 2px', 'flex-shrink:0', 'line-height:1',
        `color:${visible ? C.accent : C.dim}`,
      ].join(';');
      toggleBtn.addEventListener('click', () => {
        this._asmVerse.joints.setMarkerVisible(conn, !this._asmVerse.joints.isMarkerVisible(conn));
        this._refreshPanel('joints');
      });
      meta.appendChild(toggleBtn);

      row.append(bricks, meta);
      body.appendChild(row);
    }
  }

  _fillComponentsPanel(body) {
    const components = this._asmVerse.computeComponents();
    if (!components.length) {
      body.appendChild(this._panelEmpty('Aucune composante'));
      return;
    }
    components.forEach((comp, idx) => {
      const section = document.createElement('div');
      section.style.cssText = `padding:6px 12px;border-bottom:1px solid ${C.border}44;`;
      const heading = document.createElement('div');
      heading.style.cssText = `color:${C.accent};font-size:10px;font-weight:bold;margin-bottom:4px;`;
      heading.textContent = `Composante ${idx + 1}  (${comp.size} brique${comp.size > 1 ? 's' : ''})`;
      section.appendChild(heading);
      for (const brick of comp.bricks) {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:6px;padding:2px 0;`;
        const swatch = document.createElement('span');
        swatch.style.cssText = `width:8px;height:8px;border-radius:1px;flex-shrink:0;background:${brick.brickData.color || '#888'};border:1px solid ${C.border};`;
        const name = document.createElement('span');
        name.style.cssText = `color:${C.fg};`;
        name.textContent = brick.brickData.name || brick.brickTypeId;
        row.append(swatch, name);
        section.appendChild(row);
      }
      if (comp.links.length) {
        const links = document.createElement('div');
        links.style.cssText = `margin-top:4px;color:${C.dim};font-size:10px;`;
        links.textContent = `⇌ ${comp.links.length} lien(s) DOF`;
        section.appendChild(links);
      }
      body.appendChild(section);
    });
  }

  // ─── Gestion des modes et de l'état interne ──────────────────────────────────

  /** Bascule entre 'brick', 'component' et 'articulate'. Réinitialise processus et sélection. */
  _setMode(mode) {
    const prev = this._mode;
    // Quitter le mode articuler si on en sort
    if (prev === 'articulate' && mode !== 'articulate') this._leaveArticulateMode();
    this._mode = mode;
    this._process = 'idle';
    this._clearComponentHighlight();
    this._selectBrick(null);
    this._selectedComponent = null;
    this._updateModeBtns?.();
    if (this._linkedMoveBtn)
      this._linkedMoveBtn.style.display = mode === 'component' ? '' : 'none';
    if (this._articBar)
      this._articBar.style.display = mode === 'articulate' ? 'flex' : 'none';
    this._updateGizmoForSelection();
    // Entrer dans le mode articuler
    if (mode === 'articulate') this._enterArticulateMode();
    // Rafraîchir le panel état s'il est ouvert
    const p = this._panels?.state;
    if (p?.style.display === 'flex') this._refreshPanel('state');
  }

  /** Met à jour le processus en cours et rafraîchit le panel état. */
  _setProcess(proc) {
    this._process = proc;
    const p = this._panels?.state;
    if (p?.style.display === 'flex') this._refreshPanel('state');
  }

  /** Met à jour le highlight et _selectedBrick sans toucher aux handlers/pickers.
   *  Utilisé après drag-connect (les handlers sont déjà actifs via onConnect). */
  _setBrickSelected(brick) {
    if (this._selectedBrick) {
      const m = this._selectedBrick.mesh.material;
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
    }
    this._selectedBrick = brick;
    if (brick) {
      const m = brick.mesh.material;
      m.emissive.setHex(C.worldSlot);
      m.emissiveIntensity = 0.3;
    }
    if (this._panels?.bricks?.style.display === 'flex') this._refreshPanel('bricks');
    if (this._panels?.joints?.style.display === 'flex') this._refreshPanel('joints');
    if (this._panels?.state?.style.display  === 'flex') this._refreshPanel('state');
  }

  /** Sélectionne une brique (mode brick). null = désélection.
   *  Si la brique possède plusieurs liaisons DOF : affiche les pickers de sélection.
   *  Si une seule : active directement l'AsmDofHandler. */
  _selectBrick(brick) {
    this._clearLiaisonPickers();
    this._setBrickSelected(brick);
    if (brick) {
      const dofConns = brick.connections.filter(c => c.liaison?.asmDof?.length > 0);
      if (dofConns.length > 1) {
        // État intermédiaire : plusieurs liaisons → pickers de sélection
        this._asmHandlers?.detach();
        this._asmHandlers = null;
        this._showLiaisonPickers(dofConns.map(conn => ({ conn })), this._loadConfig().pickerDiam / 2);
      } else if (dofConns.length === 1) {
        this._activateAsmHandlers(dofConns[0], brick);
      } else {
        this._asmHandlers?.detach();
        this._asmHandlers = null;
      }
    } else {
      this._asmHandlers?.detach();
      this._asmHandlers = null;
    }
    this._updateGizmoForSelection();
  }

  /** Centre la caméra sur la composante sélectionnée, ou sur toutes les briques. */
  _centerViewOnSelection() {
    let bricks;
    if (this._mode === 'component' && this._selectedComponent) {
      bricks = [...this._selectedComponent.bricks];
    } else if (this._mode === 'brick' && this._selectedBrick) {
      bricks = [this._selectedBrick];
    } else {
      bricks = [...this._asmVerse.bricks.values()];
    }
    if (!bricks.length) return;

    const box = new THREE.Box3();
    for (const b of bricks) box.expandByObject(b.mesh);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const radius = size.length() / 2 || 1;

    // Déplacer le target des controls et reculer la caméra
    const cam = this.engine.camera;
    const dir = cam.position.clone().sub(this.engine.controls.target).normalize();
    this.engine.controls.target.copy(center);
    cam.position.copy(center).addScaledVector(dir, radius * 2.5);
    this.engine.controls.update();
  }

  /** Exporte l'assemblage courant en GLB (briques uniquement, sans sol ni helpers). */
  _exportGLB() {
    const bricks = [...this._asmVerse.bricks.values()];
    if (!bricks.length) {
      this._toast('Aucune brique à exporter');
      return;
    }

    // Construire une scène d'export propre
    const exportScene = new THREE.Scene();

    // Lumières d'export
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    exportScene.add(ambient, dir);

    // Cloner les meshes avec matériaux PBR enrichis
    for (const brick of bricks) {
      const clone = brick.mesh.clone();
      const mat   = brick.mesh.material;
      clone.material = new THREE.MeshStandardMaterial({
        color:     mat.color.clone(),
        roughness: mat.roughness ?? 0.55,
        metalness: mat.metalness ?? 0.0,
      });
      exportScene.add(clone);
    }

    const exporter = new GLTFExporter();
    exporter.parse(exportScene, (glb) => {
      const blob = new Blob([glb], { type: 'model/gltf-binary' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `rbang-export-${Date.now()}.glb`;
      a.click();
      URL.revokeObjectURL(url);

      // Nettoyer la scène d'export
      exportScene.traverse(o => {
        o.geometry?.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        }
      });

      this._toast(`Export GLB — ${bricks.length} brique(s)`);
    }, (err) => {
      console.error('[GLB export]', err);
      this._toast('Erreur export GLB');
    }, { binary: true });
  }

  /** Sélectionne une composante (mode component). null = désélection.
   *  - comp.size === 1 → délègue à _selectBrick (brique unique dans sa classe).
   *  - comp.size > 1   → highlight groupe + pickers DOF sur les liens entre composantes. */
  _selectComponent(comp) {
    this._clearComponentHighlight();
    this._clearLiaisonPickers();
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    this._selectedComponent = comp;

    if (!comp) {
      this._selectedBrick = null;
      if (this._panels?.state?.style.display === 'flex') this._refreshPanel('state');
      return;
    }

    if (comp.size === 1) {
      // Brique seule dans sa classe → comportement identique au mode brique
      this._selectBrick([...comp.bricks][0]);
      return;
    }

    // Highlight de toutes les briques du groupe
    for (const b of comp.bricks) {
      b.mesh.material.emissive.setHex(C.worldSlot);
      b.mesh.material.emissiveIntensity = 0.3;
    }

    // Pickers DOF sur les liens avec les composantes voisines
    if (comp.links.length === 1) {
      const { connection } = comp.links[0];
      const mobileInst = comp.contains(connection.instA) ? connection.instA : connection.instB;
      this._activateAsmHandlers(connection, mobileInst);
    } else if (comp.links.length > 1) {
      this._showLiaisonPickers(comp.links.map(({ connection }) => ({
        conn:       connection,
        mobileInst: comp.contains(connection.instA) ? connection.instA : connection.instB,
      })), this._loadConfig().pickerDiam / 2);
    }

    this._updateGizmoForSelection();
    if (this._panels?.state?.style.display === 'flex') this._refreshPanel('state');
  }

  /** Retourne la classe d'équivalence contenant brick, ou null. */
  _findComponent(brick) {
    return this._asmVerse.computeComponents().find(c => c.contains(brick)) ?? null;
  }

  // ─── Mode Articuler ──────────────────────────────────────────────────────────

  static ARTIC_PALETTE = [0x4fc3f7, 0xffb74d, 0x81c784, 0xf06292, 0xba68c8, 0xfff176];

  /** Greedy graph coloring — retourne Map<component, colorIndex>. */
  _graphColor(components) {
    const colorMap = new Map();
    for (const comp of components) {
      const neighborColors = new Set();
      for (const link of comp.links) {
        if (colorMap.has(link.other)) neighborColors.add(colorMap.get(link.other));
      }
      let ci = 0;
      while (neighborColors.has(ci)) ci++;
      colorMap.set(comp, ci);
    }
    return colorMap;
  }

  /** Entre dans le mode articuler : colore les classes, affiche tous les pickers DOF, masque le dock. */
  _enterArticulateMode() {
    // Masquer le dock
    if (this._dock?.el) this._dock.el.style.display = 'none';

    const components = this._asmVerse.computeComponents();
    const colorMap   = this._graphColor(components);
    const palette    = Assembler.ARTIC_PALETTE;

    // Sauvegarder les couleurs originales, appliquer la coloration selon le toggle
    const savedColors = new Map();
    for (const [comp, ci] of colorMap) {
      const hex = palette[ci % palette.length];
      for (const brick of comp.bricks) {
        savedColors.set(brick, brick.mesh.material.color.getHex());
        if (this._articulateShowColoring) brick.mesh.material.color.setHex(hex);
      }
    }

    // Construire les paires de classes voisines (1 picker par paire)
    const classPairs = this._buildClassPairs(components);

    // Déterminer la classe de référence avant de construire les pickers
    let refClass = null;
    if (this._articulateRefIds) {
      refClass = components.find(c =>
        [...c.bricks].some(b => this._articulateRefIds.has(b.id))
      ) ?? null;
    }
    if (!refClass) {
      // Auto-sélection : classe avec le plus de liaisons DOF vers d'autres classes
      let maxLinks = -1;
      for (const comp of components) {
        if (comp.links.length > maxLinks) { maxLinks = comp.links.length; refClass = comp; }
      }
    }

    this._articulateState = { components, colorMap, refClass, savedColors, selectedClass: null, classPairs };

    // Feedback visuel de la référence (conditionnel au toggle coloration)
    if (refClass) {
      if (this._articulateShowColoring) {
        for (const brick of refClass.bricks) brick.mesh.material.color.setHex(0xeeeeee);
      }
      this._articulateRefIds = new Set([...refClass.bricks].map(b => b.id));
    }

    // Construire et afficher les pickers (1 par paire, DOFs fusionnés)
    this._rebuildArticulatePickers();
  }

  /** Quitte le mode articuler : restaure les couleurs, retire les pickers, réaffiche le dock. */
  _leaveArticulateMode() {
    if (!this._articulateState) return;
    const { savedColors } = this._articulateState;

    // Restaurer les couleurs originales
    for (const [brick, hex] of savedColors) {
      brick.mesh.material.color.setHex(hex);
      brick.mesh.material.emissive.setHex(0x000000);
      brick.mesh.material.emissiveIntensity = 0;
    }

    this._clearLiaisonPickers();
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    this._articulateState = null;

    // Réafficher le dock
    if (this._dock?.el) this._dock.el.style.display = '';
  }

  /** Construit les paires de classes voisines avec toutes leurs connexions DOF. */
  _buildClassPairs(components) {
    const pairs = [];
    const seenPairs = new Set();
    for (let i = 0; i < components.length; i++) {
      const ecA = components[i];
      for (const link of ecA.links) {
        const ecB  = link.other;
        const j    = components.indexOf(ecB);
        const key  = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const conns = ecA.links
          .filter(lk => lk.other === ecB)
          .map(lk => lk.connection);
        pairs.push({ ecA, ecB, conns });
      }
    }
    return pairs;
  }

  /** Fusionne les DOFs de plusieurs connexions entre deux classes voisines.
   *  Déduplique les DOFs colinéaires en espace monde — retourne une connexion synthétique. */
  _buildMergedConn(ecA, ecB, conns, refClass) {
    // Côté fixe = refClass si appartient à la paire, sinon ecA par défaut
    const fixedClass  = (refClass === ecA || refClass === ecB) ? refClass : ecA;

    // Orienter chaque conn : instB = côté fixe, instA = côté mobile
    const oriented = conns.map(conn => {
      if (fixedClass.contains(conn.instB)) return conn;
      return { instA: conn.instB, slotA: conn.slotB, instB: conn.instA, slotB: conn.slotA, liaison: conn.liaison };
    });

    // Calculer les axes monde pour tous les DOFs
    const worldDofs = [];
    for (const conn of oriented) {
      const { instB, slotB } = conn;
      const slotBQ  = new THREE.Quaternion(...(slotB.quaternion ?? [0, 0, 0, 1]));
      const worldQ  = slotBQ.clone().premultiply(instB.mesh.quaternion.clone());
      for (const dof of (conn.liaison?.asmDof ?? [])) {
        const worldAxis = new THREE.Vector3(...(dof.axis ?? [0, 0, 1]))
          .normalize().applyQuaternion(worldQ).normalize();
        worldDofs.push({ worldAxis, dof, conn });
      }
    }

    if (worldDofs.length === 0) return null;

    // Dédupliquer par type + axe monde colinéaire
    const unique = [];
    for (const wd of worldDofs) {
      const isDup = unique.some(u =>
        u.dof.type === wd.dof.type &&
        Math.abs(u.worldAxis.dot(wd.worldAxis)) >= 0.99
      );
      if (!isDup) unique.push(wd);
    }

    // Connexion représentative = celle du premier DOF unique (détermine position du pivot)
    const repConn   = unique[0].conn;
    const { instA: repInstA, slotA: repSlotA, instB: repInstB, slotB: repSlotB } = repConn;

    // Transformer les axes monde uniques en axes locaux du repère instB/slotB de repConn
    const repSlotBQ   = new THREE.Quaternion(...(repSlotB.quaternion ?? [0, 0, 0, 1]));
    const repWorldQ   = repSlotBQ.clone().premultiply(repInstB.mesh.quaternion.clone());
    const repWorldQInv = repWorldQ.clone().invert();

    const mergedAsmDof = unique.map(wd => ({
      ...wd.dof,
      axis: wd.worldAxis.clone().applyQuaternion(repWorldQInv).normalize().toArray(),
    }));

    return {
      instA       : repInstA,
      slotA       : repSlotA,
      instB       : repInstB,
      slotB       : repSlotB,
      liaison     : { ...(repConn.liaison ?? {}), asmDof: mergedAsmDof },
      _sourceConns: oriented,   // connexions sources orientées — pour le centroïde du picker
    };
  }

  /** Reconstruit les pickers articuler (1 par paire de classes voisines, DOFs fusionnés). */
  _rebuildArticulatePickers() {
    const st = this._articulateState;
    if (!st) return;
    this._clearLiaisonPickers();
    const diam    = this._loadConfig().articulatePickerDiam ?? 0.6;
    const entries = [];
    for (const { ecA, ecB, conns } of st.classPairs) {
      const mergedConn = this._buildMergedConn(ecA, ecB, conns, st.refClass);
      if (mergedConn) entries.push({ conn: mergedConn });
    }
    if (entries.length) {
      this._showLiaisonPickers(entries, diam / 2);
      // Appliquer la visibilité selon le toggle
      if (!this._articulateShowPickers) {
        for (const p of this._liaisonPickers) p.mesh.visible = false;
      }
    }
  }

  /** Sélectionne une classe d'équivalence en mode articuler. null = désélection. */
  _selectArticulateClass(comp) {
    const st = this._articulateState;
    if (!st) return;

    // Désélectionner la classe précédente
    if (st.selectedClass) {
      for (const brick of st.selectedClass.bricks) {
        brick.mesh.material.emissiveIntensity = 0;
      }
    }

    st.selectedClass = comp;

    // Highlight de la nouvelle classe
    if (comp) {
      for (const brick of comp.bricks) {
        brick.mesh.material.emissive.setHex(0xffffff);
        brick.mesh.material.emissiveIntensity = 0.25;
      }
    }

    // Mettre à jour l'apparence du bouton ancre
    if (this._anchorBtn) {
      this._anchorBtn.style.color = comp ? C.accent : C.dim;
    }
  }

  /** Définit une classe comme référence (pivot) pour orienter les AsmHandlers. */
  _setReferenceClass(comp) {
    const st = this._articulateState;
    if (!st) return;

    // Retirer le feedback de l'ancienne référence
    if (st.refClass && this._articulateShowColoring) {
      const ci = st.colorMap.get(st.refClass);
      const hex = Assembler.ARTIC_PALETTE[ci % Assembler.ARTIC_PALETTE.length];
      for (const brick of st.refClass.bricks) brick.mesh.material.color.setHex(hex);
    }

    // Toggle si même classe
    st.refClass = (st.refClass === comp) ? null : comp;

    // Feedback visuel : la classe de référence reçoit un highlight distinct
    if (st.refClass && this._articulateShowColoring) {
      for (const brick of st.refClass.bricks) brick.mesh.material.color.setHex(0xeeeeee);
    }

    // Persister les IDs des briques de la classe de référence
    this._articulateRefIds = st.refClass
      ? new Set([...st.refClass.bricks].map(b => b.id))
      : null;

    // Détacher le handler actif et reconstruire les pickers orientés selon la nouvelle référence
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    this._rebuildArticulatePickers();
  }

  /** Active un AsmHandler pour une connexion en mode articuler, orienté selon la classe de référence. */
  _activateArticulateHandler(conn) {
    this._asmHandlers?.detach();
    this._asmHandlers = null;

    const st = this._articulateState;
    // Déterminer le côté mobile : celui qui n'est PAS dans la classe de référence
    let oriented = conn;
    if (st?.refClass) {
      // Si instA est dans la classe de référence, swap pour que instA = mobile
      if (st.refClass.contains(conn.instA) && !st.refClass.contains(conn.instB)) {
        oriented = { ...conn, instA: conn.instB, slotA: conn.slotB, instB: conn.instA, slotB: conn.slotA };
      }
      // Si instB est dans la ref, pas besoin de swap (instA est déjà mobile)
    }

    const anchorBricks = st?.refClass ? st.refClass.bricks : null;
    const cfg        = this._loadConfig();
    const stepsRot   = cfg.asmHelperStepsRot   ?? 16;
    const stepsTrans = cfg.asmHelperStepsTrans  ?? 20;
    const connections = this._asmVerse.joints.connections;
    const sbgHex   = cfg.stripBgColor   ?? '#121218';
    const sbgAlpha = Math.round((cfg.stripBgOpacity ?? 0.6) * 255).toString(16).padStart(2, '0');
    const stripBg    = sbgHex + sbgAlpha;
    const stripFont  = cfg.stripFontColor  ?? '#cccccc';
    const handlers = new AsmHandlers({
      conn: oriented, engine: this.engine, topOffset: BAR_H + BAR_ARTIC_H,
      stepsRot, stepsTrans, connections,
      solver: 'articulate',
      anchorBricks,
      xray: true, stripBg, stripFont,
    });
    if (handlers.active) {
      handlers.onMove    = () => this._updateArticulatePickers();
      handlers.onRelease = () => {
        this._asmVerse.joints.observe(this._asmVerse.slots);
        this._updateArticulatePickers();
      };
      handlers.attach();
      this._asmHandlers = handlers;
    }
  }

  /** Met à jour les positions des liaison pickers en mode articuler après manipulation DOF. */
  _updateArticulatePickers() {
    for (const p of this._liaisonPickers) {
      p.mesh.position.copy(_pickerWorldPos(p.conn));
    }
  }

  // ─── Grab IK (mode articuler) ──────────────────────────────────────────────

  /** Démarre un grab IK : calcule la chaîne cinématique et le plan de projection. */
  _startArticulateGrab(e) {
    const st = this._articulateState;
    if (!st?.refClass || !this._tapStart?.inst) return;
    const { inst, hitPt } = this._tapStart;

    const grabbedClass = st.components.find(c => c.contains(inst));
    if (!grabbedClass || grabbedClass === st.refClass) return;

    const chain = this._findChainToRef(grabbedClass, st.refClass, st.classPairs);
    if (!chain?.length) return;

    // Point de saisie en espace local de la brique
    const grabPtLocal = hitPt.clone()
      .sub(inst.mesh.position)
      .applyQuaternion(inst.mesh.quaternion.clone().invert());

    // Plan de projection : normal = direction caméra, passant par hitPt
    const camDir = new THREE.Vector3();
    this.engine.camera.getWorldDirection(camDir);
    const grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, hitPt);

    this._grabState = { grabBrick: inst, grabPtLocal, grabPlane, chain };
    this._setProcess('dragging');
  }

  /** Met à jour le grab IK à chaque pointermove. */
  _updateArticulateGrab(e) {
    if (!this._grabState) return;
    const { grabBrick, grabPtLocal, grabPlane, chain } = this._grabState;

    this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
    this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    const targetPt = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(grabPlane, targetPt)) return;

    // CCD — itérations configurables
    for (let iter = 0; iter < this._articulateCcdIter; iter++) {
      const currentPt = grabPtLocal.clone()
        .applyQuaternion(grabBrick.mesh.quaternion)
        .add(grabBrick.mesh.position);
      if (currentPt.distanceTo(targetPt) < 1e-4) break;
      for (const step of chain) this._ccdStep(step, grabBrick, grabPtLocal, targetPt);
    }

    this._updateArticulatePickers();
  }

  /** Trouve le chemin de paires de classes entre grabbedClass et refClass (BFS).
   *  Retourne un tableau ordonné { mergedConn, mobileBricks } de grabbed vers ref. */
  _findChainToRef(grabbedClass, refClass, classPairs) {
    const prev    = new Map(); // ec → { from, pair }
    const visited = new Set([grabbedClass]);
    const queue   = [grabbedClass];

    while (queue.length) {
      const ec = queue.shift();
      if (ec === refClass) break;
      for (const link of ec.links) {
        if (visited.has(link.other)) continue;
        visited.add(link.other);
        const pair = classPairs.find(p =>
          (p.ecA === ec && p.ecB === link.other) ||
          (p.ecA === link.other && p.ecB === ec)
        );
        prev.set(link.other, { from: ec, pair });
        queue.push(link.other);
      }
    }

    if (!prev.has(refClass)) return null;

    // Reconstruire le chemin grabbedClass → refClass
    const path = [];
    let curr = refClass;
    while (curr !== grabbedClass) {
      const { from, pair } = prev.get(curr);
      path.push({ ecFrom: from, ecTo: curr, pair });
      curr = from;
    }
    path.reverse();

    // Construire les étapes CCD : pour le joint entre ecFrom et ecTo,
    // les briques mobiles = tout le sous-arbre cinématique raciné en ecFrom
    // (BFS depuis ecFrom en bloquant l'arête vers ecTo)
    const chain = [];
    for (const { ecFrom, ecTo, pair } of path) {
      const mergedConn = pair
        ? this._buildMergedConn(pair.ecA, pair.ecB, pair.conns, ecTo)
        : null;
      if (!mergedConn) continue;
      chain.push({ mergedConn, mobileBricks: this._subtreeBricks(ecFrom, ecTo) });
    }

    return chain;
  }

  /** Toutes les briques du sous-arbre cinématique raciné en 'root',
   *  sans traverser l'arête vers 'blockedNeighbor'. */
  _subtreeBricks(root, blockedNeighbor) {
    const visited = new Set([root]);
    const queue   = [root];
    while (queue.length) {
      const ec = queue.shift();
      for (const link of ec.links) {
        if (link.other === blockedNeighbor || visited.has(link.other)) continue;
        visited.add(link.other);
        queue.push(link.other);
      }
    }
    const bricks = new Set();
    for (const ec of visited) for (const b of ec.bricks) bricks.add(b);
    return bricks;
  }

  /** Une étape CCD : ajuste le joint pour rapprocher le point de saisie du target. */
  _ccdStep(step, grabBrick, grabPtLocal, targetPt) {
    const { mergedConn, mobileBricks } = step;
    const pivot = _connPivotWorld(mergedConn);

    const currentPt = grabPtLocal.clone()
      .applyQuaternion(grabBrick.mesh.quaternion)
      .add(grabBrick.mesh.position);

    const vCurr = currentPt.clone().sub(pivot);
    const vTgt  = targetPt.clone().sub(pivot);

    for (const dof of (mergedConn.liaison?.asmDof ?? [])) {
      const axis = _dofWorldAxis(dof, mergedConn);

      switch (dof.type) {
        case 'rotation': {
          const vCp  = vCurr.clone().sub(axis.clone().multiplyScalar(axis.dot(vCurr)));
          const vTp  = vTgt.clone().sub(axis.clone().multiplyScalar(axis.dot(vTgt)));
          const len  = vCp.length() * vTp.length();
          if (len < 1e-6) break;
          const sinA = new THREE.Vector3().crossVectors(vCp, vTp).dot(axis) / len;
          const cosA = vCp.dot(vTp) / len;
          const rot  = new THREE.Quaternion().setFromAxisAngle(axis, Math.atan2(sinA, cosA));
          for (const b of mobileBricks) {
            b.mesh.position.sub(pivot).applyQuaternion(rot).add(pivot);
            b.mesh.quaternion.premultiply(rot);
          }
          break;
        }
        case 'translation': {
          const t = vTgt.clone().sub(vCurr).dot(axis);
          for (const b of mobileBricks) b.mesh.position.addScaledVector(axis, t);
          break;
        }
        case 'cylindrical': {
          // Translation sur l'axe, puis rotation autour
          const t = vTgt.clone().sub(vCurr).dot(axis);
          for (const b of mobileBricks) b.mesh.position.addScaledVector(axis, t);
          const cur2  = grabPtLocal.clone()
            .applyQuaternion(grabBrick.mesh.quaternion).add(grabBrick.mesh.position);
          const vC2   = cur2.clone().sub(pivot);
          const vCp2  = vC2.clone().sub(axis.clone().multiplyScalar(axis.dot(vC2)));
          const vTgtR = vTgt.clone().sub(axis.clone().multiplyScalar(axis.dot(vTgt)));
          const len2  = vCp2.length() * vTgtR.length();
          if (len2 < 1e-6) break;
          const sinA2 = new THREE.Vector3().crossVectors(vCp2, vTgtR).dot(axis) / len2;
          const cosA2 = vCp2.dot(vTgtR) / len2;
          const rot2  = new THREE.Quaternion().setFromAxisAngle(axis, Math.atan2(sinA2, cosA2));
          for (const b of mobileBricks) {
            b.mesh.position.sub(pivot).applyQuaternion(rot2).add(pivot);
            b.mesh.quaternion.premultiply(rot2);
          }
          break;
        }
        case 'ball': {
          if (vCurr.length() < 1e-6 || vTgt.length() < 1e-6) break;
          const rot = new THREE.Quaternion().setFromUnitVectors(
            vCurr.clone().normalize(), vTgt.clone().normalize()
          );
          for (const b of mobileBricks) {
            b.mesh.position.sub(pivot).applyQuaternion(rot).add(pivot);
            b.mesh.quaternion.premultiply(rot);
          }
          break;
        }
      }
    }
  }

  /** BFS traversant TOUTES les connexions (rigides + DOF) depuis brick. */
  _linkedBrickSet(brick) {
    const set   = new Set([brick]);
    const queue = [brick];
    const conns = this._asmVerse.joints.connections;
    while (queue.length) {
      const b = queue.shift();
      for (const c of conns) {
        const other = c.instA === b ? c.instB : c.instB === b ? c.instA : null;
        if (other && !set.has(other)) { set.add(other); queue.push(other); }
      }
    }
    return set;
  }

  /** Vrai si au moins une brique de brickSet est ancrée par un world slot. */
  _isGrounded(brickSet) {
    return this._asmVerse._wsConnections.some(wsc => brickSet.has(wsc.brick));
  }

  // ─── Gizmo de translation monde ──────────────────────────────────────────────

  _buildGizmo() {
    const group = new THREE.Group();

    const mkArrow = (color, rotAxis, rotAngle, worldAxis) => {
      const mat    = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
      const matHit = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });

      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.65, 8), mat);
      shaft.position.y = 0.425; // 0.1 offset + half 0.65

      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.24, 8), mat);
      tip.position.y = 0.87;    // 0.75 + half 0.24

      // Zone de hit large pour les doigts
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.0, 8), matHit);
      hit.position.y = 0.5;
      hit.userData.isGizmoHandle = true;
      hit.userData.worldAxis = worldAxis;

      [shaft, tip, hit].forEach(m => { m.renderOrder = 300; });

      const arrow = new THREE.Group();
      arrow.add(shaft, tip, hit);
      if (rotAxis) arrow.rotateOnAxis(rotAxis, rotAngle);
      group.add(arrow);
    };

    mkArrow(0xff3333, new THREE.Vector3(0, 0, 1), -Math.PI / 2, new THREE.Vector3(1, 0, 0)); // +X
    mkArrow(0x33cc55, null, 0,                                   new THREE.Vector3(0, 1, 0)); // +Y
    mkArrow(0x3399ff, new THREE.Vector3(1, 0, 0),  Math.PI / 2, new THREE.Vector3(0, 0, 1)); // +Z

    group.visible = false;
    this.engine.scene.add(group);
    this._gizmo = group;
  }

  _updateGizmoForSelection() {
    if (!this._gizmo) return;
    if (!this._linkedMove || this._mode !== 'component' || !this._selectedComponent) {
      this._gizmo.visible = false;
      return;
    }
    const bricks = [...this._selectedComponent.bricks];
    const centroid = bricks.reduce(
      (acc, b) => acc.add(b.mesh.position), new THREE.Vector3()
    ).divideScalar(bricks.length);
    this._gizmo.position.copy(centroid);
    this._gizmo.visible = true;
  }

  /** Paramètre s tel que (axisOrigin + s·axisDir) soit le point de l'axe le plus proche du rayon. */
  _rayAxisParam(ray, axisOrigin, axisDir) {
    const w  = new THREE.Vector3().subVectors(ray.origin, axisOrigin);
    const b  = ray.direction.dot(axisDir);
    const dw = ray.direction.dot(w);
    const e  = axisDir.dot(w);
    const den = 1 - b * b;
    if (Math.abs(den) < 1e-6) return e; // rayon quasi-parallèle à l'axe
    return (e - b * dw) / den;
  }

  /** Retire le highlight de toutes les briques de _selectedComponent. */
  _clearComponentHighlight() {
    if (!this._selectedComponent) return;
    for (const b of this._selectedComponent.bricks) {
      b.mesh.material.emissive.setHex(0x000000);
      b.mesh.material.emissiveIntensity = 0;
    }
  }

  /** Déplace toutes les briques de _stackCandidate.comp par delta depuis grabPt. */
  _dragCompTo(cx, cy) {
    const { comp, restoreStates, grabPt } = this._stackCandidate;
    if (!comp || !restoreStates || !grabPt) return;
    this._mouse.x =  (cx / innerWidth)  * 2 - 1;
    this._mouse.y = -(cy / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -grabPt.y);
    const pt = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(plane, pt)) return;
    const delta = pt.clone().sub(grabPt);
    for (const { brick, pos } of restoreStates) {
      brick.mesh.position.copy(pos).add(delta);
    }
  }

  _fillCataloguePanel(body) {
    const store = _catalogueLoad();
    const entries = Object.values(store).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // ── Sauvegarder la scène courante ─────────────────────────────────────────
    const saveRow = document.createElement('div');
    saveRow.style.cssText = `display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid ${C.border};flex-shrink:0;`;
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.placeholder = 'Nom de la construction…';
    nameInp.style.cssText = [
      'flex:1', 'min-width:0', `background:${C.bgDark}`, `color:${C.fg}`,
      `border:1px solid ${C.border}`, 'border-radius:2px',
      'padding:3px 6px', 'font-size:11px',
    ].join(';');
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '＋';
    saveBtn.title = 'Sauvegarder';
    saveBtn.style.cssText = [
      `background:${C.bgDark}`, `color:${C.accent}`,
      `border:1px solid ${C.accent}`, 'border-radius:2px',
      'padding:2px 8px', 'font-size:13px', 'cursor:pointer', 'flex-shrink:0',
    ].join(';');
    saveBtn.addEventListener('click', () => {
      const name = nameInp.value.trim() || `Construction ${new Date().toLocaleDateString()}`;
      if (!this._asmVerse.bricks.size) return;
      const s = _catalogueLoad();
      const id = _uid();
      s[id] = { id, name, createdAt: new Date().toISOString(), data: this._asmVerse.serialize() };
      _catalogueSave(s);
      nameInp.value = '';
      this._refreshPanel('catalogue');
    });
    saveRow.append(nameInp, saveBtn);
    body.appendChild(saveRow);

    // ── Liste des constructions ───────────────────────────────────────────────
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.style.cssText = `padding:16px 10px;color:${C.dim};font-size:10px;text-align:center;`;
      empty.textContent = 'Aucune construction sauvegardée';
      body.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:6px',
        'padding:7px 10px',
        `border-bottom:1px solid ${C.border}`,
      ].join(';');

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const nameEl = document.createElement('div');
      nameEl.textContent = entry.name;
      nameEl.style.cssText = `color:${C.fg};font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      const dateEl = document.createElement('div');
      const d = new Date(entry.createdAt);
      dateEl.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ·  ${entry.data.instances.length} brique${entry.data.instances.length > 1 ? 's' : ''}`;
      dateEl.style.cssText = `color:${C.dim};font-size:9px;margin-top:2px;`;
      info.append(nameEl, dateEl);

      const loadBtn = document.createElement('button');
      loadBtn.textContent = '↓';
      loadBtn.title = 'Charger';
      loadBtn.style.cssText = `background:transparent;border:1px solid ${C.border};color:${C.accent};border-radius:2px;padding:2px 7px;font-size:12px;cursor:pointer;flex-shrink:0;`;
      loadBtn.addEventListener('click', async () => {
        this._clearAll();
        const bricksStore   = this._loadStore('rbang_bricks');
        const shapesStore   = this._loadStore('rbang_shapes');
        const liaisonsStore = this._loadStore('rbang_liaisons');
        await this._asmVerse.restore(entry.data, bricksStore, shapesStore, liaisonsStore);
        this._saveScene();
        this._updateCount();
        this._togglePanel('catalogue');
      });

      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Supprimer';
      delBtn.style.cssText = `background:transparent;border:none;color:${C.dim};font-size:12px;cursor:pointer;padding:0 2px;flex-shrink:0;`;
      delBtn.addEventListener('click', () => {
        const s = _catalogueLoad();
        delete s[entry.id];
        _catalogueSave(s);
        this._refreshPanel('catalogue');
      });

      row.append(info, loadBtn, delBtn);
      body.appendChild(row);
    }
  }

  _fillStatePanel(body) {
    const MODE_LABELS = { brick: 'Brique', component: 'Composante', articulate: 'Articuler' };
    const PROC_LABELS = {
      idle:       'Repos',
      dragging:   'Déplacement',
      trackball:  'Rotation (world slot)',
      assembling: 'Assemblage',
    };

    const rows = [
      ['MODE',      MODE_LABELS[this._mode]   || this._mode],
      ['PROCESSUS', PROC_LABELS[this._process] || this._process],
    ];

    if (this._mode === 'articulate') {
      const st = this._articulateState;
      rows.push(['CLASSES', st ? `${st.components.length} classe(s)` : '—']);
      rows.push(['SÉLECTION', st?.selectedClass ? `Classe (${st.selectedClass.size} briques)` : '—']);
      rows.push(['RÉFÉRENCE', st?.refClass ? `Classe (${st.refClass.size} briques)` : '—']);
    } else if (this._mode === 'brick') {
      const sel = this._selectedBrick;
      rows.push(['SÉLECTION', sel ? (sel.brickData.name || sel.brickTypeId) : '—']);
      if (this._stackCandidate) {
        const b = this._stackCandidate.inst;
        rows.push(['EN COURS', b.brickData.name || b.brickTypeId]);
      }
    } else {
      const comp = this._selectedComponent;
      rows.push(['SÉLECTION', comp ? `Composante (${comp.size} briques)` : '—']);
    }

    // Séparateur
    rows.push(null);

    // Contexte AsmVerse
    rows.push(['BRIQUES',     String(this._asmVerse.bricks.size)]);
    rows.push(['LIAISONS',    String(this._asmVerse.joints.connections.length)]);
    rows.push(['COMPOSANTES', String(this._asmVerse.componentCount())]);

    for (const row of rows) {
      if (!row) {
        // Séparateur
        const sep = document.createElement('div');
        sep.style.cssText = `height:1px;background:${C.border};margin:4px 0;`;
        body.appendChild(sep);
        continue;
      }
      const [key, val] = row;
      const el = document.createElement('div');
      el.style.cssText = `display:flex;justify-content:space-between;align-items:baseline;padding:5px 12px;border-bottom:1px solid ${C.border}22;`;
      const k = document.createElement('span');
      k.style.cssText = `color:${C.dim};font-size:9px;text-transform:uppercase;letter-spacing:.1em;flex-shrink:0;`;
      k.textContent = key;
      const v = document.createElement('span');
      v.style.cssText = `color:${C.fg};font-size:11px;text-align:right;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      v.textContent = val;
      el.append(k, v);
      body.appendChild(el);
    }
  }

  _panelEmpty(msg) {
    const el = document.createElement('div');
    el.style.cssText = `color:${C.dim};padding:16px 12px;text-align:center;font-size:10px;`;
    el.textContent = msg;
    return el;
  }
}
