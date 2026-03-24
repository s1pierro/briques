# rBang — Règles UX et graphiques

## Principes fondamentaux

- **Zéro friction** — chaque action doit être évidente sans documentation ni apprentissage
- **Densité** — l'espace est précieux sur mobile, pas de marges généreuses ni de décorations inutiles
- **Permanence** — tout élément interactif est visible en permanence ; rien ne se révèle au survol
- **Tactile d'abord** — la surface est un écran Android. Toutes les interactions sont conçues pour le doigt, pas la souris

---

## Surface et interaction tactile

### Règle absolue : pas de hover

Ne jamais utiliser `:hover`, `opacity: 0` révélé au survol, ni aucun état conditionnel à `mouseenter`/`mouseleave` pour exposer des contrôles. Sur Android, le hover n'existe pas.

**Conséquences pratiques :**
- Boutons d'action toujours visibles (`opacity: 1`)
- Pas de révélation d'icônes via `tr:hover .btn`
- Les états actifs utilisent `:active` (pression) ou une classe JS appliquée explicitement

### Cibles tactiles

Taille minimale des zones de tap : **40 × 40 px** (préférer 44 px).
Les handles de redimensionnement ont une zone tactile élargie (10 px côté, zone de grip visible).

### Glissement (swipe)

Pattern établi avec `setPointerCapture` — tous les éléments draggables capturent le pointeur à `pointerdown` et écoutent sur l'élément lui-même (pas sur `window`).

```js
el.addEventListener('pointerdown', e => {
  el.setPointerCapture(e.pointerId);
  // ...
});
el.addEventListener('pointermove', e => { /* ... */ });
el.addEventListener('pointerup',     e => { /* ... */ });
el.addEventListener('pointercancel', e => { /* ... */ });
```

`touch-action: none` sur les éléments qui capturent le glissement horizontal.
`touch-action: pan-y` sur les éléments qui autorisent le scroll vertical mais capturent l'horizontal (catalogue).

---

## Thème visuel — Industrial

Inspiré du thème GTK2 **Industrial** (Ximian/Novell, GNOME 2). Esthétique d'outil professionnel : dense, métallique, fonctionnel.

### Palette

| Variable | Valeur | Usage |
|---|---|---|
| `--ml-bg` | `#353535` | Fond principal des panneaux |
| `--ml-bg2` | `#2e2e2e` | Fond secondaire (éditeur, catalogue) |
| `--ml-bg3` | `#3a3a3a` | Fond alternatif léger |
| `--ml-border` | `#1e1e1e` | Bordures sombres (bas/droite) |
| `--ml-bevel` | `#4a4a4a` | Reflet clair (haut/gauche des widgets) |
| `--ml-accent` | `#7aafc8` | Bleu acier — sélection, focus, accent |
| `--ml-sel` | `#3d5a6e` | Fond de sélection |
| `--ml-dim` | `#666` | Texte inactif, icônes secondaires |
| `--ml-text` | `#b0b0b0` | Texte courant |
| `--ml-text2` | `#d8d8d8` | Texte mis en valeur, labels actifs |

### Relief (bevel)

Chaque widget interactif simule le relief GTK2 par deux règles :

```css
box-shadow: inset 0 1px 0 var(--ml-bevel),  /* reflet haut */
            0 1px 2px #0004;                  /* ombre portée bas */
```

État pressé (`:active`) :
```css
background: #2a2a2a;
box-shadow: inset 0 1px 3px #0006;  /* enfoncement */
```

### Boutons

```css
background: linear-gradient(to bottom, #484848, #383838);
border: 1px solid var(--ml-border);
border-radius: 2px;   /* angles quasi carrés, pas de rondeur moderne */
box-shadow: inset 0 1px 0 var(--ml-bevel), 0 1px 2px #0004;
font: 700 9-10px sans-serif;
letter-spacing: .04em;
text-transform: uppercase (optionnel pour les labels courts);
```

### En-têtes de panneaux

```css
background: linear-gradient(to bottom, #404040, #323232);
border-bottom: 1px solid var(--ml-border);
box-shadow: 0 1px 0 var(--ml-bevel);
font: 700 9px sans-serif;
text-transform: uppercase;
letter-spacing: .1em;
color: var(--ml-text);
```

### Champs de saisie

```css
background: #272727;
border: 1px solid var(--ml-border);
box-shadow: inset 0 1px 3px #0006;  /* creux */
border-radius: 2px;
color: var(--ml-text2);
font: 11px sans-serif;
```
Focus : `border-color: var(--ml-accent)` — pas d'`outline`.

### Scrollbars

Visibles et dimensionnées (6 px), cohérentes avec le style bureau :

```css
::-webkit-scrollbar       { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--ml-bg2); }
::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
```

### Typographie

`sans-serif` pour tous les labels d'interface (cohérent GTK).
`monospace` uniquement pour les valeurs numériques, les noms techniques, le code.
Tailles : 9 px (labels), 10–11 px (contenu), 16 px (icônes boutons).

---

## Structure des panneaux latéraux

Pattern commun à Forge, Assembler et Modeler :

```
┌──────────┬──────────────────────┬──────────┐
│ Panneau  │    Viewport 3D       │ Panneau  │
│ gauche   │    (canvas)          │ droit    │
│ (liste/  │                      │ (détail/ │
│ catalogue│                      │ édition) │
└──────────┴──────────────────────┴──────────┘
```

- Panneaux : `position: fixed`, `z-index: 50`
- Canvas : positionné par `GameEngine.resizeViewport(leftW, rightW)`
- Largeurs pilotées par CSS custom properties (`--ml-lw`, `--ml-rw`)
- Handles de redimensionnement : `z-index: 61`, `cursor: col-resize`
- Barre de statut centrale (entre les deux panneaux) : `z-index: 40`

---

## Catalogue (panneau gauche)

Interaction swipe dual-direction sur chaque ligne :

| Geste | Action |
|---|---|
| Tap simple | Ajouter la forme dans l'arbre courant (sans réinitialisation) |
| Slide droite → | Révèle bouton **Charger** (remplace l'arbre courant) |
| Slide gauche ← | Révèle bouton **Supprimer** |

Implémentation : état `open` ∈ {-1, 0, 1}, `setPointerCapture`, `touch-action: pan-y`.
Seuil de snap : 32 px (SNAP / 2).

---

## Feedback et statut

- Barre de statut centrale : messages éphémères (2 s), titre du mode, bouton plein écran, paramètres contextuels
- Pas de modales, pas d'alertes JS (bloquent l'extension navigateur)
- Confirmation destructive : révélée par swipe, pas par popup

---

## Rendu à la demande (Modeler)

Le Modeler n'utilise pas la boucle `requestAnimationFrame` continue. Le rendu est déclenché explicitement via `_scheduleRender()` (debounce sur `requestAnimationFrame`). Cela évite de gaspiller des ressources GPU quand la scène est statique.

Déclencheurs : modification de paramètre, sélection, resize, interaction caméra (via listener `pointerdown`/`pointermove`/`wheel` + `TrackballControls.change`).

---

## Plein écran

```js
// Entrée — couvre les préfixes webkit/moz/ms
const el = document.documentElement;
(el.requestFullscreen || el.webkitRequestFullscreen || ...)?.call(el);

// Sortie
(document.exitFullscreen || document.webkitExitFullscreen || ...)?.call(document);

// Détection état
document.fullscreenElement || document.webkitFullscreenElement || ...

// Événement — écouter les trois variantes
document.addEventListener('fullscreenchange', handler);
document.addEventListener('webkitfullscreenchange', handler);
document.addEventListener('mozfullscreenchange', handler);
```
