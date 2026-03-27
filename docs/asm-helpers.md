# Helpers d'assemblage (AsmDofHandler / AsmHandlers)

Ce document décrit le système de helpers d'assemblage : leur rôle du point de
vue utilisateur, l'architecture des classes, le détail de chaque méthode, et
les points de vigilance à respecter lors du développement.

---

## 1. Rôle et expérience utilisateur

Lorsqu'une connexion comportant des `asmDof` (degrés de liberté d'assemblage)
est établie entre deux briques, des helpers apparaissent :

- **Un helper 3D** au pivot du slot B — il matérialise visuellement le type de
  liaison (anneau, flèches, sphère, cylindre) ainsi que les pas de référence
  (petites sphères) et la position courante (curseur blanc).
- **Un bandeau tactile** (strip) sous la barre de l'Assembler — l'utilisateur
  glisse son doigt horizontalement pour déplacer la brique A le long du degré
  de liberté.

L'utilisateur peut basculer le mode **pas** via le bouton à gauche du bandeau :
quand il est actif, le mouvement est quantifié sur la grille de pas, et la
brique est recalée sur le pas le plus proche à l'activation.

---

## 2. Architecture

```
Assembler
  └── AsmHandlers                  — orchestrateur pour une connexion
        └── AsmDofHandler ×N       — un handler par entrée asmDof
              ├── Helper 3D        — Group THREE.js dans la scène
              └── Strip DOM        — div tactile dans document.body
```

**`AsmHandlers`** lit la liste `liaison.asmDof` de la connexion active et
instancie un `AsmDofHandler` par entrée. Il délègue `attach()` et `detach()`.

**`AsmDofHandler`** gère un seul degré de liberté. Il est autonome : il
connaît la connexion (`conn`), le DOF (`dof`), et le moteur (`engine`), ce qui
lui suffit pour construire la géométrie et le DOM, appliquer les mouvements
physiques, et se nettoyer.

---

## 3. AsmDofHandler — référence

### Paramètres du constructeur

| Paramètre    | Type    | Description |
|--------------|---------|-------------|
| `dof`        | Object  | Entrée `asmDof` : `{ type, axis, min, max, step }` |
| `conn`       | Object  | Connexion : `{ instA, instB, slotA, slotB, liaison }` |
| `engine`     | GameEngine | Accès à `scene`, dimensions viewport |
| `stripIndex` | number  | Rang vertical du bandeau (0 = premier sous la barre) |
| `topOffset`  | number  | Hauteur en px de la barre Assembler (`BAR_H`) |
| `steps`      | number  | Divisions depuis la config (0 = utilise `dof.step`) |

**Calcul de `_stepSize` :**
- `steps > 0` et type `translation` → `(max − min) / steps`
- `steps > 0` sinon → `2π / steps`
- `steps === 0` → `dof.step ?? 0` (valeur directe, 0 = pas désactivé)

### État interne

| Propriété        | Rôle |
|------------------|------|
| `_rawTotal`      | Accumulateur brut des deltas reçus depuis le bandeau |
| `_stepActive`    | Booléen — mode pas activé ou non |
| `_stepSize`      | Pas en radians ou mètres (0 = pas libre) |
| `_refAxis`       | Axe monde du DOF (`Vector3`) |
| `_refU`, `_refV` | Repère orthonormé dans le plan du disque (rotation/cylindrical) |
| `_cursorMeshes`  | Tableau de meshes blancs : 4 pour rotation/cylindrical, 1 pour translation |
| `_helper`        | `THREE.Group` racine du helper 3D |
| `_strip`         | Élément DOM du bandeau tactile |
| `_valEl`         | Span d'affichage de la valeur courante |

### Méthodes publiques

| Méthode     | Rôle |
|-------------|------|
| `attach()`  | Construit et ajoute le helper 3D + le bandeau tactile |
| `detach()`  | Supprime le helper de la scène (dispose géométries/matériaux), retire le bandeau |

### Méthodes privées — géométrie

| Méthode               | Rôle |
|-----------------------|------|
| `_buildHelper()`      | Point d'entrée : calcule axe/pivot, construit la géométrie selon `dof.type`, ajoute marqueurs + curseur |
| `_buildRefFrame()`    | Calcule `_refU` et `_refV` : axe X du slot B projeté dans le plan perpendiculaire à `_refAxis` ; cas dégénéré (`wa ∥ X`) géré en fallback sur Y |
| `_addDiscMarkers(group, color)` | Sphères Ø 0.084 réparties à `MARKER_R` sur la circonférence — rotation et cylindrical uniquement ; guard `N ≤ 72` |
| `_addAxisMarkers(group, color)` | Sphères le long de l'axe aux pas de `min` à `max` — translation bornée uniquement ; guard `N ≤ 60` |
| `_addCursor(group)`   | 4 sphères blanches Ø 0.13 espacées de 90° (rotation/cylindrical) ou 1 sphère (translation) ; appelle `_updateCursor()` immédiatement |
| `_updateCursor()`     | Recalcule les positions des meshes curseur à partir de la **position engagée** : snappée si step actif, puis clampée `[min, max]` |

### Géométrie par type de DOF

| Type         | Couleur  | Géométrie principale | Marqueurs | Curseur |
|--------------|----------|----------------------|-----------|---------|
| `rotation`   | Acier    | Torus (anneau dans le plan du slot) | Disc markers | 4 sphères |
| `translation`| Jaune    | 2 × ArrowHelper (±axe) | Axis markers (si borné) | 1 sphère |
| `ball`       | Vert     | Sphère Ø 1.0 | — | — |
| `cylindrical`| Orange   | Cylindre Ø 0.64 + 2 × ArrowHelper | Disc markers | 4 sphères |

> **Alignement du torus** : `TorusGeometry` a son axe selon Z (anneau dans XY).
> L'orientation correcte est `setFromUnitVectors(Z, worldAxis)`, pas Y.

### Méthodes privées — maths

| Méthode           | Rôle |
|-------------------|------|
| `_worldAxis()`    | Transforme `dof.axis` du repère local du slot B vers le repère monde : `axis_local → applyQuaternion(slotBQ × instB.quaternion)` |
| `_pivotWorld()`   | Position monde du slot B : `slotB.position → applyQuaternion(instB.quaternion) + instB.position` |
| `_pxToRaw(px)`    | Mappe un delta pixel en valeur brute : `translation → (px/innerWidth) × range`, `rotation → (px/innerWidth) × 2π` |
| `_moveDelta(eff)` | Application physique pure (sans snap/clamp) : translation = `addScaledVector(axis, eff)` ; rotation = rotation autour du pivot monde via quaternion |
| `_applyDelta(raw)`| Pipeline complet : accumule dans `_rawTotal`, applique snap (compare snapped avant/après), applique clamp, appelle `_moveDelta` + `_updateCursor` |
| `_formatVal(raw)` | `°` pour rotation/ball/cylindrical, `m` pour translation |

### Pipeline d'un geste sur le bandeau

```
pointerdown  → setPointerCapture, mémorise lastX
pointermove  → dx = clientX − lastX
             → delta = _pxToRaw(dx)
             → _applyDelta(delta)
                  ├─ snap : prevSnapped = round(rawTotal/step)×step
                  │         rawTotal += delta
                  │         newSnapped = round(rawTotal/step)×step
                  │         effective = newSnapped − prevSnapped
                  ├─ clamp rawTotal dans [min, max]
                  ├─ _moveDelta(effective)  ← physique pure
                  └─ _updateCursor()
             → displayed = step actif ? round(rawTotal/step)×step : rawTotal
             → displayed = clamp(displayed, min, max)
             → valEl.textContent = _formatVal(displayed)   ← position effective
pointerup    → fond strip rétabli
```

### Bandeau — éléments DOM

```
[stepBtn] [label type+axe] [limites min…max] [valeur courante] [◀ ▶]
```

- **stepBtn** : affiche le pas (`°` ou `m`) quand step > 0, sinon `—` ; style
  coloré quand actif, grisé sinon. À l'activation, re-snap sur le pas le plus
  proche : `snapped = round(rawTotal/step)×step`, `diff = snapped − rawTotal`,
  appel `_moveDelta(diff)`.
- **Limites** : affichées uniquement si `dof.min` ou `dof.max` est défini.
- **Valeur courante** : affiche la **position effective** — snappée si step actif, clampée dans `[min, max]`. Pas `_rawTotal` brut, qui diverge de la position réelle dès que le seuil du premier pas n'est pas atteint.

---

## 4. AsmHandlers — référence

```js
new AsmHandlers({ conn, engine, topOffset, stepsRot, stepsTrans })
```

| Paramètre    | Rôle |
|--------------|------|
| `conn`       | Connexion active (doit avoir `conn.liaison.asmDof`) |
| `topOffset`  | Hauteur de la barre Assembler (`BAR_H`) |
| `stepsRot`   | Divisions pour les DOF rotatifs (lu depuis `cfg.asmHelperStepsRot`) |
| `stepsTrans` | Divisions pour les DOF translatifs (lu depuis `cfg.asmHelperStepsTrans`) |

**`active`** (getter) : `true` si au moins un handler existe (= la connexion
avait des `asmDof`).

**`attach()`** / **`detach()`** : délégués à tous les handlers enfants.
`detach()` vide également `_handlers`.

---

## 5. Intégration dans l'Assembler

### Déclenchement automatique via `onConnect`

Les handlers sont activés automatiquement à chaque nouvelle liaison, sans appel
explicite après un assemblage. Le câblage est fait une seule fois dans `_setupManagers` :

```js
this._asmVerse.joints.onConnect = (conn) => this._activateAsmHandlers(conn);
```

`onConnect` retourne `true` si les handlers sont actifs (liaison avec DOF) → le disque
marqueur n'est **pas** créé. Retourne `false` (liaison rigide) → disque créé normalement.

La restauration d'une scène (`observe` sans `notify`) ne déclenche jamais `onConnect`.

### Orientation de `conn` selon `lastInitiator`

`coincidentPairs()` retourne les briques dans l'ordre d'insertion, sans distinguer
mobile/fixe. `AsmDofHandler` suppose `instA` = mobile, `instB` = pivot fixe.

`_activateAsmHandlers` réoriente la connexion si nécessaire :

```js
const initiator = this._asmVerse.joints.lastInitiator;
const oriented = (initiator && conn.instB === initiator)
  ? { ...conn, instA: conn.instB, slotA: conn.slotB, instB: conn.instA, slotB: conn.slotA }
  : conn;
```

`lastInitiator` est disponible au moment de l'appel de `onConnect` car `_lastEntry`
est mis à jour par `observe()` juste avant de déclencher le callback.

### Tableau récapitulatif

| Point d'intégration | Méthode | Comportement |
|---------------------|---------|--------------|
| Câblage initial | `_setupManagers` | `joints.onConnect = (conn) => _activateAsmHandlers(conn)` |
| Création | `_activateAsmHandlers(conn)` | Réoriente selon `lastInitiator`, détache les précédents, crée `AsmHandlers`, appelle `attach()`, retourne `bool` |
| Retrait de brique | `_removeFromScene(inst)` | Vérifie `_handlers[0]?._conn` ; si la brique retirée est `instA` ou `instB`, détache et annule les handlers |
| Config | `_activateAsmHandlers` | Lit `cfg.asmHelperStepsRot` et `cfg.asmHelperStepsTrans` depuis la config persistée |

---

## 6. Constantes visuelles

| Constante   | Valeur | Rôle |
|-------------|--------|------|
| `DISC_R`    | 0.75   | Rayon du torus — identique au joint marker |
| `MARKER_R`  | 0.95   | Rayon du cercle des sphères de pas |
| `CURSOR_R`  | 0.95   | Rayon du cercle curseur |
| `renderOrder` helpers | 997 | Passe après les briques opaques |
| `renderOrder` curseur | 998 | Passe au-dessus des marqueurs |

---

## 7. Points de vigilance

- **`_rawTotal` ≠ position engagée** : `_rawTotal` est l'accumulateur brut du
  bandeau. Quand le step est actif, la position réellement appliquée est
  `round(rawTotal / stepSize) × stepSize`. `_updateCursor` et l'affichage
  `valEl` utilisent cette valeur snappée+clampée, pas `_rawTotal` directement.
  Afficher `_rawTotal` brut produirait une valeur erronée dès que le seuil du
  premier pas n'est pas encore atteint.

- **Repère dégénéré** : si `worldAxis ∥ X`, la projection de l'axe X du slot B
  dans le plan perpendiculaire à `worldAxis` donne un vecteur nul. `_buildRefFrame`
  bascule sur Y dans ce cas — ne pas supprimer ce guard.

- **Axe du `TorusGeometry`** : l'anneau gît dans le plan XY, axe = Z. Utiliser
  `setFromUnitVectors(new THREE.Vector3(0,0,1), worldAxis)` et non `(Y, worldAxis)`.

- **`_moveDelta` ≠ `_applyDelta`** : `_moveDelta` est la physique pure (pas de
  snap/clamp) ; `_applyDelta` orchestre l'ensemble. Le code de re-snap du bouton
  step réutilise `_moveDelta` directement pour éviter une double application
  de la logique de snap.

- **Nettoyage au retrait de brique** : `detach()` doit être appelé avant que les
  connexions ne soient supprimées de `_connections`. L'Assembler vérifie
  `_handlers[0]?._conn` pour détecter si la brique retirée est concernée.

- **`dispose()` géométrie/matériaux** : `detach()` traverse le groupe avec
  `traverse()` pour libérer chaque géométrie et chaque matériau. Ne jamais
  conserver de référence à un handler détaché.
