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
  worldSlot: 0x7aafc8,
  snapRing:  0x00ff88,
};

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
    this._scene   = scene;
    this._slots   = []; // { index, position:Vector3, mesh, brickInstanceId|null }
    this._plane   = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Y = 0
    this.SNAP_R   = 1.2; // rayon de snap trackball
  }

  // ── Ajouter un world slot à la position la plus proche sur la spirale ───────
  add(worldPos) {
    // Projeter sur le plan Y=0
    const pos = new THREE.Vector3(worldPos.x, 0, worldPos.z);
    // Chercher l'index libre le plus proche
    const index = this._nextFreeIndex(pos);
    const slotPos = spiralPos(index);
    const mesh = this._makeMesh(slotPos);
    this._scene.add(mesh);
    const slot = { index, position: slotPos, mesh, brickInstanceId: null };
    this._slots.push(slot);
    return slot;
  }

  remove(slot) {
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
      this._scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
    }
    this._slots = [];
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
    mesh.position.copy(pos).setY(0.01);

    // Anneau extérieur
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.42, 32),
      new THREE.MeshBasicMaterial({ color: C.worldSlot, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).setY(0.011);
    this._scene.add(ring);
    mesh.userData.ring = ring; // pour dispose
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ScreenSlotManager
// ═══════════════════════════════════════════════════════════════════════════════

const SS_W = 120, SS_H = 90; // taille d'un screen slot en px
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
        // Calculer les slots les plus proches du point de contact
        const nearSlots = this._nearSlotsForBrick(slot.brickId, e.clientX, e.clientY, slot);
        this._activeGesture = { slotId: slot.id, brickId: slot.brickId, nearSlots,
                                startX: e.clientX, startY: e.clientY, moved: false };
        if (this._onPickStart) this._onPickStart(this._activeGesture);
      }
      // Sinon : TrackballControls gère (zone vide → rotation preview)
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
    // Projeter chaque slot
    return brick.slots
      .map(s => {
        const p  = new THREE.Vector3(...s.position);
        if (slot.mesh) p.sub(slot.mesh.position); // correction centrage
        p.project(slot.camera);
        const d  = touchNDC.distanceTo(new THREE.Vector2(p.x, p.y));
        return { slot: s, dist: d };
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
    e.addStaticBox(24, 0.5, 24, 0, -0.25, 0, 0x2a3a2a);
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
      const wslot = this._wsm.add(pt);
      const inst  = await this._spawnBrick(brickId, wslot.position);
      if (inst) this._wsm.bind(wslot, inst.id);
    }
  }

  // ─── Assembler une brique sur une instance existante ────────────────────────

  async _assembleTo(brickId, nearSlotsA, targetInst, endX, endY) {
    // Calculer les slots de la brique cible proches du point de contact
    const nearSlotsB = this._nearSlotsOfInstance(targetInst, endX, endY);
    this._solver.refresh();
    const result = this._solver.solve(nearSlotsA, nearSlotsB);

    const bricks = this._loadStore('rbang_bricks');
    const brick  = bricks[brickId];
    if (!brick) return;

    // Calculer la position de snap
    let spawnPos;
    if (result) {
      spawnPos = this._computeSnapPos(result, targetInst);
    } else {
      // Pas de liaison compatible → placer à côté
      spawnPos = targetInst.mesh.position.clone().add(new THREE.Vector3(2, 0, 0));
    }

    const inst = await this._spawnBrick(brickId, spawnPos);
    if (inst && result) {
      this._showSnapHelper(spawnPos);
    }
  }

  // ─── Spawn d'une brique dans la scène ───────────────────────────────────────

  async _spawnBrick(brickId, pos) {
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
      const pts     = manifoldToPoints(mf);
      const color   = parseInt((brick.color || '#888888').replace('#', ''), 16);
      const mesh    = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
      mesh.castShadow = mesh.receiveShadow = true;
      // Centrer la géométrie
      const box    = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      mesh.position.copy(pos).sub(new THREE.Vector3(0, box.min.y - pos.y, 0));
      mesh.position.set(pos.x, Math.max(pos.y, (box.getSize(new THREE.Vector3()).y / 2)), pos.z);
      this.engine.scene.add(mesh);
      const id   = `bi-${++this._idSeq}`;
      const inst = new BrickInstance(id, brick, mesh, null, pts);
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
    const slots = inst.brickData.slots || [];
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

  _computeSnapPos(result, targetInst) {
    const { slotA, slotB } = result;
    // Position monde du slotB
    const wB = new THREE.Vector3(...slotB.position)
      .applyQuaternion(targetInst.mesh.quaternion)
      .add(targetInst.mesh.position);
    // Déplacer légèrement selon la normale du slot
    const offset = new THREE.Vector3(0, 0.5, 0);
    return wB.add(offset);
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
    for (const inst of this._instances.values()) {
      const { x, y, z } = inst.mesh.position;
      const body = this.engine.world.createRigidBody(
        this.engine.R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      );
      const q = inst.mesh.quaternion;
      body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      const cd = (this.engine.R.ColliderDesc.convexHull(inst.pts)
               ?? this.engine.R.ColliderDesc.ball(0.5))
        .setRestitution(0.2).setFriction(0.6);
      this.engine.world.createCollider(cd, body);
      inst.body = body;
      inst.origPos  = inst.mesh.position.clone();
      inst.origQuat = inst.mesh.quaternion.clone();
      this.engine._bodies.push({ mesh: inst.mesh, body, isStatic: false });
    }
  }

  _stopSimulation() {
    for (const inst of this._instances.values()) {
      if (inst.body) {
        const idx = this.engine._bodies.findIndex(b => b.body === inst.body);
        if (idx !== -1) this.engine._bodies.splice(idx, 1);
        this.engine.world.removeRigidBody(inst.body);
        inst.body = null;
      }
      inst.mesh.position.copy(inst.origPos);
      inst.mesh.quaternion.copy(inst.origQuat);
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

    this._simBtn = document.createElement('button');
    this._simBtn.className = 'asm-btn primary';
    this._simBtn.textContent = '▶ Simuler';
    this._simBtn.addEventListener('click', () => this._toggleSim(clearBtn));

    footer.append(clearBtn, this._simBtn);
    document.body.appendChild(footer);
    this._ui.push(footer);

    // ── onUpdate ──────────────────────────────────────────────────────────────
    this.engine.onUpdate = () => {
      this._countEl.textContent = `Briques : ${this._instances.size}`;
    };
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

  _toggleSim(clearBtn) {
    if (!this._simulating) {
      if (!this._instances.size) return;
      this._startSimulation();
      this._simBtn.textContent = '⏹ Arrêter';
      this._simBtn.classList.remove('primary');
      this._simBtn.classList.add('danger');
      clearBtn.disabled = true;
    } else {
      this._stopSimulation();
      this._simBtn.textContent = '▶ Simuler';
      this._simBtn.classList.add('primary');
      this._simBtn.classList.remove('danger');
      clearBtn.disabled = false;
    }
  }

  _clearAll() {
    for (const inst of [...this._instances.values()]) {
      this.engine.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
      inst.mesh.material.dispose();
      if (inst.body) this.engine.world.removeRigidBody(inst.body);
    }
    this._instances.clear();
    // Libérer les world slots
    for (const ws of [...this._wsm.slots]) this._wsm.unbind(ws);
    this._updateCount();
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
    return target.closest?.('.asm-panel, .asm-footer, .asm-bar, #asm-screenslots');
  }

  _updateCount() {
    if (this._countEl) this._countEl.textContent = `Briques : ${this._instances.size}`;
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
}
