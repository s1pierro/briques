import * as THREE from 'three';
import { expandSlots } from '../slot-utils.js';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';

// ─── Constantes visuelles ─────────────────────────────────────────────────────
const WS_COLOR    = 0x7aafc8;   // world slot / plan
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
   * @param {Array}          slots         — expandSlots + corrigés géo
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

  /** Position monde d'un slot (calculée dynamiquement depuis la pose courante du mesh). */
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
// _AssemblySolver  —  résolution de liaisons (interne, partagé par WorldSlots + AsmJoints)
// ═══════════════════════════════════════════════════════════════════════════════

class _AssemblySolver {
  constructor() { this._liaisons = {}; }

  refresh() {
    try { this._liaisons = JSON.parse(localStorage.getItem('rbang_liaisons') || '{}'); }
    catch { this._liaisons = {}; }
  }

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

  ballJoint() {
    return { id: '__ball__', name: 'Rotule', dof: [{ type: 'ball', axis: [0,1,0] }] };
  }

  compatible(typeA, typeB) { return this._findLiaison(typeA, typeB); }

  diagnose(nearA, nearB) {
    console.group('[AsmVerse/solver] solve() → null');
    if (!nearA.length) { console.warn('Source : aucun slot défini'); console.groupEnd(); return; }
    if (!nearB.length) { console.warn('Cible  : aucun slot défini'); console.groupEnd(); return; }
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
      if (misA.length) console.warn('typeId(s) source absents :', misA);
      if (misB.length) console.warn('typeId(s) cible  absents :', misB);
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
// AsmSlots  —  registre de tous les slots présents dans la scène
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maintient un index plat `{ brick, slot }` de tous les slots de la scène.
 * Met à jour cet index via deux points d'entrée :
 *   - registerBrick(brick)   — appelé quand une brique est ajoutée
 *   - unregisterBrick(brick) — appelé quand une brique est retirée
 *
 * Fournit des requêtes géométriques sur l'ensemble des slots sans avoir à
 * itérer les briques.
 */
export class AsmSlots {

  constructor() {
    /** @type {Array<{ brick: AsmBrick, slot: Object }>} */
    this._entries = [];
  }

  // ── Points d'entrée ──────────────────────────────────────────────────────────

  /** Ajoute tous les slots d'une brique au registre. */
  registerBrick(brick) {
    for (const slot of brick.slots) {
      this._entries.push({ brick, slot });
    }
  }

  /** Retire tous les slots d'une brique du registre. */
  unregisterBrick(brick) {
    this._entries = this._entries.filter(e => e.brick !== brick);
  }

  // ── Requêtes ─────────────────────────────────────────────────────────────────

  /** Toutes les entrées (brick, slot) de la scène. */
  get entries() { return this._entries; }

  /** Entrées filtrées pour une brique. */
  slotsOf(brick) {
    return this._entries.filter(e => e.brick === brick).map(e => e.slot);
  }

  /**
   * Slots d'une brique triés par proximité au point écran (cx, cy).
   * @param {AsmBrick}     brick
   * @param {number}       cx, cy  — coordonnées écran
   * @param {THREE.Camera} camera
   * @returns {Object[]}  slots triés (dist croissante)
   */
  nearSlotsOf(brick, cx, cy, camera) {
    const ndcX =  (cx / innerWidth)  * 2 - 1;
    const ndcY = -(cy / innerHeight) * 2 + 1;
    const touch = new THREE.Vector2(ndcX, ndcY);
    return this._entries
      .filter(e => e.brick === brick)
      .map(e => {
        const wp = e.brick.worldSlotPos(e.slot).clone();
        wp.project(camera);
        const d = touch.distanceTo(new THREE.Vector2(wp.x, wp.y));
        return { slot: e.slot, dist: d };
      })
      .sort((a, b) => a.dist - b.dist)
      .map(x => x.slot);
  }

  /**
   * Tous les slots de la scène triés par proximité au point écran (cx, cy),
   * optionnellement limités à un sous-ensemble de briques.
   * @param {number}            cx, cy
   * @param {THREE.Camera}      camera
   * @param {Iterable<AsmBrick>} [exclude]  — briques à exclure (ex. brique en cours de drag)
   * @returns {Array<{ brick: AsmBrick, slot: Object, dist: number }>}
   */
  nearSlotsAt(cx, cy, camera, exclude = []) {
    const excluded = new Set(exclude);
    const ndcX =  (cx / innerWidth)  * 2 - 1;
    const ndcY = -(cy / innerHeight) * 2 + 1;
    const touch = new THREE.Vector2(ndcX, ndcY);
    return this._entries
      .filter(e => !excluded.has(e.brick))
      .map(e => {
        const wp = e.brick.worldSlotPos(e.slot).clone();
        wp.project(camera);
        const d = touch.distanceTo(new THREE.Vector2(wp.x, wp.y));
        return { brick: e.brick, slot: e.slot, dist: d };
      })
      .sort((a, b) => a.dist - b.dist);
  }

  /** Vide le registre (lors d'un clear() global). */
  clear() { this._entries = []; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WorldSlots  —  plan monde, spirale, snap, résolution de liaison
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gère les world slots (points d'ancrage sur le plan monde) et la géométrie
 * de snap entre slots de briques.
 */
export class WorldSlots {

  /**
   * @param {THREE.Scene}      scene
   * @param {_AssemblySolver}  solver
   */
  constructor(scene, solver) {
    this._scene     = scene;
    this._solver    = solver;
    this._slots     = [];
    this._y         = 0.25;
    this._plane     = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._y);
    this._planeMesh = null;
    this.snapR      = 1.2;
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
  get all() { return this._slots; }

  // ── World slots ─────────────────────────────────────────────────────────────

  /** Ajoute un world slot proche de worldPos sur la spirale. */
  addWorldSlot(worldPos) {
    const pos    = new THREE.Vector3(worldPos.x, 0, worldPos.z);
    const index  = this._nextFreeIndex(pos);
    const slotPos = _spiralPos(index);
    slotPos.y = this._y;
    const mesh = this._makeSlotMesh(slotPos);
    this._scene.add(mesh);
    const slot = { index, position: slotPos, mesh, brickInstanceId: null };
    this._slots.push(slot);
    return slot;
  }

  bind(wslot, brickInstanceId) {
    wslot.brickInstanceId = brickInstanceId;
    wslot.mesh.material.color.setHex(0x4a8a6a);
  }

  unbind(wslot) {
    wslot.brickInstanceId = null;
    wslot.mesh.material.color.setHex(WS_COLOR);
  }

  remove(wslot) {
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

  nearest(worldPos, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const s of this._slots) {
      const d = new THREE.Vector2(worldPos.x - s.position.x, worldPos.z - s.position.z).length();
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Intersecte le ray du raycaster avec le plan des world slots. */
  raycastPlane(raycaster) {
    const pt = new THREE.Vector3();
    return raycaster.ray.intersectPlane(this._plane, pt) ? pt : null;
  }

  // ── Géométrie de snap ────────────────────────────────────────────────────────

  /**
   * Calcule la transform de snap : newBrick = targetSlot_world × sourceSlot_local⁻¹
   * @param {Object}    slotA       — slot de la brique source
   * @param {Object}    slotB       — slot de la brique cible
   * @param {AsmBrick}  targetBrick — brique cible (contient slotB)
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
   * Résout la meilleure liaison compatible entre deux listes de slots triés.
   * @returns {{ slotA, slotB, liaison } | null}
   */
  resolve(nearA, nearB) {
    return this._solver.solve(nearA, nearB);
  }

  // ── Nettoyage ────────────────────────────────────────────────────────────────

  dispose() {
    for (const s of [...this._slots]) this.remove(s);
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
      color: WS_COLOR, transparent: true, opacity: 0.07,
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
      color: WS_COLOR, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.01, pos.z);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.42, 32),
      new THREE.MeshBasicMaterial({ color: WS_COLOR, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, pos.y + 0.011, pos.z);
    this._scene.add(ring);
    mesh.userData.ring = ring;
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmJoints  —  connexions, liaisons de la scène, marqueurs, implicites
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Décrit l'ensemble des liaisons existant dans la scène d'assemblage :
 * connexions explicites (snap), implicites (clipping spatial), et leurs
 * représentations visuelles (marqueurs disque).
 *
 * Une connexion = { instA, instB, slotA, slotB, liaison, implicit? }
 * où liaison est un objet du store rbang_liaisons (ou null).
 */
export class AsmJoints {

  /** Distance max pour considérer deux slots comme coïncidents (unités scène). */
  static CLIP_DIST = 0.12;

  /**
   * @param {THREE.Scene}      scene
   * @param {_AssemblySolver}  solver
   */
  constructor(scene, solver) {
    this._scene  = scene;
    this._solver = solver;

    /** @type {Object[]}  toutes les connexions (explicites + implicites) */
    this.connections = [];

    /** @type {Array<{ mesh: THREE.Mesh, conn: Object }>} */
    this._markers = [];

    /**
     * Callback déclenché lors de l'ajout d'une connexion EXPLICITE.
     * Signature : (conn) → bool
     * Retourne true si des AsmHandlers ont pris en charge la connexion
     * (remplacent alors le disque marqueur).
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

    for (const jm of this._markers) jm.mesh.visible = false;

    const handlersActive = this.onConnect?.(conn) ?? false;
    if (!handlersActive) this._createMarker(conn);
  }

  /**
   * Détecte et enregistre les connexions implicites induites par newBrick
   * avec toutes les autres briques de la scène.
   * @param {AsmBrick}              newBrick
   * @param {Map<string,AsmBrick>}  allBricks
   */
  addImplicitsFor(newBrick, allBricks) {
    this._solver.refresh();
    for (const other of allBricks.values()) {
      if (other === newBrick) continue;
      if (this.has(newBrick, other)) continue;
      const clip = this._isClipped(newBrick, other);
      if (clip) {
        this.connections.push({
          instA: newBrick, instB: other,
          slotA: clip.slotA, slotB: clip.slotB,
          liaison: clip.liaison, implicit: true,
        });
      }
    }
  }

  /**
   * Supprime toutes les connexions impliquant brick (explicites + implicites)
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

  /** Connexions explicites (implicit !== true). */
  explicitConnections() {
    return this.connections.filter(c => !c.implicit);
  }

  /** Retire tous les marqueurs et vide les connexions. */
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
    marker.position.copy(instA.worldSlotPos(slotA));

    const dofs = conn.liaison?.dof ?? [];
    const hasDofAxis = dofs.length === 1 && dofs[0].axis;
    if (hasDofAxis) {
      const rawAxis = new THREE.Vector3(...dofs[0].axis).normalize();
      const slotBQ  = new THREE.Quaternion(...(conn.slotB.quaternion ?? [0,0,0,1]));
      const worldBQ = slotBQ.clone().premultiply(conn.instB.mesh.quaternion.clone());
      marker.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        rawAxis.clone().applyQuaternion(worldBQ).normalize()
      );
    } else if (slotA.quaternion) {
      const slotQ = new THREE.Quaternion(...slotA.quaternion);
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
// AsmEquivalenceClass  —  classe d'équivalence (composante connexe rigide)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Décrit UNE composante connexe rigide de l'assemblage :
 * - `bricks`  — briques qu'elle contient (reliées entre elles par des connexions rigides)
 * - `joints`  — connexions rigides internes (subset de AsmJoints.connections)
 * - `links`   — connexions DOF vers d'autres composantes (liaisons cinématiques)
 *
 * Une connexion est dite "rigide" si sa liaison ne possède aucun DOF
 * (`!liaison.dof?.length`) ou si elle est implicite (clipping).
 * Les connexions DOF (`liaison.dof.length > 0`) forment les arêtes du graphe
 * cinématique entre composantes.
 *
 * Instancié par AsmVerse.computeComponents() — ne pas créer directement.
 */
export class AsmEquivalenceClass {

  /**
   * @param {Iterable<AsmBrick>} bricks
   * @param {Object[]}           joints  — connexions rigides internes
   */
  constructor(bricks, joints = []) {
    /** @type {Set<AsmBrick>} */
    this.bricks = new Set(bricks);

    /** @type {Object[]}  connexions rigides internes */
    this.joints = joints;

    /**
     * Connexions DOF reliant cette composante à d'autres.
     * @type {Array<{ connection: Object, other: AsmEquivalenceClass }>}
     */
    this.links = [];
  }

  /** Retourne true si brick appartient à cette composante. */
  contains(brick) { return this.bricks.has(brick); }

  /** Nombre de briques dans cette composante. */
  get size() { return this.bricks.size; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmVerse  —  objet composite, façade de la scène d'assemblage
// ═══════════════════════════════════════════════════════════════════════════════

export class AsmVerse {

  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // Solveur de liaisons partagé
    this._solver = new _AssemblySolver();

    /** @type {Map<string, AsmBrick>}  toutes les briques de la scène */
    this.bricks = new Map();

    /** Registre de tous les slots de la scène */
    this.slots = new AsmSlots();

    /** Plan monde, world slots, snap */
    this.worldSlots = new WorldSlots(scene, this._solver);

    /** Connexions et liaisons de la scène */
    this.joints = new AsmJoints(scene, this._solver);

    this._idSeq = 0;
    this._wsConnections = []; // { wslot, brick, slotA }
  }

  // ── Gestion des briques ──────────────────────────────────────────────────────

  /**
   * Crée et ajoute une brique dans la scène.
   *
   * @param {string}                        brickTypeId
   * @param {Object}                        brickData     — { name, shapeRef, color, slots, … }
   * @param {THREE.Vector3|null}            pos           — position sol (world slot)
   * @param {{position,quaternion}|null}    snapTransform — exclusif avec pos
   * @param {Object|null}                   shapeData     — données CSG ; null = charge depuis localStorage
   * @returns {Promise<AsmBrick|null>}
   */
  async spawnBrick(brickTypeId, brickData, pos = null, snapTransform = null, shapeData = null) {
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
      geo.boundingBox = null;

      if (snapTransform) {
        mesh.position.copy(snapTransform.position);
        mesh.quaternion.copy(snapTransform.quaternion);
      } else if (pos) {
        mesh.position.set(pos.x, this.worldSlots.planY - (box.min.y - center.y), pos.z);
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
      this.slots.registerBrick(brick);   // ← point d'entrée 1 du registre
      return brick;
    } catch (e) {
      console.error('[AsmVerse] spawnBrick error', e);
      return null;
    }
  }

  /**
   * Retire une brique de la scène : mesh, slots, connexions, world slot.
   * ⚠ L'Assembler doit gérer le nettoyage des AsmHandlers AVANT d'appeler ceci.
   */
  removeBrick(brick) {
    this.scene.remove(brick.mesh);
    brick.dispose();

    // Libérer le world slot lié (le cas échéant)
    const wsConns = this._wsConnections.filter(wsc => wsc.brick === brick);
    for (const wsc of wsConns) {
      this.worldSlots.unbind(wsc.wslot);
      this.worldSlots.remove(wsc.wslot);
    }
    this._wsConnections = this._wsConnections.filter(wsc => wsc.brick !== brick);

    this.joints.removeFor(brick);
    this.slots.unregisterBrick(brick);   // ← point d'entrée 2 du registre
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
   * Déplace brickA, enregistre la connexion.
   * @returns {Object|null} conn, ou null si aucune liaison compatible
   */
  connectDrag(brickA, grabX, grabY, brickB, dropX, dropY, camera) {
    const nearA  = this.slots.nearSlotsOf(brickA, grabX, grabY, camera);
    const nearB  = this.slots.nearSlotsOf(brickB, dropX, dropY, camera);
    const result = this.worldSlots.resolve(nearA, nearB);
    if (!result) {
      this._solver.diagnose(nearA, nearB);
      return null;
    }
    const snap = this.worldSlots.computeSnap(result.slotA, result.slotB, brickB);
    brickA.mesh.position.copy(snap.position);
    brickA.mesh.quaternion.copy(snap.quaternion);
    brickA.origPos  = snap.position.clone();
    brickA.origQuat = snap.quaternion.clone();
    return this.connect(brickA, result.slotA, brickB, result.slotB, result.liaison);
  }

  // ── World slot helpers ───────────────────────────────────────────────────────

  /** Attache un world slot à une brique (mémorise la liaison pour removeBrick). */
  bindWorldSlot(wslot, brick, nearSlotA = null) {
    this.worldSlots.bind(wslot, brick.id);
    this._wsConnections.push({ wslot, brick, slotA: nearSlotA });
  }

  // ── Topologie ────────────────────────────────────────────────────────────────

  /**
   * Calcule et retourne les composantes connexes rigides de l'assemblage.
   *
   * Algorithme :
   * 1. BFS en ne traversant que les connexions RIGIDES (sans DOF).
   * 2. Pour chaque composante, rassemble les connexions DOF qui la relient
   *    à d'autres composantes et les enregistre dans AsmEquivalenceClass.links.
   *
   * @returns {AsmEquivalenceClass[]}
   */
  computeComponents() {
    const isRigid = c => c.implicit || !(c.liaison?.dof?.length);
    const seen       = new Set();
    const components = [];

    for (const brick of this.bricks.values()) {
      if (seen.has(brick.id)) continue;

      // BFS rigide
      const compIds = new Set([brick.id]);
      const queue   = [brick];
      while (queue.length) {
        const b = queue.shift();
        for (const conn of this.joints.connections) {
          if (!isRigid(conn)) continue;
          let neighbor = null;
          if (conn.instA === b && !compIds.has(conn.instB.id)) neighbor = conn.instB;
          if (conn.instB === b && !compIds.has(conn.instA.id)) neighbor = conn.instA;
          if (neighbor) { compIds.add(neighbor.id); queue.push(neighbor); }
        }
      }

      const compBricks = [...this.bricks.values()].filter(b => compIds.has(b.id));
      const internalJoints = this.joints.connections.filter(
        c => isRigid(c) && compIds.has(c.instA.id) && compIds.has(c.instB.id)
      );
      const ec = new AsmEquivalenceClass(compBricks, internalJoints);
      components.push(ec);
      for (const id of compIds) seen.add(id);
    }

    // Liens cinématiques (DOF) entre composantes
    for (const conn of this.joints.connections) {
      if (isRigid(conn)) continue;
      const ecA = components.find(ec => ec.contains(conn.instA));
      const ecB = components.find(ec => ec.contains(conn.instB));
      if (ecA && ecB && ecA !== ecB) {
        ecA.links.push({ connection: conn, other: ecB });
        ecB.links.push({ connection: conn, other: ecA });
      }
    }

    return components;
  }

  /** Nombre de composantes connexes rigides. */
  componentCount() {
    return this.computeComponents().length;
  }

  // ── Persistance ─────────────────────────────────────────────────────────────

  /**
   * Sérialise la scène (format compatible avec _saveScene / _restoreScene de l'Assembler).
   * @returns {{ version: number, instances: Object[], connections: Object[] }}
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
      instAId  : c.instA.id,
      instBId  : c.instB.id,
      slotAId  : c.slotA.id,
      slotBId  : c.slotB.id,
      liaisonId: c.liaison?.id ?? null,
      implicit : false,
    }));
    return { version: 1, instances, connections };
  }

  /**
   * Rehydrate la scène depuis des données sauvegardées.
   *
   * @param {Object}  data           — { version, instances, connections }
   * @param {Object}  bricksStore    — rbang_bricks  (id → brickData)
   * @param {Object}  shapesStore    — rbang_shapes  (shapeRef → shapeData)
   * @param {Object}  [liaisonsStore] — rbang_liaisons (id → liaison)
   * @returns {Promise<Map<string,AsmBrick>>}  ancien id → AsmBrick
   */
  async restore(data, bricksStore, shapesStore, liaisonsStore = {}) {
    if (!data?.instances?.length) return new Map();
    const idMap = new Map();

    for (const s of data.instances) {
      const brickData = bricksStore[s.brickTypeId];
      if (!brickData) continue;
      const shapeData = shapesStore[brickData.shapeRef] ?? null;
      const brick = await this.spawnBrick(
        s.brickTypeId, brickData,
        new THREE.Vector3(s.px, s.py, s.pz),
        null, shapeData
      );
      if (!brick) continue;
      // Appliquer la pose exacte sauvegardée
      brick.mesh.position.set(s.px, s.py, s.pz);
      brick.mesh.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      brick.origPos  = brick.mesh.position.clone();
      brick.origQuat = brick.mesh.quaternion.clone();
      idMap.set(s.id, brick);
    }

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

  // ── Nettoyage ────────────────────────────────────────────────────────────────

  /** Vide entièrement la scène (briques, connexions, world slots). */
  clear() {
    this.joints.dispose();
    for (const brick of [...this.bricks.values()]) {
      this.scene.remove(brick.mesh);
      brick.dispose();
    }
    this.bricks.clear();
    this.slots.clear();
    for (const wsc of this._wsConnections) {
      this.worldSlots.unbind(wsc.wslot);
      this.worldSlots.remove(wsc.wslot);
    }
    this._wsConnections = [];
  }

  /** Détruit tout (y compris les ressources THREE.js des world slots). */
  dispose() {
    this.clear();
    this.worldSlots.dispose();
  }
}
