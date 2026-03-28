import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER         from '@dimforge/rapier3d-compat';

export class GameEngine {

  // ─── Construction ──────────────────────────────────────────────────────────

  constructor({ gravity = { x: 0, y: -9.81, z: 0 } } = {}) {
    this._gravityOpts = gravity;
    this._bodies      = []; // { mesh, body }
    this._running     = false;
    this._lastTime    = 0;

    /** Appelé à chaque frame avec (dt) avant le rendu — à surcharger */
    this.onUpdate     = null;
    /** Appelé après controls.update(), avant le rendu — utile pour contraintes caméra */
    this.onPostUpdate = null;
  }

  // ─── Initialisation ────────────────────────────────────────────────────────

  async init(onStep = () => {}) {
    this._onStep = onStep;
    this._step('renderer',  'Three.js');  this._initThree();
    this._step('lights',    'Lumières');  this._initLights();
    this._step('physics',   'Rapier WASM');
    await this._initPhysics();
    this._step('ready',     'Prêt');
    return this;
  }

  _step(id, label) {
    this._onStep(id, label);
  }

  _initThree() {
    this.scene    = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111111);

    this.camera   = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
    this.camera.position.set(0, 8, 16);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    document.body.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance   = 2;
    this.controls.maxDistance   = 60;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this._vpLeft  = 0;
    this._vpRight = 0;
    this._vpTop   = 0;

    window.addEventListener('resize', () => this.resizeViewport(this._vpLeft, this._vpRight, this._vpTop));
  }

  _initLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(8, 16, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near   = 0.5;
    sun.shadow.camera.far    = 100;
    sun.shadow.camera.left   = sun.shadow.camera.bottom = -20;
    sun.shadow.camera.right  = sun.shadow.camera.top    =  20;
    this.scene.add(sun);
  }

  resizeViewport(leftOffset = 0, rightOffset = 0, topOffset = 0) {
    this._vpLeft  = leftOffset;
    this._vpRight = rightOffset;
    this._vpTop   = topOffset;
    const w = Math.max(100, innerWidth  - leftOffset - rightOffset);
    const h = Math.max(100, innerHeight - topOffset);
    const el = this.renderer.domElement;
    el.style.position = 'fixed';
    el.style.left     = leftOffset + 'px';
    el.style.top      = topOffset  + 'px';
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // TrackballControls expose handleResize() pour recalculer son offset écran
    if (typeof this.controls?.handleResize === 'function') {
      this.controls.handleResize();
    }
  }

  async _initPhysics() {
    await RAPIER.init();
    this.R     = RAPIER;
    this.world = new RAPIER.World(this._gravityOpts);
  }

  // ─── Helpers objets ────────────────────────────────────────────────────────

  addStaticBox(w, h, d, x, y, z, color = 0x333333) {
    const mesh = this._makeMesh(new THREE.BoxGeometry(w, h, d), color, false, true);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(x, y, z));
    this.world.createCollider(this.R.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
    this._bodies.push({ mesh, body, isStatic: true });
    return { mesh, body };
  }

  addDynamicBox(w, h, d, x, y, z, color = 0x00aaff) {
    const mesh = this._makeMesh(new THREE.BoxGeometry(w, h, d), color, true, true);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setRestitution(0.3).setFriction(0.6),
      body
    );
    this._bodies.push({ mesh, body, isStatic: false });
    return { mesh, body };
  }

  addDynamicSphere(radius, x, y, z, color = 0xff4400, density = 1) {
    const mesh = this._makeMesh(new THREE.SphereGeometry(radius, 16, 10), color, true, false);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    this.world.createCollider(
      this.R.ColliderDesc.ball(radius).setRestitution(0.4).setFriction(0.5).setDensity(density),
      body
    );
    this._bodies.push({ mesh, body, isStatic: false });
    return { mesh, body };
  }

  _makeMesh(geometry, color, castShadow, receiveShadow) {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color })
    );
    mesh.castShadow    = castShadow;
    mesh.receiveShadow = receiveShadow;
    this.scene.add(mesh);
    return mesh;
  }

  // ─── Boucle ────────────────────────────────────────────────────────────────

  start() {
    this._running  = true;
    this._lastTime = performance.now();
    this._loop();
    return this;
  }

  stop() {
    this._running = false;
    return this;
  }

  stepOnce() {
    this._pendingStep = true;
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());

    const now = performance.now();
    const dt  = Math.min((now - this._lastTime) / 1000, 0.05);
    this._lastTime = now;

    // Pas physique (skip si pausé — le rendu continue)
    if (!this.physPaused) {
      this.world.timestep = dt;
      this.world.step();
    } else if (this._pendingStep) {
      this._pendingStep = false;
      this.world.timestep = 1 / 60;
      this.world.step();
    }

    // Sync Three.js ← Rapier (corps dynamiques uniquement)
    for (const { mesh, body, isStatic } of this._bodies) {
      if (isStatic) continue;
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }

    if (this.onUpdate) this.onUpdate(dt);

    this.controls.update();

    if (this.onPostUpdate) this.onPostUpdate(dt);

    this.renderer.render(this.scene, this.camera);
  }

  remove({ mesh, body }) {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    this.world.removeRigidBody(body);
    const idx = this._bodies.findIndex(b => b.body === body);
    if (idx !== -1) this._bodies.splice(idx, 1);
  }

  get objectCount() {
    return this._bodies.filter(b => !b.isStatic).length;
  }
}
