# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Production: node server.js
npm run dev      # Development: node --watch server.js (auto-restarts on file change)
```

Server runs at `http://localhost:8081` by default. No build step — all client code is served as-is from `public/`.

No linter or test suite is configured.

## Architecture

**rBang** is a browser-based 3D physics sandbox. The Express server (`server.js`) only serves static files — the entire game runs client-side.

### Module resolution

`index.html` uses an importmap to expose npm packages as bare specifiers:
- `three` → `/three/build/three.module.js`
- `three/addons/` → `/three/examples/jsm/`
- `@dimforge/rapier3d-compat` → `/rapier/rapier.es.js`

All client modules use ES module syntax (`type="module"`).

### Client-side flow

```
main.js
  └── Launcher        — init screen, loading steps, mode menu
        └── GameEngine  — Three.js renderer + Rapier3D physics world + game loop
        └── modes/Sandbox — scene setup, UI buttons, per-frame cleanup via engine.onUpdate
```

**`GameEngine`** is the core abstraction:
- Wraps Three.js (scene, camera, renderer, OrbitControls) and Rapier3D physics in a single class
- Maintains a `_bodies` array of `{ mesh, body, isStatic }` pairs and syncs Rapier → Three.js each frame
- Exposes `addStaticBox`, `addDynamicBox`, `addDynamicSphere`, and `remove`
- `onUpdate(dt)` callback is called each frame before rendering — modes hook in here

**`Launcher`** manages the startup sequence:
- Shows an animated init screen while `GameEngine.init()` loads Three.js and awaits the Rapier WASM binary
- Then shows a mode-selection menu; currently only Sandbox is implemented

**`modes/Sandbox`** is the only game mode:
- Spawns a static floor and 10 dynamic boxes
- Provides shoot (sphere projectile from camera) and spawn (random box) buttons with touch support
- Uses `engine.onUpdate` for FPS counter and cleanup of bodies that fall below Y = -20

### Unused legacy files

`public/src/lights.js`, `public/src/physics.js`, and `public/src/scene.js` are leftover from an earlier flat architecture. They are not imported anywhere — all their functionality was absorbed into `GameEngine.js`.

### Adding a new game mode

1. Create `public/src/modes/MyMode.js` with `start()` and `stop()` methods that receive an `engine` instance
2. Import and wire it in `Launcher.js` (add a menu button, call `this._launch(new MyMode(this.engine))`)
