# Processus d'assemblage — rBang

Ce document décrit les trois processus fondamentaux de l'assembleur du point de vue
utilisateur, des classes et méthodes impliquées, et des enjeux de développement associés.

> **Architecture actuelle** : toute la logique de scène est portée par `AsmVerse`
> (fichier `AsmVerse.js`, classes `AsmBrick`, `AsmSlots`, `WorldSlots`, `AsmJoints`,
> `AsmEquivalenceClass`). L'`Assembler` conserve uniquement l'UI, les événements et
> la configuration.

---

## 1. Repositionnement d'une brique dans la scène

### Expérience utilisateur

L'utilisateur appuie sur une brique déjà présente dans la scène. La brique est
sélectionnée (highlight). Si un glissement de ≥ 12 px est détecté, la brique devient
semi-transparente pour signaler qu'elle est « tenue ». Quand elle est relâchée :

- **Sur une autre brique** : le moteur cherche une liaison compatible entre les slots
  les plus proches des points de saisie et de dépôt. Si une liaison est trouvée, la
  brique se snape à la position calculée et une connexion est enregistrée. Les helpers
  d'assemblage (`AsmDofHandler`) apparaissent automatiquement si la liaison définit
  des `asmDof`. Dans le cas contraire, un message de diagnostic est émis en console.
- **Sur le dock** : la brique est retirée de la scène et placée dans la pile du dock.
- **En zone neutre** : la brique reste à la position de relâchement, sans connexion.

### Classes et méthodes impliquées

| Étape | Méthode | Rôle |
|-------|---------|------|
| Saisie | `Assembler._onPointerDown` | Raycast sur les meshes ; stocke `_stackCandidate` ; désactive OrbitControls |
| Déplacement | `Assembler._onPointerMoveStack` | Seuil 12 px → feedback visuel (opacité 0,4 + `needsUpdate`) |
| Dépôt | `Assembler._onPointerUpStack` | Détecte la cible (dock / autre brique / zone neutre) |
| Connexion | `Assembler._connectDrag(instA, grabX, grabY, instB, dropX, dropY)` | Délègue à `AsmVerse.connectDrag()` |
| Snap + connexion | `AsmVerse.connectDrag(brickA, …, camera)` | Résout la liaison, snape, appelle `observe(slots, true, brickA)` |
| Nouvelle liaison | `AsmJoints.observe(slots, notify=true, initiator=brickA)` | Détecte les paires coïncidentes, crée la connexion, déclenche `onConnect` |
| AsmHandlers | `Assembler._activateAsmHandlers(conn)` | Réoriente `conn` selon `lastInitiator`, crée et attache les handlers |

**Structures de données modifiées :**
- `AsmVerse.bricks` (Map) : position/orientation de l'instance mise à jour
- `AsmJoints.connections` : nouvelle connexion `{ instA, instB, slotA, slotB, liaison }`
- `AsmJoints._lastEntry` : `{ conn, timestamp, initiator: brickA }`
- `AsmBrick.connections` : reconstruite pour les briques touchées
- `AsmSlots._occupied` : reconstruit via `syncOccupied()`
- `localStorage['rbang_asm_scene']`

### Enjeux et points de vigilance

- **Orientation de la connexion** : `coincidentPairs()` retourne les briques dans
  l'ordre d'insertion. `AsmDofHandler` assume `instA` = mobile, `instB` = pivot.
  `_activateAsmHandlers` lit `joints.lastInitiator` pour swapper si nécessaire.
- **Transparence pendant le drag** : `material.transparent = true/false` requiert
  `material.needsUpdate = true` à chaque bascule, y compris à la restauration.
- **Contrôles caméra** : OrbitControls désactivé au `pointerdown` sur une brique,
  réactivé au `pointerup` (y compris en cas de `pointercancel`).
- **Handlers de DOF orphelins** : `_removeFromScene` détecte si la brique retirée est
  impliquée dans la connexion active des `AsmHandlers` et appelle `detach()`.

---

## 2. Ajout d'une brique depuis le dock vers la scène

### Expérience utilisateur

L'utilisateur active une cellule du dock (tap), puis démarre son geste depuis
la brique affichée dans la cellule et relâche sur la scène. Selon la cible :

- **Sur une brique existante** : liaison résolue entre slots dock (triés par proximité
  au point de départ) et slots cible (triés par proximité au point d'arrivée).
  La nouvelle brique est spawnée directement à la position snappée. Les helpers
  d'assemblage apparaissent automatiquement si la liaison définit des `asmDof`.
- **Sur le plan monde** : la brique est spawnée sur le world slot le plus proche ou
  un nouveau slot en spirale phyllotaxique.

### Caméra dans les cellules dock

La cellule active propose un bouton `↻` (coin haut-droit). L'utilisateur démarre
son geste depuis ce bouton pour piloter la caméra de la cellule. Hors du bouton,
le geste reste dédié à l'assemblage.

Le `TrackballControls` de la cellule reste `enabled = false` par défaut. Le handle
dispatch un `PointerEvent` synthétique sur le canvas pour que `TrackballControls`
initialise son état interne (`_pointers` + `setPointerCapture`) et prenne le relais.

### Classes et méthodes impliquées

**Dans BrickDock (geste) :**

| Étape | Méthode | Rôle |
|-------|---------|------|
| Activation cellule | `BrickDock._bindCellGestures` → `_activateCell` | Agrandit la cellule, affiche le bouton `↻`, appelle `tb.handleResize()` |
| Handle caméra | `camHandle.pointerdown` listener | Active `tb`, dispatch synthétique → TB capture le pointeur |
| Geste assemblage | `BrickDock._bindCellGestures` (`pointermove`) | Mode `'assemble'` si geste depuis le mesh ; swipe vers bord → famille suivante |
| Slots de la brique dock | `BrickDock._nearSlotsForBrick(cell, x, y)` | Projette les slots (`expandSlots`) en NDC via la caméra de la cellule |
| Callback | `_onPickBrick(brickId, { nearSlots, endX, endY, … })` | Transmet la saisie à l'Assembler |

**Dans Assembler (spawn) :**

| Étape | Méthode | Rôle |
|-------|---------|------|
| Réception | `Assembler._handleScreenSlotDrop(gesture)` | Raycast ; aiguille vers `_assembleTo` ou spawn sur plan |
| Assemblage sur brique | `Assembler._assembleTo(brickId, nearSlotsA, targetInst, x, y)` | Résout, snape, appelle `asmVerse.spawnBrick()` puis `observe(slots, true, brick)` |
| Spawn sur plan | `AsmVerse.spawnBrick(brickTypeId, brickData, pos, snap?)` | Charge la shape CSG, centre géo, crée mesh + AsmBrick |
| World slot | `AsmVerse.bindWorldSlot(wslot, brick, nearSlotA?)` | Lie le world slot à la brique nouvellement spawnée |
| Nouvelle liaison | `AsmJoints.observe(slots, true, brick)` | Idem §1 |

**Structures de données modifiées :**
- `AsmVerse.bricks` (Map) : nouvelle `AsmBrick`
- `AsmSlots._entries` : slots de la nouvelle brique enregistrés
- `WorldSlots._slots` : nouveau world slot si placement sur plan
- `AsmVerse._wsConnections` : lien `{ wslot, brick, slotA }`
- `AsmJoints.connections`, `AsmJoints._lastEntry`
- `localStorage['rbang_asm_scene']`

### Enjeux et points de vigilance

- **Cohérence des projections** : les slots côté dock sont projetés par la caméra
  de la cellule (espace NDC miniature) ; les slots de la cible scène par la caméra
  principale. Ces deux espaces sont indépendants.
- **`handleResize()` obligatoire** : `TrackballControls.screen` est `{0,0,0,0}` à
  la construction. Sans `handleResize()` après insertion dans le DOM, `_getMouseOnCircle`
  divise par `screen.width = 0` → NaN → aucune rotation. Appeler après `appendChild`
  et après chaque changement de taille CSS.
- **Dispatch synthétique pour TB** : le handle `↻` est un élément sibling du canvas.
  Ses events ne remontent pas vers le canvas. On dispatche un `PointerEvent`
  synthétique avec le même `pointerId` pour que TB appelle `canvas.setPointerCapture()`
  et prenne le relais sur les events suivants.
- **Géométrie CSG asynchrone** : `spawnBrick` est `async`. Toute logique dépendant
  de la brique fraîchement spawnée doit être placée après l'`await`.

---

## 3. Mise sur la pile depuis la scène vers le dock

### Expérience utilisateur

L'utilisateur saisit une brique dans la scène et la fait glisser jusqu'au dock.
En relâchant, la brique disparaît de la scène et apparaît en premier dans la famille
« Stack » du dock, prête à être réutilisée.

### Classes et méthodes impliquées

| Étape | Méthode | Rôle |
|-------|---------|------|
| Détection du dépôt | `Assembler._onPointerUpStack` | `elementFromPoint` → `.closest('.brick-dock')` |
| Retrait de la scène | `Assembler._removeFromScene(inst)` | Nettoie handlers, sélection, délègue à `asmVerse.removeBrick(inst)` |
| Suppression AsmVerse | `AsmVerse.removeBrick(brick)` | Mesh dispose, world slot unbind/remove, `slots.unregisterBrick`, `observe(slots)` |
| Ajout à la pile | `BrickDock.pushToStack(brickId, brickData)` | `unshift` dans `_stackFamily.bricks` ; sauvegarde si persistance |
| Affichage stack | `BrickDock._showFamily(stackIdx)` | Dispose les anciennes cellules, crée une cellule par brique |
| Persistance | `BrickDock._saveStack()` | `localStorage['rbang_dock_stack']` |
| Sauvegarde scène | `Assembler._updateCount()` → `_saveScene()` | Déclenché par le retrait |

**Structures de données modifiées :**
- `AsmVerse.bricks` : entrée supprimée
- `AsmSlots._entries` : slots de la brique retirés
- `AsmJoints.connections` : connexions impliquant la brique supprimées (via `observe`)
- `WorldSlots._slots` : slots world liés `unbind` + `remove`
- `AsmVerse._wsConnections` : entrées supprimées
- `_stackFamily.bricks` (Array dans BrickDock) : brique ajoutée en tête
- `localStorage['rbang_dock_stack']` (si persistance)
- `localStorage['rbang_asm_scene']`

### Enjeux et points de vigilance

- **Handlers de DOF orphelins** : `_removeFromScene` vérifie `_handlers[0]?._conn`
  avant de supprimer les connexions. Si la brique est `instA` ou `instB` de la
  connexion active, `detach()` est appelé immédiatement.
- **Ordre LIFO** : `pushToStack` utilise `unshift`. La brique la plus récemment
  ajoutée apparaît toujours en premier.
- **Absence de doublons** : même `brickTypeId` déjà dans la pile → `showStack()`
  sans ajout.

---

## Références rapides

### Clés localStorage

| Clé | Contenu | Géré par |
|-----|---------|----------|
| `rbang_asm_scene` | Instances (pose + brickTypeId) + connexions | `Assembler._saveScene()` |
| `rbang_asm_cfg` | Configuration Assembler (dock, plan Y, thème…) | `Assembler._saveConfig()` |
| `rbang_dock_stack` | Pile de briques (id + données) | `BrickDock._saveStack()` |
| `rbang_bricks` | Catalogue des briques (shapeRef, color, slots…) | Forge |
| `rbang_shapes` | Définitions CSG des shapes | Forge |
| `rbang_liaisons` | Définitions des liaisons (pairs, asmDof…) | Forge |

### Seuils et constantes notables

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `CELL` | 110 px | Taille cellule dock inactive |
| `CELL_ACTIVE` | 190 px | Taille cellule dock active |
| `BAR_H` | 32 px | Hauteur barre Assembler (rogure viewport) |
| `AsmSlots.CLIP_DIST` | 0,12 | Distance de coïncidence slots (unités scène) |
| `CFG_DEFAULTS.snapR` | 1,2 | Rayon de snap world slot |
| `CFG_DEFAULTS.planY` | 0,25 | Hauteur du plan monde |
| seuil drag scène | 12 px | Déclenchement feedback visuel |
| seuil swipe dock | 15 px | Déclenchement changement de famille |
