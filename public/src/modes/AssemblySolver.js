// ═══════════════════════════════════════════════════════════════════════════════
// AssemblySolver  —  résolution de liaisons entre slots
//
// Logique métier pure : aucune dépendance Three.js ni localStorage.
// Reçoit les données rbang_liaisons à la construction (injectées par AsmVerse).
// ═══════════════════════════════════════════════════════════════════════════════

export class AssemblySolver {

  /**
   * @param {Object} liaisons  — contenu de rbang_liaisons (id → liaison)
   */
  constructor(liaisons = {}) { this._liaisons = liaisons; }

  /**
   * Cherche la première paire (slotA, slotB) compatible dans les deux listes
   * de slots ordonnés par priorité (typiquement par proximité écran).
   * @param {Object[]} nearA  — slots de la brique source, triés
   * @param {Object[]} nearB  — slots de la brique cible, triés
   * @returns {{ slotA, slotB, liaison } | null}
   */
  solve(nearA, nearB) {
    for (const sa of nearA) {
      for (const sb of nearB) {
        const li = this._findLiaison(sa.typeId, sb.typeId);
        if (li) return { slotA: sa, slotB: sb, liaison: li };
      }
    }
    return null;
  }

  /** Retourne une liaison rotule synthétique (sans définition dans rbang_liaisons). */
  ballJoint() {
    return { id: '__ball__', name: 'Rotule', dof: [{ type: 'ball', axis: [0, 1, 0] }] };
  }

  /**
   * Retourne la liaison définie pour (typeA, typeB), ou null.
   * Utilisé par AsmJoints.observe() pour les paires coïncidentes.
   */
  compatible(typeA, typeB) { return this._findLiaison(typeA, typeB); }

  /**
   * Affiche dans la console les raisons pour lesquelles solve() a renvoyé null.
   * @param {Object[]}  nearA
   * @param {Object[]}  nearB
   * @param {Set<string>} [sceneTypeIds]  — AsmSlots.typeIds, typeIds présents dans la scène
   */
  diagnose(nearA, nearB, sceneTypeIds = null) {
    console.group('[AssemblySolver] solve() → null');
    if (!nearA.length) { console.warn('Source : aucun slot défini'); console.groupEnd(); return; }
    if (!nearB.length) { console.warn('Cible  : aucun slot défini'); console.groupEnd(); return; }

    const nullA = nearA.filter(s => !s.typeId);
    const nullB = nearB.filter(s => !s.typeId);
    if (nullA.length) console.warn(`Source : ${nullA.length} slot(s) sans typeId`);
    if (nullB.length) console.warn(`Cible  : ${nullB.length} slot(s) sans typeId`);

    // Check 1 : typeIds connus dans la scène (source AsmSlots)
    if (sceneTypeIds) {
      const misA = nearA.filter(s => s.typeId && !sceneTypeIds.has(s.typeId)).map(s => s.typeId);
      const misB = nearB.filter(s => s.typeId && !sceneTypeIds.has(s.typeId)).map(s => s.typeId);
      if (misA.length) console.warn('typeId(s) source absents de la scène :', misA);
      if (misB.length) console.warn('typeId(s) cible  absents de la scène :', misB);
    }

    // Check 2 : typeIds couverts par rbang_liaisons (source Forge)
    const forgeTypes = new Set(
      Object.values(this._liaisons).flatMap(l => (l.pairs || []).flatMap(p => [p.typeA, p.typeB]))
    );
    if (!forgeTypes.size) {
      console.warn('rbang_liaisons vide — aucune liaison définie dans la Forge');
    } else {
      const misA = nearA.filter(s => s.typeId && !forgeTypes.has(s.typeId)).map(s => s.typeId);
      const misB = nearB.filter(s => s.typeId && !forgeTypes.has(s.typeId)).map(s => s.typeId);
      if (misA.length) console.warn('typeId(s) source sans liaison dans la Forge :', misA);
      if (misB.length) console.warn('typeId(s) cible  sans liaison dans la Forge :', misB);
    }

    console.warn('typeIds source :', nearA.map(s => s.typeId));
    console.warn('typeIds cible  :', nearB.map(s => s.typeId));
    console.groupEnd();
  }

  // ── Privé ────────────────────────────────────────────────────────────────────

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
