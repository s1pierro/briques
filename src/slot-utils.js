/**
 * expandSlots — matérialise les slots virtuels depuis des répétitions paramétriques.
 *
 * Chaque définition de slot peut porter un champ `repeats` (tableau d'axes) :
 *   repeats: [
 *     { count: number, step: [dx, dy, dz] },   // axe 1
 *     { count: number, step: [dx, dy, dz] },   // axe 2
 *     …
 *   ]
 *
 * L'expansion produit le produit cartésien de tous les axes.
 * Ex : repeats [{count:3,step:[2,0,0]}, {count:2,step:[0,0,1]}] → 6 slots en grille 3×2.
 *
 * Compat : l'ancien champ `repeat: { count, step }` (singulier) est accepté
 * et traité comme `repeats: [repeat]`.
 *
 * Chaque slot produit porte `_defId` = l'id de la définition parente.
 */
export function expandSlots(defs) {
  const result = [];
  for (const s of defs) {
    // Normalisation : repeat legacy → repeats
    const repeats = s.repeats ?? (s.repeat ? [s.repeat] : []);

    // Cas atomique
    if (repeats.length === 0 || repeats.every(r => (r.count ?? 1) <= 1)) {
      result.push({ ...s, _defId: s.id });
      continue;
    }

    // Produit cartésien des axes
    const counts = repeats.map(r => r.count ?? 1);
    const total  = counts.reduce((a, b) => a * b, 1);

    // Générateur de toutes les combinaisons d'indices
    function* cartesian(dims, depth = 0) {
      if (depth === dims.length) { yield []; return; }
      for (let i = 0; i < dims[depth]; i++) {
        for (const rest of cartesian(dims, depth + 1)) {
          yield [i, ...rest];
        }
      }
    }

    for (const idxs of cartesian(counts)) {
      const pos = [s.position[0], s.position[1], s.position[2]];
      for (let a = 0; a < repeats.length; a++) {
        const [dx, dy, dz] = repeats[a].step ?? [0, 0, 0];
        pos[0] += dx * idxs[a];
        pos[1] += dy * idxs[a];
        pos[2] += dz * idxs[a];
      }
      result.push({
        ...s,
        _defId:   s.id,
        id:       total > 1 ? `${s.id}#${idxs.join('_')}` : s.id,
        position: pos,
      });
    }
  }
  return result;
}
