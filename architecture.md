# rBang — Architecture

## Vue d'ensemble

rBang est un bac à sable 3D physique et un atelier de modélisation/assemblage fonctionnant entièrement dans le navigateur. Le serveur Express ne sert que des fichiers statiques et quelques routes d'écriture sur disque pour la banque de briques (Forge). Toute la logique tourne côté client en ES modules.

```
main.js
  └── Launcher          — écran d'init + menu de sélection de mode
        └── GameEngine  — renderer Three.js + monde Rapier3D + boucle
        └── modes/
              Sandbox   — bac à sable physique (démo)
              Forge     — éditeur de briques (géométrie + slots + mécanique)
              Assembler — assemblage de briques par snap de slots
              Modeler   — modeleur CSG (Manifold)
```

---

## Serveur (`server.js`)

Express minimal sur le port 8081. Aucune logique métier.

| Route | Rôle |
|---|---|
| `GET /` | Sert `public/` (fichiers statiques) |
| `GET /three/*` | Expose `node_modules/three` |
| `GET /rapier/*` | Expose `@dimforge/rapier3d-compat` |
| `GET /manifold/*` | Expose `manifold-3d` |
| `GET /eruda/*` | Expose eruda (console dev mobile) |
| `GET /bank-index` | Liste les fichiers `.json` dans `bank/` |
| `PUT /bank/:name` | Sauvegarde une brique dans `bank/<name>.json` |
| `PUT /dynamics` | Sauvegarde `public/data/assembly-dynamics.json` |
| `PUT /mechanics` | Sauvegarde `public/data/assembly-mechanics.toml` |

La banque de formes du Modeler utilise **localStorage** (client uniquement, pas de route serveur).

---

## Résolution des modules (importmap)

`index.html` déclare un importmap qui expose les packages npm comme spécificateurs nus :

```json
{
  "three":                     "/three/build/three.module.js",
  "three/addons/":             "/three/examples/jsm/",
  "@dimforge/rapier3d-compat": "/rapier/rapier.es.js",
  "manifold-3d":               "/manifold/manifold.js"
}
```

---

## GameEngine (`src/GameEngine.js`)

Abstraction centrale partagée par tous les modes. Instanciée une seule fois par `Launcher`, transmise à chaque mode.

**Responsabilités :**
- Initialise Three.js (scène, caméra PerspectiveCamera 75°, renderer WebGL, OrbitControls)
- Charge le WASM Rapier3D via `await RAPIER.init()`
- Maintient un tableau `_bodies : { mesh, body, isStatic }[]` et synchronise Rapier → Three.js à chaque frame
- Expose `resizeViewport(leftOffset, rightOffset)` pour que les modes ajustent le canvas aux panneaux latéraux
- `onUpdate(dt)` et `onPostUpdate(dt)` : callbacks frame appelés par les modes
- Helpers création d'objets : `addStaticBox`, `addDynamicBox`, `addDynamicSphere`, `remove`

**Boucle physique :** active en continu (`requestAnimationFrame`). Certains modes (Modeler) la stoppent et pilotent le rendu à la demande via `_scheduleRender()`.

---

## Launcher (`src/Launcher.js`)

Écran de démarrage et routeur de modes.

1. Affiche un écran d'init animé pendant `GameEngine.init()`
2. Présente un menu : Bac à sable / Assembleur / Forge / Modeler
3. Instancie le mode choisi, l'overlay disparaît, `mode.start()` est appelé

Interface attendue pour tout mode : `start()` et optionnellement `stop()`.

---

## Modes

### Sandbox (`modes/Sandbox.js`)

Mode de démonstration. Utilise la boucle physique continue de GameEngine. Sol statique + 10 cubes dynamiques colorés. Boutons : tirer une sphère, spawner un cube, compteur FPS.

### Forge (`modes/Forge.js`)

Éditeur de briques mécaniquesd. Charge les briques depuis `bank/*.json` (serveur). Affiche la géométrie avec `SCALE = 0.008`. Permet d'éditer les slots (points de connexion), les liaisons et les propriétés mécaniques (TOML). Sauvegarde via `PUT /bank/:name` et `PUT /mechanics`.

**Structure d'une brique JSON :**
```
{ vertices, triangles, surfaces, slots, ... }
```

**Contrôles caméra :** TrackballControls (remplace OrbitControls pendant le mode).

### Assembler (`modes/Assembler.js`)

Assemblage interactif de briques par snap de slots. Charge les briques depuis `public/data/assembly-dynamics.json`. Détecte la proximité des slots (`SNAP_DIST = 0.15`) et aligne les briques. Sauvegarde l'assemblage via `PUT /dynamics`.

**Contrôles caméra :** TrackballControls.

### Modeler (`modes/Modeler.js`)

Modeleur CSG non-destructif basé sur **Manifold** (WASM). Rendu à la demande (pas de boucle continue). Persistance dans `localStorage['rbang_shapes']`.

**Arbre CSG :** liste plate de `steps`, chaque step référence ses dépendances par ID. Le rendu reconstruit l'arbre depuis les feuilles.

**Primitives :** cube, sphère, cylindre, cône, roundedBox (hull de 8 sphères d'angle)

**Opérations :** union, subtract, intersect, repeat (translation vectorielle × n)

**Contrôles caméra :** TrackballControls.

**Panneaux :**
- Gauche : catalogue de formes (localStorage, swipe dual-direction)
- Centre : viewport Three.js (canvas)
- Droite : grille des steps + éditeur de paramètres (hauteur redimensionnable)

**Gizmo d'axes :** canvas 2D superposé, rendu indépendant (THREE.WebGLRenderer dédié).

---

## Données partagées

| Fichier | Format | Usage |
|---|---|---|
| `public/data/assembly-dynamics.json` | JSON | Assemblage courant (Assembler) |
| `public/data/assembly-mechanics.toml` | TOML | Types de slots et liaisons (Forge/Assembler) |
| `bank/*.json` | JSON | Banque de briques (Forge) |
| `localStorage['rbang_shapes']` | JSON | Banque de formes CSG (Modeler) |

---

## Fichiers hors usage

`public/src/lights.js`, `public/src/physics.js`, `public/src/scene.js` — reliquats d'une architecture plate antérieure. Non importés, toute leur logique est absorbée dans `GameEngine.js`.

---

## Ajouter un mode

1. Créer `public/src/modes/MyMode.js` avec `start()` et `stop()`
2. Dans `start()`, configurer la scène via `this.engine`, injecter les éléments UI dans `document.body`, les pousser dans `this._ui[]`
3. Dans `stop()`, appeler `this._ui.forEach(el => el.remove())` et nettoyer les ressources Three.js
4. Importer et câbler dans `Launcher.js` (ajouter un bouton dans `_buildUI`, instancier dans le handler)
