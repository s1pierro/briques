/**
 * expandSlots — matérialise les slots virtuels d'une répétition linéaire.
 *
 * Chaque définition de slot peut porter un champ optionnel `repeat` :
 *   { count: number, step: [dx, dy, dz] }
 *
 * Sans `repeat` (ou count ≤ 1), le slot est atomique et est retourné tel quel.
 * Avec `repeat`, on produit `count` slots décalés de `step` à chaque itération.
 *
 * Chaque slot produit porte `_defId` = l'id de la définition parente,
 * ce qui permet de retrouver la définition depuis un slot virtuel.
 */
export function expandSlots(defs) {
  const result = [];
  for (const s of defs) {
    const n         = s.repeat?.count ?? 1;
    const [sx, sy, sz] = s.repeat?.step ?? [0, 0, 0];
    for (let i = 0; i < n; i++) {
      result.push({
        ...s,
        _defId:   s.id,
        id:       n > 1 ? `${s.id}#${i}` : s.id,
        position: [
          s.position[0] + sx * i,
          s.position[1] + sy * i,
          s.position[2] + sz * i,
        ],
      });
    }
  }
  return result;
}
