import * as THREE from 'three';
import { expandSlots } from '../slot-utils.js';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';
import { AssemblySolver } from './AssemblySolver.js';

// ─── Constantes visuelles ─────────────────────────────────────────────────────
const WS_COLOR    = 0x7aafc8;   // world slot / plan
const JOINT_COLOR = 0x00ccff;   // marqueur disque liaison explicite



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
    /** @type {Object[]}  connexions impliquant cette brique */
    this.connections = [];
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
    /** @type {Set<Object>}  slots actuellement engagés dans une connexion */
    this._occupied = new Set();
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
   * @param {AsmBrick}       brick
   * @param {number}         cx, cy               — coordonnées écran
   * @param {THREE.Camera}   camera
   * @param {boolean}        [freeOnly=false]      — si true, exclut les slots occupés…
   * @param {AsmBrick|null}  [exceptConnectedTo]   — …sauf ceux déjà liés à cette brique
   * @returns {Object[]}  slots triés (dist croissante)
   */
  nearSlotsOf(brick, cx, cy, camera, freeOnly = false, exceptConnectedTo = null) {
    const ndcX =  (cx / innerWidth)  * 2 - 1;
    const ndcY = -(cy / innerHeight) * 2 + 1;
    const touch = new THREE.Vector2(ndcX, ndcY);
    return this._entries
      .filter(e => {
        if (e.brick !== brick) return false;
        if (!freeOnly || !this._occupied.has(e.slot)) return true;
        // Exception : slot occupé mais lié à la brique source → repositionnement autorisé
        return exceptConnectedTo != null && brick.connections.some(c =>
          (c.slotA === e.slot || c.slotB === e.slot) &&
          (c.instA === exceptConnectedTo || c.instB === exceptConnectedTo)
        );
      })
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

  /** Ensemble des typeIds de slots présents dans la scène. */
  get typeIds() {
    return new Set(this._entries.map(e => e.slot.typeId).filter(Boolean));
  }

  // ── État occupé ──────────────────────────────────────────────────────────────

  /**
   * Reconstruit l'ensemble des slots occupés depuis la liste courante des connexions.
   * Appelé par AsmJoints.observe() après chaque mise à jour des connexions.
   * @param {Object[]} connections
   */
  syncOccupied(connections) {
    this._occupied = new Set(connections.flatMap(c => [c.slotA, c.slotB]));
  }

  /** Retourne true si le slot est engagé dans au moins une connexion. */
  isOccupied(slot) { return this._occupied.has(slot); }

  /** Slots libres (non occupés) d'une brique donnée. */
  freeSlots(brick) {
    return this._entries
      .filter(e => e.brick === brick && !this._occupied.has(e.slot))
      .map(e => e.slot);
  }

  /** Vide le registre (lors d'un clear() global). */
  clear() { this._entries = []; this._occupied = new Set(); }

  /** Distance max pour considérer deux slots comme coïncidents (unités scène). */
  static CLIP_DIST = 0.12;

  /** Seuil de coïncidence actif (peut être surchargé depuis la config). */
  clipDist = AsmSlots.CLIP_DIST;

  /**
   * Retourne toutes les paires de slots coïncidents entre des briques différentes.
   * Utilisé par AsmJoints.observe() pour détecter les connexions.
   * @param {number} [clipDist]
   * @returns {Array<{ brickA: AsmBrick, slotA: Object, brickB: AsmBrick, slotB: Object }>}
   */
  coincidentPairs(clipDist = this.clipDist) {
    const pairs = [];
    for (let i = 0; i < this._entries.length; i++) {
      const { brick: bA, slot: sA } = this._entries[i];
      if (!sA.typeId) continue;
      const posA = bA.worldSlotPos(sA);
      for (let j = i + 1; j < this._entries.length; j++) {
        const { brick: bB, slot: sB } = this._entries[j];
        if (bA === bB || !sB.typeId) continue;
        if (posA.distanceTo(bB.worldSlotPos(sB)) < clipDist) {
          pairs.push({ brickA: bA, slotA: sA, brickB: bB, slotB: sB });
        }
      }
    }
    return pairs;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WorldSlots  —  grille monde, cellules, snap, résolution de liaison
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Grille infinie de cellules carrées (côté = 1 unité) sur le plan monde.
 * Chaque cellule connaît son état : libre, occupée, ou réservée.
 * Les cellules sont matérialisées à la demande (Map clé "x,z").
 */
export class WorldSlots {

  /**
   * @param {THREE.Scene}      scene
   * @param {AssemblySolver}  solver
   */
  constructor(scene, solver) {
    this._scene   = scene;
    this._solver  = solver;
    /** @type {Map<string, Object>}  "x,z" → { gx, gz, position, mesh, brickInstanceId } */
    this._cells   = new Map();
    this._y       = 0.25;
    this._plane   = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._y);
    this._gridGroup = null;
    this.snapR    = 1.2;
    this._gridRadius = 6;   // demi-côté de la grille visible (en cellules)
    this._initGrid();
    this._gridGroup.visible = false; // masquée par défaut, visible pendant dock drag
  }

  // ── Paramètres ──────────────────────────────────────────────────────────────

  get planY() { return this._y; }

  set planY(y) {
    this._y = y;
    this._plane.constant = -y;
    if (this._gridGroup) this._gridGroup.position.y = y;
    for (const cell of this._cells.values()) {
      cell.position.y = y;
      cell.mesh.position.setY(y + 0.01);
    }
  }

  get planMesh() { return this._gridGroup; }
  get all() { return [...this._cells.values()]; }

  showGrid() { if (this._gridGroup) this._gridGroup.visible = true; }
  hideGrid() { if (this._gridGroup) this._gridGroup.visible = false; }

  // ── Coordonnées grille ──────────────────────────────────────────────────────

  /** Convertit une position monde en coordonnées grille (entières). */
  worldToGrid(worldPos) {
    return {
      gx: Math.round(worldPos.x),
      gz: Math.round(worldPos.z),
    };
  }

  /** Clé Map pour une cellule grille. */
  _key(gx, gz) { return `${gx},${gz}`; }

  /** Centre monde d'une cellule grille. */
  _cellCenter(gx, gz) {
    return new THREE.Vector3(gx, this._y, gz);
  }

  // ── World slots (cellules) ─────────────────────────────────────────────────

  /** Retourne true si la cellule à (gx, gz) est libre. */
  isFree(gx, gz) {
    const cell = this._cells.get(this._key(gx, gz));
    return !cell || !cell.brickInstanceId;
  }

  /** Ajoute (ou réutilise) un world slot à la cellule la plus proche de worldPos. */
  addWorldSlot(worldPos) {
    const { gx, gz } = this.worldToGrid(worldPos);

    // Si la cellule exacte est occupée, chercher la plus proche libre
    const [fx, fz] = this._nearestFree(gx, gz);
    const key = this._key(fx, fz);

    let cell = this._cells.get(key);
    if (!cell) {
      const pos  = this._cellCenter(fx, fz);
      const mesh = this._makeCellMesh(pos);
      this._scene.add(mesh);
      cell = { gx: fx, gz: fz, position: pos, mesh, brickInstanceId: null };
      this._cells.set(key, cell);
    }
    return cell;
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
    this._scene.remove(wslot.mesh);
    wslot.mesh.geometry.dispose();
    wslot.mesh.material.dispose();
    const key = this._key(wslot.gx, wslot.gz);
    this._cells.delete(key);
  }

  nearest(worldPos, maxDist = Infinity) {
    const { gx, gz } = this.worldToGrid(worldPos);
    const key = this._key(gx, gz);
    const cell = this._cells.get(key);
    if (cell) {
      const d = new THREE.Vector2(worldPos.x - cell.position.x, worldPos.z - cell.position.z).length();
      if (d < maxDist) return cell;
    }
    // Fallback : parcours des cellules matérialisées
    let best = null, bestD = maxDist;
    for (const c of this._cells.values()) {
      const d = new THREE.Vector2(worldPos.x - c.position.x, worldPos.z - c.position.z).length();
      if (d < bestD) { bestD = d; best = c; }
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
    for (const cell of [...this._cells.values()]) this.remove(cell);
    if (this._gridGroup) {
      this._scene.remove(this._gridGroup);
      this._gridGroup.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this._gridGroup = null;
    }
  }

  // ── Privé ────────────────────────────────────────────────────────────────────

  /** Construit la grille visuelle (lignes). */
  _initGrid() {
    const r   = this._gridRadius;
    const pts = [];
    for (let i = -r; i <= r; i++) {
      // Lignes parallèles à Z
      pts.push(new THREE.Vector3(i, 0, -r), new THREE.Vector3(i, 0, r));
      // Lignes parallèles à X
      pts.push(new THREE.Vector3(-r, 0, i), new THREE.Vector3(r, 0, i));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: WS_COLOR, transparent: true, opacity: 0.15, depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);

    this._gridGroup = new THREE.Group();
    this._gridGroup.add(lines);
    this._gridGroup.position.y = this._y;
    this._scene.add(this._gridGroup);
  }

  /** Trouve la cellule libre la plus proche de (gx, gz) en spirale. */
  _nearestFree(gx, gz) {
    if (this.isFree(gx, gz)) return [gx, gz];
    for (let r = 1; r <= 12; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // périmètre seulement
          if (this.isFree(gx + dx, gz + dz)) return [gx + dx, gz + dz];
        }
      }
    }
    return [gx, gz]; // fallback
  }

  /** Crée le mesh visuel d'une cellule occupée. */
  _makeCellMesh(pos) {
    const geo  = new THREE.PlaneGeometry(0.9, 0.9);
    const mat  = new THREE.MeshBasicMaterial({
      color: WS_COLOR, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.01, pos.z);
    return mesh;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AsmJoints  —  connexions et liaisons de la scène, marqueurs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Décrit l'ensemble des liaisons existant dans la scène d'assemblage :
 * Décrit l'ensemble des liaisons existant dans la scène d'assemblage
 * et leurs représentations visuelles (marqueurs disque).
 *
 * Une connexion = { instA, instB, slotA, slotB, liaison }
 * où liaison est un objet du store rbang_liaisons (ou null).
 */
export class AsmJoints {

  /**
   * @param {THREE.Scene}      scene
   * @param {AssemblySolver}  solver
   */
  constructor(scene, solver) {
    this._scene  = scene;
    this._solver = solver;

    /** @type {Object[]}  toutes les connexions de la scène */
    this.connections = [];

    /** @type {Array<{ mesh: THREE.Mesh, conn: Object }>} */
    this._markers = [];

    /** Visibilité globale de tous les marqueurs de liaisons. */
    this.markersVisible = true;

    /**
     * Callback déclenché lors de l'ajout d'une connexion EXPLICITE.
     * Signature : (conn) → bool
     * Retourne true si des AsmHandlers ont pris en charge la connexion
     * (remplacent alors le disque marqueur).
     * @type {((conn: Object) => boolean) | null}
     */
    this.onConnect = null;

    /**
     * Dernière connexion créée avec métadonnées.
     * @type {{ conn: Object, timestamp: number, initiator: Object|null } | null}
     */
    this._lastEntry = null;
  }

  // ── Accesseurs dernière liaison ───────────────────────────────────────────────

  /** Dernière connexion créée, ou null. */
  get lastConn()      { return this._lastEntry?.conn       ?? null; }

  /** Brique initiatrice de la dernière connexion (ajoutée ou déplacée), ou null. */
  get lastInitiator() { return this._lastEntry?.initiator  ?? null; }

  /** Timestamp (ms) de création de la dernière connexion, ou null. */
  get lastTimestamp() { return this._lastEntry?.timestamp  ?? null; }

  // ── API publique ─────────────────────────────────────────────────────────────

  /**
   * Met à jour les connexions depuis l'état courant des slots.
   * Détecte les nouvelles paires coïncidentes, supprime les obsolètes.
   * Source de vérité unique — remplace add() / addImplicitsFor() / removeFor().
   *
   * @param {AsmSlots}  asmSlots
   * @param {boolean}   [notify=false]    — si true, déclenche onConnect pour les nouvelles connexions
   * @param {Object}    [initiator=null]  — brique ajoutée ou déplacée à l'origine de l'observe
   */
  observe(asmSlots, notify = false, initiator = null) {
    const pairs = asmSlots.coincidentPairs();

    // Construire la liste cible des connexions
    const next  = [];
    const added = [];
    for (const { brickA, slotA, brickB, slotB } of pairs) {
      const existing = this.connections.find(c =>
        (c.instA === brickA && c.slotA === slotA && c.instB === brickB && c.slotB === slotB) ||
        (c.instA === brickB && c.slotA === slotB && c.instB === brickA && c.slotB === slotA)
      );
      if (existing) {
        next.push(existing);
      } else {
        const liaison = this._solver.compatible(slotA.typeId, slotB.typeId);
        if (liaison) {
          const conn = { instA: brickA, instB: brickB, slotA, slotB, liaison };
          next.push(conn);
          added.push(conn);
        }
      }
    }

    // Connexions obsolètes → nettoyer les marqueurs
    const stale = this.connections.filter(c => !next.includes(c));
    for (const conn of stale) {
      const mi = this._markers.findIndex(jm => jm.conn === conn);
      if (mi !== -1) {
        const { mesh } = this._markers[mi];
        this._scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this._markers.splice(mi, 1);
      }
    }

    this.connections = next;

    // Reconstruire brick.connections pour toutes les briques touchées
    const touched = new Set([
      ...next.flatMap(c  => [c.instA, c.instB]),
      ...stale.flatMap(c => [c.instA, c.instB]),
    ]);
    for (const brick of touched) brick.connections = [];
    for (const conn of this.connections) {
      conn.instA.connections.push(conn);
      conn.instB.connections.push(conn);
    }

    // Synchroniser l'état occupé des slots
    asmSlots.syncOccupied(this.connections);

    // Nouvelles connexions → stocker métadonnées + marqueur ou activation des handlers
    for (const conn of added) {
      this._lastEntry = { conn, timestamp: Date.now(), initiator };
      const handlersActive = notify ? (this.onConnect?.(conn) ?? false) : false;
      if (!handlersActive) this._createMarker(conn);
    }
  }

  /** Retourne true si une connexion existe entre brickA et brickB. */
  has(brickA, brickB) {
    return brickA.connections.some(c => c.instA === brickB || c.instB === brickB);
  }

  /** Retire tous les marqueurs, réinitialise les connexions et les listes par brique. */
  dispose() {
    const touched = new Set(this.connections.flatMap(c => [c.instA, c.instB]));
    for (const brick of touched) brick.connections = [];
    for (const { mesh } of this._markers) {
      this._scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this._markers = [];
    this.connections = [];
    this._lastEntry = null;
  }

  /** Reflète l'état global markersVisible. */
  get allMarkersVisible() { return this.markersVisible; }

  /** Bascule la visibilité globale et applique à tous les marqueurs existants. */
  setAllMarkersVisible(visible) {
    this.markersVisible = visible;
    for (const { mesh } of this._markers) mesh.visible = visible;
  }

  /** Retourne true si le marqueur de cette connexion est visible. */
  isMarkerVisible(conn) {
    const jm = this._markers.find(m => m.conn === conn);
    return jm ? jm.mesh.visible : false;
  }

  /** Active ou masque le marqueur 3D d'une connexion (contraint par markersVisible). */
  setMarkerVisible(conn, visible) {
    const jm = this._markers.find(m => m.conn === conn);
    if (jm) jm.mesh.visible = visible && this.markersVisible;
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

    // Nouveau marqueur masqué par défaut — ne s'affiche pas au dernier assemblage
    marker.visible = false;
    this._scene.add(marker);
    this._markers.push({ mesh: marker, conn });
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
 * (`!liaison.dof?.length`).
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

    // Solveur de liaisons — données chargées une fois au démarrage
    let liaisons = {};
    try { liaisons = JSON.parse(localStorage.getItem('rbang_liaisons') || '{}'); } catch {}
    this._solver = new AssemblySolver(liaisons);

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
        console.log('[spawnBrick] fallback shapes localStorage pour', brickData.shapeRef,
          '→', shapeData ? 'trouvé' : 'ABSENT');
      } catch { return null; }
    }
    if (!shapeData?.steps || !shapeData.rootId) {
      console.warn('[spawnBrick] shapeData invalide pour', brickTypeId,
        '| steps:', shapeData?.steps?.length, '| rootId:', shapeData?.rootId);
      return null;
    }

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

    this.slots.unregisterBrick(brick);   // ← point d'entrée 2 du registre
    this.joints.observe(this.slots);     // nettoie les connexions obsolètes
    this.bricks.delete(brick.id);
  }

  // ── Connexions ───────────────────────────────────────────────────────────────

  /**
   * Assemble brickA sur brickB d'après les points d'accroche écran.
   * Déplace brickA puis déclenche l'observateur de scène.
   * @returns {Object|null} connexion détectée, ou null si aucune liaison compatible
   */
  connectDrag(brickA, grabX, grabY, brickB, dropX, dropY, camera) {
    // brickA est en cours de déplacement : tous ses slots sont temporairement libres
    const nearA  = this.slots.nearSlotsOf(brickA, grabX, grabY, camera);
    const nearB  = this.slots.nearSlotsOf(brickB, dropX, dropY, camera, true, brickA);
    const result = this.worldSlots.resolve(nearA, nearB);
    if (!result) {
      this._solver.diagnose(nearA, nearB, this.slots.typeIds);
      return null;
    }
    const snap = this.worldSlots.computeSnap(result.slotA, result.slotB, brickB);
    brickA.mesh.position.copy(snap.position);
    brickA.mesh.quaternion.copy(snap.quaternion);
    this.joints.observe(this.slots, true, brickA);
    return this.joints.connections.find(c =>
      (c.instA === brickA || c.instB === brickA) &&
      (c.instA === brickB || c.instB === brickB)
    ) ?? null;
  }

  /**
   * Calcule la position snappée de brickA vers brickB SANS modifier la scène.
   * Utilisé pour le preview en temps réel pendant le drag.
   * @returns {{ position, quaternion } | null}
   */
  previewSnap(brickA, grabX, grabY, brickB, dropX, dropY, camera) {
    const nearA  = this.slots.nearSlotsOf(brickA, grabX, grabY, camera);
    const nearB  = this.slots.nearSlotsOf(brickB, dropX, dropY, camera, true, brickA);
    const result = this.worldSlots.resolve(nearA, nearB);
    if (!result) return null;
    return this.worldSlots.computeSnap(result.slotA, result.slotB, brickB);
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
    const isRigid = c => !(c.liaison?.dof?.length);
    const seen       = new Set();
    const components = [];

    for (const brick of this.bricks.values()) {
      if (seen.has(brick.id)) continue;
      // BFS rigide — utilise brick.connections pour O(V+E)
      const compBricks = new Set([brick]);
      const queue      = [brick];
      while (queue.length) {
        const b = queue.shift();
        for (const conn of b.connections) {
          if (!isRigid(conn)) continue;
          const neighbor = conn.instA === b ? conn.instB : conn.instA;
          if (!compBricks.has(neighbor)) {
            compBricks.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      const compIds    = new Set([...compBricks].map(b => b.id));
      const internalJoints = [...compBricks].flatMap(b =>
        b.connections.filter(c => isRigid(c) && compBricks.has(c.instA) && compBricks.has(c.instB))
      ).filter((c, i, arr) => arr.indexOf(c) === i); // dédupliquer
      const ec = new AsmEquivalenceClass(compBricks, internalJoints);
      components.push(ec);
      for (const b of compBricks) seen.add(b.id);
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
    // Seules les poses des briques sont sauvegardées.
    // Les connexions sont un état dérivé : elles seront reconstruites à la
    // restauration depuis les positions monde des slots (joints.observe).
    const instances = [...this.bricks.values()].map(b => ({
      id          : b.id,
      brickTypeId : b.brickTypeId,
      px: b.mesh.position.x, py: b.mesh.position.y, pz: b.mesh.position.z,
      qx: b.mesh.quaternion.x, qy: b.mesh.quaternion.y,
      qz: b.mesh.quaternion.z, qw: b.mesh.quaternion.w,
    }));
    return { version: 1, instances };
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
    console.log('[restore] instances:', data?.instances?.length,
      '| bricksStore keys:', Object.keys(bricksStore).length,
      '| shapesStore keys:', Object.keys(shapesStore).length,
      '| liaisonsStore keys:', Object.keys(liaisonsStore).length);

    if (!data?.instances?.length) return new Map();
    const idMap = new Map();

    for (const s of data.instances) {
      const brickData = bricksStore[s.brickTypeId];
      if (!brickData) {
        console.warn('[restore] brickTypeId introuvable:', s.brickTypeId,
          '— keys dispo:', Object.keys(bricksStore).slice(0, 5));
        continue;
      }
      const shapeData = shapesStore[brickData.shapeRef] ?? null;
      console.log('[restore] instance', s.brickTypeId,
        '| shapeRef:', brickData.shapeRef,
        '| shapeData trouvé:', !!shapeData);
      const brick = await this.spawnBrick(
        s.brickTypeId, brickData,
        new THREE.Vector3(s.px, s.py, s.pz),
        null, shapeData
      );
      if (!brick) {
        console.warn('[restore] spawnBrick a retourné null pour', s.brickTypeId);
        continue;
      }
      // Appliquer la pose exacte sauvegardée
      brick.mesh.position.set(s.px, s.py, s.pz);
      brick.mesh.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      idMap.set(s.id, brick);
    }

    console.log('[restore] briques chargées:', idMap.size, '/', data.instances.length);
    // Toutes les briques sont positionnées — l'observateur détecte les connexions
    this.joints.observe(this.slots);

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
