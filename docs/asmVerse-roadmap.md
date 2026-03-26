# Feuille de route — arc asmVerse

## Objectif

Extraire et restructurer la logique de la scène d'assemblage en un module
dédié composé de cinq classes cohérentes. L'`Assembler` actuel concentre
tout en un seul fichier de ~1 600 lignes ; asmVerse le découpe en couches
claires avec des responsabilités bien délimitées.

---

## Vue d'ensemble des classes

```
AsmVerse
  ├── AsmBrick          × N     — instance d'une brique dans la scène
  ├── AsmSlots                  — gestion des slots, snapping, world slots
  ├── AsmJoints                 — connexions, marqueurs, implicites
  └── AsmEquivalenceClass       — composantes connexes, BFS
```

`AsmVerse` est le point d'entrée unique : l'`Assembler` le crée et lui délègue
tout ce qui concerne l'état de la scène. L'`Assembler` ne conserve que l'UI,
les événements et la configuration.

---

## 1. AsmBrick

**Extrait de :** classe `BrickInstance` (l. 298) + champs `_instances` (Map)

**Responsabilité :** Représenter une brique instanciée dans la scène —
identité, données, mesh THREE.js, slots expandés.

```
AsmBrick
  id          : string
  brickData   : Object          // { name, shapeRef, color, slots, … }
  mesh        : THREE.Mesh
  slots       : VirtualSlot[]   // résultat de expandSlots(brickData.slots)
```

**Méthodes :**
- `worldSlotPos(slot)` — position monde d'un slot (actuellement `_slotWorldPos`)
- `worldSlotQuat(slot)` — orientation monde d'un slot
- `dispose()` — libère le mesh et ses matériaux

**Ce qui disparaît de l'Assembler :** `BrickInstance`, `_instances`, tous les
accès `inst.mesh`, `inst.brickData`.

---

## 2. AsmSlots

**Extrait de :** `WorldSlotManager` (l. 70), `_nearSlotsOfInstance` (l. 644),
`_computeSnapTransform` (l. 667), `AssemblySolver` (l. 224)

**Responsabilité :** Tout ce qui concerne la géométrie des slots — candidats,
snap, world slots, résolution de liaison.

```
AsmSlots
  worldSlots  : WorldSlot[]
  solver      : AssemblySolver  // interne
```

**Méthodes :**
- `nearSlotsOf(brick, cx, cy, camera)` — projette et trie les slots d'une brique
- `computeSnap(slotA, slotB, targetBrick)` → `Matrix4` — composition matricielle
- `resolve(nearA, nearB)` → `{ slotA, slotB, liaison } | null` — résout la liaison
- `addWorldSlot(pos)` → `WorldSlot`
- `bindWorldSlot(wslot, brickId)`
- `unbindWorldSlot(brickId)`
- `removeWorldSlot(wslot)`
- `snapR`, `planY` — paramètres configurables

**Ce qui disparaît de l'Assembler :** `WorldSlotManager`, `AssemblySolver`,
`_nearSlotsOfInstance`, `_computeSnapTransform`, `_wsm`, `_wsConnections`.

---

## 3. AsmJoints

**Extrait de :** `_connections` (Array), `_jointMarkers`,
`_registerImplicitConnectionsFor` (l. 1 443), `_addJointMarker` (l. 831),
`_isClipped` (l. 1 424)

**Responsabilité :** Cycle de vie des connexions et de leurs visuels.

```
AsmJoints
  connections : Connection[]    // { brickA, brickB, slotA, slotB, liaison, implicit }
  markers     : THREE.Object3D[]
```

**Méthodes :**
- `add(conn)` — enregistre une connexion explicite + crée le marqueur ou active les AsmHandlers
- `addImplicitsFor(brick, allBricks)` — scan spatial, seuil CLIP_DIST
- `removeFor(brick)` — filtre toutes les connexions (explicites + implicites) + nettoie marqueurs
- `has(brickA, brickB)` → bool
- `explicitConnections()` — filtre `implicit: false`
- `dispose()` — retire tous les marqueurs de la scène

**Ce qui disparaît de l'Assembler :** `_connections`, `_jointMarkers`,
`_registerImplicitConnectionsFor`, `_registerImplicitConnections`,
`_addJointMarker`, `_isClipped`.

---

## 4. AsmEquivalenceClass

**Extrait de :** `_connectedComponent` (l. 1 490), `_componentCount` (l. 1 513)

**Responsabilité :** Calcul de la topologie du graphe d'assemblage — composantes
connexes, appartenance, taille.

```
AsmEquivalenceClass
  // sans état propre : opère sur AsmJoints à la demande
```

**Méthodes :**
- `componentOf(brick, joints)` → `Set<AsmBrick>` — BFS depuis une brique
- `count(bricks, joints)` → number — nombre de composantes
- `sameComponent(brickA, brickB, joints)` → bool

**Note :** Classe utilitaire stateless ; peut n'exposer que des méthodes
statiques si aucun état n'est nécessaire.

**Ce qui disparaît de l'Assembler :** `_connectedComponent`, `_componentCount`.

---

## 5. AsmVerse

**Responsabilité :** Orchestrateur — façade unique exposée à l'`Assembler`.
Possède `bricks` (Map), `slots` (AsmSlots), `joints` (AsmJoints).

```
AsmVerse
  bricks     : Map<id, AsmBrick>
  slots      : AsmSlots
  joints     : AsmJoints
  scene      : THREE.Scene       // référence partagée
```

**Méthodes :**
- `async spawnBrick(brickId, brickData, snapTransform?)` → `AsmBrick`
- `removeBrick(brick)` — slots, joints, mesh, world slots
- `connect(brickA, slotA, brickB, slotB, liaison)` → `Connection`
- `connectDrag(brickA, grabPt, brickB, dropPt, camera)` → `Connection | null`
- `componentCount()` → number
- `serialize()` → Object — instances + connexions explicites
- `restore(data, bricksStore, shapesStore)` — rehydrate depuis localStorage

**Ce qui disparaît de l'Assembler :** `_instances`, `_spawnBrick`, `_assembleTo`,
`_connectDrag`, `_removeFromScene`, `_restoreScene`, `_serializeSceneJSON`,
`_clearScene`, logique BFS.

---

## Ordre d'implémentation recommandé

| Étape | Classe | Justification |
|-------|--------|---------------|
| 1 | `AsmBrick` | Aucune dépendance, socle de tout le reste |
| 2 | `AsmSlots` | Dépend de `AsmBrick` (worldSlotPos) |
| 3 | `AsmJoints` | Dépend de `AsmBrick` + `AsmSlots` |
| 4 | `AsmEquivalenceClass` | Dépend de `AsmJoints` |
| 5 | `AsmVerse` | Assemble tout, remplace les méthodes Assembler |
| 6 | Refactor `Assembler` | Délègue à `AsmVerse`, conserve UI/events/config |

Chaque étape peut être testée indépendamment avant de passer à la suivante.
Les tests visuels naturels sont : spawn d'une brique → connexion → retrait →
persistance localStorage.

---

## Fichiers concernés

| Fichier | Sort |
|---------|------|
| `public/src/modes/Assembler.js` | Allégé : UI, events, config — plus de logique scène |
| `public/src/modes/AsmVerse.js` | **Nouveau** — contient les 5 classes |
| `public/src/modes/AsmDofHandler.js` | Inchangé |
| `public/src/modes/BrickDock.js` | Inchangé |
| `public/src/slot-utils.js` | Inchangé |

---

## Points de vigilance pour cet arc

- **Compat localStorage** : `serialize()` / `restore()` doivent produire le même
  format que `_saveScene()` / `_restoreScene()` actuels, ou migrer explicitement.
- **AsmHandlers** : `_activateAsmHandlers` reste dans l'Assembler (c'est de l'UI),
  mais reçoit sa connexion depuis `AsmVerse`.
- **WorldSlotManager** : le mesh visuel du plan monde (THREE.Mesh) est
  actuellement créé à l'intérieur — à décider si `AsmSlots` le conserve ou si
  c'est l'Assembler qui le gère.
- **Événements pointer** : tous les `pointerdown/move/up` restent dans
  l'Assembler ; `AsmVerse` ne connaît pas le DOM.
