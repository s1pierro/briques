import * as THREE from 'three';
import { expandSlots } from '../slot-utils.js';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';

// ─── Constantes visuelles ─────────────────────────────────────────────────────
const WSM_COLOR   = 0x7aafc8;   // world slot / plan
const JOINT_COLOR = 0x00ccff;   // marqueur disque liaison explicite

// ─── Spirale phyllotaxique (world slots) ──────────────────────────────────────
function _spiralPos(n, spacing = 2.0) {
  if (n === 0) return new THREE.Vector3(0, 0, 0);
  const angle  = n * 2.399963;
  const radius = spacing * Math.sqrt(n);
  return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmBrick  —  instance d'une brique dans la scène
// ═══════════════════════════════════════════════════════════════════════════════

export class AsmBrick {

  /**
   * @param {string}         id
   * @param {string}         brickTypeId   — clé dans rbang_bricks
   * @param {Object}         brickData     — { name, shapeRef, color, slots, … }
   * @param {THREE.Mesh}     mesh
   * @param {Array}          slots         — expandSlots + corrigés pour le centrage géo
   * @param {THREE.Vector3}  geoCenter     — centre géométrique pré-translate
   */
  constructor(id, brickTypeId, brickData, mesh, slots, geoCenter) {
    this.id          = id;
    this.brickTypeId = brickTypeId;
    this.brickData   = brickData;
    this.mesh        = mesh;
    this.slots       = slots;
    this.geoCenter   = geoCenter;
    this.origPos     = mesh.position.clone();
    this.origQuat    = mesh.quaternion.clone();
  }

  /** Position monde d'un slot. */
  worldSlotPos(slot) {
    return new THREE.Vector3(...slot.position)
      .applyQuaternion(this.mesh.quaternion)
      .add(this.mesh.position);
  }

  /** Quaternion monde d'un slot. */
  worldSlotQuat(slot) {
    const q = slot.quaternion
      ? new THREE.Quaternion(...slot.quaternion)
      : new THREE.Quaternion();
    return q.premultiply(this.mesh.quaternion.clone());
  }

  /** Libère la géométrie et le(s) matériau(x) du mesh. */
  dispose() {
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) {
      for (const m of this.mesh.material) m.dispose();
    } else {
      this.mesh.material?.dispose();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// _AssemblySolver  —  résolution de liaisons (interne à AsmSlots)
// ═══════════════════════════════════════════════════════════════════════════════

class _AssemblySolver {
  constructor() { this._liaisons = {}; }

  refresh() {
    try { this._liaisons = JSON.parse(localStorage.getItem('rbang_liaisons') || '{}'); }
    catch { this._liaisons = {}; }
  }

  /** Trouve la meilleure liaison compatible. */
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

  /** Liaison rotule universelle pour world-slot. */
  ballJoint() {
    return { id: '__ball__', name: 'Rotule', dof: [{ type: 'ball', axis: [0,1,0] }] };
  }

  /** Vérifie la compatibilité de deux typeIds. */
  compatible(typeA, typeB) { return this._findLiaison(typeA, typeB); }

  /** Diagnostic console quand solve() échoue. */
  diagnose(nearA, nearB) {
    console.group('[AsmSlots/solver] solve() → null');
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
// AsmSlots  —  géométrie des slots, snapping, world slots
// ═══════════════════════════════════════════════════════════════════════════════

export class AsmSlots {

  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this._scene     = scene;
    this._slots     = [];   // WorldSlot[]
    this._y         = 0.25;
    this._plane     = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._y);
    this._planeMesh = null;
    this.snapR      = 1.2;
    this.solver     = new _AssemblySolver();
    this._initPlaneMesh();
  }

  // ── Paramètres ──────────────────────────────────────────────────────────────

  get planY() { return this._y; }

  set planY(y) {
    this._y = y;
    this._plane.constant = -y;
    if (this._planeMesh) this._planeMesh.position.y = y;
    for (const s of this._slots) {
      s.position.y = y;
      s.mesh.position.setY(y + 0.01);
      if (s.mesh.userData.ring) s.mesh.userData.ring.position.setY(y + 0.011);
    }
  }

  get planMesh() { return this._planeMesh; }
  get worldSlots() { return this._slots; }

  // ── World slots ─────────────────────────────────────────────────────────────

  /** Ajoute un world slot proche de worldPos sur la spirale. */
  addWorldSlot(worldPos) {
    const pos   = new THREE.Vector3(worldPos.x, 0, worldPos.z);
    const index = this._nextFreeIndex(pos);
    const slotPos = _spiralPos(index);
    slotPos.y = this._y;
    const mesh = this._makeSlotMesh(slotPos);
    this._scene.add(mesh);
    const slot = { index, position: slotPos, mesh, brickInstanceId: null };
    this._slots.push(slot);
    return slot;
  }

  /** Lie un world slot à une instance de brique (par id). */
  bindWorldSlot(wslot, brickInstanceId) {
    wslot.brickInstanceId = brickInstanceId;
    wslot.mesh.material.color.setHex(0x4a8a6a);
  }

  /** Délie un world slot. */
  unbindWorldSlot(wslot) {
    wslot.brickInstanceId = null;
    wslot.mesh.material.color.setHex(WSM_COLOR);
  }

  /** Retire un world slot de la scène et de la liste. */
  removeWorldSlot(wslot) {
    if (wslot.mesh.userData.ring) {
      this._scene.remove(wslot.mesh.userData.ring);
      wslot.mesh.userData.ring.geometry.dispose();
      wslot.mesh.userData.ring.material.dispose();
    }
    this._scene.remove(wslot.mesh);
    wslot.mesh.geometry.dispose();
    wslot.mesh.material.dispose();
    const idx = this._slots.indexOf(wslot);
    if (idx !== -1) this._slots.splice(idx, 1);
  }

  /** World slot le plus proche d'un point (XZ uniquement). */
  nearestWorldSlot(worldPos, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const s of this._slots) {
      const d = new THREE.Vector2(worldPos.x - s.position.x, worldPos.z - s.position.z).length();
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Intersecte le ray du raycaster avec le plan de world slots. */
  raycastPlane(raycaster) {
    const pt = new THREE.Vector3();
    return raycaster.ray.intersectPlane(this._plane, pt) ? pt : null;
  }

  // ── Slots d'une brique ───────────────────────────────────────────────────────

  /**
   * Retourne les slots d'une brique triés par proximité au point écran (cx, cy).
   * @param {AsmBrick}       brick
   * @param {number}         cx, cy  — coordonnées écran
   * @param {THREE.Camera}   camera
   * @returns {Array}  slots triés par distance NDC croissante
   */
  nearSlotsOf(brick, cx, cy, camera) {
    const slots = brick.slots;
    if (!slots.length) return [];
    const ndcX =  (cx / innerWidth)  * 2 - 1;
    const ndcY = -(cy / innerHeight) * 2 + 1;
    const touch = new THREE.Vector2(ndcX, ndcY);
    return slots
      .map(s => {
        const wp = brick.worldSlotPos(s).clone();
        wp.project(camera);
        const d = touch.distanceTo(new THREE.Vector2(wp.x, wp.y));
        return { slot: s, dist: d };
      })
      .sort((a, b) => a.dist - b.dist)
      .map(x => x.slot);
  }

  /**
   * Calcule la transform de snap : newBrick = targetSlot_world × sourceSlot_local⁻¹
   * @param {Object}    slotA      — slot de la brique source
   * @param {Object}    slotB      — slot de la brique cible
   * @param {AsmBrick}  targetBrick
   * @returns {{ position: THREE.Vector3, quaternion: THREE.Quaternion }}
   */
  computeSnap(slotA, slotB, targetBrick) {
    const one = new THREE.Vector3(1, 1, 1);
    const tbrickMat = new THREE.Matrix4().compose(
      targetBrick.mesh.position, targetBrick.mesh.quaternion, one
    );
    const tslotMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...slotB.position),
      new THREE.Quaternion(...(slotB.quaternion ?? [0,0,0,1])),
      one
    );
    const tgtWorldMat = new THREE.Matrix4().multiplyMatrices(tbrickMat, tslotMat);
    const sslotMatInv = new THREE.Matrix4().compose(
      new THREE.Vector3(...slotA.position),
      new THREE.Quaternion(...(slotA.quaternion ?? [0,0,0,1])),
      one
    ).invert();
    const newMat = new THREE.Matrix4().multiplyMatrices(tgtWorldMat, sslotMatInv);
    const position   = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale      = new THREE.Vector3();
    newMat.decompose(position, quaternion, scale);
    return { position, quaternion };
  }

  /**
   * Résout la meilleure liaison entre deux listes de slots triées.
   * @returns {{ slotA, slotB, liaison } | null}
   */
  resolve(nearA, nearB) {
    return this.solver.solve(nearA, nearB);
  }

  // ── Nettoyage ────────────────────────────────────────────────────────────────

  dispose() {
    for (const s of [...this._slots]) this.removeWorldSlot(s);
    if (this._planeMesh) {
      this._scene.remove(this._planeMesh);
      this._planeMesh.geometry.dispose();
      this._planeMesh.material.dispose();
      this._planeMesh = null;
    }
  }

  // ── Privé ────────────────────────────────────────────────────────────────────

  _initPlaneMesh() {
    const geo = new THREE.PlaneGeometry(26, 26);
    const mat = new THREE.MeshBasicMaterial({
      color: WSM_COLOR, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this._planeMesh = new THREE.Mesh(geo, mat);
    this._planeMesh.rotation.x = -Math.PI / 2;
    this._planeMesh.position.y = this._y;
    this._scene.add(this._planeMesh);
  }

  _nextFreeIndex(pos) {
    const used = new Set(this._slots.map(s => s.index));
    let bestIndex = -1, bestD = Infinity;
    for (let i = 0; i < 64; i++) {
      if (used.has(i)) continue;
      const sp = _spiralPos(i);
      const d  = new THREE.Vector2(pos.x - sp.x, pos.z - sp.z).length();
      if (d < bestD) { bestD = d; bestIndex = i; }
    }
    return bestIndex >= 0 ? bestIndex : this._slots.length;
  }

  _makeSlotMesh(pos) {
    const geo  = new THREE.CircleGeometry(0.35, 32);
    const mat  = new THREE.MeshBasicMaterial({
      color: WSM_COLOR, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.01, pos.z);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.42, 32),
      new THREE.MeshBasicMaterial({ color: WSM_COLOR, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, pos.y + 0.011, pos.z);
    this._scene.add(ring);
    mesh.userData.ring = ring;
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmJoints  —  connexions, marqueurs, implicites
// ═══════════════════════════════════════════════════════════════════════════════

export class AsmJoints {

  /** Distance max pour considérer deux slots comme coïncidents (unités scène). */
  static CLIP_DIST = 0.12;

  /**
   * @param {THREE.Scene}      scene
   * @param {_AssemblySolver}  solver   — référence partagée depuis AsmSlots
   */
  constructor(scene, solver) {
    this._scene   = scene;
    this._solver  = solver;
    this.connections = [];
    this._markers    = []; // { mesh, conn }

    /**
     * Callback appelé lors de l'ajout d'une connexion explicite.
     * Signature : (conn) → bool
     * Retourne true si les AsmHandlers ont pris en charge la connexion
     * (auquel cas le disque marqueur n'est pas créé).
     * @type {((conn: Object) => boolean) | null}
     */
    this.onConnect = null;
  }

  // ── API publique ─────────────────────────────────────────────────────────────

  /**
   * Enregistre une connexion explicite, masque les précédents marqueurs,
   * délègue l'activation des AsmHandlers via onConnect, et crée le disque
   * si aucun handler n'est actif.
   */
  add(conn) {
    this.connections.push(conn);
    if (conn.implicit) return;

    // Masquer tous les marqueurs existants
    for (const jm of this._markers) jm.mesh.visible = false;

    // Déléguer l'activation des AsmHandlers à l'Assembler
    const handlersActive = this.onConnect?.(conn) ?? false;

    // Créer le disque uniquement si aucun handler DOF n'est actif
    if (!handlersActive) this._createMarker(conn);
  }

  /**
   * Scan spatial des connexions implicites induites par newBrick.
   * @param {AsmBrick}           newBrick
   * @param {Map<string,AsmBrick>} allBricks
   */
  addImplicitsFor(newBrick, allBricks) {
    this._solver.refresh();
    for (const other of allBricks.values()) {
      if (other === newBrick) continue;
      if (this.has(newBrick, other)) continue;
      const clip = this._isClipped(newBrick, other);
      if (clip) {
        const conn = {
          instA: newBrick, instB: other,
          slotA: clip.slotA, slotB: clip.slotB,
          liaison: clip.liaison, implicit: true,
        };
        this.connections.push(conn);
        // Pas de marqueur pour les connexions implicites
      }
    }
  }

  /**
   * Supprime toutes les connexions (explicites + implicites) impliquant brick,
   * et nettoie les marqueurs associés.
   */
  removeFor(brick) {
    const toRemove = this.connections.filter(c => c.instA === brick || c.instB === brick);
    for (const conn of toRemove) {
      const mi = this._markers.findIndex(jm => jm.conn === conn);
      if (mi !== -1) {
        const { mesh } = this._markers[mi];
        this._scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this._markers.splice(mi, 1);
      }
    }
    this.connections = this.connections.filter(c => c.instA !== brick && c.instB !== brick);
  }

  /** Retourne true si une connexion existe déjà entre brickA et brickB. */
  has(brickA, brickB) {
    return this.connections.some(
      c => (c.instA === brickA && c.instB === brickB) ||
           (c.instA === brickB && c.instB === brickA)
    );
  }

  /** Connexions explicites uniquement (implicit: false). */
  explicitConnections() {
    return this.connections.filter(c => !c.implicit);
  }

  /** Retire tous les marqueurs de la scène et libère les ressources. */
  dispose() {
    for (const { mesh } of this._markers) {
      this._scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this._markers = [];
    this.connections = [];
  }

  // ── Privé ────────────────────────────────────────────────────────────────────

  _createMarker(conn) {
    const { instA, slotA } = conn;
    const geo = new THREE.CylinderGeometry(0.75, 0.75, 0.06, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: JOINT_COLOR, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const marker = new THREE.Mesh(geo, mat);

    // Position monde du slot A
    marker.position.copy(instA.worldSlotPos(slotA));

    // Orientation : axe du DOF ou normale du slot
    const dofs = conn.liaison?.dof ?? [];
    const hasDofAxis = dofs.length === 1 && dofs[0].axis;
    if (hasDofAxis) {
      const rawAxis   = new THREE.Vector3(...dofs[0].axis).normalize();
      const slotBQ    = new THREE.Quaternion(...(conn.slotB.quaternion ?? [0,0,0,1]));
      const worldBQ   = slotBQ.clone().premultiply(conn.instB.mesh.quaternion.clone());
      const axisWorld = rawAxis.clone().applyQuaternion(worldBQ).normalize();
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisWorld);
    } else if (slotA.quaternion) {
      const slotQ  = new THREE.Quaternion(...slotA.quaternion);
      const worldQ = slotQ.premultiply(instA.mesh.quaternion.clone());
      marker.quaternion.copy(worldQ).multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
      );
    }

    this._scene.add(marker);
    this._markers.push({ mesh: marker, conn });
  }

  _isClipped(brickA, brickB) {
    const slotsA = brickA.slots;
    const slotsB = brickB.slots;
    for (const sA of slotsA) {
      if (!sA.typeId) continue;
      const posA = brickA.worldSlotPos(sA);
      for (const sB of slotsB) {
        if (!sB.typeId) continue;
        if (posA.distanceTo(brickB.worldSlotPos(sB)) < AsmJoints.CLIP_DIST) {
          const li = this._solver.compatible(sA.typeId, sB.typeId);
          if (li) return { slotA: sA, slotB: sB, liaison: li };
        }
      }
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmEquivalenceClass  —  composantes connexes (BFS stateless)
// ═══════════════════════════════════════════════════════════════════════════════

export class AsmEquivalenceClass {

  /**
   * Retourne le Set des IDs du composant connexe contenant brick.
   * @param {AsmBrick}  brick
   * @param {AsmJoints} joints
   * @returns {Set<string>}
   */
  static componentOf(brick, joints) {
    const visited = new Set([brick.id]);
    const queue   = [brick];
    while (queue.length) {
      const b = queue.shift();
      for (const conn of joints.connections) {
        let neighbor = null;
        if (conn.instA === b && !visited.has(conn.instB.id)) neighbor = conn.instB;
        if (conn.instB === b && !visited.has(conn.instA.id)) neighbor = conn.instA;
        if (neighbor) { visited.add(neighbor.id); queue.push(neighbor); }
      }
    }
    return visited;
  }

  /**
   * Nombre de composantes connexes dans bricks.
   * @param {Map<string,AsmBrick>} bricks
   * @param {AsmJoints}            joints
   * @returns {number}
   */
  static count(bricks, joints) {
    const seen = new Set();
    let n = 0;
    for (const brick of bricks.values()) {
      if (seen.has(brick.id)) continue;
      for (const id of AsmEquivalenceClass.componentOf(brick, joints)) seen.add(id);
      n++;
    }
    return n;
  }

  /**
   * Retourne true si brickA et brickB appartiennent au même composant.
   * @param {AsmBrick}  brickA
   * @param {AsmBrick}  brickB
   * @param {AsmJoints} joints
   * @returns {boolean}
   */
  static sameComponent(brickA, brickB, joints) {
    return AsmEquivalenceClass.componentOf(brickA, joints).has(brickB.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmVerse  —  façade orchestratrice
// ═══════════════════════════════════════════════════════════════════════════════

export class AsmVerse {

  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene  = scene;
    this.bricks = new Map();   // id → AsmBrick
    this.slots  = new AsmSlots(scene);
    this.joints = new AsmJoints(scene, this.slots.solver);
    this._idSeq = 0;
    this._wsConnections = []; // { wslot, brick, slotA }
  }

  // ── Gestion des briques ──────────────────────────────────────────────────────

  /**
   * Crée et ajoute une brique dans la scène.
   *
   * @param {string}  brickTypeId        — clé dans rbang_bricks
   * @param {Object}  brickData          — { name, shapeRef, color, slots, … }
   * @param {THREE.Vector3|null}  pos    — position sol (world slot), exclusif avec snapTransform
   * @param {{position,quaternion}|null} snapTransform
   * @param {Object|null}  shapeData     — données CSG ; si null, chargées depuis localStorage
   * @returns {Promise<AsmBrick|null>}
   */
  async spawnBrick(brickTypeId, brickData, pos = null, snapTransform = null, shapeData = null) {
    // Résolution des données shape
    if (!shapeData) {
      try {
        const store = JSON.parse(localStorage.getItem('rbang_shapes') || '{}');
        shapeData = store[brickData.shapeRef];
      } catch { return null; }
    }
    if (!shapeData?.steps || !shapeData.rootId) return null;

    try {
      const M     = await getManifold();
      const cache = buildCache(shapeData.steps, M);
      const mf    = cache.get(shapeData.rootId);
      if (!mf) return null;

      const { geo } = manifoldToGeometry(mf);
      const color   = parseInt((brickData.color || '#888888').replace('#', ''), 16);
      const mesh    = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color, roughness: 0.55 })
      );
      mesh.castShadow = mesh.receiveShadow = true;

      // Centrer la géométrie (les slots sont définis dans le repère centré de la Forge)
      const box    = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      geo.translate(-center.x, -center.y, -center.z);
      geo.boundingBox = null; // invalider le cache après translate

      if (snapTransform) {
        mesh.position.copy(snapTransform.position);
        mesh.quaternion.copy(snapTransform.quaternion);
      } else if (pos) {
        mesh.position.set(pos.x, this.slots.planY - (box.min.y - center.y), pos.z);
      }

      this.scene.add(mesh);

      const id    = `bi-${++this._idSeq}`;
      const slots = expandSlots(brickData.slots || []).map(s => ({
        ...s,
        position: [
          s.position[0] - center.x,
          s.position[1] - center.y,
          s.position[2] - center.z,
        ],
      }));

      const brick = new AsmBrick(id, brickTypeId, brickData, mesh, slots, center);
      this.bricks.set(id, brick);
      return brick;
    } catch (e) {
      console.error('[AsmVerse] spawnBrick error', e);
      return null;
    }
  }

  /**
   * Retire une brique de la scène : libère mesh, connexions, world slot.
   * ⚠ L'Assembler doit gérer le nettoyage des AsmHandlers AVANT d'appeler cette méthode.
   * @param {AsmBrick} brick
   */
  removeBrick(brick) {
    this.scene.remove(brick.mesh);
    brick.dispose();

    // Libérer le world slot lié (le cas échéant)
    const wsConns = this._wsConnections.filter(wsc => wsc.brick === brick);
    for (const wsc of wsConns) {
      this.slots.unbindWorldSlot(wsc.wslot);
      this.slots.removeWorldSlot(wsc.wslot);
    }
    this._wsConnections = this._wsConnections.filter(wsc => wsc.brick !== brick);

    // Supprimer connexions + marqueurs
    this.joints.removeFor(brick);

    this.bricks.delete(brick.id);
  }

  // ── Connexions ───────────────────────────────────────────────────────────────

  /**
   * Enregistre une connexion explicite entre deux briques.
   * @returns {Object} conn
   */
  connect(brickA, slotA, brickB, slotB, liaison) {
    const conn = { instA: brickA, instB: brickB, slotA, slotB, liaison };
    this.joints.add(conn);
    return conn;
  }

  /**
   * Assemble brickA sur brickB d'après les points d'accroche écran.
   * Déplace brickA à la transform de snap, enregistre la connexion.
   * @returns {Object|null} conn, ou null si aucune liaison compatible
   */
  connectDrag(brickA, grabX, grabY, brickB, dropX, dropY, camera) {
    const nearA = this.slots.nearSlotsOf(brickA, grabX, grabY, camera);
    const nearB = this.slots.nearSlotsOf(brickB, dropX, dropY, camera);
    const result = this.slots.resolve(nearA, nearB);
    if (!result) {
      this.slots.solver.diagnose(nearA, nearB);
      return null;
    }
    const snap = this.slots.computeSnap(result.slotA, result.slotB, brickB);
    brickA.mesh.position.copy(snap.position);
    brickA.mesh.quaternion.copy(snap.quaternion);
    brickA.origPos  = snap.position.clone();
    brickA.origQuat = snap.quaternion.clone();
    return this.connect(brickA, result.slotA, brickB, result.slotB, result.liaison);
  }

  // ── World slot helpers ───────────────────────────────────────────────────────

  /**
   * Attache un world slot à une brique (mémorise la liaison).
   */
  bindWorldSlot(wslot, brick, nearSlotA = null) {
    this.slots.bindWorldSlot(wslot, brick.id);
    this._wsConnections.push({ wslot, brick, slotA: nearSlotA });
  }

  // ── Topologie ────────────────────────────────────────────────────────────────

  /** Nombre de composantes connexes dans la scène. */
  componentCount() {
    return AsmEquivalenceClass.count(this.bricks, this.joints);
  }

  // ── Persistance ─────────────────────────────────────────────────────────────

  /**
   * Sérialise la scène (même format que _saveScene / _restoreScene de l'Assembler).
   * @returns {Object}
   */
  serialize() {
    const instances = [...this.bricks.values()].map(b => ({
      id          : b.id,
      brickTypeId : b.brickTypeId,
      px: b.mesh.position.x, py: b.mesh.position.y, pz: b.mesh.position.z,
      qx: b.mesh.quaternion.x, qy: b.mesh.quaternion.y,
      qz: b.mesh.quaternion.z, qw: b.mesh.quaternion.w,
    }));
    const connections = this.joints.explicitConnections().map(c => ({
      instAId   : c.instA.id,
      instBId   : c.instB.id,
      slotAId   : c.slotA.id,
      slotBId   : c.slotB.id,
      liaisonId : c.liaison?.id ?? null,
      implicit  : false,
    }));
    return { version: 1, instances, connections };
  }

  /**
   * Rehydrate la scène depuis des données sauvegardées.
   *
   * @param {Object}  data           — { version, instances, connections }
   * @param {Object}  bricksStore    — rbang_bricks (id → brickData)
   * @param {Object}  shapesStore    — rbang_shapes (shapeRef → shapeData)
   * @param {Object}  liaisonsStore  — rbang_liaisons (id → liaison)
   * @returns {Promise<Map<string,AsmBrick>>}  oldId → newBrick
   */
  async restore(data, bricksStore, shapesStore, liaisonsStore = {}) {
    if (!data?.instances?.length) return new Map();

    const idMap = new Map(); // ancien id → AsmBrick

    // 1. Recréer les instances à leur pose sauvegardée
    for (const s of data.instances) {
      const brickData = bricksStore[s.brickTypeId];
      if (!brickData) continue;
      const shapeData = shapesStore[brickData.shapeRef];
      const brick = await this.spawnBrick(
        s.brickTypeId,
        brickData,
        new THREE.Vector3(s.px, s.py, s.pz),
        null,
        shapeData ?? null
      );
      if (!brick) continue;
      // Appliquer la pose exacte (spawnBrick a posé la brique au sol, on corrige)
      brick.mesh.position.set(s.px, s.py, s.pz);
      brick.mesh.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      brick.origPos  = brick.mesh.position.clone();
      brick.origQuat = brick.mesh.quaternion.clone();
      idMap.set(s.id, brick);
    }

    // 2. Recréer les connexions explicites
    for (const c of (data.connections || [])) {
      if (c.implicit) continue;
      const brickA = idMap.get(c.instAId);
      const brickB = idMap.get(c.instBId);
      if (!brickA || !brickB) continue;
      const slotA = brickA.slots.find(s => s.id === c.slotAId || s._defId === c.slotAId);
      const slotB = brickB.slots.find(s => s.id === c.slotBId || s._defId === c.slotBId);
      if (!slotA || !slotB) continue;
      const liaison = c.liaisonId ? (liaisonsStore[c.liaisonId] ?? null) : null;
      this.connect(brickA, slotA, brickB, slotB, liaison);
    }

    return idMap;
  }

  // ── Nettoyage global ─────────────────────────────────────────────────────────

  /**
   * Vide entièrement la scène (briques, connexions, world slots, plan).
   */
  clear() {
    this.joints.dispose();
    for (const brick of [...this.bricks.values()]) {
      this.scene.remove(brick.mesh);
      brick.dispose();
    }
    this.bricks.clear();
    for (const wsc of this._wsConnections) {
      this.slots.unbindWorldSlot(wsc.wslot);
      this.slots.removeWorldSlot(wsc.wslot);
    }
    this._wsConnections = [];
  }

  /**
   * Détruit tout y compris les ressources THREE.js du gestionnaire de world slots.
   * À appeler lors du stop() de l'Assembler.
   */
  dispose() {
    this.clear();
    this.slots.dispose();
  }
}
