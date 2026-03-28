// ═══════════════════════════════════════════════════════════════════════════════
// InvolvedBricksSolverAsm — version alternative de InvolvedBricksSolver
//
// Différences vs InvolvedBricksSolver :
//
//   • Granularité par brique (pas de pré-groupement en corps rigides).
//     Chaque brique, même liée par une soudure, est sa propre classe
//     d'équivalence temporaire.
//
//   • Classification basée sur asmDof (pas dof physique) :
//     - Sans asmDof (soudure ou dof physique sans handle assemblage)
//       → "assembly-rigide" : la brique embarque inconditionnellement.
//     - Avec asmDof (colinéaire ou non) → frontière, propagation stoppée.
//
//   • Monde fixe simplifié : instB seul (pas la composante rigide de instB).
//     Les briques soudées à instB ne sont pas automatiquement "fixes".
//
// Ce solveur est plus permissif pour les connexions dof/sans-asmDof et
// offre une granularité plus fine pour les assemblages avec soudures mixtes.
// ═══════════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';

export class InvolvedBricksSolverAsm {

  /**
   * @param {Object}        conn        — connexion DOF active { instA, instB, slotA, slotB, liaison }
   * @param {Object[]}      connections — toutes les connexions de la scène (AsmJoints.connections)
   * @param {THREE.Vector3|null} dofAxis — axe DOF en espace monde ; null (ball) → [instA] seule
   * @returns {import('./AsmVerse.js').AsmBrick[]}
   */
  solve(conn, connections, dofAxis) {
    if (!dofAxis) return [conn.instA];

    const { instA, instB } = conn;

    // BFS depuis instA — chaque brique est évaluée individuellement
    const mobileSet = new Set([instA]);
    const queue     = [instA];

    while (queue.length) {
      const brick = queue.shift();
      for (const c of connections) {
        if (c === conn) continue; // joint actif : pas de retour vers instB

        const other = c.instA === brick ? c.instB
                    : c.instB === brick ? c.instA : null;
        if (!other || mobileSet.has(other)) continue;

        const hasAsmDof = c.liaison?.asmDof?.length > 0;

        if (other === instB) {
          // Fermeture sur le pivot fixe
          if (hasAsmDof && this._collinear(c, dofAxis)) continue; // asmDof colinéaire → compatible
          return [instA]; // soudure ou asmDof non colinéaire → seulement instA
        }

        // Seule une connexion sans asmDof (assembly-rigide) propage ;
        // toute liaison asmDof (même colinéaire) est une frontière.
        if (!hasAsmDof) {
          mobileSet.add(other);
          queue.push(other);
        }
      }
    }

    return [...mobileSet];
  }

  // ── Privé ─────────────────────────────────────────────────────────────────────

  /**
   * Vérifie si la connexion c a un asmDof colinéaire avec dofAxis.
   * L'axe est défini dans le repère de c.slotB (convention instB = pivot).
   */
  _collinear(c, dofAxis) {
    for (const dof of (c.liaison?.asmDof ?? [])) {
      if (!dof.axis || dof.type === 'ball') continue;
      const slotBQ = new THREE.Quaternion(...(c.slotB.quaternion ?? [0, 0, 0, 1]));
      const worldQ = slotBQ.clone().premultiply(c.instB.mesh.quaternion.clone());
      const axis   = new THREE.Vector3(...dof.axis).normalize().applyQuaternion(worldQ);
      if (dofAxis.clone().cross(axis).length() < 1e-3) return true;
    }
    return false;
  }
}
