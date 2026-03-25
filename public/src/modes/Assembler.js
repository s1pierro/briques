import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { getManifold, buildCache, manifoldToGeometry, manifoldToPoints } from '../csg-utils.js';

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
  jointImplicit: 0xffaa00,
};

// Collision groups pour éviter auto-collision entre briques assemblées (Rapier 0.12)
// Membership bit 15 (0x8000) ; filter = tout sauf bit 15
const BRICK_SIM_GROUPS = (0x8000 << 16) | 0x7FFF;

// ─── Spirale phyllotaxique ────────────────────────────────────────────────────
function spiralPos(n, spacing = 2.0) {
  if (n === 0) return new THREE.Vector3(0, 0, 0);
  const angle  = n * 2.399963; // angle d'or en radians
  const radius = spacing * Math.sqrt(n);
  return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WorldSlotManager
// ═══════════════════════════════════════════════════════════════════════════════

class WorldSlotManager {
  constructor(scene) {
    this._scene      = scene;
    this._slots      = []; // { index, position:Vector3, mesh, brickInstanceId|null }
    this._y          = 0.25; // hauteur du plan world slots
    this._plane      = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._y);
    this._planeMesh  = null;
    this.SNAP_R      = 1.2;
    this._initPlaneMesh();
  }

  // ── Plan visuel semi-transparent ─────────────────────────────────────────────
  _initPlaneMesh() {
    const geo = new THREE.PlaneGeometry(26, 26);
    const mat = new THREE.MeshBasicMaterial({
      color: C.worldSlot, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this._planeMesh = new THREE.Mesh(geo, mat);
    this._planeMesh.rotation.x = -Math.PI / 2;
    this._planeMesh.position.y = this._y;
    this._scene.add(this._planeMesh);
  }

  // ── Changer la hauteur du plan ────────────────────────────────────────────────
  setY(y) {
    this._y = y;
    this._plane.constant = -y;
    this._planeMesh.position.y = y;
    for (const s of this._slots) {
      s.position.y = y;
      s.mesh.position.setY(y + 0.01);
      if (s.mesh.userData.ring) s.mesh.userData.ring.position.setY(y + 0.011);
    }
  }

  // ── Ajouter un world slot à la position la plus proche sur la spirale ───────
  add(worldPos) {
    const pos   = new THREE.Vector3(worldPos.x, 0, worldPos.z); // XZ seulement pour la spirale
    const index = this._nextFreeIndex(pos);
    const slotPos = spiralPos(index);
    slotPos.y = this._y; // forcer la hauteur courante
    const mesh = this._makeMesh(slotPos);
    this._scene.add(mesh);
    const slot = { index, position: slotPos, mesh, brickInstanceId: null };
    this._slots.push(slot);
    return slot;
  }

  remove(slot) {
    if (slot.mesh.userData.ring) {
      this._scene.remove(slot.mesh.userData.ring);
      slot.mesh.userData.ring.geometry.dispose();
      slot.mesh.userData.ring.material.dispose();
    }
    this._scene.remove(slot.mesh);
    slot.mesh.geometry.dispose();
    slot.mesh.material.dispose();
    const idx = this._slots.indexOf(slot);
    if (idx !== -1) this._slots.splice(idx, 1);
  }

  // ── Trouver le world slot le plus proche d'un point (plan XZ) ───────────────
  nearest(worldPos, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const s of this._slots) {
      const d = new THREE.Vector2(worldPos.x - s.position.x, worldPos.z - s.position.z).length();
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // ── Relier un world slot à une instance de brique ───────────────────────────
  bind(slot, brickInstanceId) {
    slot.brickInstanceId = brickInstanceId;
    // Passer la couleur du disque à "occupé"
    slot.mesh.material.color.setHex(0x4a8a6a);
  }

  unbind(slot) {
    slot.brickInstanceId = null;
    slot.mesh.material.color.setHex(C.worldSlot);
  }

  // ── Raycast contre le plan des world slots ───────────────────────────────────
  raycastPlane(raycaster) {
    const pt = new THREE.Vector3();
    return raycaster.ray.intersectPlane(this._plane, pt) ? pt : null;
  }

  // ── Nettoyage ────────────────────────────────────────────────────────────────
  dispose() {
    for (const s of this._slots) {
      if (s.mesh.userData.ring) {
        this._scene.remove(s.mesh.userData.ring);
        s.mesh.userData.ring.geometry.dispose();
        s.mesh.userData.ring.material.dispose();
      }
      this._scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
    }
    this._slots = [];
    if (this._planeMesh) {
      this._scene.remove(this._planeMesh);
      this._planeMesh.geometry.dispose();
      this._planeMesh.material.dispose();
      this._planeMesh = null;
    }
  }

  get slots() { return this._slots; }

  // ── Privé ────────────────────────────────────────────────────────────────────
  _nextFreeIndex(pos) {
    const usedIndices = new Set(this._slots.map(s => s.index));
    // Chercher parmi les 64 premiers l'index libre dont la position spirale est la plus proche
    let bestIndex = -1, bestD = Infinity;
    for (let i = 0; i < 64; i++) {
      if (usedIndices.has(i)) continue;
      const sp = spiralPos(i);
      const d  = new THREE.Vector2(pos.x - sp.x, pos.z - sp.z).length();
      if (d < bestD) { bestD = d; bestIndex = i; }
    }
    return bestIndex >= 0 ? bestIndex : this._slots.length;
  }

  _makeMesh(pos) {
    const geo  = new THREE.CircleGeometry(0.35, 32);
    const mat  = new THREE.MeshBasicMaterial({
      color: C.worldSlot, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.01, pos.z);

    // Anneau extérieur
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.42, 32),
      new THREE.MeshBasicMaterial({ color: C.worldSlot, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, pos.y + 0.011, pos.z);
    this._scene.add(ring);
    mesh.userData.ring = ring;
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ScreenSlotManager
// ═══════════════════════════════════════════════════════════════════════════════

const SS_W = 240, SS_H = 180; // taille d'un screen slot en px
const SS_PAD = 6;
const SS_ROWS = 2;

class ScreenSlotManager {
  constructor(mainRenderer, engineCamera) {
    this._mainRenderer  = mainRenderer;
    this._engineCamera  = engineCamera;
    this._slots         = []; // { id, brickId, canvas, renderer, scene, camera, controls, rect, mesh }
    this._container     = null;
    this._onPickStart   = null; // callback(slotId, nearSlots, clientX, clientY)
    this._onPickEnd     = null;
    this._activeGesture = null; // { slotId, nearSlots, startX, startY }
    this._init();
  }

  // ── Initialisation du conteneur ──────────────────────────────────────────────
  _init() {
    const el = document.createElement('div');
    el.id = 'asm-screenslots';
    el.style.cssText = [
      'position:fixed', 'left:0', 'bottom:0',
      'display:flex', 'flex-wrap:wrap-reverse', 'flex-direction:row',
      `gap:${SS_PAD}px`, `padding:${SS_PAD}px`,
      `max-width:${(SS_W + SS_PAD) * 4 + SS_PAD}px`,
      'z-index:60', 'pointer-events:none',
      'align-content:flex-end',
    ].join(';');
    document.body.appendChild(el);
    this._container = el;
  }

  // ── Ajouter un screen slot pour une brique ───────────────────────────────────
  async add(brickId) {
    if (this._slots.find(s => s.brickId === brickId)) return; // déjà présent

    const bricks = this._loadStore('rbang_bricks');
    const brick  = bricks[brickId];
    if (!brick) return;

    // Canvas dédié
    const canvas = document.createElement('canvas');
    canvas.width  = SS_W * devicePixelRatio;
    canvas.height = SS_H * devicePixelRatio;
    canvas.style.cssText = [
      `width:${SS_W}px`, `height:${SS_H}px`,
      'display:block',
      `border:1px solid ${C.border}`,
      'border-radius:2px',
      'touch-action:none',
      'pointer-events:auto',
      `background:${C.bgDark}`,
    ].join(';');

    // Étiquette
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'position:relative', `width:${SS_W}px`,
      'pointer-events:auto', 'touch-action:none',
    ].join(';');
    const label = document.createElement('div');
    label.textContent = brick.name || brickId;
    label.style.cssText = [
      'position:absolute', 'bottom:0', 'left:0', 'right:0',
      'padding:1px 4px',
      `background:${C.bgDark}cc`,
      `color:${C.dim}`,
      'font:9px/1.4 sans-serif',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      'pointer-events:none',
    ].join(';');
    wrap.appendChild(canvas);
    wrap.appendChild(label);
    this._container.appendChild(wrap);

    // Renderer Three.js dédié
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(SS_W, SS_H);
    renderer.shadowMap.enabled = false;

    // Scène mini
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(C.bgDark);
    const camera = new THREE.PerspectiveCamera(45, SS_W / SS_H, 0.01, 100);
    camera.position.set(0, 0, 3);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const sun     = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(2, 4, 3);
    scene.add(ambient, sun);

    // TrackballControls sur le canvas
    const controls = new TrackballControls(camera, canvas);
    controls.rotateSpeed = 3;
    controls.noPan = controls.noZoom = false;
    controls.noRotate = false;

    const slot = { id: `ss-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                   brickId, canvas, renderer, scene, camera, controls,
                   mesh: null, wrap, label };
    this._slots.push(slot);

    // Charger la géométrie
    await this._loadGeometry(slot, brick);

    // Boucle de rendu propre à ce slot
    const loop = () => {
      if (!this._slots.includes(slot)) return;
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    // Événements tactiles
    this._bindGestures(slot);

    return slot;
  }

  // ── Supprimer un screen slot ──────────────────────────────────────────────────
  remove(brickId) {
    const idx = this._slots.findIndex(s => s.brickId === brickId);
    if (idx === -1) return;
    const slot = this._slots[idx];
    slot.renderer.dispose();
    if (slot.mesh) { slot.mesh.geometry.dispose(); slot.mesh.material.dispose(); }
    slot.wrap.remove();
    this._slots.splice(idx, 1);
  }

  dispose() {
    const ids = this._slots.map(s => s.brickId);
    ids.forEach(id => this.remove(id));
    this._container.remove();
  }

  // ── Rect écran d'un slot (pour hit-test depuis la zone principale) ───────────
  getRect(slotId) {
    const slot = this._slots.find(s => s.id === slotId);
    return slot ? slot.canvas.getBoundingClientRect() : null;
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────────
  onPickStart(fn) { this._onPickStart = fn; }
  onPickEnd(fn)   { this._onPickEnd   = fn; }

  get slots() { return this._slots; }

  // ── Privé : géométrie ─────────────────────────────────────────────────────────
  async _loadGeometry(slot, brick) {
    try {
      const shapes = this._loadStore('rbang_shapes');
      const data   = shapes[brick.shapeRef];
      if (!data?.steps || !data.rootId) return;
      const M     = await getManifold();
      const cache = buildCache(data.steps, M);
      const mf    = cache.get(data.rootId);
      if (!mf) return;
      const { geo } = manifoldToGeometry(mf);
      const color   = parseInt((brick.color || '#888888').replace('#', ''), 16);
      const mat     = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
      const mesh    = new THREE.Mesh(geo, mat);
      // Centrer
      const box    = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      mesh.position.sub(center);
      // Adapter la caméra à la taille
      const size = box.getSize(new THREE.Vector3()).length();
      slot.camera.position.set(0, 0, size * 1.4);
      slot.controls.update();
      slot.scene.add(mesh);
      slot.mesh = mesh;
    } catch (e) {
      console.warn('ScreenSlot geometry error', e);
    }
  }

  // ── Privé : gestures ──────────────────────────────────────────────────────────
  _bindGestures(slot) {
    const el = slot.canvas;
    let ptrs = new Map(); // pointerId → {x,y}

    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Si on touche dans la zone brique (heuristique : on a un mesh)
      if (slot.mesh && this._hitsBrick(slot, e.clientX, e.clientY)) {
        slot.controls.enabled = false; // bloquer rotation pendant le geste d'assemblage
        const nearSlots = this._nearSlotsForBrick(slot.brickId, e.clientX, e.clientY, slot);
        this._activeGesture = { slotId: slot.id, brickId: slot.brickId, nearSlots,
                                startX: e.clientX, startY: e.clientY, moved: false };
        if (this._onPickStart) this._onPickStart(this._activeGesture);
      } else {
        slot.controls.enabled = true; // zone vide → TrackballControls actif
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._activeGesture) {
        const dx = e.clientX - this._activeGesture.startX;
        const dy = e.clientY - this._activeGesture.startY;
        if (Math.sqrt(dx*dx + dy*dy) > 8) this._activeGesture.moved = true;
      }
    });

    el.addEventListener('pointerup', (e) => {
      ptrs.delete(e.pointerId);
      slot.controls.enabled = true; // toujours réactiver à la fin du geste
      if (this._activeGesture && this._onPickEnd) {
        this._onPickEnd({ ...this._activeGesture, endX: e.clientX, endY: e.clientY });
        this._activeGesture = null;
      }
    });
  }

  // Heuristique : le touch est-il sur la brique (zone centrale du canvas) ?
  _hitsBrick(slot, cx, cy) {
    const rect = slot.canvas.getBoundingClientRect();
    const lx = cx - rect.left, ly = cy - rect.top;
    const mx = rect.width / 2, my = rect.height / 2;
    const r  = Math.min(rect.width, rect.height) * 0.38;
    return Math.sqrt((lx-mx)**2 + (ly-my)**2) < r;
  }

  // Slots de la brique triés par distance au point de contact sur le canvas
  _nearSlotsForBrick(brickId, cx, cy, slot) {
    const bricks = this._loadStore('rbang_bricks');
    const brick  = bricks[brickId];
    if (!brick?.slots?.length) return [];
    const rect   = slot.canvas.getBoundingClientRect();
    // NDC dans le canvas
    const ndcX =  ((cx - rect.left)  / rect.width)  * 2 - 1;
    const ndcY = -((cy - rect.top)   / rect.height) * 2 + 1;
    const touchNDC = new THREE.Vector2(ndcX, ndcY);
    // slot.mesh.position = -geoCenter (appliqué dans _loadBrick par mesh.position.sub(center))
    // Position corrigée d'un slot = s.position + mesh.position = s.position - geoCenter
    const meshPos = slot.mesh ? slot.mesh.position : new THREE.Vector3();
    return brick.slots
      .map(s => {
        // Position monde dans la scène du screen slot pour projection NDC
        const p = new THREE.Vector3(...s.position).add(meshPos);
        p.project(slot.camera);
        const d = touchNDC.distanceTo(new THREE.Vector2(p.x, p.y));
        // Slot avec position corrigée (repère centré = repère de l'instance spawned)
        const corrected = { ...s, position: [s.position[0] + meshPos.x, s.position[1] + meshPos.y, s.position[2] + meshPos.z] };
        return { slot: corrected, dist: d };
      })
      .sort((a, b) => a.dist - b.dist)
      .map(x => x.slot);
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Solveur d'assemblage
// ═══════════════════════════════════════════════════════════════════════════════

class AssemblySolver {
  constructor() {
    this._liaisons = {};
  }

  refresh() {
    try { this._liaisons = JSON.parse(localStorage.getItem('rbang_liaisons') || '{}'); }
    catch { this._liaisons = {}; }
  }

  // Trouver la meilleure liaison compatible entre deux listes de slots (triées par proximité)
  // nearA : slots de la brique source (depuis screen slot), nearB : slots de la brique cible
  solve(nearA, nearB) {
    this.refresh();
    for (const sa of nearA) {
      for (const sb of nearB) {
        const li = this._findLiaison(sa.typeId, sb.typeId);
        if (li) return { slotA: sa, slotB: sb, liaison: li };
      }
    }
    return null;
  }

  // Liaison universelle rotule pour world slot / screen slot
  ballJoint() {
    return { id: '__ball__', name: 'Rotule', dof: [{ type: 'ball', axis: [0,1,0] }] };
  }

  // Vérifie la compatibilité de deux typeIds (public)
  compatible(typeA, typeB) { return this._findLiaison(typeA, typeB); }

  // Diagnostic console quand solve() échoue
  diagnose(nearA, nearB) {
    console.group('[AssemblySolver] solve() → null');
    if (!nearA.length) { console.warn('Brique source : aucun slot défini'); console.groupEnd(); return; }
    if (!nearB.length) { console.warn('Brique cible  : aucun slot défini'); console.groupEnd(); return; }

    const nullA = nearA.filter(s => !s.typeId);
    const nullB = nearB.filter(s => !s.typeId);
    if (nullA.length) console.warn(`Source : ${nullA.length} slot(s) sans typeId`);
    if (nullB.length) console.warn(`Cible  : ${nullB.length} slot(s) sans typeId`);

    const allTypes = new Set(
      Object.values(this._liaisons).flatMap(l => (l.pairs || []).flatMap(p => [p.typeA, p.typeB]))
    );
    if (!allTypes.size) {
      console.warn('rbang_liaisons vide — aucune liaison définie dans la Forge');
    } else {
      const misA = nearA.filter(s => s.typeId && !allTypes.has(s.typeId)).map(s => s.typeId);
      const misB = nearB.filter(s => s.typeId && !allTypes.has(s.typeId)).map(s => s.typeId);
      if (misA.length) console.warn('typeId(s) source absents des liaisons :', misA);
      if (misB.length) console.warn('typeId(s) cible  absents des liaisons :', misB);
    }

    console.warn('typeIds source :', nearA.map(s => s.typeId));
    console.warn('typeIds cible  :', nearB.map(s => s.typeId));
    console.groupEnd();
  }

  _findLiaison(typeA, typeB) {
    for (const li of Object.values(this._liaisons)) {
      for (const pair of (li.pairs || [])) {
        if ((pair.typeA === typeA && pair.typeB === typeB) ||
            (pair.typeA === typeB && pair.typeB === typeA)) return li;
      }
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Instance de brique dans la scène
// ═══════════════════════════════════════════════════════════════════════════════

class BrickInstance {
  constructor(id, brickData, mesh, body, pts) {
    this.id        = id;
    this.brickData = brickData;
    this.mesh      = mesh;
    this.body      = body;      // Rapier body (null avant simulation)
    this.pts       = pts;       // Float32Array pour convexHull
    this.slots     = [];        // slots corrigés pour le centrage géo (position - geoCenter)
    this.geoCenter = new THREE.Vector3(); // décalage bounding-box appliqué à la géo
    this.joints    = [];        // { instanceId, rapierJoint }
    this.origPos   = mesh.position.clone();
    this.origQuat  = mesh.quaternion.clone();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Assembler
// ═══════════════════════════════════════════════════════════════════════════════

export class Assembler {

  constructor(engine) {
    this.engine       = engine;
    this._ui          = [];
    this._instances   = new Map(); // id → BrickInstance
    this._wsm         = null; // WorldSlotManager
    this._ssm         = null; // ScreenSlotManager
    this._solver      = new AssemblySolver();
    this._simulating  = false;
    this._raycaster   = new THREE.Raycaster();
    this._mouse       = new THREE.Vector2(-9999, -9999);
    this._snapHelpers = [];
    this._idSeq       = 0;
    this._connections = []; // { instA, instB, slotA, slotB, liaison }
    this._wsConnections = []; // { wslot, inst, slotA } pour world slots
    this._assemblyJoints = []; // joints Rapier créés pendant l'assemblage (bodies fixed)
    this._simJoints      = []; // joints Rapier créés au démarrage simulation (bodies dynamic)
    this._simWsBodies    = []; // fixed bodies pour world slots
    this._jointMarkers   = []; // { mesh, conn } marqueurs visuels des liaisons
    this._debugStatusEl  = null;
    this._shootBalls     = []; // { mesh, body } balles de tir
    this._shootBtn       = null;
    // Paramètres physique (lus par _startSimulation, modifiables via le panneau)
    this._physParams = {
      solverIterations : 20,
      gravity          : -9.81,
      linearDamping    : 0.8,
      angularDamping   : 2.0,
      density          : 200,
      motorDamping     : 10,
    };
    // Refs vers les contrôles dans le panneau (créés par _setupConfigPanel)
    this._simPanelBtn    = null; // bouton démarrer/arrêter du panneau
    this._simPauseBtn    = null; // bouton pause
    this._simStepOneBtn  = null; // bouton pas-à-pas
    this._clearBtn       = null; // bouton Effacer (pour _toggleSim)
  }

  // ─── Cycle de vie ──────────────────────────────────────────────────────────

  async start() {
    this._setupScene();
    this._setupManagers();
    this._setupUI();
    this._setupEvents();
    this.engine.start();
  }

  stop() {
    this._simulating = false;
    this._wsm.dispose();
    this._ssm.dispose();
    this._clearSnapHelpers();
    this._instances.forEach(inst => {
      this.engine.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
      inst.mesh.material.dispose();
      if (inst.body) this.engine.world.removeRigidBody(inst.body);
    });
    this._instances.clear();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup',   this._onPointerUp);
  }

  // ─── Scène ─────────────────────────────────────────────────────────────────

  _setupScene() {
    const e = this.engine;
    e.addStaticBox(24, 0.5, 24, 0, 0, 0, 0x2a3a2a); // dessus à Y = 0.25
    e.camera.position.set(0, 8, 14);
    e.controls.target.set(0, 0, 0);
    e.controls.update();
  }

  // ─── Managers ──────────────────────────────────────────────────────────────

  _setupManagers() {
    this._wsm = new WorldSlotManager(this.engine.scene);
    this._ssm = new ScreenSlotManager(this.engine.renderer, this.engine.camera);

    this._ssm.onPickStart((gesture) => {
      this._activeGesture = gesture;
    });

    this._ssm.onPickEnd((gesture) => {
      this._activeGesture = null;
      this._handleScreenSlotDrop(gesture);
    });
  }

  // ─── Gestion du drop depuis un screen slot ──────────────────────────────────

  async _handleScreenSlotDrop(gesture) {
    const { brickId, nearSlots, endX, endY } = gesture;

    // Vérifier si le drop est dans la zone principale (hors screen slots)
    if (this._isOverScreenSlot(endX, endY)) return;

    // Mettre à jour le mouse pour le raycaster
    this._mouse.x =  (endX / innerWidth)  * 2 - 1;
    this._mouse.y = -(endY / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    // Tester les briques existantes
    const meshes = [...this._instances.values()].map(i => i.mesh);
    const hits   = this._raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      // Drop sur une brique → assembler
      const targetMesh = hits[0].object;
      const targetInst = [...this._instances.values()].find(i => i.mesh === targetMesh);
      if (targetInst) {
        await this._assembleTo(brickId, nearSlots, targetInst, endX, endY);
        return;
      }
    }

    // Drop dans le vide → créer world slot + placer la brique
    const pt = this._wsm.raycastPlane(this._raycaster);
    if (pt) {
      const wslot   = this._wsm.add(pt);
      const inst    = await this._spawnBrick(brickId, wslot.position);
      if (inst) {
        this._wsm.bind(wslot, inst.id);
        // Le slot source le plus proche = premier de nearSlots
        const nearSlots = gesture.nearSlots || [];
        this._wsConnections.push({ wslot, inst, slotA: nearSlots[0] ?? null });
      }
    }
  }

  // ─── Assembler une brique sur une instance existante ────────────────────────

  async _assembleTo(brickId, nearSlotsA, targetInst, endX, endY) {
    const nearSlotsB = this._nearSlotsOfInstance(targetInst, endX, endY);
    this._solver.refresh();
    const result = this._solver.solve(nearSlotsA, nearSlotsB);

    const bricks = this._loadStore('rbang_bricks');
    const brick  = bricks[brickId];
    if (!brick) return;

    if (result) {
      const snapTransform = this._computeSnapTransform(result.slotA, result.slotB, targetInst);
      const inst = await this._spawnBrick(brickId, null, snapTransform);
      if (inst) {
        const conn = { instA: inst, instB: targetInst,
                       slotA: result.slotA, slotB: result.slotB,
                       liaison: result.liaison };
        this._connections.push(conn);
        this._makeJoint(conn, this._assemblyJoints);
        this._addJointMarker(conn);
        // Détection implicites induites par le nouveau placement
        this._registerImplicitConnectionsFor(inst);
        this._showSnapHelper(inst.mesh.position.clone());
        this._updateCount();
      }
    } else {
      // Pas de liaison compatible → diagnostic console + placer à côté
      this._solver.diagnose(nearSlotsA, nearSlotsB);
      const pos = targetInst.mesh.position.clone().add(new THREE.Vector3(2, 0, 0));
      await this._spawnBrick(brickId, pos);
    }
  }

  // ─── Spawn d'une brique dans la scène ───────────────────────────────────────

  // pos : Vector3 pour world slot (sol), snapTransform : { position, quaternion } pour snap slot
  async _spawnBrick(brickId, pos, snapTransform = null) {
    const bricks = this._loadStore('rbang_bricks');
    const brick  = bricks[brickId];
    if (!brick) return null;
    try {
      const shapes = this._loadStore('rbang_shapes');
      const data   = shapes[brick.shapeRef];
      if (!data?.steps || !data.rootId) return null;
      const M     = await getManifold();
      const cache = buildCache(data.steps, M);
      const mf    = cache.get(data.rootId);
      if (!mf) return null;
      const { geo } = manifoldToGeometry(mf);
      const ptsRaw  = manifoldToPoints(mf);
      const color   = parseInt((brick.color || '#888888').replace('#', ''), 16);
      const mesh    = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
      mesh.castShadow = mesh.receiveShadow = true;

      // ── Centrer la géométrie sur l'origine du mesh ──────────────────────────
      // Les slots sont définis dans le repère centré de la Forge → on aligne ici
      const box    = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      geo.translate(-center.x, -center.y, -center.z);
      geo.boundingBox = null; // invalider le cache après translate
      // Décaler pts en cohérence
      const pts = new Float32Array(ptsRaw.length);
      for (let i = 0; i < ptsRaw.length; i += 3) {
        pts[i]   = ptsRaw[i]   - center.x;
        pts[i+1] = ptsRaw[i+1] - center.y;
        pts[i+2] = ptsRaw[i+2] - center.z;
      }

      if (snapTransform) {
        mesh.position.copy(snapTransform.position);
        mesh.quaternion.copy(snapTransform.quaternion);
      } else {
        // Poser la brique sur le plan world slot — calculé depuis la box originale (évite le cache périmé)
        mesh.position.set(pos.x, this._wsm._y - (box.min.y - center.y), pos.z);
      }
      this.engine.scene.add(mesh);
      const id   = `bi-${++this._idSeq}`;
      const inst = new BrickInstance(id, brick, mesh, null, pts);
      inst.geoCenter = center.clone();
      inst.slots = (brick.slots || []).map(s => ({
        ...s,
        position: [s.position[0] - center.x, s.position[1] - center.y, s.position[2] - center.z],
      }));

      // Corps Rapier fixed immédiatement (sera converti en dynamic à la simulation)
      const R = this.engine.R;
      const world = this.engine.world;
      const { x, y, z } = mesh.position;
      const q = mesh.quaternion;
      const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z));
      body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      const cd = (R.ColliderDesc.convexHull(pts) ?? R.ColliderDesc.ball(0.5))
        .setRestitution(0.2).setFriction(0.6);
      world.createCollider(cd, body);
      inst.body = body;

      this._instances.set(id, inst);
      this._updateCount();
      return inst;
    } catch (e) {
      console.error('Spawn error', e);
      return null;
    }
  }

  // ─── Slots d'une instance proches d'un point écran ──────────────────────────

  _nearSlotsOfInstance(inst, cx, cy) {
    const slots = inst.slots.length ? inst.slots : (inst.brickData.slots || []);
    if (!slots.length) return [];
    const ndcX =  (cx / innerWidth)  * 2 - 1;
    const ndcY = -(cy / innerHeight) * 2 + 1;
    const touch = new THREE.Vector2(ndcX, ndcY);
    return slots
      .map(s => {
        const wp = new THREE.Vector3(...s.position)
          .applyQuaternion(inst.mesh.quaternion)
          .add(inst.mesh.position);
        wp.project(this.engine.camera);
        const d = touch.distanceTo(new THREE.Vector2(wp.x, wp.y));
        return { slot: s, dist: d };
      })
      .sort((a, b) => a.dist - b.dist)
      .map(x => x.slot);
  }

  // ─── Position de snap ────────────────────────────────────────────────────────

  // Formule : newBrick.worldMatrix = targetSlot.worldMatrix × inverse(sourceSlot.localMatrix)
  // (même mécanique que l'ancien assembleur briques.js)
  _computeSnapTransform(slotA, slotB, targetInst) {
    const one = new THREE.Vector3(1, 1, 1);

    // Matrice monde de la brique cible
    const tbrickMat = new THREE.Matrix4().compose(
      targetInst.mesh.position, targetInst.mesh.quaternion, one
    );
    // Matrice locale du slot cible (B)
    const tslotMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...slotB.position),
      new THREE.Quaternion(...slotB.quaternion),
      one
    );
    // Matrice monde du slot cible
    const tgtWorldMat = new THREE.Matrix4().multiplyMatrices(tbrickMat, tslotMat);

    // Matrice locale du slot source (A) — inversée
    const sslotMatInv = new THREE.Matrix4().compose(
      new THREE.Vector3(...slotA.position),
      new THREE.Quaternion(...slotA.quaternion),
      one
    ).invert();

    // Matrice monde de la nouvelle brique
    const newMat = new THREE.Matrix4().multiplyMatrices(tgtWorldMat, sslotMatInv);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    newMat.decompose(position, quaternion, scale);
    return { position, quaternion };
  }

  // ─── Trackball sur un world slot ─────────────────────────────────────────────

  _startWorldSlotTrackball(wslot, e) {
    // Rotation autour de l'axe vertical du world slot
    // Déléguer à un simple pivot Y autour de wslot.position
    const pivot   = wslot.position.clone();
    const startX  = e.clientX;
    let   lastX   = startX;

    const onMove = (ev) => {
      const dx   = ev.clientX - lastX;
      lastX      = ev.clientX;
      const angle = dx * 0.01;
      // Faire pivoter toutes les instances liées
      if (wslot.brickInstanceId) {
        const inst = this._instances.get(wslot.brickInstanceId);
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
    };
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

      // Priorité 1 : brique existante
      const meshes = [...this._instances.values()].map(i => i.mesh);
      const hits   = this._raycaster.intersectObjects(meshes, false);
      if (hits.length > 0) return; // OrbitControls gère

      // Priorité 2 : world slot proche
      const pt = this._wsm.raycastPlane(this._raycaster);
      if (pt) {
        const nearest = this._wsm.nearest(pt, this._wsm.SNAP_R);
        if (nearest) {
          e.stopPropagation();
          this._startWorldSlotTrackball(nearest, e);
          return;
        }
      }
      // Sinon : OrbitControls gère la caméra
    };

    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
  }

  // ─── Simulation ──────────────────────────────────────────────────────────────

  _startSimulation() {
    this._simulating = true;
    const R = this.engine.R;
    const world = this.engine.world;

    // 1. Supprimer tous les joints d'assemblage existants
    for (const j of this._assemblyJoints) {
      try { world.removeImpulseJoint(j, true); } catch {}
    }
    this._assemblyJoints = [];

    // 2. Connexions implicites restantes → enregistrement + marqueurs seulement,
    //    les joints seront créés à l'étape 4 sur les corps dynamic
    this._registerImplicitConnections();
    // Supprimer les joints créés par _registerImplicitConnections (sur corps encore fixed)
    for (const j of this._assemblyJoints) {
      try { world.removeImpulseJoint(j, true); } catch {}
    }
    this._assemblyJoints = [];

    // 3. Appliquer les paramètres physique du panneau
    const pp = this._physParams;
    world.numSolverIterations = pp.solverIterations;
    world.gravity = { x: 0, y: pp.gravity, z: 0 };
    for (const inst of this._instances.values()) {
      inst.origPos  = inst.mesh.position.clone();
      inst.origQuat = inst.mesh.quaternion.clone();
      try { world.removeRigidBody(inst.body); } catch {}
      const { x, y, z } = inst.origPos;
      const q = inst.origQuat;
      const newBody = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setLinearDamping(pp.linearDamping)
          .setAngularDamping(pp.angularDamping)
      );
      newBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      const cd = (R.ColliderDesc.convexHull(inst.pts) ?? R.ColliderDesc.ball(0.5))
        .setRestitution(0).setFriction(0.8).setDensity(pp.density);
      world.createCollider(cd, newBody);
      // Appliquer les groupes de collision directement sur le collider (plus fiable que via desc)
      const simCol = newBody.collider(0);
      if (simCol) {
        simCol.setCollisionGroups(BRICK_SIM_GROUPS);
        console.debug('[sim col groups]', simCol.collisionGroups()?.toString(16));
      } else {
        console.warn('[sim] collider(0) null');
      }
      inst.body = newBody;
      this.engine._bodies.push({ mesh: inst.mesh, body: inst.body, isStatic: false });
    }

    // 4. Créer les joints sim sur les corps dynamic
    for (const conn of this._connections) {
      this._makeJoint(conn, this._simJoints);
    }
  }

  // ─── Joint + marqueur immédiat (assemblage ou simulation) ────────────────────

  // Crée un joint Rapier pour une connexion et l'ajoute au tableau cible
  _makeJoint(conn, targetArray) {
    const R = this.engine.R;
    const world = this.engine.world;
    const { instA, instB, slotA, slotB, liaison } = conn;
    if (!instA.body || !instB.body) return;
    try {
      // Diagnostic : vérifier cohérence mesh ↔ body
      const bta = instA.body.translation(), bra = instA.body.rotation();
      const btb = instB.body.translation(), brb = instB.body.rotation();
      const qaM = instA.mesh.quaternion, qbM = instB.mesh.quaternion;
      const paM = instA.mesh.position,   pbM = instB.mesh.position;
      // Ancres en espace monde (doivent coïncider pour un joint valide)
      const wA = new THREE.Vector3(...slotA.position).applyQuaternion(qaM).add(paM);
      const wB = new THREE.Vector3(...slotB.position).applyQuaternion(qbM).add(pbM);
      const delta = wA.distanceTo(wB);
      console.debug('[joint]', liaison?.name, {
        slotA_local: slotA.position.map(v=>v.toFixed(3)),
        slotB_local: slotB.position.map(v=>v.toFixed(3)),
        ancA_world: `${wA.x.toFixed(3)},${wA.y.toFixed(3)},${wA.z.toFixed(3)}`,
        ancB_world: `${wB.x.toFixed(3)},${wB.y.toFixed(3)},${wB.z.toFixed(3)}`,
        delta: delta.toFixed(4),
      });
      const j = this._createJoint(
        R, world,
        instA.body, instB.body,
        slotA, slotB, liaison,
        instA.mesh.quaternion, instB.mesh.quaternion
      );
      if (j) targetArray.push(j);
    } catch (e) { console.warn('_makeJoint error', e); }
  }

  // Ajoute un marqueur disque à la position monde du slot de la connexion
  _addJointMarker(conn) {
    const { instA, slotA, implicit } = conn;
    const color = implicit ? C.jointImplicit : C.jointExplicit;
    const geo = new THREE.CylinderGeometry(0.75, 0.75, 0.06, 32);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const marker = new THREE.Mesh(geo, mat);
    // Position monde du slot A
    const wp = new THREE.Vector3(...slotA.position)
      .applyQuaternion(instA.mesh.quaternion)
      .add(instA.mesh.position);
    marker.position.copy(wp);
    // Orientation : disque perpendiculaire à l'axe de DOF (pivot/glissière)
    // ou à la normale du slot (soudure / pas de DOF)
    const dofs = conn.liaison?.dof ?? [];
    const hasDofAxis = dofs.length === 1 && dofs[0].axis;
    if (hasDofAxis) {
      // Axe monde = (quatBrique_B × quatSlot_B) × dof.axis
      // Le dof.axis est défini dans le repère du slot, pas du brick directement
      const rawAxis = new THREE.Vector3(...dofs[0].axis).normalize();
      const slotBQ = new THREE.Quaternion(...conn.slotB.quaternion);
      const worldSlotBQ = slotBQ.clone().premultiply(conn.instB.mesh.quaternion.clone());
      const axisWorld = rawAxis.clone().applyQuaternion(worldSlotBQ).normalize();
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisWorld);
    } else if (slotA.quaternion) {
      const slotQ = new THREE.Quaternion(...slotA.quaternion);
      const worldQ = slotQ.premultiply(instA.mesh.quaternion.clone());
      marker.quaternion.copy(worldQ).multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
      );
    }
    this.engine.scene.add(marker);
    this._jointMarkers.push({ mesh: marker, conn });
  }

  // Supprime les marqueurs des connexions implicites
  _clearImplicitMarkers() {
    this._jointMarkers = this._jointMarkers.filter(({ mesh, conn }) => {
      if (!conn.implicit) return true;
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose(); mesh.material.dispose();
      return false;
    });
  }

  // ─── Création d'un joint Rapier selon la liaison ──────────────────────────────

  _createJoint(R, world, bodyA, bodyB, slotA, slotB, liaison, quatAMesh, quatBMesh) {
    const ancA = { x: slotA.position[0], y: slotA.position[1], z: slotA.position[2] };
    const ancB = { x: slotB.position[0], y: slotB.position[1], z: slotB.position[2] };
    const dofs = liaison?.dof ?? [];

    let jd;
    const isWeld = liaison?.type === 'weld';

    if (isWeld || dofs.length === 0) {
      const qa = new THREE.Quaternion(...slotA.quaternion);
      const qb = new THREE.Quaternion(...slotB.quaternion);
      jd = R.JointData.fixed(ancA, { x: qa.x, y: qa.y, z: qa.z, w: qa.w },
                              ancB, { x: qb.x, y: qb.y, z: qb.z, w: qb.w });
    } else if (dofs.length === 1) {
      const dof = dofs[0];
      // dof.axis est défini dans le repère du SLOT (pas du brick directement).
      // Axe monde = (quatB_mesh × quatSlot_B) × dof.axis
      const quatA = quatAMesh ?? (() => { const q = bodyA.rotation(); return new THREE.Quaternion(q.x, q.y, q.z, q.w); })();
      const quatB = quatBMesh ?? (() => { const q = bodyB.rotation(); return new THREE.Quaternion(q.x, q.y, q.z, q.w); })();
      const rawAxis   = new THREE.Vector3(...(dof.axis ?? [0, 0, 1]));
      const slotBQ    = new THREE.Quaternion(...slotB.quaternion);
      const worldSlotBQ = slotBQ.clone().premultiply(quatB.clone());
      const axisWorld = rawAxis.clone().applyQuaternion(worldSlotBQ).normalize();
      // axB : axe dans le repère local du brick B = slotBQ × dof.axis
      const axB = rawAxis.clone().applyQuaternion(slotBQ).normalize();
      // axA : même axe physique exprimé dans le repère local du brick A
      const axA = axisWorld.clone().applyQuaternion(quatA.clone().invert());
      const vA  = { x: axA.x, y: axA.y, z: axA.z };
      const vB  = { x: axB.x, y: axB.y, z: axB.z };
      switch (dof.type) {
        case 'rotation':    jd = R.JointData.revolute(ancA, ancB, vA);   break;
        case 'translation': jd = R.JointData.prismatic(ancA, ancB, vA);  break;
        case 'ball':        jd = R.JointData.spherical(ancA, ancB);       break;
        case 'cylindrical': jd = R.JointData.revolute(ancA, ancB, vA);   break;
        default:            jd = R.JointData.spherical(ancA, ancB);
      }
    } else {
      jd = R.JointData.spherical(ancA, ancB);
    }

    const joint = world.createImpulseJoint(jd, bodyA, bodyB, true);

    // Amortissement DDL libre : absorbe l'énergie d'impact (plancher motorDamping)
    if (dofs.length === 1) {
      let axis = null;
      switch (dofs[0].type) {
        case 'rotation':    axis = R.JointAxis.AngX; break;
        case 'cylindrical': axis = R.JointAxis.AngX; break;
        case 'translation': axis = R.JointAxis.LinX; break;
      }
      if (axis !== null) {
        const damping = Math.max(dofs[0].damping ?? 0, this._physParams.motorDamping);
        joint.configureMotorVelocity(axis, 0, damping);
      }
    }

    return joint;
  }

  _stopSimulation() {
    const R = this.engine.R;
    const world = this.engine.world;
    world.numSolverIterations = 4; // restaurer la valeur par défaut

    // 1. Supprimer les joints sim
    for (const j of this._simJoints) {
      try { world.removeImpulseJoint(j, true); } catch {}
    }
    this._simJoints = [];

    // 2. (world slots : pas de corps séparés créés, rien à supprimer)
    this._simWsBodies = [];

    // 3. Supprimer les balles de tir
    for (const { mesh, body } of this._shootBalls) {
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose(); mesh.material.dispose();
      try { world.removeRigidBody(body); } catch {}
      const idx = this.engine._bodies.findIndex(b => b.body === body);
      if (idx !== -1) this.engine._bodies.splice(idx, 1);
    }
    this._shootBalls = [];

    // 4. Retirer les connexions implicites + leurs marqueurs
    this._clearImplicitMarkers();
    this._connections = this._connections.filter(c => !c.implicit);

    // 5. Restaurer positions mesh + recréer corps fixed
    for (const inst of this._instances.values()) {
      const idx = this.engine._bodies.findIndex(b => b.body === inst.body);
      if (idx !== -1) this.engine._bodies.splice(idx, 1);
      inst.mesh.position.copy(inst.origPos);
      inst.mesh.quaternion.copy(inst.origQuat);
      try { world.removeRigidBody(inst.body); } catch {}
      const { x, y, z } = inst.origPos;
      const q = inst.origQuat;
      const newBody = world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(x, y, z)
      );
      newBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      const cd = (R.ColliderDesc.convexHull(inst.pts) ?? R.ColliderDesc.ball(0.5))
        .setRestitution(0.2).setFriction(0.6);
      world.createCollider(cd, newBody);
      inst.body = newBody;
    }

    // 6. Recréer les joints assembly pour les connexions explicites restantes
    for (const conn of this._connections) {
      this._makeJoint(conn, this._assemblyJoints);
    }

    this._simulating = false;
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
      .asm-panel {
        position:fixed; left:0; top:0; bottom:0; width:160px;
        background:${C.bg}; border-right:1px solid ${C.border};
        display:flex; flex-direction:column; z-index:55;
        font-family:sans-serif; font-size:12px;
      }
      .asm-panel-head {
        padding:6px 8px; border-bottom:1px solid ${C.border};
        color:${C.dim}; font-size:10px; text-transform:uppercase;
        letter-spacing:.08em; flex-shrink:0;
      }
      .asm-brick-list { flex:1; overflow-y:auto; padding:4px 0; }
      .asm-brick-list::-webkit-scrollbar { width:4px; }
      .asm-brick-list::-webkit-scrollbar-thumb { background:${C.border}; }
      .asm-brick-item {
        padding:5px 10px; cursor:pointer; color:${C.dim};
        border-left:2px solid transparent;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .asm-brick-item:active { background:#ffffff10; }
      .asm-brick-item.loaded { color:${C.fg}; border-left-color:${C.accent}; }
      .asm-footer {
        position:fixed; bottom:${SS_H * 2 + SS_PAD * 3 + 10}px; right:12px;
        display:flex; gap:8px; z-index:56;
      }
      .asm-btn {
        padding:8px 16px; border:1px solid ${C.border}; border-radius:2px;
        background:${C.bg}; color:${C.fg}; font:12px sans-serif; cursor:pointer;
        box-shadow:inset 0 1px 0 #ffffff18, 0 2px 4px rgba(0,0,0,.4);
      }
      .asm-btn:active { box-shadow:inset 0 2px 4px rgba(0,0,0,.4); }
      .asm-btn.primary { background:#3a5a6a; border-color:#5a8aaa; color:#d0eaf8; }
      .asm-btn.danger  { background:#5a2a2a; border-color:#8a4a4a; color:#f8d0d0; }
      .asm-bar {
        position:fixed; top:0; left:160px; right:0; height:28px;
        background:${C.bgDark}cc; border-bottom:1px solid ${C.border};
        display:flex; align-items:center; padding:0 12px;
        gap:1.5rem; z-index:54; pointer-events:none;
        font:10px sans-serif; color:${C.dim};
      }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // ── Panneau gauche ────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'asm-panel';
    const head = document.createElement('div');
    head.className = 'asm-panel-head';
    head.textContent = 'Briques';
    this._listEl = document.createElement('div');
    this._listEl.className = 'asm-brick-list';
    panel.append(head, this._listEl);
    document.body.appendChild(panel);
    this._ui.push(panel);

    this._populateBrickList();

    // ── Barre du haut ─────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'asm-bar';
    this._countEl = document.createElement('span');
    bar.appendChild(this._countEl);
    document.body.appendChild(bar);
    this._ui.push(bar);

    // ── Boutons bas ───────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'asm-footer';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'asm-btn danger';
    clearBtn.textContent = 'Effacer';
    clearBtn.addEventListener('click', () => { if (!this._simulating) this._clearAll(); });

    this._clearBtn = clearBtn; // référence pour _toggleSim et _setupConfigPanel

    this._simBtn = document.createElement('button');
    this._simBtn.className = 'asm-btn primary';
    this._simBtn.textContent = '▶ Simuler';
    this._simBtn.addEventListener('click', () => this._toggleSim());

    footer.append(clearBtn, this._simBtn);
    document.body.appendChild(footer);
    this._ui.push(footer);

    // ── Bouton tir (visible seulement en simulation) ───────────────────────────
    this._shootBtn = document.createElement('button');
    this._shootBtn.className = 'asm-btn';
    this._shootBtn.textContent = '●';
    this._shootBtn.title = 'Tirer une balle';
    this._shootBtn.style.cssText = [
      'position:fixed', 'right:12px',
      `bottom:${SS_H * 2 + SS_PAD * 3 + 56}px`,
      'width:44px', 'height:44px', 'padding:0',
      'border-radius:50%', 'font-size:20px',
      'display:none', 'z-index:56',
      'background:#4a3a2a', 'border-color:#8a6a4a', 'color:#f8e4c0',
    ].join(';');
    const shoot = () => {
      if (!this._simulating) return;
      const dir = new THREE.Vector3();
      this.engine.camera.getWorldDirection(dir);
      const p = this.engine.camera.position;
      const { mesh, body } = this.engine.addDynamicSphere(0.18, p.x, p.y, p.z, 0xddaa55, 1.5);
      body.setLinvel({ x: dir.x * 28, y: dir.y * 28, z: dir.z * 28 }, true);
      this._shootBalls.push({ mesh, body });
    };
    this._shootBtn.addEventListener('click', shoot);
    this._shootBtn.addEventListener('touchstart', e => { e.preventDefault(); shoot(); }, { passive: false });
    document.body.appendChild(this._shootBtn);
    this._ui.push(this._shootBtn);

    // (pause/step gérés dans _setupConfigPanel)

    // ── Panneau de configuration ──────────────────────────────────────────────
    this._setupConfigPanel();

    // ── onUpdate ──────────────────────────────────────────────────────────────
    this.engine.onUpdate = () => {
      const n = this._instances.size;
      const c = n ? this._componentCount() : 0;
      this._countEl.textContent = `Briques : ${n}` + (n ? `  |  Composants : ${c}` : '');
      if (this._debugStatusEl) {
        const conn = this._connections.length;
        this._debugStatusEl.textContent =
          `Briques : ${n}\nLiaisons : ${conn}\nComposants : ${c}`;
      }
      // Mise à jour des marqueurs de liaison pendant la simulation
      if (this._simulating) {
        for (const { mesh: marker, conn } of this._jointMarkers) {
          const { instA, slotA } = conn;
          // Position monde du slot A (mesh déjà sync depuis le body Rapier)
          marker.position.set(...slotA.position)
            .applyQuaternion(instA.mesh.quaternion)
            .add(instA.mesh.position);
          // Orientation
          const dofs = conn.liaison?.dof ?? [];
          if (dofs.length === 1 && dofs[0].axis) {
            const slotBQ = new THREE.Quaternion(...conn.slotB.quaternion);
            const worldSlotBQ = slotBQ.clone().premultiply(conn.instB.mesh.quaternion.clone());
            const axisWorld = new THREE.Vector3(...dofs[0].axis).normalize()
              .applyQuaternion(worldSlotBQ).normalize();
            marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisWorld);
          } else {
            const slotQ = new THREE.Quaternion(...slotA.quaternion);
            marker.quaternion.copy(slotQ.premultiply(instA.mesh.quaternion.clone()))
              .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
          }
        }
      }

      // Nettoyage des balles hors scène (Y < -20)
      this._shootBalls = this._shootBalls.filter(({ mesh, body }) => {
        if (body.translation().y < -20) {
          this.engine.scene.remove(mesh);
          mesh.geometry.dispose(); mesh.material.dispose();
          this.engine.world.removeRigidBody(body);
          const idx = this.engine._bodies.findIndex(b => b.body === body);
          if (idx !== -1) this.engine._bodies.splice(idx, 1);
          return false;
        }
        return true;
      });
    };
  }

  _setupConfigPanel() {
    const panel = document.createElement('div');
    panel.className = 'asm-config';
    panel.style.cssText = [
      'position:fixed', 'right:12px', 'top:36px',
      `background:${C.bg}`, `border:1px solid ${C.border}`,
      'border-radius:2px', 'padding:8px 10px',
      'z-index:60', 'font:11px sans-serif', `color:${C.fg}`,
      'min-width:180px', 'pointer-events:auto',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)',
    ].join(';');

    // ── Helpers ────────────────────────────────────────────────────────────────
    const makeSection = txt => {
      const s = document.createElement('div');
      s.style.cssText = [
        'font-size:9px', `color:${C.dim}`,
        'text-transform:uppercase', 'letter-spacing:.08em',
        'margin:8px 0 4px',
      ].join(';');
      s.textContent = txt;
      return s;
    };

    // Crée une ligne label + slider + valeur
    // isInt : si true, affiche entier ; fmt : fn optionnelle (v => string)
    const makeSlider = (label, min, max, step, init, onChange, fmt) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:3px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};flex-shrink:0;min-width:90px;font-size:10px;`;
      const sl = document.createElement('input');
      sl.type = 'range';
      sl.min = String(min); sl.max = String(max); sl.step = String(step);
      sl.value = String(init);
      sl.style.cssText = 'flex:1;cursor:pointer;accent-color:' + C.accent + ';';
      const display = fmt ?? (v => Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2));
      const val = document.createElement('span');
      val.textContent = display(init);
      val.style.cssText = [
        `color:${C.accent}`, 'min-width:34px', 'text-align:right',
        'font-variant-numeric:tabular-nums', 'font-size:10px',
      ].join(';');
      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value);
        val.textContent = display(v);
        onChange(v);
      });
      row.append(lbl, sl, val);
      return row;
    };

    const pp = this._physParams;

    // ── Assemblage ─────────────────────────────────────────────────────────────
    panel.append(makeSection('Assemblage'));
    panel.append(makeSlider('Plan Y', -2, 5, 0.05, this._wsm._y, v => {
      this._wsm.setY(v);
    }));

    // ── Moteur physique ────────────────────────────────────────────────────────
    panel.append(makeSection('Moteur physique'));
    panel.append(makeSlider('Solver iter.', 1, 50, 1, pp.solverIterations, v => {
      pp.solverIterations = v;
      if (this._simulating) this.engine.world.numSolverIterations = v;
    }));
    panel.append(makeSlider('Gravité', -30, 0, 0.1, pp.gravity, v => {
      pp.gravity = v;
      if (this._simulating) this.engine.world.gravity = { x: 0, y: v, z: 0 };
    }));
    panel.append(makeSlider('Amort. lin.', 0, 5, 0.05, pp.linearDamping, v => {
      pp.linearDamping = v;
      if (this._simulating) {
        for (const inst of this._instances.values())
          if (inst.body) inst.body.setLinearDamping(v);
      }
    }));
    panel.append(makeSlider('Amort. ang.', 0, 20, 0.1, pp.angularDamping, v => {
      pp.angularDamping = v;
      if (this._simulating) {
        for (const inst of this._instances.values())
          if (inst.body) inst.body.setAngularDamping(v);
      }
    }));

    // ── Briques sim ────────────────────────────────────────────────────────────
    panel.append(makeSection('Briques sim'));
    panel.append(makeSlider('Densité', 10, 500, 10, pp.density, v => {
      pp.density = v;
      if (this._simulating) {
        for (const inst of this._instances.values()) {
          if (inst.body) { const col = inst.body.collider(0); if (col) col.setDensity(v); }
        }
      }
    }));
    panel.append(makeSlider('Damping moteur', 0, 50, 1, pp.motorDamping, v => {
      pp.motorDamping = v;
      // Appliqué aux nouveaux joints au prochain lancement
    }));

    // ── Simulation ─────────────────────────────────────────────────────────────
    panel.append(makeSection('Simulation'));

    // Ligne 1 : démarrer / arrêter
    const panelSimBtn = document.createElement('button');
    panelSimBtn.className = 'asm-btn primary';
    panelSimBtn.textContent = '▶ Simuler';
    panelSimBtn.style.cssText = 'width:100%;margin-bottom:4px;padding:4px 0;font-size:11px;';
    panelSimBtn.addEventListener('click', () => this._toggleSim());
    panelSimBtn.addEventListener('touchstart', e => { e.preventDefault(); this._toggleSim(); }, { passive: false });
    panel.append(panelSimBtn);
    this._simPanelBtn = panelSimBtn;

    // Ligne 2 : pause / pas-à-pas
    const ctrlRow = document.createElement('div');
    ctrlRow.style.cssText = 'display:flex;gap:5px;margin-bottom:3px;';

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'asm-btn';
    pauseBtn.textContent = '⏸';
    pauseBtn.title = 'Pause physique';
    pauseBtn.disabled = true;
    pauseBtn.style.cssText = 'flex:1;padding:3px 0;font-size:14px;';

    const stepBtn = document.createElement('button');
    stepBtn.className = 'asm-btn';
    stepBtn.textContent = '⏭ Pas';
    stepBtn.title = 'Avancer d\'un pas (1/60 s)';
    stepBtn.disabled = true;
    stepBtn.style.cssText = 'flex:1;padding:3px 0;font-size:11px;';

    const doPause = () => {
      if (!this._simulating) return;
      const eng = this.engine;
      eng.physPaused = !eng.physPaused;
      pauseBtn.textContent = eng.physPaused ? '▶' : '⏸';
      pauseBtn.title = eng.physPaused ? 'Reprendre' : 'Pause physique';
      stepBtn.disabled = !eng.physPaused;
    };
    const doStep = () => {
      if (!this._simulating || !this.engine.physPaused) return;
      this.engine.stepOnce();
    };

    pauseBtn.addEventListener('click', doPause);
    pauseBtn.addEventListener('touchstart', e => { e.preventDefault(); doPause(); }, { passive: false });
    stepBtn.addEventListener('click', doStep);
    stepBtn.addEventListener('touchstart', e => { e.preventDefault(); doStep(); }, { passive: false });

    ctrlRow.append(pauseBtn, stepBtn);
    panel.append(ctrlRow);

    this._simPauseBtn   = pauseBtn;
    this._simStepOneBtn = stepBtn;

    // ── Statut ─────────────────────────────────────────────────────────────────
    const sep = document.createElement('div');
    sep.style.cssText = `border-top:1px solid ${C.border};margin:8px 0 6px;`;

    this._debugStatusEl = document.createElement('div');
    this._debugStatusEl.style.cssText = `color:${C.dim};font-size:10px;line-height:1.6;`;
    this._debugStatusEl.textContent = 'Composants : —';

    panel.append(sep, this._debugStatusEl);
    document.body.appendChild(panel);
    this._ui.push(panel);
  }

  _populateBrickList() {
    this._listEl.innerHTML = '';
    const bricks = this._loadStore('rbang_bricks');
    for (const [id, brick] of Object.entries(bricks)) {
      const item = document.createElement('div');
      item.className = 'asm-brick-item';
      item.textContent = brick.name || id;
      item.dataset.brickId = id;
      item.addEventListener('click', async () => {
        if (item.classList.contains('loaded')) {
          this._ssm.remove(id);
          item.classList.remove('loaded');
        } else {
          await this._ssm.add(id);
          item.classList.add('loaded');
        }
      });
      this._listEl.appendChild(item);
    }
    if (!Object.keys(bricks).length) {
      const empty = document.createElement('div');
      empty.style.cssText = `padding:10px 8px;color:${C.dim};font-size:10px;`;
      empty.textContent = 'Aucune brique dans la forge.';
      this._listEl.appendChild(empty);
    }
  }

  _toggleSim() {
    if (!this._simulating) {
      if (!this._instances.size) return;
      this._startSimulation();
      const label = '⏹ Arrêter';
      this._simBtn.textContent = label;
      this._simBtn.classList.remove('primary');
      this._simBtn.classList.add('danger');
      if (this._simPanelBtn) {
        this._simPanelBtn.textContent = label;
        this._simPanelBtn.classList.remove('primary');
        this._simPanelBtn.classList.add('danger');
      }
      if (this._clearBtn) this._clearBtn.disabled = true;
      if (this._shootBtn) this._shootBtn.style.display = 'block';
      if (this._simPauseBtn)   this._simPauseBtn.disabled   = false;
      if (this._simStepOneBtn) this._simStepOneBtn.disabled  = true;
    } else {
      this._stopSimulation();
      const label = '▶ Simuler';
      this._simBtn.textContent = label;
      this._simBtn.classList.add('primary');
      this._simBtn.classList.remove('danger');
      if (this._simPanelBtn) {
        this._simPanelBtn.textContent = label;
        this._simPanelBtn.classList.add('primary');
        this._simPanelBtn.classList.remove('danger');
      }
      if (this._clearBtn) this._clearBtn.disabled = false;
      if (this._shootBtn) this._shootBtn.style.display = 'none';
      if (this._simPauseBtn) {
        this._simPauseBtn.textContent = '⏸';
        this._simPauseBtn.title = 'Pause physique';
        this._simPauseBtn.disabled = true;
      }
      if (this._simStepOneBtn) this._simStepOneBtn.disabled = true;
      this.engine.physPaused = false;
    }
  }

  _clearAll() {
    // Supprimer tous les joints assembly
    for (const j of this._assemblyJoints) {
      try { this.engine.world.removeImpulseJoint(j, true); } catch {}
    }
    this._assemblyJoints = [];

    // Supprimer tous les marqueurs visuels
    for (const { mesh } of this._jointMarkers) {
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose(); mesh.material.dispose();
    }
    this._jointMarkers = [];

    for (const inst of [...this._instances.values()]) {
      this.engine.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
      inst.mesh.material.dispose();
      if (inst.body) this.engine.world.removeRigidBody(inst.body);
    }
    this._instances.clear();
    this._connections    = [];
    this._wsConnections  = [];
    // Libérer les world slots
    for (const ws of [...this._wsm.slots]) this._wsm.unbind(ws);
    this._updateCount();
  }

  // ─── Détection de connexions implicites (clipping spatial) ──────────────────

  // Seuil de proximité pour considérer deux slots comme coïncidents (unités scène)
  static CLIP_DIST = 0.12;

  // Transforme la position locale d'un slot en coordonnées monde
  _slotWorldPos(slot, inst) {
    return new THREE.Vector3(...slot.position)
      .applyQuaternion(inst.mesh.quaternion)
      .add(inst.mesh.position);
  }

  // Cherche la première paire de slots coïncidents + compatibles entre deux instances
  // Retourne { slotA, slotB, liaison } ou null
  _isClipped(instA, instB) {
    this._solver.refresh();
    const slotsA = instA.slots.length ? instA.slots : (instA.brickData.slots || []);
    const slotsB = instB.slots.length ? instB.slots : (instB.brickData.slots || []);
    for (const sA of slotsA) {
      if (!sA.typeId) continue;
      const posA = this._slotWorldPos(sA, instA);
      for (const sB of slotsB) {
        if (!sB.typeId) continue;
        if (posA.distanceTo(this._slotWorldPos(sB, instB)) < Assembler.CLIP_DIST) {
          const li = this._solver.compatible(sA.typeId, sB.typeId);
          if (li) return { slotA: sA, slotB: sB, liaison: li };
        }
      }
    }
    return null;
  }

  // Version incrémentale : vérifie uniquement newInst contre toutes les autres
  _registerImplicitConnectionsFor(newInst) {
    this._solver.refresh();
    for (const other of this._instances.values()) {
      if (other === newInst) continue;
      const alreadyKnown = this._connections.some(
        c => (c.instA === newInst && c.instB === other) ||
             (c.instA === other  && c.instB === newInst)
      );
      if (alreadyKnown) continue;
      const clip = this._isClipped(newInst, other);
      if (clip) {
        const conn = { instA: newInst, instB: other,
                       slotA: clip.slotA, slotB: clip.slotB,
                       liaison: clip.liaison, implicit: true };
        this._connections.push(conn);
        this._makeJoint(conn, this._assemblyJoints);
        this._addJointMarker(conn);
      }
    }
  }

  // Enregistre dans _connections toutes les paires implicites non encore connues
  // (à appeler avant la simulation)
  _registerImplicitConnections() {
    const instances = [...this._instances.values()];
    for (let i = 0; i < instances.length; i++) {
      for (let j = i + 1; j < instances.length; j++) {
        const instA = instances[i];
        const instB = instances[j];
        // Ignorer si déjà une connexion explicite entre ces deux instances
        const alreadyKnown = this._connections.some(
          c => (c.instA === instA && c.instB === instB) ||
               (c.instA === instB && c.instB === instA)
        );
        if (alreadyKnown) continue;
        const clip = this._isClipped(instA, instB);
        if (clip) {
          const conn = { instA, instB,
                         slotA: clip.slotA, slotB: clip.slotB,
                         liaison: clip.liaison, implicit: true };
          this._connections.push(conn);
          this._makeJoint(conn, this._assemblyJoints);
          this._addJointMarker(conn);
        }
      }
    }
  }

  // ─── Classe d'équivalence (BFS sur le graphe _connections + clipping) ────────

  // Retourne le Set<BrickInstance> du composant connexe contenant startInst
  _connectedComponent(startInst) {
    const visited = new Set();
    const queue   = [startInst];
    visited.add(startInst.id);
    while (queue.length) {
      const inst = queue.shift();
      // Connexions explicites enregistrées
      for (const conn of this._connections) {
        let neighbor = null;
        if (conn.instA === inst && !visited.has(conn.instB.id)) neighbor = conn.instB;
        if (conn.instB === inst && !visited.has(conn.instA.id)) neighbor = conn.instA;
        if (neighbor) { visited.add(neighbor.id); queue.push(neighbor); }
      }
      // Connexions implicites (clipping spatial)
      for (const other of this._instances.values()) {
        if (visited.has(other.id)) continue;
        if (this._isClipped(inst, other)) { visited.add(other.id); queue.push(other); }
      }
    }
    return new Set([...this._instances.values()].filter(i => visited.has(i.id)));
  }

  // Nombre de composants connexes dans la scène courante
  _componentCount() {
    const seen = new Set();
    let count  = 0;
    for (const inst of this._instances.values()) {
      if (seen.has(inst.id)) continue;
      for (const i of this._connectedComponent(inst)) seen.add(i.id);
      count++;
    }
    return count;
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────────────

  _isOverScreenSlot(cx, cy) {
    for (const slot of this._ssm.slots) {
      const rect = slot.canvas.getBoundingClientRect();
      if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) return true;
    }
    return false;
  }

  _isOverUI(target) {
    return target.closest?.('.asm-panel, .asm-footer, .asm-bar, .asm-config, #asm-screenslots');
  }

  _updateCount() {
    if (this._countEl) this._countEl.textContent = `Briques : ${this._instances.size}`;
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
}
