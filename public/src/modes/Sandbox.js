import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { getManifold, buildCache, manifoldToGeometry, manifoldToPoints } from '../csg-utils.js';


export class Sandbox {

  constructor(engine) {
    this.engine = engine;
    this._ui    = [];
    this._spawnInterval = null;
  }

  start() {
    this._setupScene();
    this._setupUI();
    this._setupPhysicsPanel();
    this._setupStatusBar();
    this._spawnInterval = setInterval(() => this._spawnRandom(), 1000);
    this.engine.start();
  }

  stop() {
    clearInterval(this._spawnInterval);
    this._spawnInterval = null;
    this.engine.stop();
    this._ui.forEach(el => el.remove());
    this._ui = [];
  }

  _setupScene() {
    this.engine.addStaticBox(15, 0.5, 15, 0, 0, 0);
  }

  _setupUI() {
    const btn = document.createElement('button');
    btn.textContent = '🔫';
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px',
      'width:52px', 'height:52px',
      'background:#c0392b', 'color:#fff',
      'border:none', 'border-radius:10px', 'font-size:22px',
      'z-index:50', 'cursor:pointer',
      'box-shadow:0 4px 12px rgba(0,0,0,.5)',
    ].join(';');

    const shoot = () => {
      const dir = new THREE.Vector3();
      this.engine.camera.getWorldDirection(dir);
      const p = this.engine.camera.position;
      const { body } = this.engine.addDynamicSphere(0.35, p.x, p.y, p.z, 0xff4400, 80);
      body.setLinvel({ x: dir.x * 25, y: dir.y * 25, z: dir.z * 25 }, true);
    };

    btn.addEventListener('click', shoot);
    btn.addEventListener('touchstart', e => { e.preventDefault(); shoot(); }, { passive: false });

    document.body.appendChild(btn);
    this._ui.push(btn);
  }

  _spawnRandom() {
    const load = key => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
    const bricks = load('rbang_bricks');
    const keys   = Object.keys(bricks);
    if (!keys.length) { this._spawnBox(); return; }
    const brick = bricks[keys[Math.floor(Math.random() * keys.length)]];

    // csgTree embarqué > shapeRef externe
    let data;
    if (brick.csgTree?.steps && brick.csgTree.rootId) {
      data = brick.csgTree;
    } else if (brick.shapeRef) {
      const shapes = load('rbang_shapes');
      data = shapes[brick.shapeRef];
    }
    if (!data?.steps || !data.rootId) { this._spawnBox(); return; }
    this._spawnShape(data, brick.color);
  }

  async _spawnShape(data, colorHex) {
    try {
      const M      = await getManifold();
      const cache  = buildCache(data.steps, M);
      const mf     = cache.get(data.rootId);
      if (!mf) { this._spawnBox(); return; }

      const { geo } = manifoldToGeometry(mf);
      const pts     = manifoldToPoints(mf);

      const color = colorHex ? parseInt(colorHex.replace('#', ''), 16) : 0x888888;
      const mesh  = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
      mesh.castShadow = mesh.receiveShadow = true;

      const x = (Math.random() - 0.5) * 5;
      const y = 8 + Math.random() * 2;
      const z = (Math.random() - 0.5) * 5;

      const e    = this.engine;
      e.scene.add(mesh);
      const body = e.world.createRigidBody(e.R.RigidBodyDesc.dynamic().setTranslation(x, y, z));
      const cd   = (e.R.ColliderDesc.convexHull(pts) ?? e.R.ColliderDesc.ball(0.5))
                     .setRestitution(0.3).setFriction(0.6);
      e.world.createCollider(cd, body);
      e._bodies.push({ mesh, body, isStatic: false });
    } catch {
      this._spawnBox();
    }
  }

  _spawnBox() {
    this.engine.addDynamicBox(1, 1, 1,
      (Math.random() - 0.5) * 5,
      8 + Math.random() * 2,
      (Math.random() - 0.5) * 5,
      0x888888
    );
  }

  _setupPhysicsPanel() {
    const C = { bg: '#2e2e2e', border: '#555', fg: '#d0d0d0', dim: '#888', accent: '#7aafc8' };

    const panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'right:12px', 'top:44px',
      `background:${C.bg}`, `border:1px solid ${C.border}`,
      'border-radius:2px', 'padding:8px 10px',
      'z-index:60', 'font:11px sans-serif', `color:${C.fg}`,
      'min-width:180px',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)',
    ].join(';');

    const makeSection = txt => {
      const s = document.createElement('div');
      s.style.cssText = [
        'font-size:9px', `color:${C.dim}`,
        'text-transform:uppercase', 'letter-spacing:.08em',
        'margin:8px 0 4px',
      ].join(';');
      s.textContent = txt;
      return s;
    };

    const makeSlider = (label, min, max, step, init, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:3px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};flex-shrink:0;min-width:90px;font-size:10px;`;
      const sl = document.createElement('input');
      sl.type = 'range';
      sl.min = String(min); sl.max = String(max); sl.step = String(step);
      sl.value = String(init);
      sl.style.cssText = 'flex:1;cursor:pointer;accent-color:' + C.accent + ';';
      const fmt = v => Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2);
      const val = document.createElement('span');
      val.textContent = fmt(init);
      val.style.cssText = [
        `color:${C.accent}`, 'min-width:34px', 'text-align:right',
        'font-variant-numeric:tabular-nums', 'font-size:10px',
      ].join(';');
      sl.addEventListener('input', () => { const v = parseFloat(sl.value); val.textContent = fmt(v); onChange(v); });
      row.append(lbl, sl, val);
      return row;
    };

    panel.append(makeSection('Moteur physique'));
    panel.append(makeSlider('Gravité', -30, 0, 0.1, -9.81, v => {
      this.engine.world.gravity = { x: 0, y: v, z: 0 };
    }));
    panel.append(makeSlider('Solver iter.', 1, 50, 1, 4, v => {
      this.engine.world.numSolverIterations = v;
    }));
    panel.append(makeSlider('Amort. lin.', 0, 5, 0.05, 0, v => {
      this._linearDamping = v;
    }));
    panel.append(makeSlider('Amort. ang.', 0, 20, 0.1, 0, v => {
      this._angularDamping = v;
    }));

    // Pause / pas-à-pas
    panel.append(makeSection('Simulation'));
    const ctrlRow = document.createElement('div');
    ctrlRow.style.cssText = 'display:flex;gap:5px;';

    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = '⏸';
    pauseBtn.title = 'Pause physique';
    pauseBtn.style.cssText = [
      'flex:1', 'padding:3px 0', 'font-size:14px', 'cursor:pointer',
      `background:${C.bg}`, `border:1px solid ${C.border}`, `color:${C.fg}`,
      'border-radius:2px',
    ].join(';');

    const stepBtn = document.createElement('button');
    stepBtn.textContent = '⏭ Pas';
    stepBtn.title = "Avancer d'un pas (1/60 s)";
    stepBtn.disabled = true;
    stepBtn.style.cssText = [
      'flex:1', 'padding:3px 0', 'font-size:11px', 'cursor:pointer',
      `background:${C.bg}`, `border:1px solid ${C.border}`, `color:${C.fg}`,
      'border-radius:2px',
    ].join(';');

    const doPause = () => {
      this.engine.physPaused = !this.engine.physPaused;
      pauseBtn.textContent = this.engine.physPaused ? '▶' : '⏸';
      pauseBtn.title = this.engine.physPaused ? 'Reprendre' : 'Pause physique';
      stepBtn.disabled = !this.engine.physPaused;
    };
    const doStep = () => { if (this.engine.physPaused) this.engine.stepOnce(); };

    pauseBtn.addEventListener('click', doPause);
    pauseBtn.addEventListener('touchstart', e => { e.preventDefault(); doPause(); }, { passive: false });
    stepBtn.addEventListener('click', doStep);
    stepBtn.addEventListener('touchstart', e => { e.preventDefault(); doStep(); }, { passive: false });

    ctrlRow.append(pauseBtn, stepBtn);
    panel.append(ctrlRow);

    // Densité pixel
    panel.append(makeSection('Rendu'));
    panel.append(makeSlider('Densité pixel', 0.25, Math.min(3, devicePixelRatio), 0.25, devicePixelRatio, v => {
      this.engine.renderer.setPixelRatio(v);
      this.engine.resizeViewport(this.engine._vpLeft, this.engine._vpRight, this.engine._vpTop);
    }));

    // Export GLB
    panel.append(makeSection('Export'));
    const exportBtn = document.createElement('button');
    exportBtn.textContent = '⤓ Export GLB';
    exportBtn.style.cssText = [
      'width:100%', 'padding:5px 0', 'font-size:11px', 'cursor:pointer',
      `background:${C.bg}`, `border:1px solid ${C.border}`, `color:${C.fg}`,
      'border-radius:2px', 'margin-top:2px',
    ].join(';');
    exportBtn.addEventListener('click', () => this._exportGLB());
    panel.append(exportBtn);

    document.body.appendChild(panel);
    this._ui.push(panel);
    this._panel = panel;

    this._linearDamping  = 0;
    this._angularDamping = 0;
  }

  _exportGLB() {
    const exportScene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    exportScene.add(ambient, dir);

    for (const { mesh, isStatic } of this.engine._bodies) {
      if (isStatic) continue;
      const clone = mesh.clone();
      const mat = mesh.material;
      clone.material = new THREE.MeshStandardMaterial({
        color:     mat.color.clone(),
        roughness: mat.roughness ?? 0.55,
        metalness: mat.metalness ?? 0.0,
      });
      exportScene.add(clone);
    }

    if (!exportScene.children.length) return;

    const exporter = new GLTFExporter();
    exporter.parse(exportScene, (glb) => {
      const blob = new Blob([glb], { type: 'model/gltf-binary' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `rbang-sandbox-${Date.now()}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, console.error, { binary: true });
  }

  _setupStatusBar() {
    const bar = document.createElement('div');
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'height:36px', 'background:rgba(0,0,0,0.55)',
      'backdrop-filter:blur(6px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'gap:2rem', 'z-index:50',
      'font-family:monospace', 'font-size:13px', 'color:#aaa',
      'pointer-events:none',
    ].join(';');

    const fps  = document.createElement('span');
    const objs = document.createElement('span');

    const cfgBtn = document.createElement('button');
    cfgBtn.textContent = '⚙';
    cfgBtn.title = 'Panneau de configuration';
    cfgBtn.style.cssText = [
      'position:absolute', 'right:12px',
      'background:transparent', 'border:none',
      'color:#aaa', 'font-size:16px', 'cursor:pointer',
      'pointer-events:auto', 'padding:0 4px', 'line-height:1',
    ].join(';');
    cfgBtn.addEventListener('click', () => {
      const visible = this._panel.style.display !== 'none';
      this._panel.style.display = visible ? 'none' : '';
      cfgBtn.style.color = visible ? '#555' : '#aaa';
    });
    cfgBtn.addEventListener('touchstart', e => { e.preventDefault(); cfgBtn.click(); }, { passive: false });

    const fsBtn = document.createElement('button');
    fsBtn.textContent = '⛶';
    fsBtn.title = 'Plein écran';
    fsBtn.style.cssText = [
      'position:absolute', 'right:40px',
      'background:transparent', 'border:none',
      'color:#aaa', 'font-size:16px', 'cursor:pointer',
      'pointer-events:auto', 'padding:0 4px', 'line-height:1',
    ].join(';');
    const toggleFs = () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    };
    fsBtn.addEventListener('click', toggleFs);
    fsBtn.addEventListener('touchstart', e => { e.preventDefault(); toggleFs(); }, { passive: false });
    document.addEventListener('fullscreenchange', () => {
      fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
      fsBtn.title       = document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran';
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = '↺';
    reloadBtn.title = 'Recharger';
    reloadBtn.style.cssText = fsBtn.style.cssText.replace('right:40px', 'right:68px');
    const hardReload = async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      location.reload();
    };
    reloadBtn.addEventListener('click', hardReload);
    reloadBtn.addEventListener('touchstart', e => { e.preventDefault(); hardReload(); }, { passive: false });

    bar.appendChild(fps);
    bar.appendChild(objs);
    bar.appendChild(reloadBtn);
    bar.appendChild(fsBtn);
    bar.appendChild(cfgBtn);
    document.body.appendChild(bar);
    this._ui.push(bar);

    let frames = 0;
    let elapsed = 0;
    const KILL_Y = -20;

    this.engine.onUpdate = (dt) => {
      frames++;
      elapsed += dt;
      if (elapsed >= 1) {
        fps.textContent = `FPS : ${frames}`;
        frames  = 0;
        elapsed = 0;
      }

      const toRemove = this.engine._bodies.filter(
        b => !b.isStatic && b.body.translation().y < KILL_Y
      );
      toRemove.forEach(b => this.engine.remove(b));

      objs.textContent = `Objets : ${this.engine.objectCount}`;
    };
  }
}
