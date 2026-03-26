# Processus d'assemblage — rBang

Ce document décrit les trois processus fondamentaux de l'assembleur du point de vue
utilisateur, des classes et méthodes impliquées, et des enjeux de développement associés.

---

## 1. Repositionnement d'une brique dans la scène

### Expérience utilisateur

L'utilisateur appuie longuement (ou fait glisser) une brique déjà présente dans la scène.
Pendant le glissement, la brique devient semi-transparente pour signaler qu'elle est
« tenue ». Quand elle est relâchée :

- **Sur une autre brique** : le moteur cherche une liaison compatible entre les slots les
  plus proches des points de saisie et de dépôt. Si une liaison est trouvée, la brique
  se snape automatiquement en position et une connexion est enregistrée. Dans le cas
  contraire, la brique reste à la position de relâchement.
- **Sur le dock** : la brique est retirée de la scène et placée dans la pile du dock
  (voir §3).
- **En zone neutre** : la brique reste à la position de relâchement, sans connexion.

Lorsqu'une connexion explicite est établie, les helpers d'assemblage (`AsmDofHandler`)
apparaissent si la liaison définit des `asmDof`, permettant d'ajuster finement les
degrés de liberté restants.

### Classes et méthodes impliquées

| Étape | Méthode | Rôle |
|-------|---------|------|
| Saisie | `Assembler._onPointerDown` | Raycast sur les meshes de briques ; stocke `_stackCandidate` ; désactive les contrôles caméra |
| Déplacement | `Assembler._onPointerMoveStack` | Seuil 12 px pour déclencher le feedback visuel (opacité 0,4) |
| Dépôt | `Assembler._onPointerUpStack` | Détecte la cible (dock / autre brique / zone neutre) |
| Connexion | `Assembler._connectDrag(instA, grabX, grabY, instB, dropX, dropY)` | Collecte les slots candidats, résout la liaison, snape et enregistre |
| Slots candidats | `Assembler._nearSlotsOfInstance(inst, x, y)` | Projette les slots en NDC, trie par proximité au point de contact |
| Snap | `Assembler._computeSnapTransform(slotA, slotB, targetInst)` | Composition matricielle : `M_new = M_slotB_world × M_slotA_local⁻¹` |
| Liaison implicite | `Assembler._registerImplicitConnectionsFor(inst)` | Parcourt toutes les instances et crée des connexions implicites pour celles qui sont à portée (`CLIP_DIST`) |
| Marqueur / helpers | `Assembler._addJointMarker(conn)` → `_activateAsmHandlers(conn)` | Crée le disque visuel ou les helpers `AsmDofHandler` selon que `liaison.asmDof` est renseigné |
| Persistance | `Assembler._saveScene()` | Sérialise instances + connexions dans `localStorage['rbang_asm_scene']` |

**Structures de données modifiées :**
- `_instances` (Map) : pose de l'instance mise à jour
- `_connections` (Array) : nouvelle entrée `{ instA, instB, slotA, slotB, liaison, implicit: false }`
- `_jointMarkers` (Array) : nouveau mesh disque ou annulation des marqueurs précédents
- `localStorage['rbang_asm_scene']`

### Enjeux et points de vigilance

- **Centrage de la géométrie** : lors du spawn, la géométrie est translatée pour que son
  centre de boîte englobante coïncide avec l'origine du mesh. Les positions de slots
  sont stockées dans ce repère centré. Toute modification de la géométrie doit invalider
  le cache (`geo.boundingBox = null`) et recalculer le centrage, sans quoi le snap
  serait décalé.
- **Connexions implicites** : après chaque connexion explicite,
  `_registerImplicitConnectionsFor` est appelée. Elle crée silencieusement des
  connexions entre briques proches (seuil `CLIP_DIST`). Ces connexions ne génèrent pas
  de marqueur visuel mais participent à la simulation physique. Toute modification du
  déplacement d'une brique doit être suivie d'un re-scan implicite.
- **Transparence pendant le drag** : le feedback visuel (opacité 0,4) nécessite
  `material.needsUpdate = true` à chaque bascule de `transparent`. Sans ce flag,
  THREE.js ne recompile pas le shader et l'opacité reste inchangée visuellement.
  La restauration (opacité 1) au `pointerup` et au `pointercancel` requiert également ce flag.
- **Contrôles caméra** : les `TrackballControls` sont désactivés au `pointerdown` sur
  une brique et réactivés au `pointerup`. Un oubli de réactivation bloquerait la caméra.
- **Handlers de DOF** : `_activateAsmHandlers` détache les handlers précédents avant
  d'en créer de nouveaux. Ne jamais conserver de référence directe à un handler détaché.

---

## 2. Ajout d'une brique depuis le dock vers la scène

### Expérience utilisateur

L'utilisateur tape sur une cellule du dock pour l'activer, puis la « lance » vers la
scène en faisant glisser son doigt depuis la cellule. Selon la cible du relâchement :

- **Sur une brique existante** : le moteur cherche une liaison compatible entre les slots
  de la brique du dock (triés par proximité au point de départ du geste) et ceux de la
  brique cible (triés par proximité au point d'arrivée). La nouvelle brique est spawnée
  directement à la position snappée.
- **Sur le plan monde** : la brique est spawnée sur le world slot le plus proche du
  point de relâchement (ou sur un nouveau slot en spirale phyllotaxique si tous sont
  occupés), posée sur le plan Y configuré.

### Classes et méthodes impliquées

**Dans BrickDock (geste) :**

| Étape | Méthode | Rôle |
|-------|---------|------|
| Activation cellule | `BrickDock._bindCellGestures` → `_activateCell` | Agrandit la cellule, démarre la boucle de rendu partagée |
| Détection du geste | `BrickDock._bindCellGestures` (`pointermove`) | Mode `'assemble'` si le glissement part du mesh affiché ; mode `'trackball'` sinon |
| Slots de la brique dock | `BrickDock._nearSlotsForBrick(cell, x, y)` | Projette les slots virtuels (`expandSlots`) en NDC via la caméra de la cellule |
| Callback | `_onPickBrick(brickId, { nearSlots, endX, endY, … })` | Transmet la saisie à l'Assembler |

**Dans Assembler (spawn) :**

| Étape | Méthode | Rôle |
|-------|---------|------|
| Réception du callback | `Assembler._onDockPickBrick(brickId, gesture)` | Raycast depuis le point de relâchement ; aiguille vers `_assembleTo` ou `_spawnBrick` |
| Assemblage sur brique | `Assembler._assembleTo(brickId, nearSlotsA, targetInst, x, y)` | Résout la liaison, calcule le snap, appelle `_spawnBrick` avec `snapTransform` |
| Spawn sur plan | `Assembler._spawnBrick(brickId, wsPosition)` | Charge la shape CSG, centre la géométrie, crée le mesh et l'instance |
| Centrage géométrie | *(dans `_spawnBrick`)* | `geo.translate(-cx, -cy, -cz)` + `geo.boundingBox = null` |
| Placement Y | *(dans `_spawnBrick`)* | `y = wsm._y − (box.min.y − center.y)` pour poser la brique sur le plan |
| World slot | `WorldSlotManager.add(pt)` → `Assembler._wsm.bind(wslot, inst.id)` | Crée ou réutilise un slot en spirale phyllotaxique ; lie au mesh |
| Connexion & marqueur | *(idem §1)* | Connexion, marqueur, implicites, sauvegarde |

**Expansion des slots virtuels :**
`expandSlots(brick.slots)` (slot-utils.js) est appelée à la fois dans `_nearSlotsForBrick`
(BrickDock) et dans `_spawnBrick` (Assembler) pour transformer les définitions
paramétriques (`repeat.count × step`) en liste plate de slots virtuels, chacun portant
`_defId` pour référencer sa définition source.

**Structures de données modifiées :**
- `_instances` (Map) : nouvelle `BrickInstance` avec slots recentrés
- `_wsm._slots` : nouveau world slot si placement sur plan
- `_wsConnections` (Array) : lien `{ wslot, instId }`
- `_connections`, `_jointMarkers`, `localStorage['rbang_asm_scene']`

### Enjeux et points de vigilance

- **Cohérence des projections** : les slots « candidats » côté dock sont projetés par la
  caméra de la cellule (espace NDC de la miniature), tandis que les slots de la cible
  en scène sont projetés par la caméra principale. Ces deux espaces sont indépendants :
  ne pas les mélanger dans les comparaisons de proximité.
- **Slots paramétriques** : `expandSlots` doit être appelée partout où des slots sont
  utilisés (dock, scene, forge helpers). Une définition ajoutée sans `expandSlots` dans
  l'un des points ne produira pas de slots virtuels, rendant la connexion impossible.
- **Géométrie CSG asynchrone** : `_spawnBrick` est `async` (attend `getManifold()`).
  Toute logique qui dépend de l'instance fraîchement spawnée doit être placée après
  l'`await`, ou gérer le cas où l'instance n'existe pas encore.
- **Spirale phyllotaxique et index libre** : `WorldSlotManager._nextFreeIndex()` préfère
  l'index ≤ 64 le plus bas non occupé ; au-delà de 64, utilise `_slots.length`. Si des
  slots sont supprimés et recréés fréquemment, des « trous » peuvent apparaître dans la
  grille visuelle.

---

## 3. Mise sur la pile depuis la scène vers le dock

### Expérience utilisateur

L'utilisateur saisit une brique dans la scène et la fait glisser jusqu'au dock (le fond
coloré du dock doit être touché). En relâchant, la brique disparaît de la scène et
apparaît en premier dans la famille « Stack » du dock, prête à être réutilisée.

Si la persistance de la pile est activée (paramètre de configuration), la brique reste
dans le stack même après rechargement de la page.

### Classes et méthodes impliquées

| Étape | Méthode | Rôle |
|-------|---------|------|
| Détection du dépôt sur dock | `Assembler._onPointerUpStack` | `document.elementFromPoint` → `.closest('.brick-dock')` |
| Retrait de la scène | `Assembler._removeFromScene(inst)` | Supprime mesh, connexions explicites/implicites, world slots liés, markers, `_instances` |
| Ajout à la pile | `BrickDock.pushToStack(brickId, brickData)` | Vérifie l'absence de doublon ; `unshift` dans `_stackFamily.bricks` ; sauvegarde si persistance |
| Affichage stack | `BrickDock._showFamily(stackIdx)` | Dispose les anciennes cellules, crée une cellule par brique de la pile |
| Persistance | `BrickDock._saveStack()` | `localStorage['rbang_dock_stack'] = JSON.stringify(_stackFamily.bricks)` |
| Sauvegarde scène | `Assembler._updateCount()` → `_saveScene()` | Déclenché par le retrait, met à jour `rbang_asm_scene` |

**Structures de données modifiées :**
- `_instances` (Map) : entrée supprimée
- `_connections` (Array) : toutes les connexions impliquant l'instance filtrées
- `_jointMarkers` (Array) : markers associés disposés et retirés
- `_wsm._slots` : slots world liés à l'instance `unbind` + `remove`
- `_wsConnections` (Array) : entrées de liaison wslot↔inst supprimées
- `_stackFamily.bricks` (Array dans BrickDock) : brique ajoutée en tête
- `localStorage['rbang_dock_stack']` (si persistance activée)
- `localStorage['rbang_asm_scene']`

### Enjeux et points de vigilance

- **Ordre LIFO** : `pushToStack` utilise `unshift` (pas `push`). La brique la plus
  récemment ajoutée apparaît toujours en premier dans le dock. Ce comportement est
  intentionnel pour faciliter les cycles retrait/réutilisation.
- **Absence de doublons** : si la même `brickTypeId` est déjà dans la pile, elle n'est
  pas ajoutée une seconde fois. La pile représente une palette de types, pas un
  inventaire de quantités.
- **Nettoyage complet des connexions** : `_removeFromScene` filtre toutes les connexions
  (explicites et implicites) où `instA === inst || instB === inst`. Si d'autres instances
  avaient des connexions implicites uniquement avec la brique retirée, celles-ci sont
  silencieusement supprimées sans notification ni recalcul des liaisons restantes.
- **Handlers de DOF orphelins** : `_removeFromScene` détecte si la brique retirée est
  impliquée dans la connexion active des `AsmHandlers` (via `_asmHandlers._handlers[0]?._conn`)
  et appelle `detach()` + `null` si c'est le cas. Ce nettoyage est effectué avant la
  suppression des connexions pour éviter tout accès à des objets libérés.
- **Persistance indépendante** : `rbang_dock_stack` et `rbang_asm_scene` sont deux clés
  localStorage distinctes. Une réinitialisation de scène n'efface pas la pile, et
  inversement. Cela permet de conserver sa palette entre plusieurs sessions de travail.

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

### Seuils et constantes notables

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `CELL` | 110 px | Taille cellule dock inactive |
| `CELL_ACTIVE` | 190 px | Taille cellule dock active |
| `BAR_H` | 32 px | Hauteur barre Assembler (rogure viewport) |
| `CFG_DEFAULTS.snapR` | 1,2 | Rayon de snap world slot |
| `CFG_DEFAULTS.planY` | 0,25 | Hauteur du plan monde |
| seuil drag scène | 12 px | Déclenchement feedback visuel au glissement |
| seuil swipe dock | 15 px | Déclenchement du changement de famille |
