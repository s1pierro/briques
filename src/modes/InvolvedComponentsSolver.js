// ═══════════════════════════════════════════════════════════════════════════════
// InvolvedComponentsSolver — solveur au niveau des classes d'équivalence
//
// Utilisé en mode Composante. Lève InvolvedBricksSolver d'un cran :
// les nœuds du BFS sont des composantes connexes rigides, pas des briques.
//
// Algorithme (arbre ouvert) :
//   1. Calcule les composantes rigides depuis les connexions de la scène.
//   2. BFS depuis la composante mobile (celle contenant instA).
//   3. Franchit les liaisons DOF vers les composantes voisines.
//   4. Si une voisine est la composante fixe (instB) :
//        - DOF colinéaire → compatible, on continue sans l'embarquer.
//        - DOF non colinéaire → conflit → retourne uniquement la composante mobile.
//   5. Retourne les briques de toutes les composantes embarquées.
// ═══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';

export class InvolvedComponentsSolver {

  /**
   * @param {Object}        conn        — connexion DOF active { instA, instB, slotA, slotB, liaison }
   * @param {Object[]}      connections — toutes les connexions de la scène
   * @param {THREE.Vector3|null} dofAxis — axe DOF monde ; null → [instA] seule
   * @returns {import('./AsmVerse.js').AsmBrick[]}
   */
  solve(conn, connections, dofAxis) {
    if (!dofAxis) return [conn.instA];

    const { instA, instB } = conn;

    // 1. Composantes rigides depuis les connexions
    const allBricks = new Set(connections.flatMap(c => [c.instA, c.instB]));
    allBricks.add(instA);
    allBricks.add(instB);
    const comps = this._rigidComponents(allBricks, connections);

    const mobileComp = comps.find(c => c.has(instA));
    const fixedComp  = comps.find(c => c.has(instB));
    if (!mobileComp || !fixedComp) return [instA];

    // 2. BFS sur le graphe de composantes
    const mobileSet = new Set([mobileComp]);
    const queue     = [mobileComp];

    while (queue.length) {
      const comp = queue.shift();

      for (const c of connections) {
        if (c === conn) continue;
        // Seules les connexions DOF traversent les frontières de composantes
        if (!(c.liaison?.dof?.length > 0)) continue;

        const inA = comp.has(c.instA);
        const inB = comp.has(c.instB);
        if (!inA && !inB) continue; // ne touche pas cette composante
        if (inA && inB)  continue;  // interne (ne devrait pas arriver pour un DOF)

        const otherBrick = inA ? c.instB : c.instA;
        const other = comps.find(cc => cc.has(otherBrick));
        if (!other || mobileSet.has(other)) continue;

        if (other === fixedComp) {
          // Fermeture sur le côté fixe
          if (this._collinear(c, dofAxis)) continue; // colinéaire → compatible
          return [...mobileComp];                     // non colinéaire → conflit
        }

        mobileSet.add(other);
        queue.push(other);
      }
    }

    return [...mobileSet].flatMap(c => [...c]);
  }

  // ── Privé ───────────────────────────────────────────────────────────────────

  /** BFS via connexions rigides (sans dof) → liste de Set<AsmBrick>. */
  _rigidComponents(allBricks, connections) {
    const seen  = new Set();
    const comps = [];

    for (const start of allBricks) {
      if (seen.has(start)) continue;
      const comp = new Set([start]);
      const q    = [start];
      while (q.length) {
        const b = q.shift();
        for (const c of connections) {
          if (c.liaison?.dof?.length > 0) continue;
          const other = c.instA === b ? c.instB : c.instB === b ? c.instA : null;
          if (other && !comp.has(other)) { comp.add(other); q.push(other); }
        }
      }
      for (const b of comp) seen.add(b);
      comps.push(comp);
    }

    return comps;
  }

  /** Vérifie si la connexion c a un axe DOF colinéaire avec dofAxis. */
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
