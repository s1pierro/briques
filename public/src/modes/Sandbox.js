import * as THREE from 'three';
import { getManifold, buildCache, manifoldToGeometry, manifoldToPoints } from '../csg-utils.js';

const COLORS = [0x00aaff, 0xff6600, 0x00ff88, 0xff2255, 0xffcc00];

export class Sandbox {

  constructor(engine) {
    this.engine = engine;
    this._ui    = [];
    this._spawnInterval = null;
  }

  start() {
    this._setupScene();
    this._setupUI();
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
    const store = (() => {
      try { return JSON.parse(localStorage.getItem('rbang_shapes') || '{}'); } catch { return {}; }
    })();
    const names = Object.keys(store);
    if (!names.length) { this._spawnBox(); return; }
    const data = store[names[Math.floor(Math.random() * names.length)]];
    if (!data?.steps || !data.rootId) { this._spawnBox(); return; }
    this._spawnShape(data);
  }

  async _spawnShape(data) {
    try {
      const M      = await getManifold();
      const cache  = buildCache(data.steps, M);
      const mf     = cache.get(data.rootId);
      if (!mf) { this._spawnBox(); return; }

      const { geo } = manifoldToGeometry(mf);
      const pts     = manifoldToPoints(mf);

      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
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
      COLORS[Math.floor(Math.random() * COLORS.length)]
    );
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
    bar.appendChild(fps);
    bar.appendChild(objs);
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
