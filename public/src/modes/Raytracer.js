import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }     from 'three/addons/loaders/GLTFLoader.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

const CFG_KEY = 'rbang_raytracer_cfg';
const CFG_DEFAULTS = {
  bgColor:    '#1a1a2e',
  exposure:   1.0,
  bounces:    5,
  tilesX:     2,
  tilesY:     2,
};

/* États du rendu */
const RT_IDLE    = 'idle';     // pas encore lancé ou arrêté
const RT_RUNNING = 'running';  // accumulation en cours
const RT_PAUSED  = 'paused';   // accumulation suspendue (samples conservés)

function loadCfg() {
  try { return { ...CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY)) }; }
  catch { return { ...CFG_DEFAULTS }; }
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

export class Raytracer {

  constructor(engine) {
    this._engine    = engine;
    this._cfg       = loadCfg();
    this._renderer  = null;
    this._scene     = null;
    this._camera    = null;
    this._controls  = null;
    this._pathTracer = null;
    this._state     = RT_IDLE;
    this._samples   = 0;
    this._startTime = 0;
    this._elapsed   = 0;       // temps cumulé (pause-aware)
    this._raf       = 0;
    this._ui        = null;
  }

  /* ── public API ── */

  async start() {
    if (this._engine?.renderer?.domElement) {
      this._engine.renderer.domElement.style.display = 'none';
    }
    if (this._engine?._running) {
      this._engine._running = false;
    }
    this._initThree();
    this._initScene();
    this._initPathTracer();
    this._buildUI();
    // rendu preview standard (pas de pathtracing)
    this._renderPreview();
  }

  stop() {
    this._state = RT_IDLE;
    cancelAnimationFrame(this._raf);
    if (this._controls) this._controls.dispose();
    if (this._renderer) this._renderer.dispose();
    if (this._pathTracer) this._pathTracer.dispose();
    if (this._ui) this._ui.remove();
    const c = document.querySelector('#rt-canvas');
    if (c) c.remove();
  }

  /* ── Three.js base ── */

  _initThree() {
    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = this._cfg.exposure;
    this._renderer.setSize(window.innerWidth, window.innerHeight);
    this._renderer.setPixelRatio(1);
    this._renderer.domElement.id = 'rt-canvas';
    this._renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:0;';
    document.body.appendChild(this._renderer.domElement);

    this._camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
    this._camera.position.set(3, 2, 3);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.addEventListener('change', () => {
      if (this._state === RT_IDLE) this._renderPreview();
      if (this._state === RT_PAUSED) this._renderPreview();
      // en running, le reset d'accumulation suffit
      if (this._state === RT_RUNNING) this._resetAccumulation();
    });

    window.addEventListener('resize', () => {
      this._camera.aspect = window.innerWidth / window.innerHeight;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(window.innerWidth, window.innerHeight);
      if (this._state === RT_RUNNING) {
        this._pathTracer.updateCamera();
        this._resetAccumulation();
      } else {
        this._renderPreview();
      }
    });
  }

  _initScene() {
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(this._cfg.bgColor);
    this._scene.environment = null;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 })
    );
    floor.rotation.x = -Math.PI / 2;
    this._scene.add(floor);

    const ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this._scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 2.0);
    dir.position.set(5, 8, 3);
    this._scene.add(dir);

    const fill = new THREE.DirectionalLight(0xaaccff, 0.8);
    fill.position.set(-3, 4, -2);
    this._scene.add(fill);

  }

  /* ── Rendu preview (Three.js standard, pas de pathtracing) ── */

  _renderPreview() {
    this._camera.updateMatrixWorld();
    this._renderer.render(this._scene, this._camera);
  }

  /* ── Path tracer ── */

  _initPathTracer() {
    this._pathTracer = new WebGLPathTracer(this._renderer);
    this._pathTracer.tiles.set(this._cfg.tilesX, this._cfg.tilesY);
    this._pathTracer.bounces = this._cfg.bounces;
    this._pathTracer.renderDelay = 50;
    this._pathTracer.setScene(this._scene, this._camera);
  }

  _resetAccumulation() {
    if (this._pathTracer) {
      this._pathTracer.updateCamera();
      this._samples   = 0;
      this._elapsed   = 0;
      this._startTime = performance.now();
    }
  }

  /* ── Contrôle du rendu ── */

  _startRender() {
    if (this._state === RT_RUNNING) return;
    if (this._state === RT_IDLE) {
      // premier lancement ou après stop → reset complet
      this._pathTracer.setScene(this._scene, this._camera);
      this._resetAccumulation();
    }
    if (this._state === RT_PAUSED) {
      // reprise → on repart du temps accumulé
      this._startTime = performance.now() - this._elapsed * 1000;
    }
    this._state = RT_RUNNING;
    this._updateButtons();
    this._tick();
  }

  _pauseRender() {
    if (this._state !== RT_RUNNING) return;
    this._state = RT_PAUSED;
    cancelAnimationFrame(this._raf);
    this._elapsed = (performance.now() - this._startTime) / 1000;
    this._updateButtons();
  }

  _stopRender() {
    if (this._state === RT_IDLE) return;
    cancelAnimationFrame(this._raf);
    this._state   = RT_IDLE;
    this._samples = 0;
    this._elapsed = 0;
    this._updateButtons();
    this._updateHUD();
    // revenir au rendu preview
    this._renderPreview();
  }

  _tick() {
    if (this._state !== RT_RUNNING) return;
    this._raf = requestAnimationFrame(() => this._tick());
    this._camera.updateMatrixWorld();
    this._pathTracer.renderSample();
    this._samples = this._pathTracer.samples;
    this._updateHUD();
  }

  /* ── Import GLB ── */

  async _importGLB() {
    const wasRunning = this._state === RT_RUNNING;
    if (wasRunning) this._pauseRender();

    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.glb,.gltf';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const loader = new GLTFLoader();
      try {
        const gltf = await loader.loadAsync(url);
        const model = gltf.scene;

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2 / maxDim;
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));
        model.position.y += (size.y * scale) / 2;

        this._scene.add(model);
        // scène modifiée → retour idle, preview
        this._stopRender();
        this._pathTracer.setScene(this._scene, this._camera);
        this._renderPreview();
      } catch (e) {
        console.error('[Raytracer] GLB load error:', e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    input.click();
  }

  /* ── Export PNG ── */

  _capture() {
    const link = document.createElement('a');
    link.download = `rbang-render-${this._samples}spp.png`;
    link.href = this._renderer.domElement.toDataURL('image/png');
    link.click();
  }

  /* ── UI ── */

  _buildUI() {
    const ui = document.createElement('div');
    ui.id = 'rt-ui';
    ui.style.cssText = `
      position:fixed; top:12px; left:12px; z-index:10;
      font-family:'Segoe UI',system-ui,sans-serif;
      color:#fff; pointer-events:none;
    `;
    ui.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;pointer-events:auto;">
        <button id="rt-play"    class="rt-btn rt-render">▶ Rendre</button>
        <button id="rt-pause"   class="rt-btn" disabled>⏸ Pause</button>
        <button id="rt-stop"    class="rt-btn" disabled>⏹ Stop</button>
        <span style="width:4px"></span>
        <button id="rt-import"  class="rt-btn">📂 GLB</button>
        <button id="rt-capture" class="rt-btn">📷</button>
        <button id="rt-cfg"     class="rt-btn">⚙</button>
        <button id="rt-quit"    class="rt-btn rt-quit">✕</button>
      </div>
      <div id="rt-hud" style="
        margin-top:8px; padding:6px 10px;
        background:rgba(0,0,0,0.5); border-radius:6px;
        font-size:0.85rem; font-variant-numeric:tabular-nums;
      ">Prêt</div>
      <div id="rt-config-panel" style="
        display:none; margin-top:8px; padding:12px;
        background:rgba(10,10,20,0.85); border-radius:8px;
        font-size:0.85rem; pointer-events:auto;
        max-width:280px;
      "></div>
    `;
    document.body.appendChild(ui);
    this._ui = ui;

    const style = document.createElement('style');
    style.textContent = `
      .rt-btn {
        padding:8px 14px; border:1px solid #334; border-radius:8px;
        background:rgba(10,10,20,0.7); color:#fff;
        font-size:0.9rem; cursor:pointer;
        transition:background 0.2s, opacity 0.2s;
      }
      .rt-btn:active { background:rgba(0,170,255,0.3); }
      .rt-btn:disabled { opacity:0.3; cursor:default; }
      .rt-btn.rt-render { border-color:#0a5; color:#6f8; }
      .rt-btn.rt-render:active { background:rgba(0,170,80,0.3); }
      .rt-quit { border-color:#a33; color:#f88; }
    `;
    document.head.appendChild(style);

    // render controls
    ui.querySelector('#rt-play').addEventListener('click', () => this._startRender());
    ui.querySelector('#rt-pause').addEventListener('click', () => this._pauseRender());
    ui.querySelector('#rt-stop').addEventListener('click', () => this._stopRender());

    // autres
    ui.querySelector('#rt-import').addEventListener('click', () => this._importGLB());
    ui.querySelector('#rt-capture').addEventListener('click', () => this._capture());
    ui.querySelector('#rt-cfg').addEventListener('click', () => this._toggleConfig());
    ui.querySelector('#rt-quit').addEventListener('click', () => this._quit());

    this._btnPlay  = ui.querySelector('#rt-play');
    this._btnPause = ui.querySelector('#rt-pause');
    this._btnStop  = ui.querySelector('#rt-stop');
    this._hudEl    = ui.querySelector('#rt-hud');
    this._cfgPanel = ui.querySelector('#rt-config-panel');
    this._buildConfigPanel();
  }

  _updateButtons() {
    const play  = this._btnPlay;
    const pause = this._btnPause;
    const stop  = this._btnStop;
    switch (this._state) {
      case RT_IDLE:
        play.disabled  = false; play.textContent = '▶ Rendre';
        pause.disabled = true;
        stop.disabled  = true;
        break;
      case RT_RUNNING:
        play.disabled  = true;
        pause.disabled = false;
        stop.disabled  = false;
        break;
      case RT_PAUSED:
        play.disabled  = false; play.textContent = '▶ Reprendre';
        pause.disabled = true;
        stop.disabled  = false;
        break;
    }
  }

  _updateHUD() {
    if (!this._hudEl) return;
    if (this._state === RT_IDLE && this._samples === 0) {
      this._hudEl.textContent = 'Prêt';
      return;
    }
    const elapsed = this._state === RT_PAUSED
      ? this._elapsed.toFixed(1)
      : ((performance.now() - this._startTime) / 1000).toFixed(1);
    const label = this._state === RT_PAUSED ? ' ⏸' : '';
    this._hudEl.textContent = `${this._samples} spp · ${elapsed}s${label}`;
  }

  _toggleConfig() {
    const p = this._cfgPanel;
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }

  _buildConfigPanel() {
    const p = this._cfgPanel;
    p.innerHTML = `
      <label style="display:block;margin-bottom:8px">
        Fond <input type="color" id="rtc-bg" value="${this._cfg.bgColor}"
        style="vertical-align:middle;margin-left:6px;">
      </label>
      <label style="display:block;margin-bottom:8px">
        Exposition
        <input type="range" id="rtc-exposure" min="0.1" max="5" step="0.1"
        value="${this._cfg.exposure}" style="width:100%;">
      </label>
      <label style="display:block;margin-bottom:8px">
        Rebonds
        <input type="range" id="rtc-bounces" min="1" max="20" step="1"
        value="${this._cfg.bounces}" style="width:100%;">
        <span id="rtc-bounces-val">${this._cfg.bounces}</span>
      </label>
      <label style="display:block;margin-bottom:8px">
        Tiles
        <input type="range" id="rtc-tiles" min="1" max="6" step="1"
        value="${this._cfg.tilesX}" style="width:100%;">
        <span id="rtc-tiles-val">${this._cfg.tilesX}×${this._cfg.tilesX}</span>
      </label>
    `;

    p.querySelector('#rtc-bg').addEventListener('input', e => {
      this._cfg.bgColor = e.target.value;
      this._scene.background = new THREE.Color(e.target.value);
      if (this._state === RT_IDLE || this._state === RT_PAUSED) this._renderPreview();
      if (this._state === RT_RUNNING) {
        this._pathTracer.setScene(this._scene, this._camera);
        this._resetAccumulation();
      }
      saveCfg(this._cfg);
    });

    p.querySelector('#rtc-exposure').addEventListener('input', e => {
      this._cfg.exposure = parseFloat(e.target.value);
      this._renderer.toneMappingExposure = this._cfg.exposure;
      if (this._state === RT_IDLE || this._state === RT_PAUSED) this._renderPreview();
      if (this._state === RT_RUNNING) this._resetAccumulation();
      saveCfg(this._cfg);
    });

    p.querySelector('#rtc-bounces').addEventListener('input', e => {
      this._cfg.bounces = parseInt(e.target.value);
      p.querySelector('#rtc-bounces-val').textContent = this._cfg.bounces;
      this._pathTracer.bounces = this._cfg.bounces;
      if (this._state === RT_RUNNING) this._resetAccumulation();
      saveCfg(this._cfg);
    });

    p.querySelector('#rtc-tiles').addEventListener('input', e => {
      const v = parseInt(e.target.value);
      this._cfg.tilesX = v; this._cfg.tilesY = v;
      p.querySelector('#rtc-tiles-val').textContent = `${v}×${v}`;
      this._pathTracer.tiles.set(v, v);
      if (this._state === RT_RUNNING) this._resetAccumulation();
      saveCfg(this._cfg);
    });
  }

  /* ── Quitter ── */

  _quit() {
    this.stop();
    location.reload();
  }
}
