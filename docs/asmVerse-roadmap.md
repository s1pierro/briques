# Feuille de route — arc asmVerse

## Objectif

Extraire et restructurer la logique de la scène d'assemblage en un module
dédié composé de cinq classes cohérentes. L'`Assembler` actuel concentre
tout en un seul fichier de ~1 600 lignes ; asmVerse le découpe en couches
claires avec des responsabilités bien délimitées.

---

## État d'implémentation ✓ Terminé

Branche : `assembler-v2` — toutes les classes sont implémentées et intégrées.

---

## Vue d'ensemble des classes

```
AsmVerse
  ├── AsmBrick          × N     — instance d'une brique dans la scène
  ├── AsmSlots                  — registre de tous les slots présents dans la scène
  ├── WorldSlots                — plan monde, spirale, snap, résolution de liaison
  ├── AsmJoints                 — connexions, marqueurs, observateur de scène
  └── AsmEquivalenceClass       — composante connexe rigide (BFS)
```

`AsmVerse` est le point d'entrée unique : l'`Assembler` le crée et lui délègue
tout ce qui concerne l'état de la scène. L'`Assembler` ne conserve que l'UI,
les événements et la configuration.

Fichier : `public/src/modes/AsmVerse.js`
Solveur : `public/src/modes/AssemblySolver.js` (module dédié, logique pure)

---

## 1. AsmBrick ✓

**Responsabilité :** Représenter une brique instanciée dans la scène —
identité, données, mesh THREE.js, slots expandés.

```
AsmBrick
  id            : string
  brickTypeId   : string         // clé dans rbang_bricks
  brickData     : Object         // { name, shapeRef, color, slots, … }
  mesh          : THREE.Mesh
  slots         : Object[]       // expandSlots + correction géo center
  geoCenter     : THREE.Vector3  // centre géométrique pré-translate
  origPos       : THREE.Vector3  // position au dernier snap / spawn
  origQuat      : THREE.Quaternion
  connections   : Object[]       // connexions impliquant cette brique (sync par AsmJoints.observe)
```

**Méthodes :**
- `worldSlotPos(slot)` — position monde d'un slot
- `worldSlotQuat(slot)` — quaternion monde d'un slot
- `dispose()` — libère géométrie et matériaux

---

## 2. AsmSlots ✓

**Responsabilité :** Registre plat `{ brick, slot }` de tous les slots de la
scène. Maintenu via `registerBrick` / `unregisterBrick`. Fournit des requêtes
géométriques sans itérer les briques.

```
AsmSlots
  _entries   : Array<{ brick: AsmBrick, slot: Object }>
  _occupied  : Set<slot>   // mis à jour par syncOccupied() après chaque observe()
```

**Méthodes :**
- `registerBrick(brick)` / `unregisterBrick(brick)` — points d'entrée du registre
- `slotsOf(brick)` → `Object[]`
- `nearSlotsOf(brick, cx, cy, camera, freeOnly?, exceptConnectedTo?)` → `Object[]`
  — trie les slots par proximité écran ; `freeOnly=true` exclut les occupés,
  `exceptConnectedTo` autorise les slots déjà liés à la brique source (repositionnement)
- `nearSlotsAt(cx, cy, camera, exclude?)` → `Array<{ brick, slot, dist }>`
  — tous les slots de la scène, hors briques exclues
- `get typeIds` → `Set<string>` — ensemble des typeIds présents dans la scène
- `syncOccupied(connections)` — reconstruit `_occupied` depuis la liste des connexions
- `isOccupied(slot)` → `bool`
- `freeSlots(brick)` → `Object[]`
- `clear()` — vide le registre (clear global)
- `coincidentPairs(clipDist?)` → paires coïncidentes entre briques différentes

**Constante :** `AsmSlots.CLIP_DIST = 0.12` (unités scène)

---

## 3. WorldSlots ✓

**Responsabilité :** Plan monde (mesh semi-transparent), world slots positionnés
sur spirale phyllotaxique, géométrie de snap (composition matricielle),
résolution de liaison via AssemblySolver.

```
WorldSlots
  _slots     : WorldSlot[]
  _y         : number         // hauteur du plan
  _plane     : THREE.Plane
  _planeMesh : THREE.Mesh
  snapR      : number         // rayon de snap
```

**Méthodes :**
- `addWorldSlot(worldPos)` → `WorldSlot`
- `bind(wslot, brickInstanceId)` / `unbind(wslot)` / `remove(wslot)`
- `nearest(worldPos, maxDist?)` → `WorldSlot | null`
- `raycastPlane(raycaster)` → `THREE.Vector3 | null`
- `computeSnap(slotA, slotB, targetBrick)` → `{ position, quaternion }`
  — formule : `tgtWorldMat = tbrickMat × tslotMat` ; `newMat = tgtWorldMat × sslotMatInv`
- `resolve(nearA, nearB)` → `{ slotA, slotB, liaison } | null`
- `get planY` / `set planY` — repositionne plan + world slots
- `get planMesh` / `get all`
- `dispose()`

---

## 4. AsmJoints ✓

**Responsabilité :** Source de vérité unique sur les connexions de la scène.
Remplace le trio `add / addImplicitsFor / removeFor` par un observateur de scène.
Gère les marqueurs visuels (disques 3D).

```
AsmJoints
  connections    : Object[]   // { instA, instB, slotA, slotB, liaison }
  _markers       : Array<{ mesh: THREE.Mesh, conn: Object }>
  markersVisible : boolean    // état global
  onConnect      : ((conn) => bool) | null   // callback activation handlers
```

**Méthodes :**
- `observe(asmSlots, notify?)` — **méthode principale**
  1. Calcule `coincidentPairs()` depuis AsmSlots
  2. Réconcilie avec les connexions existantes (garde, ajoute, supprime)
  3. Nettoie les marqueurs des connexions obsolètes
  4. Met à jour `brick.connections` pour toutes les briques touchées
  5. Appelle `syncOccupied()` sur AsmSlots
  6. Pour chaque nouvelle connexion : déclenche `onConnect` si `notify=true`, sinon crée un marqueur (masqué par défaut)
- `has(brickA, brickB)` → `bool`
- `dispose()` — retire tous les marqueurs, vide les connexions
- `get allMarkersVisible` / `setAllMarkersVisible(visible)` — toggle global
- `isMarkerVisible(conn)` → `bool` / `setMarkerVisible(conn, visible)`

**Comportement marqueurs :** les nouveaux marqueurs démarrent `visible=false`
(pas d'affichage automatique au dernier assemblage). L'utilisateur active via
le toggle du panneau liaisons.

---

## 5. AsmEquivalenceClass ✓

**Responsabilité :** Représenter UNE composante connexe rigide.
Créée par `AsmVerse.computeComponents()` — pas instanciée directement.

```
AsmEquivalenceClass
  bricks  : Set<AsmBrick>   // briques de la composante
  joints  : Object[]        // connexions rigides internes (dédupliquées)
  links   : Array<{ connection, other: AsmEquivalenceClass }>  // liaisons DOF
```

**Méthodes :**
- `contains(brick)` → `bool`
- `get size` → `number`

**Connexion rigide :** `!(liaison.dof?.length)` — pas de DOF.
**Lien cinématique :** connexion avec `liaison.dof.length > 0` → relie deux composantes.

---

## 6. AsmVerse ✓

**Responsabilité :** Façade unique exposée à l'Assembler. Orchestre les cinq
sous-classes. Porte la persistance et la topologie.

```
AsmVerse
  scene        : THREE.Scene
  bricks       : Map<id, AsmBrick>
  slots        : AsmSlots
  worldSlots   : WorldSlots
  joints       : AsmJoints
  _solver      : AssemblySolver   // chargé une fois depuis localStorage au constructeur
  _wsConnections : Array<{ wslot, brick, slotA }>
```

**Méthodes :**
- `async spawnBrick(brickTypeId, brickData, pos?, snapTransform?, shapeData?)` → `AsmBrick|null`
- `removeBrick(brick)` — mesh, dispose, world slot, slots, observe, delete
- `connectDrag(brickA, grabX, grabY, brickB, dropX, dropY, camera)` → `conn|null`
- `bindWorldSlot(wslot, brick, nearSlotA?)` — mémorise pour removeBrick
- `computeComponents()` → `AsmEquivalenceClass[]` — BFS rigide + liens DOF
- `componentCount()` → `number`
- `serialize()` → `{ version, instances, connections }` — format compatible save
- `async restore(data, bricksStore, shapesStore, liaisonsStore?)` → `Map<oldId, AsmBrick>`
- `clear()` — vide scène sans détruire les world slots
- `dispose()` — détruit tout y compris les world slots

---

## 7. AssemblySolver (module séparé) ✓

Fichier : `public/src/modes/AssemblySolver.js`

**Responsabilité :** Logique métier pure — aucune dépendance Three.js ni
localStorage. Reçoit les liaisons (`rbang_liaisons`) une fois à la construction.

**Méthodes :**
- `solve(nearA, nearB)` → `{ slotA, slotB, liaison } | null` — produit cartésien
- `compatible(typeA, typeB)` → `liaison | null`
- `ballJoint()` → liaison rotule synthétique
- `diagnose(nearA, nearB, sceneTypeIds?)` — log console détaillé si solve() → null

---

## Ordre d'implémentation réalisé

| Étape | Classe | Statut |
|-------|--------|--------|
| 1 | `AsmBrick` | ✓ |
| 2 | `AsmSlots` + `WorldSlots` | ✓ |
| 3 | `AsmJoints` (observateur) | ✓ |
| 4 | `AsmEquivalenceClass` | ✓ |
| 5 | `AsmVerse` | ✓ |
| 6 | Refactor `Assembler` | ✓ Délègue à AsmVerse, conserve UI/events/config |
| 7 | `AssemblySolver` (module dédié) | ✓ |

---

## Fichiers concernés

| Fichier | État |
|---------|------|
| `public/src/modes/Assembler.js` | Allégé : UI, events, config — délègue à AsmVerse |
| `public/src/modes/AsmVerse.js` | ✓ Contient les 6 classes |
| `public/src/modes/AssemblySolver.js` | ✓ Module dédié, logique pure |
| `public/src/modes/AsmDofHandler.js` | Inchangé |
| `public/src/modes/BrickDock.js` | Inchangé |
| `public/src/slot-utils.js` | Inchangé |

---

## Points de vigilance résolus

- **Observer pattern** : `observe()` remplace add/addImplicitsFor/removeFor.
  Source de vérité unique — pas de concept explicit/implicit.
- **Slot occupancy** : `AsmSlots._occupied` reconstruit atomiquement après chaque
  `observe()` via `syncOccupied()`.
- **Free slot filtering** : `nearSlotsOf(..., freeOnly, exceptConnectedTo)` —
  la brique draggée ignore `freeOnly` (tous ses slots sont libres temporairement) ;
  `exceptConnectedTo` permet le repositionnement (slot occupé lié à la source reste disponible).
- **Marqueurs masqués par défaut** : `_createMarker` pose `visible=false` —
  l'utilisateur active via le toggle global ou par connexion dans le panneau liaisons.
- **Liaisons chargées une fois** : `AssemblySolver` reçoit `rbang_liaisons` au
  constructeur d'AsmVerse — pas de lecture localStorage à chaque appel.
- **Nettoyage dock** : `_removeFromScene` → `asmVerse.removeBrick()` couvre
  mesh, dispose, world slots, slots, connexions (via observe), bricks Map.
- **Compat localStorage** : `serialize()` / `restore()` produisent le même
  format que `_saveScene()` / `_restoreScene()` de l'Assembler v1.
