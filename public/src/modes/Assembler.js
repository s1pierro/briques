import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';
import { BrickDock } from './BrickDock.js';
import { expandSlots } from '../slot-utils.js';

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

// Hauteur de la barre de titre — rogne le viewport rendu et le dock
const BAR_H = 32;

// Persistance de la configuration de l'Assembler
const CFG_KEY = 'rbang_asm_cfg';
const CFG_DEFAULTS = {
  dockEdge             : 'bottom',
  dockAlign            : 'center',
  activateOnOutsideTap : true,
  planY                : 0.25,
  snapR                : 1.2,
  planVisible          : true,
  accent               : '#7aafc8',
  stackPersist         : false,
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
  constructor(id, brickData, mesh) {
    this.id          = id;
    this.brickData   = brickData;
    this.mesh        = mesh;
    this.brickTypeId = null;    // clé dans rbang_bricks (type de brique)
    this.slots       = [];      // slots corrigés pour le centrage géo (position - geoCenter)
    this.geoCenter   = new THREE.Vector3();
    this.origPos     = mesh.position.clone();
    this.origQuat    = mesh.quaternion.clone();
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
    this._dock        = null; // BrickDock
    this._configOverlay = null; // modale configuration
    this._solver      = new AssemblySolver();
    this._raycaster   = new THREE.Raycaster();
    this._mouse       = new THREE.Vector2(-9999, -9999);
    this._snapHelpers = [];
    this._idSeq       = 0;
    this._connections   = []; // { instA, instB, slotA, slotB, liaison }
    this._wsConnections = []; // { wslot, inst, slotA } pour world slots
    this._jointMarkers  = []; // { mesh, conn } marqueurs visuels des liaisons
    this._stackCandidate = null; // { inst, startX, startY } — brique saisie en cours de drag
  }

  // ─── Cycle de vie ──────────────────────────────────────────────────────────

  async start() {
    this._setupScene();
    this._setupManagers();
    this._applyConfig();
    this._setupUI();
    this._setupEvents();
    this.engine.start();
  }

  _loadConfig() {
    try { return { ...CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
    catch { return { ...CFG_DEFAULTS }; }
  }

  _saveConfig(patch) {
    const cfg = this._loadConfig();
    localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign(cfg, patch)));
  }

  _applyConfig() {
    const cfg = this._loadConfig();
    this._dock.setPosition(cfg.dockEdge, cfg.dockAlign);
    this._dock.setActivateOnOutsideTap(cfg.activateOnOutsideTap);
    this._dock.setStackPersist(cfg.stackPersist);
    this._wsm.setY(cfg.planY);
    this._wsm.SNAP_R = cfg.snapR;
    if (this._wsm._planeMesh) this._wsm._planeMesh.visible = cfg.planVisible;
  }

  stop() {
    this.engine.resizeViewport(0, 0, 0);
    this._wsm.dispose();
    this._dock?.destroy();
    this._clearSnapHelpers();
    this._instances.forEach(inst => {
      this.engine.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
      inst.mesh.material.dispose();
    });
    this._instances.clear();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup',   this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMoveStack, { capture: true });
    window.removeEventListener('pointerup',   this._onPointerUpStack,   { capture: true });
    this.engine.controls.enabled = true; // au cas où un grab était en cours
    this._stackCandidate = null;
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
    this._wsm  = new WorldSlotManager(this.engine.scene);
    this._dock = new BrickDock(this.engine, { edge: 'bottom', align: 'center' });

    this._dock.onPickBrick((brickId, gesture) => {
      // Swipe vers la scène depuis le dock → placer la brique
      this._activeGesture = null;
      this._handleScreenSlotDrop(gesture);
    });

    // Charger toutes les briques disponibles dans le dock
    const bricks = this._loadStore('rbang_bricks');
    this._dock.load(bricks);
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
      const color   = parseInt((brick.color || '#888888').replace('#', ''), 16);
      const mesh    = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
      mesh.castShadow = mesh.receiveShadow = true;

      // ── Centrer la géométrie sur l'origine du mesh ──────────────────────────
      // Les slots sont définis dans le repère centré de la Forge → on aligne ici
      const box    = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      geo.translate(-center.x, -center.y, -center.z);
      geo.boundingBox = null; // invalider le cache après translate

      if (snapTransform) {
        mesh.position.copy(snapTransform.position);
        mesh.quaternion.copy(snapTransform.quaternion);
      } else {
        mesh.position.set(pos.x, this._wsm._y - (box.min.y - center.y), pos.z);
      }
      this.engine.scene.add(mesh);
      const id   = `bi-${++this._idSeq}`;
      const inst = new BrickInstance(id, brick, mesh);
      inst.brickTypeId = brickId;
      inst.geoCenter = center.clone();
      inst.slots = expandSlots(brick.slots || []).map(s => ({
        ...s,
        position: [s.position[0] - center.x, s.position[1] - center.y, s.position[2] - center.z],
      }));

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
      if (hits.length > 0) {
        // Brique saisie : enregistrer le candidat et bloquer la caméra
        const hitMesh = hits[0].object;
        const hitInst = [...this._instances.values()].find(i => i.mesh === hitMesh);
        if (hitInst) {
          this._stackCandidate = { inst: hitInst, startX: e.clientX, startY: e.clientY };
          this.engine.controls.enabled = false;
        }
        return;
      }

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

    this._onPointerMoveStack = (e) => {
      if (!this._stackCandidate) return;
      // Feedback visuel dès que le drag démarre (seuil 12px)
      const { inst, startX, startY } = this._stackCandidate;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) >= 12) {
        inst.mesh.material.transparent = true;
        inst.mesh.material.opacity      = 0.4;
      }
    };

    this._onPointerUpStack = (e) => {
      if (!this._stackCandidate) return;
      const { inst, startX, startY } = this._stackCandidate;

      const under  = document.elementFromPoint(e.clientX, e.clientY);
      const onDock = under?.closest?.('.brick-dock');

      if (onDock) {
        // ── Drop sur le dock → empiler
        this._removeFromScene(inst);
        this._dock.pushToStack(inst.brickTypeId, inst.brickData);
        e.stopPropagation();
      } else {
        // ── Drop sur une autre brique → assembler
        this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
        this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this.engine.camera);
        const others = [...this._instances.values()].filter(i => i !== inst);
        const hits   = this._raycaster.intersectObjects(others.map(i => i.mesh), false);
        if (hits.length > 0) {
          const target = others.find(i => i.mesh === hits[0].object);
          if (target) this._connectDrag(inst, startX, startY, target, e.clientX, e.clientY);
        }
        // Restaurer opacité dans tous les cas (assemblage ou abandon)
        inst.mesh.material.transparent = false;
        inst.mesh.material.opacity      = 1;
      }

      this.engine.controls.enabled = true;
      this._stackCandidate = null;
    };

    window.addEventListener('pointercancel', () => {
      if (this._stackCandidate) {
        const m = this._stackCandidate.inst?.mesh;
        if (m) { m.material.transparent = false; m.material.opacity = 1; }
        this._stackCandidate = null;
      }
      this.engine.controls.enabled = true;
    }, { capture: true });

    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointermove', this._onPointerMoveStack, { capture: true });
    window.addEventListener('pointerup',   this._onPointerUpStack,   { capture: true });
  }

  // ─── Marqueur visuel d'une connexion ─────────────────────────────────────────

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
        z-index:54; pointer-events:auto;
        font:10px sans-serif; color:${C.dim};
      }
      .asm-bar-btn {
        background:transparent; border:none; color:${C.dim};
        font-size:16px; cursor:pointer; padding:0 8px; height:100%;
        line-height:1; flex-shrink:0;
      }
      .asm-bar-btn:active { color:${C.fg}; }
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

    this._countEl = document.createElement('span');
    this._countEl.style.cssText = 'flex:1;text-align:center;pointer-events:none;';

    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'asm-bar-btn';
    cfgBtn.title = 'Configuration';
    cfgBtn.textContent = '⚙';
    cfgBtn.addEventListener('click', () => this._openConfigModal());

    bar.append(fsBtn, this._countEl, cfgBtn);
    document.body.appendChild(bar);
    this._ui.push(bar);

    // ── Modale de configuration ───────────────────────────────────────────────
    this._setupConfigModal();

    // ── Rogner le viewport rendu + dock sous la barre ─────────────────────────
    this.engine.resizeViewport(0, 0, BAR_H);
    this._dock.setInsets({ top: BAR_H });

    // ── onUpdate ──────────────────────────────────────────────────────────────
    this.engine.onUpdate = () => {
      const n = this._instances.size;
      const c = n ? this._componentCount() : 0;
      const nConn = this._connections.length;
      this._countEl.textContent = `Briques : ${n}` + (n ? `  |  Liaisons : ${nConn}  |  Composants : ${c}` : '');
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

    // ── Corps (flex-wrap, cartes) ────────────────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = [
      'display:flex', 'flex-wrap:wrap',
      'gap:14px', 'padding:16px',
      'overflow-y:auto', 'flex:1',
      'align-items:flex-start',
    ].join(';');

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
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex-shrink:0;min-width:70px;`;
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
      row.append(lbl, sl, val);
      return row;
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
    body.append(dockCard);

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
    body.append(stackCard);

    // ── Carte : World Slots ───────────────────────────────────────────────────
    const wsCard = makeCard('World Slots');
    wsCard.append(
      makeSlider('Plan Y', -2, 5, 0.05, this._wsm._y, v => { this._wsm.setY(v); this._saveConfig({ planY: v }); }),
      makeSlider('Rayon snap', 0.3, 4, 0.1, this._wsm.SNAP_R, v => { this._wsm.SNAP_R = v; this._saveConfig({ snapR: v }); }),
      makeToggle('Plan visible', this._wsm._planeMesh?.visible ?? true,
        v => { if (this._wsm._planeMesh) this._wsm._planeMesh.visible = v; this._saveConfig({ planVisible: v }); }),
    );
    body.append(wsCard);

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
    body.append(themeCard);

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._ui.push(overlay);
    this._configOverlay = overlay;
  }

  _openConfigModal() {
    if (this._configOverlay) this._configOverlay.style.display = 'flex';
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
    for (const { mesh } of this._jointMarkers) {
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose(); mesh.material.dispose();
    }
    this._jointMarkers = [];

    for (const inst of [...this._instances.values()]) {
      this.engine.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
      inst.mesh.material.dispose();
    }
    this._instances.clear();
    this._connections   = [];
    this._wsConnections = [];
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
        this._addJointMarker(conn);
      }
    }
  }

  // Enregistre dans _connections toutes les paires implicites non encore connues
  _registerImplicitConnections() {
    const instances = [...this._instances.values()];
    for (let i = 0; i < instances.length; i++) {
      for (let j = i + 1; j < instances.length; j++) {
        const instA = instances[i];
        const instB = instances[j];
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

  // Assemble instA (brique saisie) sur instB (brique cible) après un drag-drop scène→scène
  _connectDrag(instA, grabX, grabY, instB, dropX, dropY) {
    const nearSlotsA = this._nearSlotsOfInstance(instA, grabX, grabY);
    const nearSlotsB = this._nearSlotsOfInstance(instB, dropX, dropY);
    this._solver.refresh();
    const result = this._solver.solve(nearSlotsA, nearSlotsB);
    if (result) {
      const snap = this._computeSnapTransform(result.slotA, result.slotB, instB);
      instA.mesh.position.copy(snap.position);
      instA.mesh.quaternion.copy(snap.quaternion);
      instA.origPos  = snap.position.clone();
      instA.origQuat = snap.quaternion.clone();
      const conn = { instA, instB,
                     slotA: result.slotA, slotB: result.slotB,
                     liaison: result.liaison };
      this._connections.push(conn);
      this._addJointMarker(conn);
      this._registerImplicitConnectionsFor(instA);
      this._showSnapHelper(instA.mesh.position.clone());
    } else {
      this._solver.diagnose(nearSlotsA, nearSlotsB);
    }
  }

  _removeFromScene(inst) {
    this.engine.scene.remove(inst.mesh);
    inst.mesh.geometry.dispose();
    inst.mesh.material.dispose();

    // Supprimer les connexions impliquant cette instance + leurs marqueurs
    const connToRemove = this._connections.filter(c => c.instA === inst || c.instB === inst);
    for (const conn of connToRemove) {
      const mi = this._jointMarkers.findIndex(jm => jm.conn === conn);
      if (mi !== -1) {
        const { mesh } = this._jointMarkers[mi];
        this.engine.scene.remove(mesh);
        mesh.geometry.dispose(); mesh.material.dispose();
        this._jointMarkers.splice(mi, 1);
      }
    }
    this._connections = this._connections.filter(c => c.instA !== inst && c.instB !== inst);

    // Libérer le world slot lié (le cas échéant)
    const wsConns = this._wsConnections.filter(wsc => wsc.inst === inst);
    for (const wsc of wsConns) {
      this._wsm.unbind(wsc.wslot);
      this._wsm.remove(wsc.wslot);
    }
    this._wsConnections = this._wsConnections.filter(wsc => wsc.inst !== inst);

    this._instances.delete(inst.id);
    this._updateCount();
  }

  _isOverScreenSlot(cx, cy) {
    if (!this._dock?.el) return false;
    const rect = this._dock.el.getBoundingClientRect();
    return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
  }

  _isOverUI(target) {
    return target.closest?.('.brick-dock, .asm-bar, .asm-modal-overlay');
  }

  _updateCount() {
    if (this._countEl) this._countEl.textContent = `Briques : ${this._instances.size}`;
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
}
