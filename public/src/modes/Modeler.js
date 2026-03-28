import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

// ─── Manifold (WASM) ──────────────────────────────────────────────────────────

let _M = null; // instance Manifold après init

async function getManifold() {
  if (_M) return _M;
  const Module = (await import(window.RBANG_BASE + 'manifold/manifold.js')).default;
  const wasm = await Module();
  wasm.setup();          // initialise les méthodes statiques (cube, sphere…)
  _M = wasm;
  return _M;
}

// ─── Évaluation CSG ───────────────────────────────────────────────────────────

function evalStep(step, cache, M) {
  if (cache.has(step.id)) return cache.get(step.id);

  const p = step.params;
  let result;

  switch (step.kind) {
    case 'cube':
      result = M.Manifold.cube([p.x ?? 1, p.y ?? 1, p.z ?? 1], true);
      break;
    case 'sphere':
      result = M.Manifold.sphere(p.r ?? 0.5, p.segs ?? 24);
      break;
    case 'cylinder':
      result = M.Manifold.cylinder(p.h ?? 1, p.r ?? 0.5, p.r ?? 0.5, p.segs ?? 24, true);
      break;
    case 'cone':
      result = M.Manifold.cylinder(p.h ?? 1, p.r ?? 0.5, 0, p.segs ?? 24, true);
      break;
    case 'roundedBox': {
      const w = p.x ?? 2, h = p.y ?? 2, d = p.z ?? 2;
      const r = Math.min(p.r ?? 0.2, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
      const segs = p.segs ?? 8;
      const corners = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
        corners.push(M.Manifold.sphere(r, segs).translate([sx * (w / 2 - r), sy * (h / 2 - r), sz * (d / 2 - r)]));
      result = M.Manifold.hull(corners);
      break;
    }
    case 'union': {
      const a = cache.get(p.a); const b = cache.get(p.b);
      result = a && b ? M.Manifold.union(a, b) : (a || b || M.Manifold.cube([0,0,0]));
      break;
    }
    case 'subtract': {
      const a = cache.get(p.a); const b = cache.get(p.b);
      result = a && b ? M.Manifold.difference(a, b) : (a || M.Manifold.cube([0,0,0]));
      break;
    }
    case 'intersect': {
      const a = cache.get(p.a); const b = cache.get(p.b);
      result = a && b ? M.Manifold.intersection(a, b) : M.Manifold.cube([0,0,0]);
      break;
    }
    case 'repeat': {
      const base = cache.get(p.src);
      if (!base) { result = M.Manifold.cube([0.001, 0.001, 0.001]); break; }
      const n = Math.max(1, Math.round(p.n ?? 2));
      const copies = [];
      for (let i = 0; i < n; i++)
        copies.push(base.translate([i * (p.dx ?? 0), i * (p.dy ?? 0), i * (p.dz ?? 0)]));
      result = copies.reduce((acc, m) => M.Manifold.union(acc, m));
      break;
    }
    default:
      result = M.Manifold.cube([0.1, 0.1, 0.1]);
  }

  // Appliquer les transformations (translate, rotate en degrés, scale)
  const tr = step.translate;
  const ro = step.rotate;
  const sc = step.scale;
  if (tr && (tr[0] || tr[1] || tr[2]))
    result = result.translate(tr);
  if (ro && (ro[0] || ro[1] || ro[2]))
    result = result.rotate(ro);
  if (sc && (sc[0] !== 1 || sc[1] !== 1 || sc[2] !== 1))
    result = result.scale(sc);

  cache.set(step.id, result);
  return result;
}

function buildCache(steps, M) {
  const cache = new Map();
  for (const s of steps) evalStep(s, cache, M);
  return cache;
}

function manifoldToGeometry(manifold) {
  const mesh     = manifold.getMesh();
  const verts    = mesh.vertProperties;  // Float32Array
  const tris     = mesh.triVerts;        // Uint32Array, 3 indices per tri
  const stride   = mesh.numProp ?? 3;    // floats per vertex (≥3 for x,y,z)
  const numFaces = tris.length / 3;
  const numVerts = verts.length / stride;

  const pos = new Float32Array(tris.length * 3);
  const nm  = new Float32Array(tris.length * 3);

  for (let i = 0; i < tris.length; i += 3) {
    const v0 = tris[i] * stride, v1 = tris[i+1] * stride, v2 = tris[i+2] * stride;
    const ax = verts[v0], ay = verts[v0+1], az = verts[v0+2];
    const bx = verts[v1], by = verts[v1+1], bz = verts[v1+2];
    const cx = verts[v2], cy = verts[v2+1], cz = verts[v2+2];
    const base = i * 3;
    pos[base]   = ax; pos[base+1] = ay; pos[base+2] = az;
    pos[base+3] = bx; pos[base+4] = by; pos[base+5] = bz;
    pos[base+6] = cx; pos[base+7] = cy; pos[base+8] = cz;
    // Normal face
    const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const nl = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
    for (let k = 0; k < 3; k++) {
      nm[base + k*3]   = nx/nl;
      nm[base + k*3+1] = ny/nl;
      nm[base + k*3+2] = nz/nl;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nm,  3));
  return { geo, numFaces, numVerts };
}

// ─── Constantes UI ────────────────────────────────────────────────────────────

const LS_KEY = 'rbang_modeler_v1';

const KIND_META = {
  cube:      { icon: '⬜', label: 'Cube',      color: '#4488ff', isPrim: true  },
  sphere:    { icon: '⬤', label: 'Sphère',    color: '#44cc88', isPrim: true  },
  cylinder:  { icon: '⬭', label: 'Cylindre',  color: '#ffaa33', isPrim: true  },
  cone:      { icon: '△', label: 'Cône',      color: '#ff6644', isPrim: true  },
  roundedBox:{ icon: '▢', label: 'Cube arrondi', color: '#aa88ff', isPrim: true  },
  union:     { icon: '∪', label: 'Union',     color: '#aaaaff', isPrim: false },
  subtract:  { icon: '−', label: 'Soustraire',color: '#ff6688', isPrim: false },
  intersect: { icon: '∩', label: 'Intersection', color: '#88ffaa', isPrim: false },
  repeat:    { icon: '⁂', label: 'Répétition', color: '#ffcc44', isPrim: false },
};

const DEFAULT_PARAMS = {
  cube:      { x: 2, y: 2, z: 2 },
  sphere:    { r: 1, segs: 24 },
  cylinder:  { r: 0.5, h: 2, segs: 24 },
  cone:      { r: 0.8, h: 2, segs: 24 },
  roundedBox:{ x: 2, y: 2, z: 2, r: 0.3, segs: 8 },
  union:     { a: null, b: null },
  subtract:  { a: null, b: null },
  intersect: { a: null, b: null },
  repeat:    { src: null, n: 3, dx: 2, dy: 0, dz: 0 },
};

// ─── Mode Modeler ─────────────────────────────────────────────────────────────

export class Modeler {

  constructor(engine) {
    this.engine      = engine;
    this._ui         = [];
    this._M          = null;        // Manifold API
    this._cache      = new Map();   // stepId → Manifold
    this._meshes     = new Map();   // stepId → THREE.Mesh (un par step visible)
    this._selId      = null;        // step sélectionné
    this._leftW      = 160;
    this._rightW     = 320;
    this._worldGizmo = null;

    // Params gizmo (persistés séparément)
    const gp = JSON.parse(localStorage.getItem('rbang_gizmo') || '{}');
    this._gizmoParams = { axisLen: gp.axisLen ?? 5, gradStep: gp.gradStep ?? 1, gradRatio: gp.gradRatio ?? 0.08 };
    this._gizmoXray   = true;  // gizmo monde visible à travers la géométrie

    // Données persistées
    this._data = this._load();
  }

  // ─── Persistance ────────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        // Migration : garantir que chaque step a un champ visible
        (d.steps || []).forEach(s => { if (s.visible === undefined) s.visible = true; });
        return { steps: d.steps || [] };
      }
    } catch (_) {}
    return { steps: [] };
  }

  _save() {
    localStorage.setItem(LS_KEY, JSON.stringify(this._data));
  }

  // ─── Cycle de vie ───────────────────────────────────────────────────────────

  async start() {
    this._rafHandle   = null;   // handle RAF en attente (demand render)
    this._setupScene();
    this._setupGizmo();
    this._buildWorldGizmo();
    this._setupUI();
    // Pas d'engine.start() : pas de physique, rendu à la demande uniquement

    this._setStatus('Chargement Manifold…');
    this._M = await getManifold();
    this._setStatus('');

    await this._rebuildAll();
    this._loadCatalog();
  }

  stop() {
    if (this._rafHandle !== null) { cancelAnimationFrame(this._rafHandle); this._rafHandle = null; }
    this._fsAC?.abort();
    if (this._onInteract) {
      const dom = this.engine.renderer.domElement;
      dom.removeEventListener('pointerdown', this._onInteract);
      dom.removeEventListener('pointermove', this._onInteract);
      dom.removeEventListener('wheel',       this._onInteract);
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    this._clearMeshes();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    document.documentElement.style.removeProperty('--ml-lw');
    document.documentElement.style.removeProperty('--ml-rw');
    this.engine.resizeViewport(0, 0);
    this.engine.controls.dispose();
    this.engine.controls = this._origControls;
    this._origControls.enabled = true;
    if (this._gizmoRenderer) { this._gizmoRenderer.dispose(); this._gizmoRenderer = null; }
    this._clearWorldGizmo();
  }

  // ─── Rendu à la demande ─────────────────────────────────────────────────────

  _scheduleRender() {
    if (this._rafHandle !== null) return;
    this._rafHandle = requestAnimationFrame(() => this._renderFrame());
  }

  _renderFrame() {
    this._rafHandle = null;
    this.engine.controls.update();
    this.engine.renderer.render(this.engine.scene, this.engine.camera);
    if (this._gizmoRenderer && this._gizmoScene && this._gizmoCam) {
      const mc  = this.engine.camera;
      const dir = mc.position.clone().sub(this.engine.controls.target).normalize();
      this._gizmoCam.position.copy(dir).multiplyScalar(5);
      this._gizmoCam.up.copy(mc.up);
      this._gizmoCam.lookAt(0, 0, 0);
      this._gizmoRenderer.render(this._gizmoScene, this._gizmoCam);
    }
  }

  // ─── Gizmo axes ─────────────────────────────────────────────────────────────

  _setupGizmo() {
    const SIZE = 90;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `
      position:fixed; bottom:56px; left:calc(var(--ml-lw) + 10px);
      width:${SIZE}px; height:${SIZE}px;
      z-index:45; border-radius:4px; opacity:0.88;
      cursor:pointer; box-sizing:border-box;
      border: 1px solid var(--ml-bevel);
      box-shadow: inset 0 1px 0 var(--ml-bevel), 0 1px 2px #0004;
    `;
    canvas.title = 'Toggle xray gizmo';
    canvas.addEventListener('click', () => this._toggleGizmoXray());
    this._gizmoCanvas = canvas;
    document.body.appendChild(canvas);
    this._ui.push(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this._gizmoRenderer = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 2));

    const L = 0.62;
    const AXES = [
      { dir: new THREE.Vector3(1,0,0), color: 0xdd3333, label:'X', lc:'#dd4444' },
      { dir: new THREE.Vector3(0,1,0), color: 0x33bb33, label:'Y', lc:'#44cc44' },
      { dir: new THREE.Vector3(0,0,1), color: 0x3377dd, label:'Z', lc:'#4488ee' },
    ];

    for (const { dir, color, label, lc } of AXES) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), L, color, L*0.28, L*0.14);
      arrow.traverse(o => {
        if (o.material) { o.material = o.material.clone(); o.material.depthTest = false; }
        o.renderOrder = 1;
      });
      scene.add(arrow);

      // Label sprite via canvas 2D
      const lc2 = document.createElement('canvas');
      lc2.width = lc2.height = 48;
      const ctx = lc2.getContext('2d');
      ctx.fillStyle = lc;
      ctx.font = 'bold 26px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 24, 26);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(lc2), depthTest: false, transparent: true })
      );
      sprite.scale.set(0.3, 0.3, 1);
      sprite.position.copy(dir).multiplyScalar(L + 0.22);
      sprite.renderOrder = 2;
      scene.add(sprite);
    }

    this._gizmoScene  = scene;
    this._gizmoCam    = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 20);
    this._gizmoCam.position.set(0, 0, 5);
    // Le rendu du gizmo est intégré dans _renderFrame() — pas de hook onUpdate
  }

  // ─── Scène ──────────────────────────────────────────────────────────────────

  _setupScene() {
    const e = this.engine;

    this._origControls = e.controls;
    this._origControls.enabled = false;

    const tb = new TrackballControls(e.camera, e.renderer.domElement);
    tb.rotateSpeed = 3.5; tb.zoomSpeed = 1.2; tb.panSpeed = 0.8;
    tb.dynamicDampingFactor = 0.18;
    tb.minDistance = 0.2; tb.maxDistance = 40;
    e.controls = tb;

    e.camera.position.set(3, 2.5, 3);
    tb.target.set(0, 0, 0);
    tb.update();

    // Amorce : les events pointeur/wheel déclenchent le premier update()
    // Ensuite l'event "change" de TrackballControls prend le relais (damping résiduel)
    this._onInteract = () => this._scheduleRender();
    const dom = e.renderer.domElement;
    dom.addEventListener('pointerdown', this._onInteract);
    dom.addEventListener('pointermove', this._onInteract);
    dom.addEventListener('wheel',       this._onInteract, { passive: true });
    tb.addEventListener('change', () => this._scheduleRender());

    this._onResize = () => { this._applyPanelWidth(); this._scheduleRender(); };
    window.addEventListener('resize', this._onResize);

    this._fill = new THREE.DirectionalLight(0x7799ff, 0.5);
    this._fill.position.set(-2, 1, -2);
    e.scene.add(this._fill);
  }

  // ─── Gizmo monde ────────────────────────────────────────────────────────────

  _clearWorldGizmo() {
    if (!this._worldGizmo) return;
    this.engine.scene.remove(this._worldGizmo);
    this._worldGizmo.traverse(o => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
    this._worldGizmo = null;
  }

  _buildWorldGizmo() {
    this._clearWorldGizmo();
    const { axisLen, gradStep } = this._gizmoParams;
    const group = new THREE.Group();

    const xray = this._gizmoXray;
    const depthMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({
      color, depthTest: !xray, transparent: opacity < 1 || xray, opacity,
    });

    const AXES = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xdd3333 },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x33bb44 },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x3377dd },
    ];

    const gradR    = gradStep * this._gizmoParams.gradRatio;
    const gradGeo  = new THREE.SphereGeometry(gradR, 7, 7);
    const steps    = Math.round(axisLen / gradStep);

    for (const { dir, color } of AXES) {
      // Flèche positive
      const arrow = new THREE.ArrowHelper(
        dir, new THREE.Vector3(), axisLen,
        color, axisLen * 0.06, axisLen * 0.028
      );
      arrow.traverse(o => {
        if (o.material) { o.material = o.material.clone(); o.material.depthTest = !xray; if (xray) o.material.transparent = true; }
        o.renderOrder = 500;
      });
      group.add(arrow);

      // Demi-axe négatif (ligne simple, opacité réduite)
      const negGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), dir.clone().multiplyScalar(-axisLen * 0.55),
      ]);
      const negLine = new THREE.Line(negGeo, new THREE.LineBasicMaterial({
        color, depthTest: !xray, transparent: true, opacity: 0.2,
      }));
      negLine.renderOrder = 499;
      group.add(negLine);

      // Graduations — positif et négatif
      for (let i = 1; i <= steps; i++) {
        for (const sign of [1, -1]) {
          if (sign === -1 && i * gradStep > axisLen * 0.55) continue;
          const s = new THREE.Mesh(gradGeo, depthMat(color, sign > 0 ? 0.85 : 0.3));
          s.position.copy(dir).multiplyScalar(i * gradStep * sign);
          s.renderOrder = 501;
          group.add(s);
        }
      }
    }

    // Sphère à l'origine
    const originMesh = new THREE.Mesh(
      new THREE.SphereGeometry(gradR * 1.6, 9, 9),
      depthMat(0xffffff, 0.55)
    );
    originMesh.renderOrder = 502;
    group.add(originMesh);

    this.engine.scene.add(group);
    this._worldGizmo = group;
    this._scheduleRender();
  }

  _toggleGizmoXray() {
    this._gizmoXray = !this._gizmoXray;
    // Mise à jour des matériaux en place — pas de reconstruction
    if (this._worldGizmo) {
      this._worldGizmo.traverse(o => {
        if (!o.material) return;
        [].concat(o.material).forEach(m => {
          m.depthTest    = !this._gizmoXray;
          m.transparent  = true;
          m.needsUpdate  = true;
        });
      });
    }
    // Feedback visuel sur le canvas du gizmo de coin
    if (this._gizmoCanvas) {
      this._gizmoCanvas.style.borderColor = this._gizmoXray ? 'var(--ml-accent)' : 'var(--ml-border)';
    }
    this._scheduleRender();
  }

  // ─── CSG ────────────────────────────────────────────────────────────────────

  async _rebuildAll() {
    if (!this._M) return;
    this._cache = buildCache(this._data.steps, this._M);
    this._clearMeshes();
    for (const s of this._data.steps) this._updateMesh(s.id);
  }

  async _rebuildFrom(fromId) {
    if (!this._M) return;
    let invalidate = false;
    for (const s of this._data.steps) {
      if (s.id === fromId) invalidate = true;
      if (invalidate) {
        this._cache.delete(s.id);
        evalStep(s, this._cache, this._M);
        this._updateMesh(s.id);
      }
    }
  }

  _updateMesh(id) {
    // Supprimer l'ancien mesh de ce step
    const old = this._meshes.get(id);
    if (old) {
      this.engine.scene.remove(old);
      old.geometry.dispose();
      old.material.dispose();
      this._meshes.delete(id);
    }
    const step = this._data.steps.find(s => s.id === id);
    if (!step || !step.visible) { this._scheduleRender(); return; }
    const mf = this._cache.get(id);
    if (!mf) return;
    try {
      const { geo, numFaces, numVerts } = manifoldToGeometry(mf);
      const mat  = new THREE.MeshStandardMaterial({
        color: id === this._selId ? 0x4488ff : 0x3366cc,
        roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.engine.scene.add(mesh);
      this._meshes.set(id, mesh);
      if (id === this._selId) this._updateStatsOverlay(numFaces, numVerts);
    } catch (e) {
      console.warn('Manifold→Three.js:', e);
    }
    this._scheduleRender();
  }

  _clearMeshes() {
    for (const mesh of this._meshes.values()) {
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this._meshes.clear();
  }

  // ─── Mutations données ──────────────────────────────────────────────────────

  _addStep(kind) {
    const id = 's' + Date.now().toString(36);
    const meta = KIND_META[kind];
    const step = {
      id,
      kind,
      label: meta.label,
      params:    structuredClone(DEFAULT_PARAMS[kind]),
      translate: [0, 0, 0],
      rotate:    [0, 0, 0],
      scale:     [1, 1, 1],
    };
    // Pré-remplir a/b avec les deux derniers steps
    if (!meta.isPrim) {
      const prev = this._data.steps;
      if (kind === 'repeat') {
        // Pré-remplir src avec la dernière primitive
        const lastPrim = this._data.steps.filter(s => KIND_META[s.kind]?.isPrim).at(-1);
        step.params.src = lastPrim?.id ?? null;
      } else {
        step.params.a = prev.at(-2)?.id ?? prev.at(-1)?.id ?? null;
        step.params.b = prev.at(-1)?.id ?? null;
      }
    }
    step.visible = true;
    this._data.steps.push(step);
    this._save();
    this._selId = id;
    this._rebuildFrom(id);
    this._renderGrid();
  }

  _removeStep(id) {
    // Supprimer le mesh associé avant de retirer le step
    const old = this._meshes.get(id);
    if (old) { this.engine.scene.remove(old); old.geometry.dispose(); old.material.dispose(); this._meshes.delete(id); }
    this._data.steps = this._data.steps.filter(s => s.id !== id);
    if (this._selId === id) this._selId = this._data.steps.at(-1)?.id ?? null;
    this._save();
    this._rebuildAll();
    this._renderGrid();
  }

  _updateParam(id, key, value) {
    const step = this._data.steps.find(s => s.id === id);
    if (!step) return;
    step.params[key] = value;
    this._save();
    this._rebuildFrom(id);
  }

  _cloneStep() {
    const step = this._data.steps.find(s => s.id === this._selId);
    if (!step) return;
    const newId = 'step-' + Math.random().toString(36).slice(2, 9);
    const clone = {
      ...step,
      id: newId,
      label: (step.label || step.op) + ' (copie)',
      params: { ...step.params },
      visible: true,
    };
    this._data.steps.push(clone);
    this._selId = newId;
    this._save();
    this._rebuildFrom(newId);
    this._renderGrid();
    this._renderEditor();
  }

  _purgeTree(targetId) {
    // Collecter récursivement tous les steps dont dépend targetId
    const deps = new Set();
    const collect = (id) => {
      if (!id || deps.has(id)) return;
      deps.add(id);
      const s = this._data.steps.find(s => s.id === id);
      if (!s) return;
      collect(s.params.a);
      collect(s.params.b);
      collect(s.params.src);
    };
    collect(targetId);

    // Supprimer les meshes des steps qui seront retirés
    for (const s of this._data.steps) {
      if (!deps.has(s.id)) {
        const mesh = this._meshes.get(s.id);
        if (mesh) { this.engine.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); this._meshes.delete(s.id); }
      }
    }

    this._data.steps = this._data.steps.filter(s => deps.has(s.id));
    this._selId = targetId;
    this._save();
    this._renderGrid();
    this._renderEditor();
  }

  _toggleStepVisible(id) {
    const step = this._data.steps.find(s => s.id === id);
    if (!step) return;
    step.visible = !step.visible;
    this._save();
    this._updateMesh(id);
    // Mise à jour ciblée de l'œil dans la grille
    const eye = this._gridWrap?.querySelector(`[data-eye="${id}"]`);
    if (eye) { eye.classList.toggle('off', !step.visible); eye.title = step.visible ? 'Masquer' : 'Afficher'; }
  }

  // ─── UI ─────────────────────────────────────────────────────────────────────

  _setupUI() {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --ml-bg:      #353535;
        --ml-bg2:     #2e2e2e;
        --ml-bg3:     #3a3a3a;
        --ml-border:  #1e1e1e;
        --ml-bevel:   #4a4a4a;
        --ml-accent:  #7aafc8;
        --ml-sel:     #3d5a6e;
        --ml-dim:     #666;
        --ml-text:    #b0b0b0;
        --ml-text2:   #d8d8d8;
        --ml-lw:      160px;
        --ml-rw:      320px;
        --ml-ed-h:    220px;
      }

      /* ── Panneau catalogue gauche ── */
      .ml-left {
        position: fixed; left: 0; top: 0; bottom: 0;
        width: var(--ml-lw);
        background: var(--ml-bg2);
        border-right: 1px solid var(--ml-border);
        box-shadow: inset -1px 0 0 var(--ml-bevel);
        display: flex; flex-direction: column;
        z-index: 50; overflow: hidden;
      }
      .ml-cat-head {
        flex-shrink: 0; height: 36px;
        display: flex; align-items: center; gap: 4px;
        padding: 0 8px;
        background: linear-gradient(to bottom, #404040, #323232);
        border-bottom: 1px solid var(--ml-border);
        box-shadow: 0 1px 0 var(--ml-bevel);
        font: 700 9px sans-serif; color: var(--ml-text);
        text-transform: uppercase; letter-spacing: .1em;
      }
      .ml-cat-head span { flex: 1; }
      .ml-cat-io {
        padding: 3px 7px; border-radius: 2px; cursor: pointer;
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel), 0 1px 2px #0004;
        background: linear-gradient(to bottom, #484848, #383838);
        color: var(--ml-text); font: 700 11px sans-serif;
        line-height: 1;
      }
      .ml-cat-io:active { background: #2a2a2a; box-shadow: inset 0 1px 3px #0006; }
      .ml-cat-list {
        flex: 1; overflow-y: auto; padding: 2px 0;
      }
      .ml-cat-list::-webkit-scrollbar { width: 6px; }
      .ml-cat-list::-webkit-scrollbar-track { background: var(--ml-bg2); }
      .ml-cat-list::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
      .ml-cat-row {
        position: relative; overflow: hidden;
        border-left: 3px solid transparent;
      }
      .ml-cat-row.sel { border-left-color: var(--ml-accent); }
      .ml-cat-item {
        position: relative; z-index: 1;
        padding: 6px 10px; cursor: pointer;
        font: 11px sans-serif; color: var(--ml-text);
        background: var(--ml-bg2);
        touch-action: pan-y;
        user-select: none;
        will-change: transform;
      }
      .ml-cat-row.sel .ml-cat-item { background: var(--ml-sel); color: var(--ml-text2); }
      .ml-cat-load {
        position: absolute; left: 0; top: 0; bottom: 0; width: 64px;
        background: #2a3d2a; color: #88cc88;
        display: flex; align-items: center; justify-content: center;
        font: 700 9px sans-serif; letter-spacing: .04em;
        cursor: pointer;
      }
      .ml-cat-del {
        position: absolute; right: 0; top: 0; bottom: 0; width: 64px;
        background: #4a2020; color: #cc7070;
        display: flex; align-items: center; justify-content: center;
        font: 700 9px sans-serif; letter-spacing: .04em;
        cursor: pointer;
      }
      .ml-cat-empty {
        padding: 12px 10px; font: 10px sans-serif;
        color: var(--ml-dim); text-align: center;
      }

      /* ── Handle gauche ── */
      .ml-handle-left {
        position: fixed; top: 0; bottom: 0; width: 10px; z-index: 61;
        cursor: col-resize; touch-action: none;
        left: calc(var(--ml-lw) - 5px);
      }
      .ml-handle-left::after { content: ''; position: absolute; inset: 0; }
      .ml-handle-left.dragging::after { background: #7aafc830; }

      /* ── Toolbar éditeur ── */
      .ml-ed-toolbar {
        display: flex; gap: 4px; flex-wrap: wrap;
        padding: 6px 8px; border-bottom: 1px solid var(--ml-border);
        background: linear-gradient(to bottom, #3e3e3e, #303030);
        box-shadow: 0 1px 0 var(--ml-bevel);
        flex-shrink: 0;
      }
      .ml-ed-tbtn {
        padding: 3px 9px; border-radius: 2px;
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel), 0 1px 2px #0004;
        background: linear-gradient(to bottom, #484848, #383838);
        cursor: pointer;
        font: 700 9px sans-serif; color: var(--ml-text);
        letter-spacing: .04em;
      }
      .ml-ed-tbtn:active { background: #2a2a2a; box-shadow: inset 0 1px 3px #0006; color: var(--ml-text2); }
      .ml-ed-tbtn.primary { color: var(--ml-accent); border-color: #7aafc866; }

      /* Mini-form export inline */
      .ml-export-form {
        display: flex; gap: 5px; align-items: center;
        padding: 6px 8px; border-bottom: 1px solid var(--ml-border);
        background: var(--ml-bg2); flex-shrink: 0;
      }
      .ml-export-form input {
        flex: 1; min-width: 0; background: #272727; color: var(--ml-text2);
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 3px #0006;
        border-radius: 2px;
        padding: 3px 6px; font: 11px sans-serif;
      }
      .ml-export-form input:focus { outline: none; border-color: var(--ml-accent); }
      .ml-export-form button {
        padding: 3px 9px; border-radius: 2px; cursor: pointer;
        font: 700 9px sans-serif; border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel), 0 1px 2px #0004;
      }
      .ml-export-form .ok  { background: linear-gradient(to bottom, #3a5a3a, #2a4a2a); color: #88cc88; }
      .ml-export-form .nok { background: linear-gradient(to bottom, #484848, #383838); color: var(--ml-dim); }

      /* ── Poignée de redimensionnement ── */
      .ml-handle {
        position: fixed; top: 0; bottom: 0; width: 28px; z-index: 61;
        cursor: col-resize; touch-action: none;
        right: var(--ml-rw);
      }

      /* ── Panneau droit ── */
      .ml-right {
        position: fixed; right: 0; top: 0; bottom: 0;
        width: var(--ml-rw);
        background: var(--ml-bg);
        border-left: 1px solid var(--ml-border);
        box-shadow: inset 1px 0 0 var(--ml-bevel);
        display: flex; flex-direction: column;
        z-index: 50; overflow: hidden;
      }

      /* ── Barre d'ajout ── */
      .ml-addbar {
        display: flex; flex-wrap: wrap; gap: 4px;
        padding: 8px;
        background: linear-gradient(to bottom, #3e3e3e, #323232);
        border-bottom: 1px solid var(--ml-border);
        box-shadow: 0 1px 0 var(--ml-bevel);
        flex-shrink: 0;
      }
      .ml-addbtn {
        padding: 4px 9px; border-radius: 2px;
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel), 0 1px 2px #0004;
        background: linear-gradient(to bottom, #484848, #383838);
        cursor: pointer;
        font: 700 10px sans-serif; letter-spacing: .03em;
      }
      .ml-addbtn:active { background: #2a2a2a; box-shadow: inset 0 1px 3px #0006; }

      /* ── Grille objets ── */
      .ml-grid-wrap {
        flex: 1; overflow: auto;
      }
      .ml-grid-wrap::-webkit-scrollbar { width: 6px; height: 6px; }
      .ml-grid-wrap::-webkit-scrollbar-track { background: var(--ml-bg2); }
      .ml-grid-wrap::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }

      .ml-table {
        border-collapse: collapse;
        min-width: 100%;
        font: 11px sans-serif;
      }

      .ml-layer-eye {
        display: block; cursor: pointer;
        opacity: 1; transition: opacity .12s;
        user-select: none;
      }
      .ml-layer-eye.off { opacity: .3; }

      /* Lignes objets */
      .ml-table tbody tr { cursor: pointer; }
      .ml-table tbody tr.sel { background: var(--ml-sel); }

      .ml-table tbody td {
        border: 1px solid var(--ml-border);
        padding: 3px 4px;
        vertical-align: middle;
        text-align: center;
      }
      .ml-td-obj {
        text-align: left !important;
        padding: 4px 8px !important;
      }

      /* Cellule objet */
      .ml-obj-row { display: flex; align-items: center; gap: 5px; }
      .ml-obj-idx { color: var(--ml-dim); font-size: 9px; min-width: 14px; }
      .ml-obj-icon { font-size: 12px; }
      .ml-obj-label { flex: 1; color: var(--ml-text2); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .ml-obj-params { font: 9px sans-serif; color: var(--ml-dim);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ml-obj-del { color: var(--ml-dim); cursor: pointer;
        font-size: 11px; padding: 0 2px; }
      .ml-obj-purge { color: var(--ml-dim); cursor: pointer;
        font-size: 11px; padding: 0 2px; }

      /* Drag & drop réordonnancement */
      .ml-drag-btn {
        background: none; border: none; cursor: grab; touch-action: none;
        color: var(--ml-dim); font-size: 15px; padding: 0 8px;
        line-height: 1; user-select: none; flex-shrink: 0;
      }
      .ml-drag-btn:active { cursor: grabbing; }
      .ml-table tbody tr.ml-dragging { opacity: .35; }
      .ml-table tbody tr.ml-drop-before td { border-top: 2px solid var(--ml-accent); }
      .ml-table tbody tr.ml-drop-after  td { border-bottom: 2px solid var(--ml-accent); }

      /* ── Barre titre éditeur (séparateur draggable) ── */
      .ml-ed-titlebar {
        flex-shrink: 0; height: 28px;
        border-top: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel);
        background: linear-gradient(to bottom, #3a3a3a, #2e2e2e);
        display: flex; align-items: center; gap: 7px;
        padding: 0 10px;
        cursor: row-resize; touch-action: none;
        user-select: none;
      }
      .ml-ed-titlebar-grip {
        display: flex; flex-direction: column; gap: 2px; flex-shrink: 0;
      }
      .ml-ed-titlebar-grip span {
        display: block; width: 18px; height: 2px; border-radius: 1px;
        background: var(--ml-dim);
      }
      .ml-ed-titlebar-label {
        flex: 1; font: 700 9px sans-serif; color: var(--ml-text);
        text-transform: uppercase; letter-spacing: .1em;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ml-ed-titlebar.dragging .ml-ed-titlebar-grip span { background: var(--ml-accent); }

      /* ── Éditeur de step ── */
      .ml-editor {
        flex-shrink: 0; height: var(--ml-ed-h); overflow-y: auto;
        padding: 10px;
        background: var(--ml-bg2);
        display: flex; flex-direction: column; gap: 8px;
      }
      .ml-editor::-webkit-scrollbar { width: 6px; }
      .ml-editor::-webkit-scrollbar-track { background: var(--ml-bg2); }
      .ml-editor::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
      .ml-ed-row { display: flex; align-items: center; gap: 6px; }
      .ml-ed-key { font: 9px sans-serif; color: var(--ml-dim); min-width: 38px; }
      .ml-ed-input {
        flex: 1; min-width: 0; background: #272727; color: var(--ml-text2);
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 3px #0006;
        border-radius: 2px;
        padding: 3px 4px; font: 11px sans-serif;
      }
      .ml-ed-input:focus { outline: none; border-color: var(--ml-accent); }
      .ml-ed-select {
        flex: 1; background: #272727; color: var(--ml-text2);
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 3px #0006;
        border-radius: 2px;
        padding: 3px 5px; font: 11px sans-serif;
      }
      .ml-ed-nosel {
        font: 11px sans-serif; color: var(--ml-dim);
        text-align: center; padding: 12px 0;
      }

      /* ── Barre statut ── */
      .ml-statusbar {
        position: fixed; top: 0;
        left: var(--ml-lw); right: var(--ml-rw);
        height: 40px; z-index: 40;
        background: linear-gradient(to bottom, #444, #383838);
        border-bottom: 1px solid var(--ml-border);
        box-shadow: 0 1px 0 var(--ml-bevel), 0 2px 6px #0005;
        display: flex; align-items: center;
        padding: 0 14px; gap: 10px;
        font: 10px sans-serif;
      }
      .ml-bar-title {
        color: var(--ml-text2); letter-spacing: .14em;
        text-transform: uppercase; font-weight: 700;
        flex-shrink: 0; margin-right: 6px;
        text-shadow: 0 1px 0 #0006;
      }
      /* ── Paramètres gizmo dans la barre ── */
      .ml-bar-gizmo {
        margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0;
      }
      .ml-bar-gizmo label {
        font: 9px sans-serif; color: var(--ml-text); letter-spacing: .06em;
      }
      .ml-bar-gizmo input {
        width: 46px; background: #272727; color: var(--ml-text2);
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 3px #0006;
        border-radius: 2px;
        padding: 2px 5px; font: 11px sans-serif; text-align: center;
      }
      .ml-bar-gizmo input:focus { outline: none; border-color: var(--ml-accent); }
      .ml-reset-view {
        position: fixed; bottom: 12px; left: calc(var(--ml-lw) + 10px);
        background: linear-gradient(to bottom, #484848, #383838);
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel), 0 2px 4px #0005;
        color: var(--ml-text); font: 700 10px sans-serif; border-radius: 2px;
        padding: 5px 12px; cursor: pointer; letter-spacing: .05em;
        z-index: 60;
      }
      .ml-reset-view:active { background: #2a2a2a; box-shadow: inset 0 1px 3px #0006; }
      .ml-stats {
        position: fixed; bottom: 12px; right: calc(var(--ml-rw) + 10px);
        background: linear-gradient(to bottom, #484848, #383838);
        border: 1px solid var(--ml-border);
        box-shadow: inset 0 1px 0 var(--ml-bevel), 0 2px 4px #0005;
        color: var(--ml-dim); font: 10px sans-serif; border-radius: 2px;
        padding: 4px 10px; z-index: 60; pointer-events: none;
        letter-spacing: .04em;
      }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // Barre de statut
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'ml-statusbar';

    const fsBtn = document.createElement('button');
    fsBtn.textContent = '⛶';
    fsBtn.title = 'Plein écran';
    fsBtn.style.cssText = `
      background: transparent; border: none; color: var(--ml-text);
      font-size: 16px; cursor: pointer; padding: 0 6px 0 0;
      line-height: 1; flex-shrink: 0;
    `;
    const fsEnter = () => {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen)
        ?.call(el);
    };
    const fsExit = () => {
      (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen)
        ?.call(document);
    };
    const fsElement = () =>
      document.fullscreenElement || document.webkitFullscreenElement ||
      document.mozFullScreenElement || document.msFullscreenElement;

    fsBtn.addEventListener('click', () => { fsElement() ? fsExit() : fsEnter(); });

    this._fsAC = new AbortController();
    const onFsChange = () => {
      const active = !!fsElement();
      fsBtn.textContent = active ? '✕' : '⛶';
      fsBtn.title = active ? 'Quitter plein écran' : 'Plein écran';
    };
    const sig = { signal: this._fsAC.signal };
    document.addEventListener('fullscreenchange',       onFsChange, sig);
    document.addEventListener('webkitfullscreenchange', onFsChange, sig);
    document.addEventListener('mozfullscreenchange',    onFsChange, sig);
    this._statusEl.appendChild(fsBtn);

    const barTitle = document.createElement('span');
    barTitle.className = 'ml-bar-title';
    barTitle.textContent = 'Modeler';
    this._statusEl.appendChild(barTitle);

    // Paramètres gizmo — poussés à droite
    const gizmoCtrl = document.createElement('div');
    gizmoCtrl.className = 'ml-bar-gizmo';

    const makeGP = (labelTxt, key, step) => {
      const lbl = document.createElement('label');
      lbl.textContent = labelTxt;
      const inp = document.createElement('input');
      inp.type  = 'number';
      inp.step  = step;
      inp.min   = step;
      inp.value = this._gizmoParams[key];
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (v > 0) {
          this._gizmoParams[key] = v;
          localStorage.setItem('rbang_gizmo', JSON.stringify(this._gizmoParams));
          this._buildWorldGizmo();
        }
      });
      gizmoCtrl.append(lbl, inp);
    };
    makeGP('axes',  'axisLen',   '0.5');
    makeGP('grad',  'gradStep',  '0.1');
    makeGP('ratio', 'gradRatio', '0.01');

    this._statusEl.appendChild(gizmoCtrl);
    document.body.appendChild(this._statusEl);
    this._ui.push(this._statusEl);

    // Bouton reset vue
    const resetViewBtn = document.createElement('button');
    resetViewBtn.className = 'ml-reset-view';
    resetViewBtn.textContent = '⌂ Vue';
    resetViewBtn.title = 'Réinitialiser la caméra';
    resetViewBtn.addEventListener('click', () => {
      const cam = this.engine.camera;
      const tb  = this.engine.controls;
      cam.position.set(3, 2.5, 3);
      tb.target.set(0, 0, 0);
      tb.update();
      this._scheduleRender();
    });
    document.body.appendChild(resetViewBtn);
    this._ui.push(resetViewBtn);

    // Overlay stats maillage
    this._statsEl = document.createElement('div');
    this._statsEl.className = 'ml-stats';
    this._statsEl.textContent = '—';
    document.body.appendChild(this._statsEl);
    this._ui.push(this._statsEl);

    // ── Panneau catalogue gauche ─────────────────────────────────────────────
    const left = document.createElement('div');
    left.className = 'ml-left';
    const catHead = document.createElement('div');
    catHead.className = 'ml-cat-head';
    catHead.innerHTML = '<span>Catalogue</span>';

    const catExport = document.createElement('button');
    catExport.className = 'ml-cat-io'; catExport.title = 'Exporter JSON';
    catExport.textContent = '↓';
    catExport.addEventListener('click', () => this._downloadShapes());

    const catImportInput = document.createElement('input');
    catImportInput.type = 'file'; catImportInput.accept = '.json';
    catImportInput.style.display = 'none';
    catImportInput.addEventListener('change', (e) => this._uploadShapes(e.target.files[0]));

    const catImport = document.createElement('button');
    catImport.className = 'ml-cat-io'; catImport.title = 'Importer JSON';
    catImport.textContent = '↑';
    catImport.addEventListener('click', () => catImportInput.click());

    catHead.append(catExport, catImport, catImportInput);
    left.appendChild(catHead);
    this._catalogListEl = document.createElement('div');
    this._catalogListEl.className = 'ml-cat-list';
    this._catalogListEl.innerHTML = '<div class="ml-cat-empty">Catalogue vide</div>';
    left.appendChild(this._catalogListEl);
    document.body.appendChild(left);
    this._ui.push(left);

    // Handle redimensionnement gauche
    const lh = document.createElement('div');
    lh.className = 'ml-handle-left';
    document.body.appendChild(lh);
    this._ui.push(lh);
    {
      const MIN_LW = 100, MAX_LW = Math.floor(innerWidth * 0.35);
      let lDragging = false, lStartX = 0, lStartW = 0;
      lh.addEventListener('pointerdown', (e) => {
        e.preventDefault(); lh.setPointerCapture(e.pointerId);
        lDragging = true; lStartX = e.clientX; lStartW = this._leftW;
        lh.classList.add('dragging');
      });
      lh.addEventListener('pointermove', (e) => {
        if (!lDragging) return;
        this._leftW = Math.max(MIN_LW, Math.min(MAX_LW, lStartW + (e.clientX - lStartX)));
        this._applyPanelWidth(); this._scheduleRender();
      });
      lh.addEventListener('pointerup',     () => { lDragging = false; lh.classList.remove('dragging'); });
      lh.addEventListener('pointercancel', () => { lDragging = false; lh.classList.remove('dragging'); });
    }

    // Panneau droit
    const right = document.createElement('div');
    right.className = 'ml-right';

    // Barre d'ajout
    const addBar = document.createElement('div');
    addBar.className = 'ml-addbar';
    const BTNS = [
      { kind: 'cube',      label: '⬜ Cube'  },
      { kind: 'sphere',    label: '⬤ Sphère' },
      { kind: 'cylinder',  label: '⬭ Cyl'   },
      { kind: 'cone',      label: '△ Cône'  },
      { kind: 'roundedBox',label: '▢ Round' },
      { kind: 'subtract',  label: '− Soustr' },
      { kind: 'union',     label: '∪ Union'  },
      { kind: 'intersect', label: '∩ Inter'  },
      { kind: 'repeat',    label: '⁂ Répét'  },
    ];
    BTNS.forEach(({ kind, label }) => {
      const btn = document.createElement('button');
      btn.className = 'ml-addbtn';
      btn.textContent = label;
      const km = KIND_META[kind];
      btn.style.color = km.color;
      btn.style.borderColor = km.color + '44';
      btn.addEventListener('click', () => this._addStep(kind));
      addBar.appendChild(btn);
    });
    right.appendChild(addBar);

    // Zone grille
    this._gridWrap = document.createElement('div');
    this._gridWrap.className = 'ml-grid-wrap';
    right.appendChild(this._gridWrap);

    // Barre titre éditeur (draggable)
    this._editorH = 220;
    const edBar = document.createElement('div');
    edBar.className = 'ml-ed-titlebar';
    const grip = document.createElement('div');
    grip.className = 'ml-ed-titlebar-grip';
    grip.innerHTML = '<span></span><span></span><span></span>';
    this._edTitleLabel = document.createElement('div');
    this._edTitleLabel.className = 'ml-ed-titlebar-label';
    this._edTitleLabel.textContent = 'Éditeur';
    edBar.appendChild(grip);
    edBar.appendChild(this._edTitleLabel);
    right.appendChild(edBar);

    // Drag vertical pour redimensionner l'éditeur
    const MIN_ED = 60, MAX_ED = 420;
    let edDragging = false, edStartY = 0, edStartH = 0;
    edBar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      edBar.setPointerCapture(e.pointerId);
      edDragging = true;
      edStartY = e.clientY;
      edStartH = this._editorH;
      edBar.classList.add('dragging');
    });
    edBar.addEventListener('pointermove', (e) => {
      if (!edDragging) return;
      const delta = edStartY - e.clientY;
      this._editorH = Math.max(MIN_ED, Math.min(MAX_ED, edStartH + delta));
      document.documentElement.style.setProperty('--ml-ed-h', this._editorH + 'px');
    });
    edBar.addEventListener('pointerup', () => { edDragging = false; edBar.classList.remove('dragging'); });
    edBar.addEventListener('pointercancel', () => { edDragging = false; edBar.classList.remove('dragging'); });

    // Toolbar éditeur
    this._edToolbarEl = document.createElement('div');
    this._edToolbarEl.className = 'ml-ed-toolbar';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'ml-ed-tbtn primary';
    exportBtn.textContent = '↗ Catalogue';
    exportBtn.addEventListener('click', () => this._showExportForm());
    this._edToolbarEl.appendChild(exportBtn);

    const cloneBtn = document.createElement('button');
    cloneBtn.className = 'ml-ed-tbtn';
    cloneBtn.textContent = '⎘ Cloner';
    cloneBtn.addEventListener('click', () => this._cloneStep());
    this._edToolbarEl.appendChild(cloneBtn);
    right.appendChild(this._edToolbarEl);

    // Éditeur inline
    this._editorEl = document.createElement('div');
    this._editorEl.className = 'ml-editor';
    right.appendChild(this._editorEl);

    document.body.appendChild(right);
    this._ui.push(right);

    // ── Poignée de redimensionnement (identique Forge) ───────────────────────
    this._setupResizeHandle();

    this._applyPanelWidth();
    this._renderGrid();
    this._renderEditor();
  }

  // ─── Redimensionnement ──────────────────────────────────────────────────────

  _applyPanelWidth() {
    document.documentElement.style.setProperty('--ml-lw', this._leftW  + 'px');
    document.documentElement.style.setProperty('--ml-rw', this._rightW + 'px');
    this.engine.resizeViewport(this._leftW, this._rightW);
  }

  _setupResizeHandle() {
    const MIN_PANEL = 180, MAX_PANEL = Math.floor(innerWidth * 0.75);

    const h = document.createElement('div');
    h.className = 'ml-handle';
    document.body.appendChild(h);
    this._ui.push(h);

    let dragging = false, startX = 0, startW = 0;

    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      dragging = true;
      startX = e.clientX;
      startW = this._rightW;
      h.classList.add('dragging');
    });

    h.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      this._rightW = Math.max(MIN_PANEL, Math.min(MAX_PANEL, startW - delta));
      this._applyPanelWidth();
      this._scheduleRender();
    });

    h.addEventListener('pointerup', () => {
      dragging = false;
      h.classList.remove('dragging');
    });

    h.addEventListener('pointercancel', () => {
      dragging = false;
      h.classList.remove('dragging');
    });
  }

  // ─── Catalogue ──────────────────────────────────────────────────────────────

  _shapesStore() {
    try { return JSON.parse(localStorage.getItem('rbang_shapes') || '{}'); } catch { return {}; }
  }
  _shapesSave(store) {
    localStorage.setItem('rbang_shapes', JSON.stringify(store));
  }

  _loadCatalog() {
    this._renderCatalog(Object.keys(this._shapesStore()));
  }

  _renderCatalog(names) {
    const el = this._catalogListEl;
    if (!el) return;
    el.innerHTML = '';
    if (!names.length) {
      el.innerHTML = '<div class="ml-cat-empty">Catalogue vide</div>';
      return;
    }
    for (const name of names) el.appendChild(this._makeCatalogRow(name));
  }

  _makeCatalogRow(name) {
    const SNAP = 64;
    const row  = document.createElement('div');
    row.className = 'ml-cat-row';

    const load = document.createElement('div');
    load.className = 'ml-cat-load';
    load.textContent = '↺ Charger';

    const item = document.createElement('div');
    item.className = 'ml-cat-item';
    item.textContent = name;

    const del = document.createElement('div');
    del.className = 'ml-cat-del';
    del.textContent = '✕ Suppr';

    row.append(load, item, del);

    // open : -1 = delete visible, 0 = fermé, 1 = load visible
    let open = 0, dragging = false, startX = 0;

    const setX = (x, animated) => {
      item.style.transition = animated ? 'transform .18s ease' : 'none';
      item.style.transform  = `translateX(${x}px)`;
    };

    item.addEventListener('pointerdown', (e) => {
      item.setPointerCapture(e.pointerId);
      startX = e.clientX; dragging = false;
    });

    item.addEventListener('pointermove', (e) => {
      const dx = e.clientX - startX;
      if (!dragging && Math.abs(dx) < 8) return;
      dragging = true;
      const base = open * SNAP;
      setX(Math.max(-SNAP, Math.min(SNAP, base + dx)), false);
    });

    item.addEventListener('pointerup', (e) => {
      if (!dragging) {
        if (open !== 0) { setX(0, true); open = 0; }
        else            { this._appendFromCatalog(name); row.classList.add('sel'); }
        return;
      }
      dragging = false;
      const newX = open * SNAP + (e.clientX - startX);
      if      (newX < -(SNAP / 2)) { open = -1; setX(-SNAP, true); }
      else if (newX >  (SNAP / 2)) { open =  1; setX( SNAP, true); }
      else                         { open =  0; setX(0, true); }
    });

    item.addEventListener('pointercancel', () => {
      dragging = false; setX(open * SNAP, true);
    });

    load.addEventListener('click', () => {
      setX(0, true); open = 0;
      this._importFromCatalog(name);
      row.classList.add('sel');
    });
    del.addEventListener('click', () => this._deleteFromCatalog(name, row));

    return row;
  }

  _deleteFromCatalog(name, rowEl) {
    const store = this._shapesStore();
    delete store[name];
    this._shapesSave(store);
    rowEl.remove();
    if (!this._catalogListEl.querySelector('.ml-cat-row'))
      this._catalogListEl.innerHTML = '<div class="ml-cat-empty">Catalogue vide</div>';
  }

  _remapSteps(data, name) {
    const idMap = new Map();
    for (const s of data.steps) {
      idMap.set(s.id, 'step-' + Math.random().toString(36).slice(2, 9));
    }
    const remapId = id => idMap.get(id) ?? id;
    const newRootId = remapId(data.rootId);
    const imported = data.steps.map(s => ({
      ...s,
      id:     idMap.get(s.id),
      label:  s.label || name,
      params: {
        ...s.params,
        a:   s.params.a   ? remapId(s.params.a)   : s.params.a,
        b:   s.params.b   ? remapId(s.params.b)   : s.params.b,
        src: s.params.src ? remapId(s.params.src) : s.params.src,
      },
      visible: idMap.get(s.id) === newRootId,
    }));
    return { imported, newRootId };
  }

  async _importFromCatalog(name) {
    try {
      const data = this._shapesStore()[name];
      if (!data?.steps || !data.rootId) { this._setStatus('Format incompatible'); return; }

      const { imported, newRootId } = this._remapSteps(data, name);
      this._clearMeshes();
      this._data.steps = imported;
      this._selId = newRootId;
      this._save();
      await this._rebuildAll();
      this._renderGrid();
      this._renderEditor();

      // Mettre en surbrillance l'item du catalogue
      this._catalogListEl?.querySelectorAll('.ml-cat-item').forEach(el => {
        el.classList.toggle('sel', el.textContent === name);
      });
    } catch (e) {
      this._setStatus('Erreur import : ' + e.message);
    }
  }

  async _appendFromCatalog(name) {
    try {
      const data = this._shapesStore()[name];
      if (!data?.steps || !data.rootId) { this._setStatus('Format incompatible'); return; }

      const { imported, newRootId } = this._remapSteps(data, name);
      this._data.steps.push(...imported);
      this._selId = newRootId;
      this._save();
      await this._rebuildAll();
      this._renderGrid();
      this._renderEditor();
    } catch (e) {
      this._setStatus('Erreur import : ' + e.message);
    }
  }

  _showExportForm() {
    const step = this._data.steps.find(s => s.id === this._selId);
    if (!step) { this._setStatus('Sélectionne un objet'); return; }

    // Si déjà ouvert, fermer
    const existing = this._edToolbarEl?.querySelector('.ml-export-form');
    if (existing) { existing.remove(); return; }

    const form = document.createElement('div');
    form.className = 'ml-export-form';

    const input = document.createElement('input');
    input.type  = 'text';
    input.value = step.label || step.kind;
    input.placeholder = 'Nom dans le catalogue';

    const ok = document.createElement('button');
    ok.className = 'ok'; ok.textContent = '✓';

    const cancel = document.createElement('button');
    cancel.className = 'nok'; cancel.textContent = '✕';

    form.append(input, ok, cancel);
    this._edToolbarEl.appendChild(form);
    input.focus();

    const doExport = async () => {
      const name = input.value.trim();
      if (!name) return;
      form.remove();
      await this._exportToBank(name, step.id);
    };

    ok.addEventListener('click', doExport);
    cancel.addEventListener('click', () => form.remove());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doExport(); if (e.key === 'Escape') form.remove(); });
  }

  async _exportToBank(name, rootId) {
    // 1. Purger la scène — ne garder que l'arbre du step racine
    this._purgeTree(rootId);
    this._renderGrid();
    this._renderEditor();

    // 2. Sauvegarder le tree propre
    const payload = {
      type:      'modeler-shape',
      name,
      rootId,
      steps:     this._data.steps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      const store = this._shapesStore();
      store[name] = payload;
      this._shapesSave(store);
      this._setStatus(`↗ "${name}" exporté`);
      this._addToCatalogList(name);
    } catch (e) {
      this._setStatus('Erreur export : ' + e.message);
    }
  }

  _downloadShapes() {
    const store = this._shapesStore();
    const blob  = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rbang-shapes.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _uploadShapes(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const incoming = JSON.parse(e.target.result);
        if (typeof incoming !== 'object') throw new Error();
        const store = { ...this._shapesStore(), ...incoming };
        this._shapesSave(store);
        this._renderCatalog(Object.keys(store));
        this._setStatus(`↑ ${Object.keys(incoming).length} forme(s) importée(s)`);
      } catch {
        this._setStatus('Fichier invalide');
      }
    };
    reader.readAsText(file);
  }

  _addToCatalogList(name) {
    if (!this._catalogListEl) return;
    const empty = this._catalogListEl.querySelector('.ml-cat-empty');
    if (empty) empty.remove();
    // Éviter les doublons
    const exists = [...this._catalogListEl.querySelectorAll('.ml-cat-item')]
      .some(el => el.textContent === name);
    if (exists) return;
    this._catalogListEl.appendChild(this._makeCatalogRow(name));
  }

  // ─── Grille ─────────────────────────────────────────────────────────────────

  _renderGrid() {
    const { steps } = this._data;
    const wrap = this._gridWrap;
    wrap.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'ml-table';

    // ── Corps (pas d'en-tête nécessaire) ──
    const tbody = document.createElement('tbody');

    // État local du drag (réinitialisé à chaque render)
    let dragId = null; // id de l'étape en cours de drag
    let beforeId = null; // id de l'étape devant laquelle on va insérer (null = fin)

    const clearDropMarkers = () => {
      for (const tr of tbody.querySelectorAll('tr')) {
        tr.classList.remove('ml-drop-before', 'ml-drop-after');
      }
    };

    steps.forEach((step, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.stepId = step.id;
      tr.style.cursor = 'grab';
      if (step.id === this._selId) tr.classList.add('sel');

      // Cellule œil
      const tdEye = document.createElement('td');
      tdEye.style.cssText = 'width:28px;text-align:center;padding:0 4px;';
      const eye = document.createElement('span');
      eye.className = 'ml-layer-eye' + (step.visible ? '' : ' off');
      eye.dataset.eye = step.id;
      eye.textContent = '👁';
      eye.title = step.visible ? 'Masquer' : 'Afficher';
      eye.style.fontSize = '13px';
      eye.addEventListener('click', e => { e.stopPropagation(); this._toggleStepVisible(step.id); });
      tdEye.appendChild(eye);
      tr.appendChild(tdEye);

      // Cellule objet
      const tdObj = document.createElement('td');
      tdObj.className = 'ml-td-obj';
      const km = KIND_META[step.kind] || {};
      const paramStr = this._paramsShort(step);
      const isLast = idx === steps.length - 1;
      tdObj.innerHTML = `
        <div class="ml-obj-row">
          <span class="ml-obj-idx">${idx + 1}</span>
          <span class="ml-obj-icon" style="color:${km.color}">${km.icon}</span>
          <button class="ml-drag-btn" title="Réordonner">⠿</button>
          <span class="ml-obj-label">${step.label}</span>
          ${isLast ? `<span class="ml-obj-purge" title="Purifier l'arbre">⌥</span>` : ''}
          <span class="ml-obj-del" title="Supprimer">✕</span>
        </div>
        ${paramStr ? `<div class="ml-obj-params">${paramStr}</div>` : ''}
      `;
      tdObj.querySelector('.ml-obj-del').addEventListener('click', e => {
        e.stopPropagation(); this._removeStep(step.id);
      });
      if (isLast) {
        tdObj.querySelector('.ml-obj-purge').addEventListener('click', e => {
          e.stopPropagation(); this._purgeTree(step.id);
        });
      }
      tr.appendChild(tdObj);

      tr.addEventListener('click', () => {
        const prev = this._selId;
        this._selId = step.id;
        if (prev && this._meshes.has(prev)) this._meshes.get(prev).material.color.setHex(0x3366cc);
        if (this._meshes.has(step.id)) this._meshes.get(step.id).material.color.setHex(0x4488ff);
        this._scheduleRender();
        this._renderGrid();
        this._renderEditor();
      });

      // ── Drag via le bouton poignée ────────────────────────────────────────
      const dragBtn = tdObj.querySelector('.ml-drag-btn');
      dragBtn.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        dragBtn.setPointerCapture(e.pointerId);
        dragId   = step.id;
        beforeId = null;
        tr.classList.add('ml-dragging');

        const onMove = ev => {
          clearDropMarkers();
          const y    = ev.clientY;
          const rows = [...tbody.querySelectorAll('tr:not(.ml-dragging)')];
          let found  = false;
          for (const row of rows) {
            const rect = row.getBoundingClientRect();
            if (y < rect.top + rect.height / 2) {
              row.classList.add('ml-drop-before');
              beforeId = row.dataset.stepId;
              found    = true;
              break;
            }
          }
          if (!found) {
            rows.at(-1)?.classList.add('ml-drop-after');
            beforeId = null;
          }
        };

        const commit = () => {
          dragBtn.removeEventListener('pointermove',   onMove);
          dragBtn.removeEventListener('pointerup',     commit);
          dragBtn.removeEventListener('pointercancel', cancel);
          tr.classList.remove('ml-dragging');
          clearDropMarkers();
          dragId = null;
          const target = beforeId;
          beforeId = null;
          const arr  = this._data.steps;
          const from = arr.findIndex(s => s.id === step.id);
          if (from === -1) return;
          const [moved] = arr.splice(from, 1);
          if (target === null) {
            arr.push(moved);
          } else {
            const to = arr.findIndex(s => s.id === target);
            arr.splice(to === -1 ? arr.length : to, 0, moved);
          }
          this._save();
          this._rebuildAll().then(() => { this._renderGrid(); this._renderEditor(); });
        };

        const cancel = () => {
          dragBtn.removeEventListener('pointermove',   onMove);
          dragBtn.removeEventListener('pointerup',     commit);
          dragBtn.removeEventListener('pointercancel', cancel);
          tr.classList.remove('ml-dragging');
          clearDropMarkers();
          dragId = null;
          this._renderGrid();
        };

        dragBtn.addEventListener('pointermove',   onMove);
        dragBtn.addEventListener('pointerup',     commit);
        dragBtn.addEventListener('pointercancel', cancel);
      });

      tbody.appendChild(tr);
    });

    if (!steps.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2;
      td.style.cssText = 'color:#1e2e3e;font:10px monospace;text-align:center;padding:20px;';
      td.textContent = 'Ajoute un objet avec les boutons ci-dessus';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  _paramsShort(step) {
    const p = step.params;
    switch (step.kind) {
      case 'cube':      return `${p.x}×${p.y}×${p.z}`;
      case 'sphere':    return `r ${p.r}`;
      case 'cylinder':  return `r ${p.r}  h ${p.h}`;
      case 'cone':        return `r ${p.r}  h ${p.h}`;
      case 'roundedBox':  return `${p.x}×${p.y}×${p.z}  r ${p.r}`;
      case 'subtract':
      case 'union':
      case 'intersect': {
        const ai = this._data.steps.findIndex(s => s.id === p.a) + 1;
        const bi = this._data.steps.findIndex(s => s.id === p.b) + 1;
        return ai && bi ? `①${ai} − ①${bi}`.replace('−', KIND_META[step.kind].icon) : '—';
      }
      case 'repeat':
        return `${p.n ?? 1}×  (${p.dx ?? 0}, ${p.dy ?? 0}, ${p.dz ?? 0})`;
      default: return '';
    }
  }

  // ─── Éditeur ────────────────────────────────────────────────────────────────

  _renderEditor() {
    const el = this._editorEl;
    el.innerHTML = '';

    const step = this._data.steps.find(s => s.id === this._selId);
    if (!step) {
      if (this._edTitleLabel) { this._edTitleLabel.textContent = 'Éditeur'; this._edTitleLabel.style.color = ''; }
      el.innerHTML = '<div class="ml-ed-nosel">Sélectionne un objet</div>';
      return;
    }

    const km = KIND_META[step.kind] || {};
    if (this._edTitleLabel) {
      this._edTitleLabel.textContent = `${km.icon}  ${km.label ?? step.kind}`;
      this._edTitleLabel.style.color = km.color ?? '';
    }

    // Label
    this._edRow(el, 'nom', 'text', step.label, val => {
      step.label = val; this._save(); this._renderGrid();
    });

    const p = step.params;
    const km2 = KIND_META[step.kind];

    if (km2.isPrim) {
      // Params numériques
      const PARAM_KEYS = {
        cube:     [['x','X'], ['y','Y'], ['z','Z']],
        sphere:   [['r','Rayon'], ['segs','Segments']],
        cylinder: [['r','Rayon'], ['h','Hauteur'], ['segs','Segments']],
        cone:       [['r','Rayon'], ['h','Hauteur'], ['segs','Segments']],
        roundedBox: [['x','X'], ['y','Y'], ['z','Z'], ['r','Rayon coin'], ['segs','Segments']],
      };
      for (const [key, label] of (PARAM_KEYS[step.kind] || [])) {
        this._edRow(el, label, 'number', p[key], val => {
          this._updateParam(step.id, key, val);
        });
      }
    } else if (step.kind === 'repeat') {
      const others = this._data.steps.filter(s => s.id !== step.id);
      this._edRowSelect(el, 'Source', others, p.src, val => {
        this._updateParam(step.id, 'src', val);
      });
      this._edSep(el);
      this._edRow(el, 'N', 'number', p.n ?? 3, val => this._updateParam(step.id, 'n', val));
      this._edRow(el, 'dx', 'number', p.dx ?? 0, val => this._updateParam(step.id, 'dx', val));
      this._edRow(el, 'dy', 'number', p.dy ?? 0, val => this._updateParam(step.id, 'dy', val));
      this._edRow(el, 'dz', 'number', p.dz ?? 0, val => this._updateParam(step.id, 'dz', val));
    } else {
      // Sélecteurs a / b
      const prevSteps = this._data.steps.filter(s => s.id !== step.id);
      for (const [key, label] of [['a', 'Objet A'], ['b', 'Objet B']]) {
        this._edRowSelect(el, label, prevSteps, p[key], val => {
          this._updateParam(step.id, key, val);
        });
      }
    }

    // ── Transformations ──────────────────────────────────────────────────────
    this._edSep(el);
    const tr = step.translate ?? [0, 0, 0];
    const ro = step.rotate    ?? [0, 0, 0];
    const sc = step.scale     ?? [1, 1, 1];

    this._edVec3(el, 'pos', tr, (i, v) => {
      if (!step.translate) step.translate = [0, 0, 0];
      step.translate[i] = v;
      this._save();
      this._rebuildFrom(step.id);
    });
    this._edVec3(el, 'rot °', ro, (i, v) => {
      if (!step.rotate) step.rotate = [0, 0, 0];
      step.rotate[i] = v;
      this._save();
      this._rebuildFrom(step.id);
    });
    this._edVec3(el, 'scale', sc, (i, v) => {
      if (!step.scale) step.scale = [1, 1, 1];
      step.scale[i] = v;
      this._save();
      this._rebuildFrom(step.id);
    });
  }

  _edRepeatAxis(container, axis, color, count, spacing, onChange) {
    const row = document.createElement('div');
    row.className = 'ml-ed-row';
    const lbl = document.createElement('span');
    lbl.className = 'ml-ed-key';
    lbl.textContent = axis;
    lbl.style.color = color;

    const inpN = document.createElement('input');
    inpN.className = 'ml-ed-input';
    inpN.type = 'number'; inpN.min = '1'; inpN.step = '1';
    inpN.value = count ?? 1;
    inpN.title = 'Nombre';
    inpN.style.cssText = `border-left:2px solid ${color};padding-left:4px;`;

    const inpD = document.createElement('input');
    inpD.className = 'ml-ed-input';
    inpD.type = 'number'; inpD.step = 'any';
    inpD.value = spacing ?? 0;
    inpD.title = 'Espacement';

    const fire = () => onChange(Math.max(1, parseInt(inpN.value) || 1), parseFloat(inpD.value) || 0);
    inpN.addEventListener('change', fire);
    inpD.addEventListener('change', fire);

    row.append(lbl, inpN, inpD);
    container.appendChild(row);
  }

  _edSep(container) {
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #0e0e1e;margin:2px 0;';
    container.appendChild(sep);
  }

  _edVec3(container, label, vec, onChange) {
    const row = document.createElement('div');
    row.className = 'ml-ed-row';
    const lbl = document.createElement('span');
    lbl.className = 'ml-ed-key';
    lbl.textContent = label;
    row.appendChild(lbl);

    const COLORS = ['#cc4444', '#44cc44', '#4488ff'];
    const AXES   = ['X', 'Y', 'Z'];
    AXES.forEach((axis, i) => {
      const inp = document.createElement('input');
      inp.className = 'ml-ed-input';
      inp.type  = 'number';
      inp.step  = 'any';
      inp.value = vec[i] ?? 0;
      inp.title = axis;
      inp.style.borderLeft = `2px solid ${COLORS[i]}`;
      inp.style.paddingLeft = '4px';
      inp.addEventListener('change', () => onChange(i, parseFloat(inp.value) || 0));
      row.appendChild(inp);
    });
    container.appendChild(row);
  }

  _edRow(container, label, type, value, onChange) {
    const row = document.createElement('div');
    row.className = 'ml-ed-row';
    const lbl = document.createElement('span');
    lbl.className = 'ml-ed-key';
    lbl.textContent = label;
    const inp = document.createElement('input');
    inp.className = 'ml-ed-input';
    inp.type = type;
    inp.value = value ?? '';
    if (type === 'number') { inp.step = 'any'; }
    inp.addEventListener('change', () => {
      onChange(type === 'number' ? parseFloat(inp.value) : inp.value);
    });
    row.append(lbl, inp);
    container.appendChild(row);
  }

  _edRowSelect(container, label, steps, currentId, onChange) {
    const row = document.createElement('div');
    row.className = 'ml-ed-row';
    const lbl = document.createElement('span');
    lbl.className = 'ml-ed-key';
    lbl.textContent = label;
    const sel = document.createElement('select');
    sel.className = 'ml-ed-select';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '—';
    sel.appendChild(none);
    steps.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${i + 1}. ${s.label}`;
      if (s.id === currentId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value || null));
    row.append(lbl, sel);
    container.appendChild(row);
  }

  _setStatus(msg) {
    // kept for Manifold loading message — modifies title only
    const titleEl = this._statusEl?.querySelector('.ml-bar-title');
    if (titleEl) titleEl.textContent = msg || 'Modeler';
  }

  _updateStatsOverlay(numFaces, numVerts) {
    if (!this._statsEl) return;
    this._statsEl.textContent = `${numFaces.toLocaleString()} f  ${numVerts.toLocaleString()} v`;
  }
}
