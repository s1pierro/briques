// ═══════════════════════════════════════════════════════════════════════════════
// InvolvedBricksSolver — briques à déplacer lors de l'actionnement d'un DOF
//
// Résolution en arbre ouvert (pas de boucle cinématique fermée).
//
// Depuis instA (brique mobile du DOF actif), le solveur collecte :
//   • toutes les briques liées par des connexions rigides (corps rigide)
//   • les briques liées par des DOF colinéaires à l'axe actif (compatibles)
//
// Si la traversée rencontre le côté fixe (composante de instB) via une liaison
// NON colinéaire, seule instA est renvoyée (la propagation violerait la contrainte).
// ═══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';

export class InvolvedBricksSolver {

  /**
   * @param {Object}        conn        — connexion DOF active { instA, instB, slotA, slotB, liaison }
   * @param {Object[]}      connections — toutes les connexions de la scène (AsmJoints.connections)
   * @param {THREE.Vector3|null} dofAxis — axe DOF en espace monde ; null (ball) → [instA] seule
   * @returns {import('./AsmVerse.js').AsmBrick[]}
   */
  solve(conn, connections, dofAxis) {
    if (!dofAxis) return [conn.instA];

    const { instA, instB } = conn;

    // 1. Composante rigide du côté fixe (instB + ses voisins rigides hors joint actif)
    const fixedSet = this._rigidSet(instB, conn, connections);

    // 2. BFS depuis instA pour collecter les briques embarquées
    const mobileSet = new Set([instA]);
    const queue     = [instA];

    while (queue.length) {
      const brick = queue.shift();
      for (const c of connections) {
        if (c === conn) continue; // joint actif : pas de retour vers instB

        const other = c.instA === brick ? c.instB
                    : c.instB === brick ? c.instA : null;
        if (!other || mobileSet.has(other)) continue;

        const isRigid = !(c.liaison?.dof?.length > 0);

        if (fixedSet.has(other)) {
          // Connexion vers le monde fixe
          if (!isRigid && this._collinear(c, dofAxis)) continue; // DOF colinéaire → compatible
          return [instA]; // fermeture non colinéaire → seulement instA
        }

        // Brique potentiellement mobile : rigide ou DOF colinéaire → embarquée
        if (isRigid || this._collinear(c, dofAxis)) {
          mobileSet.add(other);
          queue.push(other);
        }
        // DOF non colinéaire vers brique non-fixe → frontière, on ne traverse pas
      }
    }

    return [...mobileSet];
  }

  // ── Privé ─────────────────────────────────────────────────────────────────────

  /** BFS des briques rigidement connectées à `start`, en excluant `excludeConn`. */
  _rigidSet(start, excludeConn, connections) {
    const set   = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const b = queue.shift();
      for (const c of connections) {
        if (c === excludeConn || c.liaison?.dof?.length > 0) continue;
        const other = c.instA === b ? c.instB : c.instB === b ? c.instA : null;
        if (other && !set.has(other)) { set.add(other); queue.push(other); }
      }
    }
    return set;
  }

  /**
   * Vérifie si la connexion c possède un axe DOF colinéaire avec dofAxis.
   * L'axe est défini dans le repère de c.slotB (convention instB = pivot).
   * Les DOF de type 'ball' sont ignorés (pas d'axe unique → non colinéaire).
   */
  _collinear(c, dofAxis) {
    for (const dof of (c.liaison?.dof ?? [])) {
      if (!dof.axis || dof.type === 'ball') continue;
      const slotBQ = new THREE.Quaternion(...(c.slotB.quaternion ?? [0, 0, 0, 1]));
      const worldQ = slotBQ.clone().premultiply(c.instB.mesh.quaternion.clone());
      const axis   = new THREE.Vector3(...dof.axis).normalize().applyQuaternion(worldQ);
      if (dofAxis.clone().cross(axis).length() < 1e-3) return true;
    }
    return false;
  }
}
