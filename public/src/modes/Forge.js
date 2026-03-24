import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import * as dynamics from '../dynamics.js';

const SCALE = 0.008;

// ─── Géométrie depuis JSON ────────────────────────────────────────────────────

function buildGeometry(obj, highlightSurfaces = null) {
  const verts = obj.vertices;
  const tris  = obj.triangles;
  const normalTris = [], hlTris = [];

  if (highlightSurfaces?.length) {
    const hlSet = new Set();
    for (const si of highlightSurfaces) {
      obj.surfaces[si]?.triangleset.forEach(ti => hlSet.add(ti));
    }
    tris.forEach((t, i) => (hlSet.has(i) ? hlTris : normalTris).push(t));
  } else {
    tris.forEach(t => normalTris.push(t));
  }

  function buf(list) {
    const pos = new Float32Array(list.length * 9);
    const nm  = new Float32Array(list.length * 9);
    list.forEach((t, i) => {
      const v0=verts[t['0']], v1=verts[t['1']], v2=verts[t['2']];
      const ax=v0['0']*SCALE,ay=v0['1']*SCALE,az=v0['2']*SCALE;
      const bx=v1['0']*SCALE,by=v1['1']*SCALE,bz=v1['2']*SCALE;
      const cx=v2['0']*SCALE,cy=v2['1']*SCALE,cz=v2['2']*SCALE;
      pos.set([ax,ay,az,bx,by,bz,cx,cy,cz], i*9);
      const ux=bx-ax,uy=by-ay,uz=bz-az,vx=cx-ax,vy=cy-ay,vz=cz-az;
      const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
      const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
      for(let k=0;k<3;k++) nm.set([nx/nl,ny/nl,nz/nl], i*9+k*3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos,3));
    g.setAttribute('normal',   new THREE.BufferAttribute(nm,3));
    return g;
  }

  return { normalGeo: buf(normalTris), highlightGeo: hlTris.length ? buf(hlTris) : null };
}

// ─── Mode Forge ───────────────────────────────────────────────────────────────

export class Forge {

  constructor(engine) {
    this.engine        = engine;
    this._ui           = [];
    this._bankList     = [];
    this._brickData    = null;
    this._brickName    = null;
    this._meshGroup    = null;
    this._slotMarkers  = [];
    this._selectedIdx  = null;
    this._dirtyBrick   = false;
    this._dirtyDyn     = false;
    this._raycaster    = new THREE.Raycaster();
    this._mouse        = new THREE.Vector2(-9999, -9999);
    this._activeTab    = 'brick'; // 'brick' | 'slots' | 'meca'
    this._mecaSubTab   = 'slots'; // 'slots' | 'liaisons'
    this._leftW        = 172;
    this._rightW       = 296;
  }

  // ─── Cycle de vie ─────────────────────────────────────────────────────────

  async start() {
    this._setupScene();
    this._setupEvents();
    this._setupUI();
    this.engine.start();
    await dynamics.init();
    await this._loadBankList();
  }

  stop() {
    this.engine.stop();
    this._clearScene();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    window.removeEventListener('click',   this._onClick);
    window.removeEventListener('keydown', this._onKeyDown);
    document.documentElement.style.removeProperty('--fg-left-w');
    document.documentElement.style.removeProperty('--fg-right-w');
    this.engine.resizeViewport(0, 0);

    // Restaurer OrbitControls
    this.engine.controls.dispose();
    this.engine.controls = this._origControls;
    this._origControls.enabled = true;
    this.engine.onPostUpdate = null;
  }

  // ─── Scène ────────────────────────────────────────────────────────────────

  _setupScene() {
    const e = this.engine;
    this._grid = new THREE.GridHelper(4, 20, 0x181825, 0x111120);
    e.scene.add(this._grid);

    // ── Remplacer OrbitControls par TrackballControls ──────────────────────
    this._origControls = e.controls;
    this._origControls.enabled = false;

    const tb = new TrackballControls(e.camera, e.renderer.domElement);
    tb.rotateSpeed          = 3.5;
    tb.zoomSpeed            = 1.2;
    tb.panSpeed             = 0.8;
    tb.dynamicDampingFactor = 0.18;
    tb.minDistance          = 0.2;
    tb.maxDistance          = 20;
    // Touch : 1 doigt rotate, 2 doigts zoom, 3 doigts pan
    tb.keys = ['KeyA', 'KeyS', 'KeyD'];
    e.controls = tb;

    e.camera.position.set(1.5, 1.2, 1.5);
    tb.target.set(0, 0.3, 0);
    tb.update();

    this._fillLight = new THREE.DirectionalLight(0x8899ff, 0.4);
    this._fillLight.position.set(-1, 0.5, -1);
    e.scene.add(this._fillLight);

    // Axe verrouillé : null | 'x' | 'y' | 'z'
    this._lockedAxis  = null;
    this._lockOffset  = 0; // composante conservée le long de l'axe

    e.onPostUpdate = () => this._applyAxisLock();
  }

  _clearScene() {
    this._disposeMeshGroup();
    this._clearSlotMarkers();
    if (this._grid)      this.engine.scene.remove(this._grid);
    if (this._fillLight) this.engine.scene.remove(this._fillLight);
  }

  _disposeMeshGroup() {
    if (!this._meshGroup) return;
    this.engine.scene.remove(this._meshGroup);
    this._meshGroup.traverse(o => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach(m => m.dispose());
    });
    this._meshGroup = null;
  }

  // ─── Banque ───────────────────────────────────────────────────────────────

  async _loadBankList() {
    const res = await fetch('/bank-index');
    this._bankList = await res.json();
    this._renderBankList();
  }

  async _loadBrick(name) {
    const res  = await fetch(`/bank/${encodeURIComponent(name)}.json`);
    const data = await res.json();
    this._brickName  = name;
    this._brickData  = data;
    this._selectedIdx = null;
    this._dirtyBrick  = false;
    this._rebuildMesh();
    this._rebuildSlotMarkers();
    this._renderActiveTab();
    this._updateSaveBtns();
    this._updateHint();
  }

  // ─── Maillage ─────────────────────────────────────────────────────────────

  _rebuildMesh(hlSurfaces = null) {
    this._disposeMeshGroup();
    const data = this._brickData;
    const { normalGeo, highlightGeo } = buildGeometry(data.object, hlSurfaces);
    const col = data.color ? parseInt(data.color.replace('#',''), 16) : 0x888888;

    const group = new THREE.Group();
    this._brickMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(normalGeo, this._brickMat));

    if (highlightGeo) {
      const hlMat = new THREE.MeshStandardMaterial({ color: 0xffee44, roughness: 0.3, side: THREE.DoubleSide, emissive: 0x332200 });
      group.add(new THREE.Mesh(highlightGeo, hlMat));
    }

    const box = new THREE.Box3().setFromObject(group.children[0]);
    this._brickCenter = box.getCenter(new THREE.Vector3());
    group.position.sub(this._brickCenter);

    this.engine.scene.add(group);
    this._meshGroup = group;
  }

  // ─── Marqueurs slots ──────────────────────────────────────────────────────

  _clearSlotMarkers() {
    for (const m of this._slotMarkers) {
      this.engine.scene.remove(m.group);
      m.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this._slotMarkers = [];
  }

  _rebuildSlotMarkers() {
    this._clearSlotMarkers();
    if (!this._brickData?.slots?.length) return;

    this._brickData.slots.forEach((slot, i) => {
      const e   = slot.mat.elements;
      const col = dynamics.getSlotColor(slot.type);
      const pos = new THREE.Vector3(e[12]*SCALE, e[13]*SCALE, e[14]*SCALE).sub(this._brickCenter);
      const axis = new THREE.Vector3(e[4], e[5], e[6]).normalize();

      const group = new THREE.Group();
      group.position.copy(pos);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 10, 10),
        new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.92 })
      );
      sphere.userData.slotIndex = i;
      sphere.renderOrder = 999;
      group.add(sphere);

      const arrow = new THREE.ArrowHelper(axis, new THREE.Vector3(), 0.15, col, 0.04, 0.025);
      arrow.traverse(o => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.depthTest   = false;
          o.material.transparent = true;
          o.material.opacity     = 0.75;
        }
        o.renderOrder = 999;
      });
      group.add(arrow);

      this.engine.scene.add(group);
      this._slotMarkers.push({ group, sphere, slotIndex: i });
    });
  }

  _highlightMarker(idx) {
    this._slotMarkers.forEach(m => {
      const sel = m.slotIndex === idx;
      const col = dynamics.getSlotColor(this._brickData.slots[m.slotIndex]?.type);
      m.sphere.material.color.setHex(sel ? 0xffffff : col);
      m.sphere.material.opacity = sel ? 1.0 : 0.92;
      m.sphere.scale.setScalar(sel ? 1.7 : 1.0);
    });
  }

  // ─── Sélection slot ───────────────────────────────────────────────────────

  _selectSlot(idx) {
    this._selectedIdx = idx;
    const slot = this._brickData.slots[idx];
    this._rebuildMesh(slot.surfaces);
    this._rebuildSlotMarkers();
    this._highlightMarker(idx);
    this._switchTab('slots');
    this._renderSlotsTab();
  }

  _pickSlot(event) {
    const rect = this.engine.renderer.domElement.getBoundingClientRect();
    this._mouse.set(
      ((event.clientX - rect.left) / rect.width)  * 2 - 1,
     -((event.clientY - rect.top)  / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);
    const hits = this._raycaster.intersectObjects(this._slotMarkers.map(m => m.sphere), false);
    if (hits.length) { this._selectSlot(hits[0].object.userData.slotIndex); return true; }
    return false;
  }

  // ─── Modifications brique ─────────────────────────────────────────────────

  _setBrickColor(hex) {
    this._brickData.color = hex;
    if (this._brickMat) this._brickMat.color.setStyle(hex);
    this._markDirtyBrick();
  }

  _setBrickName(name) {
    this._brickData.name = name;
    this._markDirtyBrick();
  }

  _setAuthors(authors) {
    this._brickData.authors = authors;
    this._markDirtyBrick();
  }

  _setDescription(desc) {
    this._brickData.description = desc;
    this._markDirtyBrick();
  }

  _markDirtyBrick() {
    this._dirtyBrick = true;
    this._updateSaveBtns();
    this._updateBankListItem();
  }

  // ─── Modifications slot ───────────────────────────────────────────────────

  _setSlotType(idx, type) {
    this._brickData.slots[idx].type = type;
    this._markDirtyBrick();
    this._rebuildSlotMarkers();
    this._highlightMarker(idx);
  }

  _setSlotPosition(idx, x, y, z) {
    const e = this._brickData.slots[idx].mat.elements;
    e[12] = x; e[13] = y; e[14] = z;
    this._markDirtyBrick();
    this._rebuildSlotMarkers();
    this._highlightMarker(idx);
  }

  _rotateSlotAxis(idx, rx, ry, rz) {
    const e   = this._brickData.slots[idx].mat.elements;
    const mat = new THREE.Matrix4().fromArray(e);
    const pos = new THREE.Vector3(e[12], e[13], e[14]);
    mat.premultiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
    mat.setPosition(pos);
    this._brickData.slots[idx].mat.elements = Array.from(mat.elements);
    this._markDirtyBrick();
    this._rebuildSlotMarkers();
    this._highlightMarker(idx);
    this._renderSlotsTab(); // refresh axe affiché
  }

  // ─── Sauvegarde ───────────────────────────────────────────────────────────

  async _saveBrick() {
    if (!this._brickName || !this._brickData) return;
    // Injection des métadonnées temporelles
    if (!this._brickData.createdAt) this._brickData.createdAt = new Date().toISOString();
    this._brickData.updatedAt = new Date().toISOString();

    const res = await fetch(`/bank/${encodeURIComponent(this._brickName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this._brickData),
    });
    const json = await res.json();
    if (json.ok) {
      this._dirtyBrick = false;
      this._updateSaveBtns();
      this._updateBankListItem();
      this._flashBtn(this._saveBrickBtn, '✓ Brique sauvegardée');
    }
  }

  async _saveDynamics() {
    const result = await dynamics.save();
    if (result.ok) {
      this._dirtyDyn = false;
      this._updateSaveBtns();
      this._flashBtn(this._saveDynBtn, '✓ Dynamique sauvegardée');
    }
  }

  async _saveAll() {
    if (this._dirtyBrick) await this._saveBrick();
    if (this._dirtyDyn)   await this._saveDynamics();
  }

  _flashBtn(btn, msg) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('flash');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('flash'); }, 1800);
  }

  // ─── Événements ───────────────────────────────────────────────────────────

  _setupEvents() {
    this._onClick = (e) => {
      if (e.target !== this.engine.renderer.domElement) return;
      this._pickSlot(e);
    };
    this._onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this._saveAll(); }
    };
    window.addEventListener('click',   this._onClick);
    window.addEventListener('keydown', this._onKeyDown);
  }

  // ─── UI ───────────────────────────────────────────────────────────────────

  _setupUI() {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --fg-bg:     #353535;
        --fg-bg2:    #2e2e2e;
        --fg-border: #1e1e1e;
        --fg-bevel:  #4a4a4a;
        --fg-accent: #7aafc8;
        --fg-sel:    #3d5a6e;
        --fg-dim:    #666;
        --fg-text:   #b0b0b0;
        --fg-text2:  #d8d8d8;
      }

      /* ── Panneaux ── */
      .fg-left  { position:fixed; left:0; top:0; bottom:0; width:var(--fg-left-w,172px);
        background:var(--fg-bg2); border-right:1px solid var(--fg-border);
        box-shadow:inset -1px 0 0 var(--fg-bevel);
        display:flex; flex-direction:column; z-index:50; }
      .fg-right { position:fixed; right:0; top:0; bottom:0; width:var(--fg-right-w,296px);
        background:var(--fg-bg); border-left:1px solid var(--fg-border);
        box-shadow:inset 1px 0 0 var(--fg-bevel);
        display:flex; flex-direction:column; z-index:50; }

      /* ── Poignées de redimensionnement ── */
      .fg-handle { position:fixed; top:0; bottom:0; width:10px; z-index:60;
        cursor:col-resize; touch-action:none; }
      .fg-handle::after { content:''; position:absolute; inset:0; }
      .fg-handle.dragging::after { background:#7aafc830; }
      .fg-handle-left  { left:calc(var(--fg-left-w,172px) - 5px); }
      .fg-handle-right { right:calc(var(--fg-right-w,296px) - 5px); }

      /* ── En-têtes ── */
      .fg-head { padding:9px 12px; font:700 9px/1 sans-serif; color:var(--fg-text);
        text-transform:uppercase; letter-spacing:.12em; flex-shrink:0;
        background:linear-gradient(to bottom,#404040,#323232);
        border-bottom:1px solid var(--fg-border);
        box-shadow:0 1px 0 var(--fg-bevel); }

      /* ── Liste briques ── */
      .fg-blist { flex:1; overflow-y:auto; padding:2px 0; }
      .fg-blist::-webkit-scrollbar { width:6px; }
      .fg-blist::-webkit-scrollbar-track { background:var(--fg-bg2); }
      .fg-blist::-webkit-scrollbar-thumb { background:#555; border-radius:2px; }
      .fg-bitem { padding:5px 12px; cursor:pointer; font:11px sans-serif;
        color:var(--fg-text); border-left:3px solid transparent;
        display:flex; align-items:center; gap:5px; }
      .fg-bitem.sel { background:var(--fg-sel); color:var(--fg-text2); border-left-color:var(--fg-accent); }
      .fg-dirty-dot { width:5px; height:5px; border-radius:50%;
        background:var(--fg-accent); flex-shrink:0; opacity:0; }
      .fg-bitem.dirty .fg-dirty-dot { opacity:1; }

      /* ── Tabs ── */
      .fg-tabs { display:flex; border-bottom:1px solid var(--fg-border); flex-shrink:0;
        background:linear-gradient(to bottom,#3a3a3a,#303030);
        box-shadow:0 1px 0 var(--fg-bevel); }
      .fg-tab  { flex:1; padding:8px 4px; text-align:center; cursor:pointer;
        font:9px sans-serif; color:var(--fg-dim); text-transform:uppercase;
        letter-spacing:.08em; border-bottom:2px solid transparent; }
      .fg-tab.active { color:var(--fg-accent); border-bottom-color:var(--fg-accent); }

      /* ── Contenu tabs ── */
      .fg-tab-content { flex:1; overflow-y:auto; padding:12px; display:flex;
        flex-direction:column; gap:10px; }
      .fg-tab-content::-webkit-scrollbar { width:6px; }
      .fg-tab-content::-webkit-scrollbar-track { background:var(--fg-bg); }
      .fg-tab-content::-webkit-scrollbar-thumb { background:#555; border-radius:2px; }

      /* ── Champs génériques ── */
      .fg-label { font:700 9px sans-serif; color:var(--fg-dim); text-transform:uppercase;
        letter-spacing:.1em; margin-bottom:4px; }
      .fg-input { width:100%; box-sizing:border-box; background:#272727;
        color:var(--fg-text2); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006;
        padding:5px 8px; font:12px sans-serif; }
      .fg-input:focus { outline:none; border-color:var(--fg-accent); }
      .fg-textarea { width:100%; box-sizing:border-box; background:#272727;
        color:var(--fg-text); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006;
        padding:5px 8px; font:11px sans-serif; resize:vertical; min-height:52px; }
      .fg-textarea:focus { outline:none; border-color:var(--fg-accent); }
      .fg-select { width:100%; background:#272727; color:var(--fg-text2);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006;
        padding:5px 7px; font:11px sans-serif; }

      /* ── Color picker ── */
      .fg-colorpicker { display:flex; align-items:center; gap:8px; }
      .fg-colorpreview { width:44px; height:44px; border-radius:2px;
        border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; flex-shrink:0; }
      .fg-colorinput { position:absolute; opacity:0; width:1px; height:1px; }

      /* ── Tags auteurs ── */
      .fg-tags { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
      .fg-tag  { background:#3a3a3a; color:var(--fg-text); border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 0 var(--fg-bevel);
        border-radius:2px; padding:2px 8px; font:10px sans-serif;
        display:flex; align-items:center; gap:4px; }
      .fg-tag-del { cursor:pointer; font-size:11px; color:var(--fg-dim); }
      .fg-taginput { background:transparent; border:none; border-bottom:1px solid var(--fg-border);
        color:var(--fg-text2); font:10px sans-serif; width:80px; outline:none; padding:2px 3px; }

      /* ── Métadonnées en disclosure ── */
      .fg-details { background:var(--fg-bg2); border:1px solid var(--fg-border);
        border-radius:2px; overflow:hidden; }
      .fg-details summary { padding:7px 10px; cursor:pointer; font:10px sans-serif;
        color:var(--fg-dim); letter-spacing:.05em; user-select:none; list-style:none;
        background:linear-gradient(to bottom,#3a3a3a,#303030); }
      .fg-details summary::-webkit-details-marker { display:none; }
      .fg-details summary::before { content:'▶ '; font-size:8px; }
      .fg-details[open] summary::before { content:'▼ '; }
      .fg-details-body { padding:8px 10px; display:flex; flex-direction:column; gap:7px;
        border-top:1px solid var(--fg-border); }
      .fg-meta-row { font:10px sans-serif; color:var(--fg-dim); display:flex;
        align-items:baseline; gap:6px; }
      .fg-meta-key { color:var(--fg-dim); min-width:72px; }

      /* ── Section ── */
      .fg-section { border-bottom:1px solid var(--fg-border); padding-bottom:10px; }

      /* ── Slots liste ── */
      .fg-slot-list { display:flex; flex-direction:column; gap:2px; }
      .fg-sitem { display:flex; align-items:center; gap:6px; padding:5px 7px;
        border-radius:2px; cursor:pointer;
        border:1px solid transparent; }
      .fg-sitem.sel { background:var(--fg-sel); border-color:var(--fg-bevel); }
      .fg-sdot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
      .fg-stype { flex:1; font:11px sans-serif; color:var(--fg-text);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fg-sidx { font:10px sans-serif; color:var(--fg-dim); }
      .fg-sdel { font:12px sans-serif; color:var(--fg-dim); cursor:pointer; padding:0 2px; }

      /* ── Éditeur slot ── */
      .fg-sloteditor { background:var(--fg-bg2); border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 3px #0004;
        border-radius:2px; padding:10px; display:flex; flex-direction:column; gap:9px; }
      .fg-coords { display:flex; gap:4px; }
      .fg-coord { flex:1; width:0; background:#272727; color:var(--fg-text2);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006;
        padding:4px 5px; font:11px sans-serif; }
      .fg-coord:focus { outline:none; border-color:var(--fg-accent); }
      .fg-rotbtns { display:grid; grid-template-columns:repeat(3,1fr); gap:3px; }
      .fg-rotbtn { padding:5px 2px;
        background:linear-gradient(to bottom,#484848,#383838);
        color:var(--fg-text); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; font:10px sans-serif; text-align:center; }
      .fg-rotbtn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }
      .fg-axisrow { font:10px sans-serif; color:var(--fg-dim); background:var(--fg-bg2);
        padding:5px 7px; border-radius:2px; border:1px solid var(--fg-border); }
      .fg-noselbanner { font:11px sans-serif; color:var(--fg-dim); text-align:center;
        padding:20px 0; }
      .fg-addslot { width:100%; padding:7px;
        background:linear-gradient(to bottom,#404040,#333);
        color:var(--fg-text); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; font:10px sans-serif; margin-top:2px; }
      .fg-addslot:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }

      /* ── Sous-onglets Méca ── */
      .fg-subtabs { display:flex; gap:3px; margin-bottom:8px; }
      .fg-subtab  { flex:1; padding:5px 4px; text-align:center; cursor:pointer;
        font:9px sans-serif; color:var(--fg-dim); text-transform:uppercase;
        letter-spacing:.08em; border:1px solid var(--fg-border); border-radius:2px;
        background:linear-gradient(to bottom,#484848,#383838);
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004; }
      .fg-subtab.active { color:var(--fg-accent); border-color:var(--fg-accent);
        background:var(--fg-sel); box-shadow:inset 0 1px 3px #0006; }

      /* ── Cartes de slot (sous-onglet Slots) ── */
      .fg-meca-card { background:var(--fg-bg2); border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 3px #0003;
        border-radius:2px; padding:8px; margin-bottom:6px; }
      .fg-meca-card-hdr { display:flex; align-items:center; gap:6px;
        margin-bottom:6px; padding-bottom:5px; border-bottom:1px solid var(--fg-border); }
      .fg-meca-row { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
      .fg-meca-key { font:9px sans-serif; color:var(--fg-dim); min-width:68px; flex-shrink:0; }

      /* ── Compat/Liaisons tab ── */
      .fg-compat-info { font:10px sans-serif; color:var(--fg-dim); background:var(--fg-bg2);
        border:1px solid var(--fg-border); border-radius:2px; padding:6px 8px;
        line-height:1.5; }
      .fg-compat-grid { overflow-x:auto; }
      .fg-compat-table { border-collapse:collapse; font:10px sans-serif; }
      .fg-compat-table th, .fg-compat-table td { padding:4px 6px;
        border:1px solid var(--fg-border); text-align:center; min-width:28px; }
      .fg-compat-table th { background:linear-gradient(to bottom,#404040,#333);
        color:var(--fg-text); font-weight:700; }
      .fg-compat-table td { cursor:pointer; }
      .fg-compat-table td.has-rule { color:var(--fg-text2); }
      .fg-compat-table td.sel-cell { background:var(--fg-sel) !important;
        outline:1px solid var(--fg-accent); }
      .fg-badge { display:inline-block; padding:1px 4px; border-radius:2px;
        font:9px/1.4 sans-serif; font-weight:700; }
      .fg-rule-editor { background:var(--fg-bg2); border:1px solid var(--fg-border);
        border-radius:2px; padding:10px; display:flex; flex-direction:column; gap:8px; }
      .fg-rule-add { display:flex; flex-direction:column; gap:6px; background:var(--fg-bg2);
        border:1px dashed var(--fg-bevel); border-radius:2px; padding:8px; }

      /* ── Boutons de sauvegarde ── */
      .fg-savezone { display:flex; gap:6px; padding:8px 10px;
        border-top:1px solid var(--fg-border);
        background:linear-gradient(to bottom,#3a3a3a,#2e2e2e);
        box-shadow:inset 0 1px 0 var(--fg-bevel);
        flex-shrink:0; }
      .fg-savebtn { flex:1; padding:9px 6px;
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        font:11px/1 sans-serif; font-weight:700; cursor:pointer;
        background:linear-gradient(to bottom,#484848,#383838); color:var(--fg-dim); }
      .fg-savebtn.active { background:linear-gradient(to bottom,#3a5a3a,#2a4a2a);
        color:#88cc88; border-color:#2a4a2a; box-shadow:inset 0 1px 0 #4a7a4a; }
      .fg-savebtn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }
      .fg-savebtn.flash  { background:#3a6a3a; color:#aaffaa; }

      /* ── Barre du haut ── */
      .fg-bar { position:fixed; top:0; left:var(--fg-left-w,172px); right:var(--fg-right-w,296px);
        height:36px; background:linear-gradient(to bottom,#444,#383838);
        border-bottom:1px solid var(--fg-border);
        box-shadow:0 1px 0 var(--fg-bevel), 0 2px 6px #0005;
        display:flex; align-items:center; justify-content:center; gap:1.5rem;
        z-index:40; pointer-events:none; font:10px sans-serif; color:var(--fg-text); }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // ── Panneau gauche ────────────────────────────────────────────────────
    const left = document.createElement('div');
    left.className = 'fg-left';
    left.innerHTML = '<div class="fg-head">Banque de briques</div>';
    this._blistEl = document.createElement('div');
    this._blistEl.className = 'fg-blist';
    left.appendChild(this._blistEl);
    document.body.appendChild(left);
    this._ui.push(left);

    // ── Panneau droit ─────────────────────────────────────────────────────
    const right = document.createElement('div');
    right.className = 'fg-right';

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'fg-tabs';
    const TABS = [
      { id: 'brick',  label: '🧱 Brique' },
      { id: 'slots',  label: '● Slots'   },
      { id: 'meca',   label: '⚙ Méca'    },
    ];
    this._tabEls = {};
    TABS.forEach(({ id, label }) => {
      const t = document.createElement('div');
      t.className = 'fg-tab' + (id === this._activeTab ? ' active' : '');
      t.textContent = label;
      t.dataset.tab = id;
      t.addEventListener('click', () => this._switchTab(id));
      tabBar.appendChild(t);
      this._tabEls[id] = t;
    });
    right.appendChild(tabBar);

    // Contenu des tabs
    this._tabContentEl = document.createElement('div');
    this._tabContentEl.className = 'fg-tab-content';
    right.appendChild(this._tabContentEl);

    // Zone de sauvegarde fixe en bas
    const saveZone = document.createElement('div');
    saveZone.className = 'fg-savezone';
    this._saveBrickBtn = document.createElement('button');
    this._saveBrickBtn.className = 'fg-savebtn';
    this._saveBrickBtn.textContent = '💾 Brique';
    this._saveBrickBtn.title = 'Sauvegarder la brique (Ctrl+S)';
    this._saveBrickBtn.addEventListener('click', () => this._saveBrick());

    this._saveDynBtn = document.createElement('button');
    this._saveDynBtn.className = 'fg-savebtn';
    this._saveDynBtn.textContent = '⚙ Méca';
    this._saveDynBtn.title = 'Sauvegarder la mécanique d\'assemblage';
    this._saveDynBtn.addEventListener('click', () => this._saveDynamics());

    saveZone.append(this._saveBrickBtn, this._saveDynBtn);
    right.appendChild(saveZone);

    document.body.appendChild(right);
    this._ui.push(right);

    // ── Barre de statut ───────────────────────────────────────────────────
    this._barEl = document.createElement('div');
    this._barEl.className = 'fg-bar';
    document.body.appendChild(this._barEl);
    this._ui.push(this._barEl);

    this._updateSaveBtns();
    this._updateHint();
    this._renderActiveTab();
    this._setupResizeHandles();
    this._setupViewWidget();
    this._applyPanelWidths();
  }

  // ─── Redimensionnement ────────────────────────────────────────────────────

  _applyPanelWidths() {
    document.documentElement.style.setProperty('--fg-left-w',  this._leftW  + 'px');
    document.documentElement.style.setProperty('--fg-right-w', this._rightW + 'px');
    this.engine.resizeViewport(this._leftW, this._rightW);
  }

  // ─── Widget vues + verrous ────────────────────────────────────────────────

  _setupViewWidget() {
    const style = document.createElement('style');
    style.textContent = `
      .fg-viewwidget { position:fixed; top:44px; right:calc(var(--fg-right-w,296px) + 8px);
        display:flex; flex-direction:column; gap:4px; z-index:55; }
      .fg-vwrow { display:flex; gap:3px; }
      .fg-vbtn { width:34px; height:28px;
        background:linear-gradient(to bottom,#484848,#383838);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; font:10px/1 sans-serif; color:var(--fg-text);
        display:flex; align-items:center; justify-content:center; }
      .fg-vbtn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }
      .fg-vbtn.lock-active { background:var(--fg-sel); color:var(--fg-accent);
        border-color:var(--fg-accent); box-shadow:inset 0 1px 3px #0006; }
      .fg-vsep { width:1px; background:var(--fg-border); margin:0 2px; }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    const widget = document.createElement('div');
    widget.className = 'fg-viewwidget';

    // ── Rangée 1 : presets axiaux ─────────────────────────────────────────
    const presetRow = document.createElement('div');
    presetRow.className = 'fg-vwrow';

    const PRESETS = [
      { label: '+X', tip: 'Vue depuis +X',  axis: 'x', sign:  1 },
      { label: '−X', tip: 'Vue depuis −X',  axis: 'x', sign: -1 },
      { label: '+Y', tip: 'Vue depuis +Y (dessus)',  axis: 'y', sign:  1 },
      { label: '−Y', tip: 'Vue depuis −Y (dessous)', axis: 'y', sign: -1 },
      { label: '+Z', tip: 'Vue depuis +Z',  axis: 'z', sign:  1 },
      { label: '−Z', tip: 'Vue depuis −Z',  axis: 'z', sign: -1 },
      { label: '⟳',  tip: 'Réinitialiser la vue',   axis: null },
    ];

    PRESETS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'fg-vbtn';
      btn.textContent = p.label;
      btn.title = p.tip;
      btn.addEventListener('click', () => this._snapView(p.axis, p.sign));
      presetRow.appendChild(btn);
    });

    // ── Rangée 2 : verrous d'axe ──────────────────────────────────────────
    const lockRow = document.createElement('div');
    lockRow.className = 'fg-vwrow';

    const lockLabel = document.createElement('div');
    lockLabel.className = 'fg-vbtn';
    lockLabel.style.cssText = 'cursor:default;width:auto;padding:0 5px;font-size:9px;color:#223;';
    lockLabel.textContent = '🔒';
    lockRow.appendChild(lockLabel);

    const sep = document.createElement('div');
    sep.className = 'fg-vsep';
    lockRow.appendChild(sep);

    this._lockBtns = {};
    ['X', 'Y', 'Z'].forEach(ax => {
      const btn = document.createElement('button');
      btn.className = 'fg-vbtn';
      btn.textContent = ax;
      btn.title = `Verrouiller rotation — axe ${ax}`;
      btn.addEventListener('click', () => this._toggleAxisLock(ax.toLowerCase()));
      lockRow.appendChild(btn);
      this._lockBtns[ax.toLowerCase()] = btn;
    });

    widget.append(presetRow, lockRow);
    document.body.appendChild(widget);
    this._ui.push(widget);
  }

  _snapView(axis, sign) {
    const cam    = this.engine.camera;
    const target = this.engine.controls.target.clone();
    const dist   = cam.position.distanceTo(target) || 2;

    let pos;
    if (!axis) {
      // Reset
      pos = new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(dist).add(target);
    } else {
      pos = target.clone();
      pos[axis] += dist * sign;
    }

    cam.position.copy(pos);
    cam.lookAt(target);
    // TrackballControls recalcule _eye depuis camera.position au prochain update
  }

  _toggleAxisLock(axis) {
    if (this._lockedAxis === axis) {
      // Déverrouiller
      this._lockedAxis = null;
      Object.values(this._lockBtns).forEach(b => b.classList.remove('lock-active'));
    } else {
      // Verrouiller
      this._lockedAxis = axis;
      // Capturer la composante courante le long de l'axe (en offset depuis target)
      const offset = this.engine.camera.position.clone().sub(this.engine.controls.target);
      this._lockOffset = offset[axis];
      Object.entries(this._lockBtns).forEach(([k, b]) =>
        b.classList.toggle('lock-active', k === axis)
      );
    }
  }

  _applyAxisLock() {
    if (!this._lockedAxis) return;
    const cam    = this.engine.camera;
    const target = this.engine.controls.target;
    const offset = cam.position.clone().sub(target);
    const dist   = offset.length();
    const ax     = this._lockedAxis;

    // Composante le long de l'axe verrouillé → on la force à la valeur capturée
    const locked = this._lockOffset;
    // Rayon dans le plan perpendiculaire
    const perpR  = Math.sqrt(Math.max(0, dist * dist - locked * locked));

    // Composantes dans le plan perpendiculaire
    const perp = offset.clone();
    perp[ax] = 0;
    const perpLen = perp.length();
    if (perpLen > 1e-6) {
      perp.multiplyScalar(perpR / perpLen);
    } else {
      // Cas dégénéré : caméra dans l'axe — choisir une perpendiculaire arbitraire
      const fallback = ax === 'y' ? 'z' : 'y';
      perp.set(0, 0, 0);
      perp[fallback] = perpR;
    }
    perp[ax] = locked;

    cam.position.copy(target.clone().add(perp));
    cam.lookAt(target);
  }

  _setupResizeHandles() {
    const MIN_PANEL = 120, MAX_PANEL = Math.floor(innerWidth * 0.4);

    const makeHandle = (side) => {
      const h = document.createElement('div');
      h.className = `fg-handle fg-handle-${side}`;
      document.body.appendChild(h);
      this._ui.push(h);

      let startX, startW;

      const onMove = (x) => {
        const delta = x - startX;
        if (side === 'left') {
          this._leftW = Math.max(MIN_PANEL, Math.min(MAX_PANEL, startW + delta));
        } else {
          this._rightW = Math.max(MIN_PANEL, Math.min(MAX_PANEL, startW - delta));
        }
        this._applyPanelWidths();
      };

      const onEnd = () => {
        h.classList.remove('dragging');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup',   onPointerUp);
      };

      const onPointerMove = (e) => onMove(e.clientX);
      const onPointerUp   = ()  => onEnd();

      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('dragging');
        startX = e.clientX;
        startW = side === 'left' ? this._leftW : this._rightW;
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup',   onPointerUp);
      });
    };

    makeHandle('left');
    makeHandle('right');
  }

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  _switchTab(id) {
    this._activeTab = id;
    Object.entries(this._tabEls).forEach(([k, el]) => el.classList.toggle('active', k === id));
    this._renderActiveTab();
    this._updateHint();
  }

  _renderActiveTab() {
    switch (this._activeTab) {
      case 'brick':  this._renderBrickTab(); break;
      case 'slots':  this._renderSlotsTab(); break;
      case 'meca':   this._renderMecaTab();  break;
    }
  }

  // ─── Tab Brique ───────────────────────────────────────────────────────────

  _renderBrickTab() {
    const el = this._tabContentEl;
    el.innerHTML = '';

    if (!this._brickData) {
      el.innerHTML = '<div class="fg-noselbanner">← Sélectionne une brique</div>';
      return;
    }

    const d = this._brickData;

    // ── Couleur ────────────────────────────────────────────────────────────
    const colorSec = document.createElement('div');
    colorSec.className = 'fg-section';
    const colorLbl = document.createElement('div');
    colorLbl.className = 'fg-label';
    colorLbl.textContent = 'Couleur';

    const colorRow = document.createElement('div');
    colorRow.className = 'fg-colorpicker';

    const preview = document.createElement('div');
    preview.className = 'fg-colorpreview';
    preview.style.background = d.color || '#888888';

    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'color';
    hiddenInput.className = 'fg-colorinput';
    hiddenInput.value = d.color || '#888888';

    preview.addEventListener('click', () => hiddenInput.click());
    hiddenInput.addEventListener('input', (e) => {
      preview.style.background = e.target.value;
      this._setBrickColor(e.target.value);
    });

    const hexField = document.createElement('input');
    hexField.className = 'fg-input';
    hexField.value = d.color || '#888888';
    hexField.placeholder = '#rrggbb';
    hexField.addEventListener('change', (e) => {
      const val = e.target.value;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        preview.style.background = val;
        hiddenInput.value = val;
        this._setBrickColor(val);
      }
    });

    colorRow.append(preview, hiddenInput, hexField);
    colorSec.append(colorLbl, colorRow);
    el.appendChild(colorSec);

    // ── Nom ────────────────────────────────────────────────────────────────
    const nameSec = document.createElement('div');
    nameSec.className = 'fg-section';
    const nameLbl = document.createElement('div');
    nameLbl.className = 'fg-label';
    nameLbl.textContent = 'Nom';
    const nameInput = document.createElement('input');
    nameInput.className = 'fg-input';
    nameInput.value = d.name || '';
    nameInput.placeholder = 'Nom de la brique…';
    nameInput.addEventListener('input',  (e) => this._setBrickName(e.target.value));
    nameSec.append(nameLbl, nameInput);
    el.appendChild(nameSec);

    // ── Auteurs ────────────────────────────────────────────────────────────
    const authorSec = document.createElement('div');
    const authorLbl = document.createElement('div');
    authorLbl.className = 'fg-label';
    authorLbl.textContent = 'Auteurs';
    const tagsRow = document.createElement('div');
    tagsRow.className = 'fg-tags';
    const authors = Array.isArray(d.authors) ? d.authors : [];

    const renderTags = () => {
      tagsRow.innerHTML = '';
      authors.forEach((a, i) => {
        const tag = document.createElement('span');
        tag.className = 'fg-tag';
        tag.innerHTML = `${a} <span class="fg-tag-del" data-i="${i}">✕</span>`;
        tag.querySelector('.fg-tag-del').addEventListener('click', () => {
          authors.splice(i, 1);
          this._setAuthors([...authors]);
          renderTags();
        });
        tagsRow.appendChild(tag);
      });
      const addInput = document.createElement('input');
      addInput.className = 'fg-taginput';
      addInput.placeholder = '+ auteur';
      addInput.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ',') && addInput.value.trim()) {
          e.preventDefault();
          authors.push(addInput.value.trim());
          this._setAuthors([...authors]);
          renderTags();
        }
      });
      tagsRow.appendChild(addInput);
    };
    renderTags();
    authorSec.append(authorLbl, tagsRow);
    el.appendChild(authorSec);

    // ── Description ────────────────────────────────────────────────────────
    const descSec = document.createElement('div');
    const descLbl = document.createElement('div');
    descLbl.className = 'fg-label';
    descLbl.textContent = 'Description';
    const descArea = document.createElement('textarea');
    descArea.className = 'fg-textarea';
    descArea.value = d.description || '';
    descArea.placeholder = 'Description optionnelle…';
    descArea.addEventListener('input', (e) => this._setDescription(e.target.value));
    descSec.append(descLbl, descArea);
    el.appendChild(descSec);

    // ── Métadonnées temporelles ────────────────────────────────────────────
    const details = document.createElement('details');
    details.className = 'fg-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Métadonnées';
    const body = document.createElement('div');
    body.className = 'fg-details-body';
    [
      ['Créé',      d.createdAt  ? new Date(d.createdAt).toLocaleString()  : '—'],
      ['Modifié',   d.updatedAt  ? new Date(d.updatedAt).toLocaleString()  : '—'],
      ['Slots',     (d.slots || []).length],
      ['Triangles', d.object?.triangles?.length || 0],
    ].forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'fg-meta-row';
      row.innerHTML = `<span class="fg-meta-key">${k}</span><span>${v}</span>`;
      body.appendChild(row);
    });
    details.append(summary, body);
    el.appendChild(details);
  }

  // ─── Tab Slots ────────────────────────────────────────────────────────────

  _renderSlotsTab() {
    const el = this._tabContentEl;
    el.innerHTML = '';

    if (!this._brickData) {
      el.innerHTML = '<div class="fg-noselbanner">← Sélectionne une brique</div>';
      return;
    }

    const slots = this._brickData.slots || [];

    // ── Liste des slots ────────────────────────────────────────────────────
    const listSec = document.createElement('div');
    listSec.className = 'fg-section';
    const listLbl = document.createElement('div');
    listLbl.className = 'fg-label';
    listLbl.textContent = `${slots.length} slot${slots.length !== 1 ? 's' : ''}`;
    const list = document.createElement('div');
    list.className = 'fg-slot-list';

    slots.forEach((slot, i) => {
      const col    = dynamics.getSlotColor(slot.type);
      const hexCol = '#' + col.toString(16).padStart(6, '0');
      const item   = document.createElement('div');
      item.className = 'fg-sitem' + (i === this._selectedIdx ? ' sel' : '');
      item.innerHTML = `
        <span class="fg-sdot" style="background:${hexCol}"></span>
        <span class="fg-stype" title="${slot.type}">${dynamics.getSlotMeta(slot.type).label || slot.type}</span>
        <span class="fg-sidx">${i}</span>
        <span class="fg-sdel" title="Supprimer ce slot">✕</span>
      `;
      item.querySelector('.fg-stype').addEventListener('click', () => this._selectSlot(i));
      item.querySelector('.fg-sdot').addEventListener('click', () => this._selectSlot(i));
      item.querySelector('.fg-sidx').addEventListener('click', () => this._selectSlot(i));
      item.querySelector('.fg-sdel').addEventListener('click', (e) => {
        e.stopPropagation();
        this._brickData.slots.splice(i, 1);
        if (this._selectedIdx === i) this._selectedIdx = null;
        else if (this._selectedIdx > i) this._selectedIdx--;
        this._markDirtyBrick();
        this._rebuildMesh(this._selectedIdx != null ? this._brickData.slots[this._selectedIdx]?.surfaces : null);
        this._rebuildSlotMarkers();
        if (this._selectedIdx != null) this._highlightMarker(this._selectedIdx);
        this._renderSlotsTab();
      });
      list.appendChild(item);
    });

    // Bouton ajouter
    const addBtn = document.createElement('button');
    addBtn.className = 'fg-addslot';
    addBtn.textContent = '＋ Nouveau slot';
    addBtn.addEventListener('click', () => {
      this._brickData.slots.push({
        type: 'system plate pin',
        mat: { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] },
        surfaces: [],
        uid: '#slot-' + Math.random().toString(36).slice(2, 18),
        xrepeat: 0, yrepeat: 0, xrepeatinc: 100, yrepeatinc: 100,
        index: this._brickData.slots.length,
      });
      this._markDirtyBrick();
      this._rebuildSlotMarkers();
      this._selectSlot(this._brickData.slots.length - 1);
    });

    listSec.append(listLbl, list, addBtn);
    el.appendChild(listSec);

    // ── Éditeur du slot sélectionné ────────────────────────────────────────
    if (this._selectedIdx == null || !slots[this._selectedIdx]) {
      const msg = document.createElement('div');
      msg.className = 'fg-noselbanner';
      msg.textContent = 'Clique sur un slot pour l\'éditer';
      el.appendChild(msg);
      return;
    }

    const slot = slots[this._selectedIdx];
    const idx  = this._selectedIdx;
    const e    = slot.mat.elements;

    const editor = document.createElement('div');
    editor.className = 'fg-sloteditor';

    // Type
    const typeLbl = document.createElement('div');
    typeLbl.className = 'fg-label';
    typeLbl.textContent = 'Type';
    const typeSelect = document.createElement('select');
    typeSelect.className = 'fg-select';
    dynamics.getAllSlotTypes().forEach(t => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = t;
      if (t === slot.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', () => {
      this._setSlotType(idx, typeSelect.value);
      this._renderSlotsTab();
    });
    editor.append(typeLbl, typeSelect);

    // Compatibilités rapides (info)
    const compats = dynamics.getCompatibles(slot.type);
    if (compats.length) {
      const compatInfo = document.createElement('div');
      compatInfo.style.cssText = 'font:9px monospace;color:#2a3a4a;line-height:1.6;';
      compatInfo.textContent = 'Compatible : ' + compats.map(t => dynamics.getSlotMeta(t).label).join(', ');
      editor.appendChild(compatInfo);
    }

    // Position
    const posLbl = document.createElement('div');
    posLbl.className = 'fg-label';
    posLbl.textContent = 'Position (unités brutes)';
    const posRow = document.createElement('div');
    posRow.className = 'fg-coords';
    ['X','Y','Z'].forEach((axis, ai) => {
      const inp = document.createElement('input');
      inp.className = 'fg-coord';
      inp.type = 'number'; inp.step = '1';
      inp.placeholder = axis;
      inp.value = Math.round(e[12 + ai] * 100) / 100;
      inp.style.borderLeft = `2px solid ${['#f55','#5c5','#55f'][ai]}`;
      inp.addEventListener('change', () => {
        const vals = Array.from(posRow.querySelectorAll('input')).map(i => parseFloat(i.value));
        this._setSlotPosition(idx, vals[0], vals[1], vals[2]);
      });
      posRow.appendChild(inp);
    });
    editor.append(posLbl, posRow);

    // Axe + rotation
    const axisLbl = document.createElement('div');
    axisLbl.className = 'fg-label';
    axisLbl.textContent = 'Axe normal · Rotation ±90°';
    const ax = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const axisRow = document.createElement('div');
    axisRow.className = 'fg-axisrow';
    axisRow.textContent = `${ax.x.toFixed(3)}  ${ax.y.toFixed(3)}  ${ax.z.toFixed(3)}`;
    const rotBtns = document.createElement('div');
    rotBtns.className = 'fg-rotbtns';
    const HP = Math.PI / 2;
    [['+X',HP,0,0],['-X',-HP,0,0],['+Y',0,HP,0],['-Y',0,-HP,0],['+Z',0,0,HP],['-Z',0,0,-HP]].forEach(([l,rx,ry,rz]) => {
      const btn = document.createElement('button');
      btn.className = 'fg-rotbtn'; btn.textContent = l;
      btn.addEventListener('click', () => this._rotateSlotAxis(idx, rx, ry, rz));
      rotBtns.appendChild(btn);
    });
    editor.append(axisLbl, axisRow, rotBtns);

    // Surfaces
    const surfLbl = document.createElement('div');
    surfLbl.className = 'fg-label';
    surfLbl.textContent = `Surfaces surlignées (${slot.surfaces.length})`;
    const surfInfo = document.createElement('div');
    surfInfo.style.cssText = 'font:9px monospace;color:#2a3a4a;';
    const totalTris = slot.surfaces.reduce((acc, si) => acc + (this._brickData.object.surfaces[si]?.triangleset?.length || 0), 0);
    surfInfo.textContent = slot.surfaces.length
      ? `Indices : ${slot.surfaces.join(', ')} — ${totalTris} triangles`
      : 'Aucune surface associée';
    editor.append(surfLbl, surfInfo);

    // Répétition si non nulle
    if (slot.xrepeat || slot.yrepeat) {
      const repLbl = document.createElement('div');
      repLbl.className = 'fg-label';
      repLbl.textContent = 'Répétition';
      const repInfo = document.createElement('div');
      repInfo.className = 'fg-axisrow';
      repInfo.textContent = `X ×${slot.xrepeat} Δ${slot.xrepeatinc}u   Y ×${slot.yrepeat} Δ${slot.yrepeatinc}u`;
      editor.append(repLbl, repInfo);
    }

    el.appendChild(editor);
  }

  // ─── Tab Méca ─────────────────────────────────────────────────────────────

  _renderMecaTab() {
    const el = this._tabContentEl;
    el.innerHTML = '';

    // Bandeau contextuel
    const info = document.createElement('div');
    info.className = 'fg-compat-info';
    info.textContent = '⚠ Ces définitions s\'appliquent à tous les assemblages.';
    el.appendChild(info);

    // Sous-onglets
    const subBar = document.createElement('div');
    subBar.className = 'fg-subtabs';
    const SUBS = [{ id: 'slots', label: 'Types de slots' }, { id: 'liaisons', label: 'Liaisons' }];
    const subEls = {};
    SUBS.forEach(({ id, label }) => {
      const t = document.createElement('div');
      t.className = 'fg-subtab' + (id === this._mecaSubTab ? ' active' : '');
      t.textContent = label;
      t.addEventListener('click', () => {
        this._mecaSubTab = id;
        this._renderMecaTab();
      });
      subBar.appendChild(t);
      subEls[id] = t;
    });
    el.appendChild(subBar);

    if (this._mecaSubTab === 'slots') {
      this._renderMecaSlotsPanel(el);
    } else {
      this._renderMecaLiaisonsPanel(el);
    }
  }

  // ── Sous-onglet : Types de slots ──────────────────────────────────────────

  _renderMecaSlotsPanel(el) {
    const slots = dynamics.getAllSlots();
    const ROLES  = ['pin', 'hole'];
    const FIELDS = ['label', 'role', 'family', 'color', 'description'];

    ROLES.forEach(role => {
      const group = slots.filter(s => s.role === role);
      if (!group.length) return;

      const hdr = document.createElement('div');
      hdr.className = 'fg-label';
      hdr.style.marginTop = '8px';
      hdr.textContent = role === 'pin' ? '▲ Pins (mâles)' : '▽ Holes (femelles)';
      el.appendChild(hdr);

      group.forEach(slot => {
        const card = document.createElement('div');
        card.className = 'fg-meca-card';

        // En-tête de la carte (dot couleur + id)
        const cardHdr = document.createElement('div');
        cardHdr.className = 'fg-meca-card-hdr';
        const dot = document.createElement('span');
        dot.className = 'fg-sdot';
        dot.style.background = slot.color || '#888';
        const idSpan = document.createElement('span');
        idSpan.style.cssText = 'flex:1;font:10px monospace;color:#556;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        idSpan.textContent = slot.id;
        idSpan.title = slot.id;

        const delBtn = document.createElement('span');
        delBtn.style.cssText = 'cursor:pointer;color:#aa3333;font:11px monospace;opacity:.5;';
        delBtn.textContent = '✕';
        delBtn.title = 'Supprimer ce type de slot';
        delBtn.addEventListener('click', () => {
          dynamics.removeSlot(slot.id);
          this._dirtyDyn = true;
          this._updateSaveBtns();
          this._renderMecaTab();
        });
        cardHdr.append(dot, idSpan, delBtn);
        card.appendChild(cardHdr);

        // Champs éditables
        FIELDS.forEach(field => {
          const row = document.createElement('div');
          row.className = 'fg-meca-row';
          const lbl = document.createElement('span');
          lbl.className = 'fg-meca-key';
          lbl.textContent = field;

          if (field === 'color') {
            // Color picker inline
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex;align-items:center;gap:5px;flex:1;cursor:pointer;';
            const preview = document.createElement('span');
            preview.style.cssText = `width:16px;height:16px;border-radius:3px;background:${slot.color};border:1px solid #2a2a3a;flex-shrink:0;`;
            const inp = document.createElement('input');
            inp.type = 'color'; inp.value = slot.color || '#888888';
            inp.style.cssText = 'position:absolute;opacity:0;width:1px;height:1px;';
            const hexSpan = document.createElement('span');
            hexSpan.style.cssText = 'font:10px monospace;color:#556;';
            hexSpan.textContent = slot.color || '#888888';
            inp.addEventListener('input', e => {
              slot.color = e.target.value;
              preview.style.background = e.target.value;
              hexSpan.textContent = e.target.value;
              dynamics.updateSlot(slot.id, { color: e.target.value });
              this._dirtyDyn = true;
              this._updateSaveBtns();
              this._rebuildSlotMarkers(); // refresh 3D si brique chargée
            });
            wrap.append(preview, inp, hexSpan);
            row.append(lbl, wrap);
          } else if (field === 'role') {
            const sel = document.createElement('select');
            sel.className = 'fg-select';
            sel.style.flex = '1';
            ['pin', 'hole'].forEach(r => {
              const opt = document.createElement('option');
              opt.value = opt.textContent = r;
              if (r === slot.role) opt.selected = true;
              sel.appendChild(opt);
            });
            sel.addEventListener('change', () => {
              dynamics.updateSlot(slot.id, { role: sel.value });
              this._dirtyDyn = true; this._updateSaveBtns();
            });
            row.append(lbl, sel);
          } else {
            const inp = document.createElement('input');
            inp.className = 'fg-input';
            inp.style.flex = '1';
            inp.value = slot[field] || '';
            inp.addEventListener('input', () => {
              dynamics.updateSlot(slot.id, { [field]: inp.value });
              this._dirtyDyn = true; this._updateSaveBtns();
            });
            row.append(lbl, inp);
          }

          card.appendChild(row);
        });

        el.appendChild(card);
      });
    });

    // Bouton ajouter
    const addBtn = document.createElement('button');
    addBtn.className = 'fg-addslot';
    addBtn.textContent = '＋ Nouveau type de slot';
    addBtn.style.marginTop = '6px';
    addBtn.addEventListener('click', () => {
      const id = 'slot-' + Math.random().toString(36).slice(2, 8);
      dynamics.addSlot({ id, label: id, role: 'pin', family: 'custom', color: '#888888', description: '' });
      this._dirtyDyn = true; this._updateSaveBtns();
      this._renderMecaTab();
    });
    el.appendChild(addBtn);
  }

  // ── Sous-onglet : Liaisons ────────────────────────────────────────────────

  _renderMecaLiaisonsPanel(el) {
    const allTypes  = dynamics.getAllSlotTypes();
    const pins      = allTypes.filter(t => dynamics.getSlotMeta(t).role === 'pin');
    const holes     = allTypes.filter(t => dynamics.getSlotMeta(t).role === 'hole');
    const jointDefs = dynamics.getAllJointDefs();

    // Grille pin × hole
    const gridWrap = document.createElement('div');
    gridWrap.className = 'fg-compat-grid';
    const table = document.createElement('table');
    table.className = 'fg-compat-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th'));
    holes.forEach(h => {
      const th = document.createElement('th');
      const meta = dynamics.getSlotMeta(h);
      th.textContent = meta.label.split('·')[1]?.trim() || h;
      th.title = h; th.style.color = meta.color;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let selCell = null;

    pins.forEach(pin => {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      const pm = dynamics.getSlotMeta(pin);
      th.textContent = pm.label.split('·')[1]?.trim() || pin;
      th.title = pin; th.style.color = pm.color;
      row.appendChild(th);

      holes.forEach(hole => {
        const td = document.createElement('td');
        const liaison = dynamics.getRule(pin, hole);
        if (liaison) {
          const jd = jointDefs[liaison.joint] || {};
          td.classList.add('has-rule');
          const badge = document.createElement('span');
          badge.className = 'fg-badge';
          badge.title = liaison.description || '';
          badge.textContent = jd.icon || liaison.joint[0].toUpperCase();
          const colors = { fixed: ['#1a2a1a','#44aa66'], revolute: ['#1a1a3a','#4488ff'] };
          const [bg, fg] = colors[liaison.joint] || ['#2a2a1a','#aaaa44'];
          badge.style.background = bg; badge.style.color = fg;
          td.appendChild(badge);
        } else {
          td.innerHTML = '<span style="color:#1a1a2a">·</span>';
        }
        td.addEventListener('click', () => {
          if (selCell) selCell.classList.remove('sel-cell');
          td.classList.add('sel-cell'); selCell = td;
          this._renderLiaisonEditor(el, pin, hole, liaison);
        });
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    gridWrap.appendChild(table);
    el.appendChild(gridWrap);

    this._liaisonEditorSlot = document.createElement('div');
    this._liaisonEditorSlot.innerHTML = '<div class="fg-noselbanner" style="margin-top:6px">Clique sur une cellule</div>';
    el.appendChild(this._liaisonEditorSlot);
  }

  _renderLiaisonEditor(parentEl, pin, hole, liaison) {
    const slot = this._liaisonEditorSlot;
    slot.innerHTML = '';
    const pm = dynamics.getSlotMeta(pin);
    const hm = dynamics.getSlotMeta(hole);
    const jointDefs = dynamics.getAllJointDefs();

    const editor = document.createElement('div');
    editor.className = 'fg-rule-editor';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'font:9px monospace;line-height:1.8;padding-bottom:5px;border-bottom:1px solid #111;';
    hdr.innerHTML = `<span style="color:${pm.color}">${pm.label}</span> <span style="color:#334">↔</span> <span style="color:${hm.color}">${hm.label}</span>`;
    editor.appendChild(hdr);

    if (liaison) {
      const jtLbl = document.createElement('div');
      jtLbl.className = 'fg-label'; jtLbl.textContent = 'Liaison résultante';
      const jtSel = document.createElement('select');
      jtSel.className = 'fg-select';
      Object.entries(jointDefs).forEach(([id, def]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${def.icon}  ${def.label} — ${def.description}`;
        if (id === liaison.joint) opt.selected = true;
        jtSel.appendChild(opt);
      });
      jtSel.addEventListener('change', () => {
        dynamics.updateLiaison(liaison.id, { joint: jtSel.value });
        this._dirtyDyn = true; this._updateSaveBtns();
        this._renderMecaTab();
      });
      editor.append(jtLbl, jtSel);

      const descLbl = document.createElement('div');
      descLbl.className = 'fg-label'; descLbl.textContent = 'Description';
      const descInp = document.createElement('input');
      descInp.className = 'fg-input'; descInp.value = liaison.description || '';
      descInp.addEventListener('input', () => {
        dynamics.updateLiaison(liaison.id, { description: descInp.value });
        this._dirtyDyn = true; this._updateSaveBtns();
      });
      editor.append(descLbl, descInp);

      const delBtn = document.createElement('button');
      delBtn.style.cssText = 'background:transparent;border:1px solid #3a1a1a;color:#aa4444;border-radius:5px;padding:5px 8px;font:10px monospace;cursor:pointer;margin-top:4px;';
      delBtn.textContent = '✕ Supprimer cette liaison';
      delBtn.addEventListener('click', () => {
        dynamics.removeLiaison(liaison.id);
        this._dirtyDyn = true; this._updateSaveBtns();
        this._renderMecaTab();
      });
      editor.appendChild(delBtn);
    } else {
      const addLbl = document.createElement('div');
      addLbl.className = 'fg-label'; addLbl.textContent = 'Aucune liaison — Créer ?';
      const jtSel = document.createElement('select');
      jtSel.className = 'fg-select';
      Object.entries(jointDefs).forEach(([id, def]) => {
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = `${def.icon}  ${def.label}`;
        jtSel.appendChild(opt);
      });
      const addBtn = document.createElement('button');
      addBtn.style.cssText = 'width:100%;padding:7px;background:#001a0a;color:#44aa66;border:1px solid #1a3a1a;border-radius:5px;font:10px monospace;cursor:pointer;';
      addBtn.textContent = '＋ Créer cette liaison';
      addBtn.addEventListener('click', () => {
        const ok = dynamics.addLiaison({ slotA: pin, slotB: hole, joint: jtSel.value, description: `${pm.label} ↔ ${hm.label}` });
        if (ok) { this._dirtyDyn = true; this._updateSaveBtns(); this._renderMecaTab(); }
      });
      editor.append(addLbl, jtSel, addBtn);
    }

    slot.appendChild(editor);
  }

  // ─── Helpers UI ───────────────────────────────────────────────────────────

  _updateSaveBtns() {
    if (!this._saveBrickBtn) return;
    this._saveBrickBtn.classList.toggle('active', this._dirtyBrick);
    this._saveDynBtn.classList.toggle('active', this._dirtyDyn);
  }

  _updateHint() {
    if (!this._barEl) return;
    const hints = {
      brick:  'Édite le nom, la couleur et les métadonnées',
      slots:  'Clique sur une sphère ou un slot pour l\'éditer',
      meca:   'Édite les types de slots et les liaisons d\'assemblage',
    };
    const brickLabel = this._brickName
      ? `<strong style="color:#6677aa">${this._brickName}</strong>`
      : '<span style="color:#223">Aucune brique</span>';
    this._barEl.innerHTML = `<span>Forge</span>${brickLabel}<span>${hints[this._activeTab]}</span>`;
  }

  _updateBankListItem() {
    const item = this._blistEl.querySelector(`[data-name="${CSS.escape(this._brickName)}"]`);
    if (!item) return;
    item.classList.toggle('dirty', this._dirtyBrick);
  }

  _renderBankList() {
    this._blistEl.innerHTML = '';
    for (const name of this._bankList) {
      const item = document.createElement('div');
      item.className = 'fg-bitem';
      item.dataset.name = name;
      item.innerHTML = `<span class="fg-dirty-dot"></span><span>${name}</span>`;
      item.addEventListener('click', () => {
        if (this._dirtyBrick) {
          this._promptUnsaved(() => this._doLoadBrick(name, item));
        } else {
          this._doLoadBrick(name, item);
        }
      });
      this._blistEl.appendChild(item);
    }
  }

  _doLoadBrick(name, item) {
    document.querySelectorAll('.fg-bitem').forEach(el => el.classList.remove('sel'));
    item.classList.add('sel');
    this._loadBrick(name);
  }

  _promptUnsaved(onConfirm) {
    // Bannière inline, pas de confirm() natif
    const banner = document.createElement('div');
    banner.style.cssText = `position:fixed;top:32px;left:var(--fg-left-w,172px);right:var(--fg-right-w,296px);z-index:60;
      background:#1a1000;border-bottom:1px solid #3a2a00;
      padding:8px 16px;display:flex;align-items:center;gap:12px;
      font:11px monospace;color:#aa8833;`;
    banner.innerHTML = `<span style="flex:1">Modifications non sauvegardées</span>`;
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Sauvegarder';
    saveBtn.style.cssText = 'background:#224;color:#44aa66;border:1px solid #336;border-radius:4px;padding:4px 10px;font:10px monospace;cursor:pointer;';
    const discardBtn = document.createElement('button');
    discardBtn.textContent = 'Ignorer';
    discardBtn.style.cssText = 'background:transparent;color:#778;border:1px solid #222;border-radius:4px;padding:4px 10px;font:10px monospace;cursor:pointer;';
    banner.append(saveBtn, discardBtn);
    document.body.appendChild(banner);
    const close = () => banner.remove();
    saveBtn.addEventListener('click', async () => { close(); await this._saveBrick(); onConfirm(); });
    discardBtn.addEventListener('click', () => { close(); this._dirtyBrick = false; onConfirm(); });
  }
}
