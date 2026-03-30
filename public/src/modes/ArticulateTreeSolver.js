// ═══════════════════════════════════════════════════════════════════════════════
// ArticulateTreeSolver — solveur pour arbre cinématique ouvert avec ancre
//
// Utilisé en mode Articuler. Étend la logique d'InvolvedComponentsSolver :
//   1. Calcule les composantes rigides.
//   2. Coupe l'arbre à la liaison active.
//   3. Détermine le côté ancre (fixe) vs le côté mobile via BFS depuis l'ancre.
//   4. Retourne les briques de toutes les composantes du sous-arbre mobile.
//
// Paramètre supplémentaire : `anchorBricks` (Set<AsmBrick>) — briques de la
// classe de référence. Si absent, retombe sur InvolvedComponentsSolver classique.
// ═══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';

export class ArticulateTreeSolver {

  /**
   * @param {Set<AsmBrick>|null} anchorBricks — briques de la classe de référence (ancre)
   */
  constructor(anchorBricks = null) {
    this._anchorBricks = anchorBricks;
  }

  /**
   * @param {Object}        conn        — connexion DOF active { instA, instB, slotA, slotB, liaison }
   * @param {Object[]}      connections — toutes les connexions de la scène
   * @param {THREE.Vector3|null} dofAxis — axe DOF monde ; null → [instA] seule
   * @returns {import('./AsmVerse.js').AsmBrick[]}
   */
  solve(conn, connections, dofAxis) {
    if (!dofAxis) return [conn.instA];

    const { instA, instB } = conn;

    // 1. Composantes rigides
    const allBricks = new Set(connections.flatMap(c => [c.instA, c.instB]));
    allBricks.add(instA);
    allBricks.add(instB);
    const comps = this._rigidComponents(allBricks, connections);

    const compA = comps.find(c => c.has(instA));
    const compB = comps.find(c => c.has(instB));
    if (!compA || !compB) return [instA];

    // 2. Trouver la composante ancre
    const anchorComp = this._anchorBricks
      ? comps.find(c => [...this._anchorBricks].some(b => c.has(b)))
      : compB; // fallback : instB est le pivot

    if (!anchorComp) return [instA];

    // 3. Merger les liaisons colinéaires entre mêmes composantes.
    //    Deux connexions DOF entre les mêmes deux composantes dont les axes sont
    //    colinéaires forment une seule liaison cinématique (pas une boucle).
    //    On regroupe par paire de composantes : Set<"compIdx-compIdx"> → connexions.
    const compOf = brick => comps.findIndex(c => c.has(brick));
    const pairKey = c => {
      const a = compOf(c.instA), b = compOf(c.instB);
      return a < b ? `${a}-${b}` : `${b}-${a}`;
    };
    const activeKey = pairKey(conn);

    // Tester la colinéarité d'une connexion avec l'axe DOF actif
    const isColinear = c => {
      for (const dof of (c.liaison?.dof ?? [])) {
        if (!dof.axis || dof.type === 'ball') continue;
        const slotQ  = new THREE.Quaternion(...(c.slotB.quaternion ?? [0, 0, 0, 1]));
        const worldQ = slotQ.clone().premultiply(c.instB.mesh.quaternion.clone());
        const axis   = new THREE.Vector3(...dof.axis).normalize().applyQuaternion(worldQ);
        if (dofAxis.clone().cross(axis).length() < 1e-3) return true;
      }
      return false;
    };

    // Connexions à ne pas traverser : la liaison active + toute liaison colinéaire
    // entre les deux mêmes composantes (elles forment un seul lien cinématique)
    const isBlockedConn = c => {
      if (!(c.liaison?.dof?.length > 0)) return false;
      if (pairKey(c) !== activeKey) return false;
      // Même paire de composantes → bloquée si colinéaire ou si c'est la liaison active
      const isSameConn =
        (c.instA === instA && c.instB === instB) ||
        (c.instA === instB && c.instB === instA);
      return isSameConn || isColinear(c);
    };

    // 4. BFS depuis la composante ancre SANS traverser les liaisons bloquées
    //    → détermine le sous-arbre fixe
    const fixedSet = new Set([anchorComp]);
    const queue    = [anchorComp];

    while (queue.length) {
      const comp = queue.shift();
      for (const c of connections) {
        if (isBlockedConn(c)) continue;
        if (!(c.liaison?.dof?.length > 0)) continue; // seules les DOF traversent

        const inA = comp.has(c.instA);
        const inB = comp.has(c.instB);
        if (!inA && !inB) continue;
        if (inA && inB)  continue;

        const otherBrick = inA ? c.instB : c.instA;
        const other = comps.find(cc => cc.has(otherBrick));
        if (!other || fixedSet.has(other)) continue;

        fixedSet.add(other);
        queue.push(other);
      }
    }

    // 4. Le sous-arbre mobile = toutes les composantes qui ne sont PAS dans fixedSet
    const mobileBricks = [];
    for (const comp of comps) {
      if (!fixedSet.has(comp)) {
        for (const b of comp) mobileBricks.push(b);
      }
    }

    return mobileBricks.length ? mobileBricks : [instA];
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
}
