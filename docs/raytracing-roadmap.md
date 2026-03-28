# Feuille de route — Mode Raytracing

## Objectif

Ajouter un mode de rendu photoréaliste dans le navigateur, basé sur **three-gpu-pathtracer**, capable de charger les exports GLB de l'Assembler et de produire des images haute qualité (ombres douces, réflexions, caustiques, GI).

---

## Phase 1 — Viewer pathtracer minimal

- [ ] Installer `three-gpu-pathtracer` (npm ou CDN)
- [ ] Créer `public/src/modes/Raytracer.js` avec `start(engine)` / `stop()`
- [ ] Import GLB via `GLTFLoader` (fichier local ou depuis le catalogue Assembler)
- [ ] Intégrer `PathTracingRenderer` : accumulation progressive, convergence visible
- [ ] Contrôles caméra (OrbitControls, identiques à l'Assembler)
- [ ] Bouton "Rendre" / "Stop" — démarrage et arrêt de l'accumulation
- [ ] Affichage du nombre de samples et temps écoulé
- [ ] Wirer dans `Launcher.js` (nouveau bouton mode)

## Phase 2 — Éclairage et environnement

- [ ] Chargement HDRI (`.hdr` / `.exr`) comme environnement — IBL + fond
- [ ] Bibliothèque de HDRIs embarqués (2-3 presets : studio, extérieur, neutre)
- [ ] Lumières ponctuelles éditables (position, couleur, intensité)
- [ ] Sol plan optionnel avec ombre de contact (shadow catcher)
- [ ] Réglage exposition / tone mapping (ACES, Reinhard)

## Phase 3 — Matériaux PBR avancés

- [ ] Éditeur de matériaux par brique dans la scène raytracer :
  - Roughness / Metalness (sliders)
  - Clearcoat (vernis)
  - Transmission + IOR (verre, plastique translucide)
  - Emissive (briques lumineuses)
  - Subsurface scattering (optionnel)
- [ ] Presets matériaux : plastique mat, plastique brillant, métal brossé, chrome, verre
- [ ] Sauvegarde des assignations matériau dans le catalogue

## Phase 4 — Export image

- [ ] Bouton "Capturer" — export PNG/JPG de l'image convergée
- [ ] Réglage résolution (1x, 2x, 4x du viewport)
- [ ] Réglage nombre de samples cible (qualité vs temps)
- [ ] Filigrane optionnel (logo rBang / auteur)

## Phase 5 — Scène et composition

- [ ] Import de plusieurs GLB dans la même scène raytracer
- [ ] Positionnement / rotation des objets importés (gizmo simple)
- [ ] Objets de scène prédéfinis : plan infini, sphère ciel, cube room
- [ ] Profondeur de champ (DOF caméra) : focale, ouverture
- [ ] Sauvegarde / restauration de la scène raytracer (localStorage)

## Phase 6 — Intégration Assembler

- [ ] Bouton "Ouvrir en Raytracer" directement depuis l'Assembler (transfert scène sans fichier)
- [ ] Synchronisation live optionnelle : modifications Assembler → mise à jour scène raytracer
- [ ] Rendu thumbnail pour le catalogue (render basse résolution automatique)

---

## Dépendances

| Package | Usage |
|---|---|
| `three-gpu-pathtracer` | Rendu pathtracing GPU (WebGL2) |
| `three` (existant) | Scène, matériaux, loaders |
| `GLTFLoader` (existant dans addons) | Chargement des exports GLB |
| `RGBELoader` (addons Three.js) | Chargement HDRI `.hdr` |
| `EXRLoader` (addons Three.js) | Chargement HDRI `.exr` (optionnel) |

## Contraintes

- Android / Chrome — performances GPU limitées, privilégier la résolution basse + accumulation longue
- Pas de WebGPU requis — `three-gpu-pathtracer` fonctionne en WebGL2
- Touch-first — tous les contrôles doivent être tactiles
