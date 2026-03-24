import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { getManifold, buildCache, manifoldToGeometry } from '../csg-utils.js';

// ─── Stores localStorage ──────────────────────────────────────────────────────

const LS_BRICKS     = 'rbang_bricks';
const LS_SLOT_TYPES = 'rbang_slot_types';
const LS_LIAISONS   = 'rbang_liaisons';

function loadStore(key)       { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } }
function saveStore(key, data) { localStorage.setItem(key, JSON.stringify(data)); }
function uid(prefix = 'id')   { return prefix + '-' + Math.random().toString(36).slice(2, 9); }

// ─── Couleurs DOF ─────────────────────────────────────────────────────────────

const DOF_COLOR = {
  rotation:    0x7aafc8,
  translation: 0xffcc44,
  ball:        0x88cc88,
  cylindrical: 0xff8844,
};

const DOF_LABELS = {
  rotation:    'Pivot',
  translation: 'Glissière',
  ball:        'Rotule',
  cylindrical: 'Pivot glissant',
};

// ─── Forge ────────────────────────────────────────────────────────────────────

export class Forge {

  constructor(engine) {
    this.engine          = engine;
    this._ui             = [];
    this._activeTab      = 'brick';
    this._mecaSubTab     = 'types';
    this._currentBrick   = null;
    this._selectedSlotId = null;
    this._helpers        = [];
    this._xray           = false;
    this._meshGroup      = null;
    this._brickMat       = null;
    this._leftW          = 172;
    this._rightW         = 300;
    this._dirty          = false;
    this._lockedAxis     = null;
    this._lockOffset     = 0;
  }

  // ─── Cycle de vie ─────────────────────────────────────────────────────────

  async start() {
    this._setupScene();
    this._setupUI();
    this._setupResizeHandles();
    this._setupViewWidget();
    this._applyPanelWidths();
    this.engine.start();
  }

  stop() {
    this.engine.stop();
    this._clearScene();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    document.documentElement.style.removeProperty('--fg-left-w');
    document.documentElement.style.removeProperty('--fg-right-w');
    this.engine.resizeViewport(0, 0);
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

    this._origControls         = e.controls;
    this._origControls.enabled = false;

    const tb = new TrackballControls(e.camera, e.renderer.domElement);
    tb.rotateSpeed          = 3.5;
    tb.zoomSpeed            = 1.2;
    tb.panSpeed             = 0.8;
    tb.dynamicDampingFactor = 0.18;
    tb.minDistance          = 0.2;
    tb.maxDistance          = 20;
    tb.keys = ['KeyA', 'KeyS', 'KeyD'];
    e.controls = tb;

    e.camera.position.set(1.5, 1.2, 1.5);
    tb.target.set(0, 0.3, 0);
    tb.update();

    this._fillLight = new THREE.DirectionalLight(0x8899ff, 0.4);
    this._fillLight.position.set(-1, 0.5, -1);
    e.scene.add(this._fillLight);

    e.onPostUpdate = () => this._applyAxisLock();
  }

  _clearScene() {
    this._disposeMeshGroup();
    this._clearHelpers();
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
    this._brickMat  = null;
  }

  // ─── Maillage ─────────────────────────────────────────────────────────────

  async _rebuildMesh() {
    this._disposeMeshGroup();
    if (!this._currentBrick?.shapeRef) return;
    try {
      const shapes = JSON.parse(localStorage.getItem('rbang_shapes') || '{}');
      const data   = shapes[this._currentBrick.shapeRef];
      if (!data?.steps || !data.rootId) { this._setStatus('Shape introuvable dans le catalogue'); return; }

      const M     = await getManifold();
      const cache = buildCache(data.steps, M);
      const mf    = cache.get(data.rootId);
      if (!mf) { this._setStatus('Erreur CSG'); return; }

      const { geo } = manifoldToGeometry(mf);
      const color   = parseInt((this._currentBrick.color || '#888888').replace('#', ''), 16);
      this._brickMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });

      const mesh = new THREE.Mesh(geo, this._brickMat);
      mesh.castShadow = mesh.receiveShadow = true;

      const group  = new THREE.Group();
      group.add(mesh);
      const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      group.position.sub(center);

      this.engine.scene.add(group);
      this._meshGroup = group;
      this._brickCenter = center;
    } catch (err) {
      this._setStatus('Erreur chargement géométrie');
      console.error(err);
    }
    this._rebuildHelpers();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _clearHelpers() {
    for (const g of this._helpers) {
      this.engine.scene.remove(g);
      g.traverse(o => {
        o.geometry?.dispose();
        if (o.material) [].concat(o.material).forEach(m => m.dispose());
      });
    }
    this._helpers = [];
  }

  _rebuildHelpers() {
    this._clearHelpers();
    if (!this._currentBrick?.slots?.length) return;
    const liaisons = Object.values(loadStore(LS_LIAISONS));
    const offset   = this._meshGroup?.position ?? new THREE.Vector3();

    for (const slot of this._currentBrick.slots) {
      const g = this._buildSlotHelper(slot, liaisons, offset);
      this.engine.scene.add(g);
      this._helpers.push(g);
    }
    this._applyXrayToHelpers();
  }

  _buildSlotHelper(slot, liaisons, groupOffset) {
    const group = new THREE.Group();
    const [px, py, pz] = slot.position;
    group.position.set(px + groupOffset.x, py + groupOffset.y, pz + groupOffset.z);
    const [qx, qy, qz, qw] = slot.quaternion;
    group.quaternion.set(qx, qy, qz, qw);

    const selected = slot.id === this._selectedSlotId;
    const axLen    = 0.12;

    // Trièdre XYZ
    const addArrow = (dir, baseColor, selColor) => {
      const color = selected ? selColor : baseColor;
      const a     = new THREE.ArrowHelper(dir, new THREE.Vector3(), axLen, color, axLen * 0.3, axLen * 0.15);
      a.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.depthWrite = false; } o.renderOrder = 998; });
      group.add(a);
    };
    addArrow(new THREE.Vector3(1, 0, 0), 0x992222, 0xff4444);
    addArrow(new THREE.Vector3(0, 1, 0), 0x229922, 0x44ff44);
    addArrow(new THREE.Vector3(0, 0, 1), 0x224499, 0x4488ff);

    // Sphère origine
    const sp = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 8, 8),
      new THREE.MeshBasicMaterial({ color: selected ? 0xffffff : 0x999999, depthWrite: false })
    );
    sp.renderOrder = 999;
    group.add(sp);

    // DOF helpers — liaisons référençant ce type de slot
    for (const liaison of liaisons) {
      if (!liaison.pairs?.some(p => p.typeA === slot.typeId || p.typeB === slot.typeId)) continue;
      for (const dof of (liaison.dof || [])) this._addDofHelper(group, dof);
    }

    return group;
  }

  _addDofHelper(group, dof) {
    const [ax, ay, az] = dof.axis || [0, 0, 1];
    const axis  = new THREE.Vector3(ax, ay, az).normalize();
    const color = DOF_COLOR[dof.type] ?? 0xffffff;
    const mat   = () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });

    const alignToAxis = (mesh) => {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      mesh.renderOrder = 997;
    };

    const addArrows = () => {
      [axis.clone(), axis.clone().negate()].forEach(dir => {
        const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), 0.16, color, 0.05, 0.03);
        a.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.depthWrite = false; } o.renderOrder = 997; });
        group.add(a);
      });
    };

    switch (dof.type) {
      case 'rotation': {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.014, 24, 1, true), mat());
        alignToAxis(m);
        group.add(m);
        break;
      }
      case 'translation': {
        addArrows();
        break;
      }
      case 'ball': {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), mat());
        m.renderOrder = 997;
        group.add(m);
        break;
      }
      case 'cylindrical': {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.014, 24, 1, true), mat());
        alignToAxis(m);
        group.add(m);
        addArrows();
        break;
      }
    }
  }

  _applyXrayToHelpers() {
    for (const g of this._helpers) {
      g.traverse(o => { if (o.material) o.material.depthTest = !this._xray; });
    }
  }

  _setXray(v) {
    this._xray = v;
    if (this._xrayBtn) this._xrayBtn.classList.toggle('active', v);
    this._applyXrayToHelpers();
  }

  // ─── Stores ───────────────────────────────────────────────────────────────

  _bricks()         { return loadStore(LS_BRICKS); }
  _slotTypes()      { return loadStore(LS_SLOT_TYPES); }
  _liaisons()       { return loadStore(LS_LIAISONS); }
  _saveBricks(s)    { saveStore(LS_BRICKS, s); }
  _saveSlotTypes(s) { saveStore(LS_SLOT_TYPES, s); }
  _saveLiaisons(s)  { saveStore(LS_LIAISONS, s); }

  // ─── Briques ──────────────────────────────────────────────────────────────

  _saveBrick() {
    if (!this._currentBrick) return;
    const store = this._bricks();
    store[this._currentBrick.id] = { ...this._currentBrick, updatedAt: new Date().toISOString() };
    this._saveBricks(store);
    this._dirty = false;
    this._updateSaveBtn();
    this._renderBrickList();
    this._setStatus('Brique sauvegardée');
  }

  _markDirty() { this._dirty = true; this._updateSaveBtn(); }

  _updateSaveBtn() {
    if (this._saveBrickBtn) this._saveBrickBtn.classList.toggle('active', this._dirty);
  }

  _newBrickFromShape(shapeName) {
    this._currentBrick   = { id: uid('br'), name: shapeName, shapeRef: shapeName, color: '#7aafc8', slots: [], createdAt: new Date().toISOString() };
    this._selectedSlotId = null;
    this._dirty          = true;
    this._rebuildMesh();
    this._renderBrickList();
    this._renderActiveTab();
    this._updateSaveBtn();
  }

  _loadBrick(id) {
    const b = this._bricks()[id];
    if (!b) return;
    this._currentBrick   = { ...b, slots: b.slots ? b.slots.map(s => ({ ...s })) : [] };
    this._selectedSlotId = null;
    this._dirty          = false;
    this._rebuildMesh();
    this._renderActiveTab();
    this._updateSaveBtn();
  }

  _deleteBrick(id) {
    const store = this._bricks();
    delete store[id];
    this._saveBricks(store);
    if (this._currentBrick?.id === id) {
      this._currentBrick = null;
      this._disposeMeshGroup();
      this._clearHelpers();
      this._renderActiveTab();
    }
    this._renderBrickList();
  }

  _setBrickColor(hex) {
    if (!this._currentBrick) return;
    this._currentBrick.color = hex;
    if (this._brickMat) this._brickMat.color.setStyle(hex);
    this._markDirty();
  }

  _setBrickName(name) {
    if (!this._currentBrick) return;
    this._currentBrick.name = name;
    this._markDirty();
    this._renderBrickList();
  }

  // ─── Slots ────────────────────────────────────────────────────────────────

  _addSlot() {
    if (!this._currentBrick) return;
    const slot = { id: uid('sl'), typeId: null, position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    this._currentBrick.slots.push(slot);
    this._selectedSlotId = slot.id;
    this._markDirty();
    this._rebuildHelpers();
    this._renderSlotsTab();
  }

  _deleteSlot(id) {
    if (!this._currentBrick) return;
    this._currentBrick.slots = this._currentBrick.slots.filter(s => s.id !== id);
    if (this._selectedSlotId === id) this._selectedSlotId = null;
    this._markDirty();
    this._rebuildHelpers();
    this._renderSlotsTab();
  }

  _selectSlot(id) {
    this._selectedSlotId = id;
    this._rebuildHelpers();
    this._renderSlotsTab();
  }

  _updateSlotPos(id, xyz) {
    const s = this._currentBrick?.slots.find(s => s.id === id);
    if (!s) return;
    s.position = xyz;
    this._markDirty();
    this._rebuildHelpers();
  }

  _rotateSlot(id, axis, deg) {
    const s = this._currentBrick?.slots.find(s => s.id === id);
    if (!s) return;
    const q   = new THREE.Quaternion(...s.quaternion);
    const rot = new THREE.Quaternion().setFromAxisAngle(
      { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) }[axis],
      deg * Math.PI / 180
    );
    q.premultiply(rot);
    s.quaternion = [q.x, q.y, q.z, q.w];
    this._markDirty();
    this._rebuildHelpers();
    this._renderSlotEditor(id);
  }

  _setSlotType(id, typeId) {
    const s = this._currentBrick?.slots.find(s => s.id === id);
    if (!s) return;
    s.typeId = typeId || null;
    this._markDirty();
    this._rebuildHelpers();
  }

  // ─── Types de slots ───────────────────────────────────────────────────────

  _addSlotType(name) {
    const store = this._slotTypes();
    const id    = uid('st');
    store[id]   = { id, name: name || ('Type ' + (Object.keys(store).length + 1)) };
    this._saveSlotTypes(store);
    return id;
  }

  _deleteSlotType(id) {
    const store = this._slotTypes();
    delete store[id];
    this._saveSlotTypes(store);
    this._renderMecaTab();
  }

  _renameSlotType(id, name) {
    const store = this._slotTypes();
    if (store[id]) { store[id].name = name; this._saveSlotTypes(store); }
  }

  // ─── Liaisons ─────────────────────────────────────────────────────────────

  _addLiaison() {
    const store = this._liaisons();
    const id    = uid('li');
    store[id]   = { id, name: 'Liaison ' + (Object.keys(store).length + 1), pairs: [], dof: [] };
    this._saveLiaisons(store);
    this._renderMecaTab();
  }

  _deleteLiaison(id) {
    const store = this._liaisons();
    delete store[id];
    this._saveLiaisons(store);
    this._renderMecaTab();
  }

  _patchLiaison(id, patch) {
    const store = this._liaisons();
    if (!store[id]) return;
    Object.assign(store[id], patch);
    this._saveLiaisons(store);
    this._rebuildHelpers();
  }

  _addLiaisonPair(liId, typeA, typeB) {
    const store = this._liaisons();
    if (!store[liId]) return;
    store[liId].pairs.push({ typeA, typeB });
    this._saveLiaisons(store);
    this._renderMecaTab();
  }

  _removeLiaisonPair(liId, idx) {
    const store = this._liaisons();
    if (!store[liId]) return;
    store[liId].pairs.splice(idx, 1);
    this._saveLiaisons(store);
    this._renderMecaTab();
  }

  _addLiaisonDof(liId, dof) {
    const store = this._liaisons();
    if (!store[liId]) return;
    store[liId].dof.push(dof);
    this._saveLiaisons(store);
    this._renderMecaTab();
    this._rebuildHelpers();
  }

  _removeLiaisonDof(liId, idx) {
    const store = this._liaisons();
    if (!store[liId]) return;
    store[liId].dof.splice(idx, 1);
    this._saveLiaisons(store);
    this._renderMecaTab();
    this._rebuildHelpers();
  }

  // ─── Export / Import ──────────────────────────────────────────────────────

  _exportBricks() {
    this._download('rbang-bricks.json', this._bricks());
  }

  _exportMeca() {
    this._download('rbang-meca.json', { slotTypes: this._slotTypes(), liaisons: this._liaisons() });
  }

  _download(filename, data) {
    const a = document.createElement('a');
    a.href  = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _importBricks(file) {
    this._readJSON(file, d => {
      this._saveBricks({ ...this._bricks(), ...d });
      this._renderBrickList();
      this._setStatus(`${Object.keys(d).length} brique(s) importée(s)`);
    });
  }

  _importMeca(file) {
    this._readJSON(file, d => {
      if (d.slotTypes) this._saveSlotTypes({ ...this._slotTypes(), ...d.slotTypes });
      if (d.liaisons)  this._saveLiaisons({ ...this._liaisons(), ...d.liaisons });
      this._renderMecaTab();
      this._setStatus('Données méca importées');
    });
  }

  _readJSON(file, cb) {
    const r = new FileReader();
    r.onload = e => { try { cb(JSON.parse(e.target.result)); } catch { this._setStatus('Fichier invalide'); } };
    r.readAsText(file);
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
      .fg-left  { position:fixed; left:0; top:0; bottom:0; width:var(--fg-left-w,172px);
        background:var(--fg-bg2); border-right:1px solid var(--fg-border);
        box-shadow:inset -1px 0 0 var(--fg-bevel);
        display:flex; flex-direction:column; z-index:50; }
      .fg-right { position:fixed; right:0; top:0; bottom:0; width:var(--fg-right-w,300px);
        background:var(--fg-bg); border-left:1px solid var(--fg-border);
        box-shadow:inset 1px 0 0 var(--fg-bevel);
        display:flex; flex-direction:column; z-index:50; }

      /* ── Poignées ── */
      .fg-handle { position:fixed; top:0; bottom:0; width:28px; z-index:61;
        cursor:col-resize; touch-action:none; }
      .fg-handle-left  { left:calc(var(--fg-left-w,172px) - 14px); }
      .fg-handle-right { right:calc(var(--fg-right-w,300px) - 14px); }

      /* ── En-têtes ── */
      .fg-head { padding:9px 12px; font:700 9px/1 sans-serif; color:var(--fg-text);
        text-transform:uppercase; letter-spacing:.12em; flex-shrink:0;
        background:linear-gradient(to bottom,#404040,#323232);
        border-bottom:1px solid var(--fg-border); box-shadow:0 1px 0 var(--fg-bevel); }

      /* ── Liste briques ── */
      .fg-blist { flex:1; overflow-y:auto; padding:2px 0; }
      .fg-blist::-webkit-scrollbar       { width:6px; }
      .fg-blist::-webkit-scrollbar-track { background:var(--fg-bg2); }
      .fg-blist::-webkit-scrollbar-thumb { background:#555; border-radius:2px; }
      .fg-bitem { padding:5px 10px 5px 12px; cursor:pointer; font:11px sans-serif;
        color:var(--fg-text); border-left:3px solid transparent;
        display:flex; align-items:center; gap:5px; }
      .fg-bitem.sel { background:var(--fg-sel); color:var(--fg-text2); border-left-color:var(--fg-accent); }
      .fg-bitem-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fg-bdel { font:12px sans-serif; color:var(--fg-dim); padding:0 2px; flex-shrink:0; }
      .fg-bactions { padding:8px; border-top:1px solid var(--fg-border);
        display:flex; flex-direction:column; gap:4px; flex-shrink:0; }

      /* ── Tabs ── */
      .fg-tabs { display:flex; border-bottom:1px solid var(--fg-border); flex-shrink:0;
        background:linear-gradient(to bottom,#3a3a3a,#303030);
        box-shadow:0 1px 0 var(--fg-bevel); }
      .fg-tab  { flex:1; padding:8px 4px; text-align:center; cursor:pointer;
        font:9px sans-serif; color:var(--fg-dim); text-transform:uppercase;
        letter-spacing:.08em; border-bottom:2px solid transparent; }
      .fg-tab.active { color:var(--fg-accent); border-bottom-color:var(--fg-accent); }
      .fg-tab-content { flex:1; overflow-y:auto; padding:12px;
        display:flex; flex-direction:column; gap:10px; }
      .fg-tab-content::-webkit-scrollbar       { width:6px; }
      .fg-tab-content::-webkit-scrollbar-track { background:var(--fg-bg); }
      .fg-tab-content::-webkit-scrollbar-thumb { background:#555; border-radius:2px; }

      /* ── Sous-onglets ── */
      .fg-subtabs { display:flex; gap:3px; flex-shrink:0; }
      .fg-subtab  { flex:1; padding:5px 4px; text-align:center; cursor:pointer;
        font:9px sans-serif; color:var(--fg-dim); text-transform:uppercase;
        letter-spacing:.08em; border:1px solid var(--fg-border); border-radius:2px;
        background:linear-gradient(to bottom,#484848,#383838);
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004; }
      .fg-subtab.active { color:var(--fg-accent); border-color:var(--fg-accent);
        background:var(--fg-sel); box-shadow:inset 0 1px 3px #0006; }

      /* ── Éléments génériques ── */
      .fg-label { font:700 9px sans-serif; color:var(--fg-dim); text-transform:uppercase;
        letter-spacing:.1em; margin-bottom:4px; }
      .fg-input { width:100%; box-sizing:border-box; background:#272727;
        color:var(--fg-text2); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006; padding:5px 8px; font:12px sans-serif; }
      .fg-input:focus { outline:none; border-color:var(--fg-accent); }
      .fg-select { width:100%; background:#272727; color:var(--fg-text2);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006; padding:5px 7px; font:11px sans-serif; }
      .fg-btn { padding:6px 10px; background:linear-gradient(to bottom,#484848,#383838);
        color:var(--fg-text); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; font:10px sans-serif; }
      .fg-btn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }
      .fg-btn.w100 { width:100%; }
      .fg-btn.accent { background:linear-gradient(to bottom,#3a5a3a,#2a4a2a);
        color:#88cc88; border-color:#2a4a2a; }
      .fg-btn.active { background:linear-gradient(to bottom,#3a5a3a,#2a4a2a);
        color:#88cc88; border-color:#2a4a2a; box-shadow:inset 0 1px 0 #4a7a4a; }
      .fg-section { border-bottom:1px solid var(--fg-border); padding-bottom:10px; }
      .fg-noselbanner { font:11px sans-serif; color:var(--fg-dim);
        text-align:center; padding:20px 0; }

      /* ── Color picker ── */
      .fg-colorpicker { display:flex; align-items:center; gap:8px; }
      .fg-colorpreview { width:40px; height:40px; border-radius:2px;
        border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; flex-shrink:0; }
      .fg-colorinput { position:absolute; opacity:0; width:1px; height:1px; }

      /* ── Slots liste ── */
      .fg-slist { display:flex; flex-direction:column; gap:2px; }
      .fg-sitem { display:flex; align-items:center; gap:6px; padding:5px 7px;
        border-radius:2px; cursor:pointer; border:1px solid transparent; }
      .fg-sitem.sel { background:var(--fg-sel); border-color:var(--fg-bevel); }
      .fg-sdot { width:9px; height:9px; border-radius:50%; background:var(--fg-accent); flex-shrink:0; }
      .fg-sname { flex:1; font:11px sans-serif; color:var(--fg-text);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fg-sdel { font:12px sans-serif; color:var(--fg-dim); cursor:pointer; padding:0 2px; }

      /* ── Éditeur slot ── */
      .fg-sloteditor { background:var(--fg-bg2); border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 3px #0004; border-radius:2px;
        padding:10px; display:flex; flex-direction:column; gap:9px; }
      .fg-coords { display:flex; gap:4px; }
      .fg-coord  { flex:1; width:0; background:#272727; color:var(--fg-text2);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 3px #0006; padding:4px 5px; font:11px sans-serif; }
      .fg-coord:focus { outline:none; border-color:var(--fg-accent); }
      .fg-rotbtns { display:grid; grid-template-columns:repeat(3,1fr); gap:3px; }
      .fg-rotbtn { padding:5px 2px; background:linear-gradient(to bottom,#484848,#383838);
        color:var(--fg-text); border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; font:10px sans-serif; text-align:center; }
      .fg-rotbtn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }
      .fg-quat-info { font:10px monospace; color:var(--fg-dim); background:var(--fg-bg2);
        padding:4px 7px; border-radius:2px; border:1px solid var(--fg-border);
        word-break:break-all; line-height:1.5; }

      /* ── Méca ── */
      .fg-meca-item { background:var(--fg-bg2); border:1px solid var(--fg-border);
        border-radius:2px; padding:8px; margin-bottom:5px; }
      .fg-meca-hdr { display:flex; align-items:center; gap:6px;
        margin-bottom:6px; padding-bottom:5px; border-bottom:1px solid var(--fg-border); }
      .fg-meca-name { flex:1; font:700 10px sans-serif; color:var(--fg-text2); }
      .fg-meca-row { display:flex; align-items:center; gap:6px; margin-bottom:4px; font:10px sans-serif; }
      .fg-meca-key { color:var(--fg-dim); min-width:64px; flex-shrink:0; }
      .fg-pair-tag { background:#3a3a3a; border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 0 var(--fg-bevel); border-radius:2px;
        padding:2px 6px; font:9px sans-serif; color:var(--fg-text);
        display:inline-flex; align-items:center; gap:4px; }
      .fg-pair-del { cursor:pointer; color:var(--fg-dim); }
      .fg-dof-tag  { display:inline-flex; align-items:center; gap:4px;
        padding:2px 6px; border-radius:2px; font:9px sans-serif; border:1px solid var(--fg-border);
        box-shadow:inset 0 1px 0 var(--fg-bevel); background:#3a3a3a; }
      .fg-add-form { background:var(--fg-bg2); border:1px dashed var(--fg-bevel);
        border-radius:2px; padding:8px; display:flex; flex-direction:column; gap:6px; }
      .fg-row { display:flex; gap:6px; align-items:center; }

      /* ── Table vue d'ensemble ── */
      .fg-overview { overflow-x:auto; margin-bottom:8px; }
      .fg-ov-table { border-collapse:collapse; font:9px sans-serif; }
      .fg-ov-table th, .fg-ov-table td { padding:3px 6px;
        border:1px solid var(--fg-border); text-align:center; }
      .fg-ov-table th { background:linear-gradient(to bottom,#404040,#333);
        color:var(--fg-text); font-weight:700; }
      .fg-ov-table td { color:var(--fg-dim); }
      .fg-ov-table td.hit { color:var(--fg-accent); background:var(--fg-sel); }

      /* ── Zone sauvegarde ── */
      .fg-savezone { display:flex; gap:6px; padding:8px 10px;
        border-top:1px solid var(--fg-border);
        background:linear-gradient(to bottom,#3a3a3a,#2e2e2e);
        box-shadow:inset 0 1px 0 var(--fg-bevel); flex-shrink:0; }
      .fg-savebtn { flex:1; padding:9px 6px; border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        font:11px/1 sans-serif; font-weight:700; cursor:pointer;
        background:linear-gradient(to bottom,#484848,#383838); color:var(--fg-dim); }
      .fg-savebtn.active { background:linear-gradient(to bottom,#3a5a3a,#2a4a2a);
        color:#88cc88; border-color:#2a4a2a; }
      .fg-savebtn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }

      /* ── Barre statut ── */
      .fg-bar { position:fixed; top:0; left:var(--fg-left-w,172px); right:var(--fg-right-w,300px);
        height:36px; background:linear-gradient(to bottom,#444,#383838);
        border-bottom:1px solid var(--fg-border);
        box-shadow:0 1px 0 var(--fg-bevel), 0 2px 6px #0005;
        display:flex; align-items:center; justify-content:center; gap:1rem;
        z-index:40; font:10px sans-serif; color:var(--fg-text); }
      .fg-xraybtn { padding:4px 10px; background:linear-gradient(to bottom,#484848,#383838);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel);
        cursor:pointer; font:9px sans-serif; color:var(--fg-dim);
        pointer-events:all; }
      .fg-xraybtn.active { color:var(--fg-accent); border-color:var(--fg-accent);
        background:var(--fg-sel); }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // ── Panneau gauche : liste des briques ────────────────────────────────
    const left = document.createElement('div');
    left.className = 'fg-left';
    const leftHead = document.createElement('div');
    leftHead.className = 'fg-head';
    leftHead.textContent = 'Briques';
    this._blistEl = document.createElement('div');
    this._blistEl.className = 'fg-blist';
    const leftActions = document.createElement('div');
    leftActions.className = 'fg-bactions';

    const importCatBtn = document.createElement('button');
    importCatBtn.className = 'fg-btn w100';
    importCatBtn.textContent = '+ Depuis catalogue';
    importCatBtn.addEventListener('click', () => this._showCataloguePicker());

    const exportBricksBtn = document.createElement('button');
    exportBricksBtn.className = 'fg-btn w100';
    exportBricksBtn.textContent = '↓ Exporter';
    exportBricksBtn.addEventListener('click', () => this._exportBricks());

    const importBricksInput = document.createElement('input');
    importBricksInput.type = 'file'; importBricksInput.accept = '.json';
    importBricksInput.style.display = 'none';
    importBricksInput.addEventListener('change', e => { if (e.target.files[0]) this._importBricks(e.target.files[0]); });

    const importBricksBtn = document.createElement('button');
    importBricksBtn.className = 'fg-btn w100';
    importBricksBtn.textContent = '↑ Importer';
    importBricksBtn.addEventListener('click', () => importBricksInput.click());

    leftActions.append(importCatBtn, exportBricksBtn, importBricksBtn, importBricksInput);
    left.append(leftHead, this._blistEl, leftActions);
    document.body.appendChild(left);
    this._ui.push(left);

    // ── Panneau droit : tabs ──────────────────────────────────────────────
    const right = document.createElement('div');
    right.className = 'fg-right';

    const tabBar = document.createElement('div');
    tabBar.className = 'fg-tabs';
    const TABS = [
      { id: 'brick', label: '🧱 Brique' },
      { id: 'slots', label: '● Slots'   },
      { id: 'meca',  label: '⚙ Méca'    },
    ];
    this._tabEls = {};
    TABS.forEach(({ id, label }) => {
      const t = document.createElement('div');
      t.className = 'fg-tab' + (id === this._activeTab ? ' active' : '');
      t.textContent = label;
      t.addEventListener('click', () => this._switchTab(id));
      tabBar.appendChild(t);
      this._tabEls[id] = t;
    });
    right.appendChild(tabBar);

    this._tabContentEl = document.createElement('div');
    this._tabContentEl.className = 'fg-tab-content';
    right.appendChild(this._tabContentEl);

    // Zone de sauvegarde
    const saveZone = document.createElement('div');
    saveZone.className = 'fg-savezone';
    this._saveBrickBtn = document.createElement('button');
    this._saveBrickBtn.className = 'fg-savebtn';
    this._saveBrickBtn.textContent = '💾 Sauvegarder';
    this._saveBrickBtn.addEventListener('click', () => this._saveBrick());
    saveZone.appendChild(this._saveBrickBtn);
    right.appendChild(saveZone);

    document.body.appendChild(right);
    this._ui.push(right);

    // ── Barre de statut centrale ──────────────────────────────────────────
    this._barEl = document.createElement('div');
    this._barEl.className = 'fg-bar';

    const barTitle = document.createElement('span');
    barTitle.textContent = 'Forge';
    this._barTitle = barTitle;

    this._xrayBtn = document.createElement('button');
    this._xrayBtn.className = 'fg-xraybtn';
    this._xrayBtn.textContent = 'X-RAY';
    this._xrayBtn.title = 'Helpers visibles à travers la géométrie';
    this._xrayBtn.addEventListener('click', () => this._setXray(!this._xray));

    this._barEl.append(barTitle, this._xrayBtn);
    document.body.appendChild(this._barEl);
    this._ui.push(this._barEl);

    // ── Rendu initial ─────────────────────────────────────────────────────
    this._renderBrickList();
    this._renderActiveTab();
    this._updateSaveBtn();
  }

  // ─── Catalogue picker ──────────────────────────────────────────────────────

  _showCataloguePicker() {
    const shapes = Object.keys(JSON.parse(localStorage.getItem('rbang_shapes') || '{}'));
    if (!shapes.length) { this._setStatus('Catalogue vide — crée des formes dans le Modeler'); return; }

    // Overlay picker
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:#0009;z-index:200;display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--fg-bg);border:1px solid var(--fg-border);border-radius:2px;min-width:220px;max-height:60vh;display:flex;flex-direction:column;overflow:hidden;';

    const head = document.createElement('div');
    head.style.cssText = 'padding:9px 12px;font:700 9px sans-serif;color:var(--fg-text);text-transform:uppercase;letter-spacing:.1em;background:linear-gradient(to bottom,#404040,#323232);border-bottom:1px solid var(--fg-border);';
    head.textContent = 'Choisir une forme';

    const list = document.createElement('div');
    list.style.cssText = 'overflow-y:auto;flex:1;';

    shapes.forEach(name => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 14px;font:11px sans-serif;color:var(--fg-text);cursor:pointer;border-bottom:1px solid var(--fg-border);';
      row.textContent = name;
      row.addEventListener('click', () => {
        overlay.remove();
        this._newBrickFromShape(name);
      });
      list.appendChild(row);
    });

    const cancel = document.createElement('button');
    cancel.style.cssText = 'margin:8px;padding:6px;background:linear-gradient(to bottom,#484848,#383838);color:var(--fg-dim);border:1px solid var(--fg-border);border-radius:2px;cursor:pointer;font:10px sans-serif;';
    cancel.textContent = 'Annuler';
    cancel.addEventListener('click', () => overlay.remove());

    box.append(head, list, cancel);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // ─── Liste briques ─────────────────────────────────────────────────────────

  _renderBrickList() {
    const el    = this._blistEl;
    const store = this._bricks();
    el.innerHTML = '';

    const names = Object.values(store);
    if (!names.length) {
      el.innerHTML = '<div style="padding:12px;font:10px sans-serif;color:var(--fg-dim);text-align:center;">Aucune brique</div>';
      return;
    }

    for (const b of names) {
      const row = document.createElement('div');
      row.className = 'fg-bitem' + (b.id === this._currentBrick?.id ? ' sel' : '');
      const name = document.createElement('span');
      name.className = 'fg-bitem-name';
      name.textContent = b.name || b.id;
      const del = document.createElement('span');
      del.className = 'fg-bdel';
      del.textContent = '✕';
      del.title = 'Supprimer';
      del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteBrick(b.id); });
      row.append(name, del);
      row.addEventListener('click', () => this._loadBrick(b.id));
      el.appendChild(row);
    }
  }

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  _switchTab(id) {
    this._activeTab = id;
    Object.entries(this._tabEls).forEach(([k, el]) => el.classList.toggle('active', k === id));
    this._renderActiveTab();
  }

  _renderActiveTab() {
    switch (this._activeTab) {
      case 'brick': this._renderBrickTab(); break;
      case 'slots': this._renderSlotsTab(); break;
      case 'meca':  this._renderMecaTab();  break;
    }
  }

  // ─── Tab Brique ───────────────────────────────────────────────────────────

  _renderBrickTab() {
    const el = this._tabContentEl;
    el.innerHTML = '';

    if (!this._currentBrick) {
      el.innerHTML = '<div class="fg-noselbanner">← Sélectionne ou crée une brique</div>';
      return;
    }
    const b = this._currentBrick;

    // Nom
    const nameSec = document.createElement('div');
    nameSec.className = 'fg-section';
    const nameLbl = document.createElement('div');
    nameLbl.className = 'fg-label'; nameLbl.textContent = 'Nom';
    const nameInp = document.createElement('input');
    nameInp.className = 'fg-input'; nameInp.value = b.name || '';
    nameInp.addEventListener('input', e => this._setBrickName(e.target.value));
    nameSec.append(nameLbl, nameInp);
    el.appendChild(nameSec);

    // Géométrie (référence shape)
    const geoSec = document.createElement('div');
    geoSec.className = 'fg-section';
    const geoLbl = document.createElement('div');
    geoLbl.className = 'fg-label'; geoLbl.textContent = 'Géométrie';
    const geoRef = document.createElement('div');
    geoRef.style.cssText = 'font:10px monospace;color:var(--fg-accent);padding:4px 7px;background:var(--fg-bg2);border:1px solid var(--fg-border);border-radius:2px;';
    geoRef.textContent = b.shapeRef || '—';
    geoSec.append(geoLbl, geoRef);
    el.appendChild(geoSec);

    // Couleur
    const colorSec = document.createElement('div');
    colorSec.className = 'fg-section';
    const colorLbl = document.createElement('div');
    colorLbl.className = 'fg-label'; colorLbl.textContent = 'Couleur';
    const colorRow = document.createElement('div');
    colorRow.className = 'fg-colorpicker';
    const preview = document.createElement('div');
    preview.className = 'fg-colorpreview'; preview.style.background = b.color || '#888';
    const hiddenInp = document.createElement('input');
    hiddenInp.type = 'color'; hiddenInp.className = 'fg-colorinput'; hiddenInp.value = b.color || '#888888';
    preview.addEventListener('click', () => hiddenInp.click());
    hiddenInp.addEventListener('input', e => { preview.style.background = e.target.value; this._setBrickColor(e.target.value); });
    const hexInp = document.createElement('input');
    hexInp.className = 'fg-input'; hexInp.value = b.color || '#888888';
    hexInp.addEventListener('change', e => {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
        preview.style.background = e.target.value; hiddenInp.value = e.target.value;
        this._setBrickColor(e.target.value);
      }
    });
    colorRow.append(preview, hiddenInp, hexInp);
    colorSec.append(colorLbl, colorRow);
    el.appendChild(colorSec);

    // Résumé slots
    const slotSec = document.createElement('div');
    const slotLbl = document.createElement('div');
    slotLbl.className = 'fg-label'; slotLbl.textContent = 'Slots';
    const slotCount = document.createElement('div');
    slotCount.style.cssText = 'font:10px sans-serif;color:var(--fg-dim);';
    slotCount.textContent = (b.slots?.length || 0) + ' slot(s) défini(s)';
    slotSec.append(slotLbl, slotCount);
    el.appendChild(slotSec);
  }

  // ─── Tab Slots ────────────────────────────────────────────────────────────

  _renderSlotsTab() {
    const el = this._tabContentEl;
    el.innerHTML = '';

    if (!this._currentBrick) {
      el.innerHTML = '<div class="fg-noselbanner">← Charge une brique</div>';
      return;
    }

    const slots     = this._currentBrick.slots || [];
    const slotTypes = this._slotTypes();

    // Liste
    const list = document.createElement('div');
    list.className = 'fg-slist';
    slots.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'fg-sitem' + (s.id === this._selectedSlotId ? ' sel' : '');
      const dot  = document.createElement('span'); dot.className = 'fg-sdot';
      const name = document.createElement('span'); name.className = 'fg-sname';
      name.textContent = slotTypes[s.typeId]?.name ? `${i + 1}. ${slotTypes[s.typeId].name}` : `Slot ${i + 1}`;
      const del  = document.createElement('span'); del.className = 'fg-sdel'; del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); this._deleteSlot(s.id); });
      row.append(dot, name, del);
      row.addEventListener('click', () => this._selectSlot(s.id));
      list.appendChild(row);
    });
    el.appendChild(list);

    // Éditeur du slot sélectionné
    if (this._selectedSlotId) {
      const editorContainer = document.createElement('div');
      editorContainer.id = 'fg-slot-editor';
      el.appendChild(editorContainer);
      this._renderSlotEditor(this._selectedSlotId);
    }

    // Bouton ajouter
    const addBtn = document.createElement('button');
    addBtn.className = 'fg-btn w100'; addBtn.textContent = '+ Ajouter un slot';
    addBtn.addEventListener('click', () => this._addSlot());
    el.appendChild(addBtn);
  }

  _renderSlotEditor(slotId) {
    const container = document.getElementById('fg-slot-editor');
    if (!container) return;
    const s = this._currentBrick?.slots.find(s => s.id === slotId);
    if (!s) return;
    container.innerHTML = '';

    const slotTypes = this._slotTypes();
    const editor = document.createElement('div');
    editor.className = 'fg-sloteditor';

    // Type
    const typeLbl = document.createElement('div'); typeLbl.className = 'fg-label'; typeLbl.textContent = 'Type';
    const typeSel = document.createElement('select'); typeSel.className = 'fg-select';
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '— aucun —';
    typeSel.appendChild(noneOpt);
    Object.values(slotTypes).forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      if (t.id === s.typeId) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener('change', e => this._setSlotType(slotId, e.target.value));
    editor.append(typeLbl, typeSel);

    // Position
    const posLbl = document.createElement('div'); posLbl.className = 'fg-label'; posLbl.textContent = 'Position';
    const coordRow = document.createElement('div'); coordRow.className = 'fg-coords';
    ['X', 'Y', 'Z'].forEach((ax, i) => {
      const inp = document.createElement('input');
      inp.className = 'fg-coord'; inp.type = 'text'; inp.placeholder = ax;
      inp.value = s.position[i]?.toFixed(4) ?? '0';
      inp.addEventListener('change', () => {
        const xyz = ['X', 'Y', 'Z'].map((_, j) => {
          const sibling = coordRow.children[j];
          return parseFloat(sibling.value) || 0;
        });
        this._updateSlotPos(slotId, xyz);
      });
      coordRow.appendChild(inp);
    });
    editor.append(posLbl, coordRow);

    // Boutons de rotation
    const rotLbl = document.createElement('div'); rotLbl.className = 'fg-label'; rotLbl.textContent = 'Rotation (±90°)';
    const rotGrid = document.createElement('div'); rotGrid.className = 'fg-rotbtns';
    [['+ X', 'x', 90], ['+ Y', 'y', 90], ['+ Z', 'z', 90],
     ['− X', 'x',-90], ['− Y', 'y',-90], ['− Z', 'z',-90]].forEach(([lbl, ax, deg]) => {
      const b = document.createElement('button');
      b.className = 'fg-rotbtn'; b.textContent = lbl;
      b.addEventListener('click', () => this._rotateSlot(slotId, ax, deg));
      rotGrid.appendChild(b);
    });
    editor.append(rotLbl, rotGrid);

    // Quaternion (lecture seule)
    const quatLbl = document.createElement('div'); quatLbl.className = 'fg-label'; quatLbl.textContent = 'Quaternion';
    const quatInfo = document.createElement('div'); quatInfo.className = 'fg-quat-info';
    const [qx, qy, qz, qw] = s.quaternion.map(v => v.toFixed(4));
    quatInfo.textContent = `x ${qx}  y ${qy}  z ${qz}  w ${qw}`;
    editor.append(quatLbl, quatInfo);

    container.appendChild(editor);
  }

  // ─── Tab Méca ─────────────────────────────────────────────────────────────

  _renderMecaTab() {
    const el = this._tabContentEl;
    el.innerHTML = '';

    // Sous-onglets
    const subtabs = document.createElement('div');
    subtabs.className = 'fg-subtabs';
    [{ id: 'types', label: 'Types de slots' }, { id: 'liaisons', label: 'Liaisons' }].forEach(({ id, label }) => {
      const t = document.createElement('div');
      t.className = 'fg-subtab' + (id === this._mecaSubTab ? ' active' : '');
      t.textContent = label;
      t.addEventListener('click', () => { this._mecaSubTab = id; this._renderMecaTab(); });
      subtabs.appendChild(t);
    });
    el.appendChild(subtabs);

    // Table vue d'ensemble (partagée)
    this._renderOverviewTable(el);

    if (this._mecaSubTab === 'types') this._renderMecaTypesSubTab(el);
    else                              this._renderMecaLiaisonsSubTab(el);
  }

  _renderOverviewTable(container) {
    const slotTypes = Object.values(this._slotTypes());
    const liaisons  = Object.values(this._liaisons());

    if (!slotTypes.length) {
      const msg = document.createElement('div');
      msg.style.cssText = 'font:10px sans-serif;color:var(--fg-dim);padding:4px 0 8px;';
      msg.textContent = 'Aucun type de slot défini.';
      container.appendChild(msg);
      return;
    }

    // Calculer les cellules actives (couple de types couverts par une liaison)
    const hitSet = new Set();
    for (const li of liaisons) {
      for (const p of (li.pairs || [])) hitSet.add(p.typeA + '|' + p.typeB);
    }

    const wrap = document.createElement('div'); wrap.className = 'fg-overview';
    const tbl  = document.createElement('table'); tbl.className = 'fg-ov-table';
    const thead = tbl.createTHead();
    const hrow  = thead.insertRow();
    hrow.insertCell().textContent = '';
    slotTypes.forEach(t => { const th = document.createElement('th'); th.textContent = t.name; hrow.appendChild(th); });

    const tbody = tbl.createTBody();
    slotTypes.forEach(ta => {
      const row = tbody.insertRow();
      const th  = document.createElement('th'); th.textContent = ta.name; row.appendChild(th);
      slotTypes.forEach(tb => {
        const td  = row.insertCell();
        const hit = hitSet.has(ta.id + '|' + tb.id) || hitSet.has(tb.id + '|' + ta.id);
        td.textContent = hit ? '●' : '·';
        if (hit) td.className = 'hit';
      });
    });

    wrap.appendChild(tbl);
    container.appendChild(wrap);
  }

  _renderMecaTypesSubTab(container) {
    const slotTypes = this._slotTypes();

    // Liste des types
    const list = document.createElement('div');
    Object.values(slotTypes).forEach(t => {
      const item = document.createElement('div'); item.className = 'fg-meca-item';
      const hdr  = document.createElement('div'); hdr.className = 'fg-meca-hdr';
      const name = document.createElement('input'); name.className = 'fg-input';
      name.value = t.name; name.style.flex = '1';
      name.addEventListener('change', e => this._renameSlotType(t.id, e.target.value));
      const del = document.createElement('button'); del.className = 'fg-btn'; del.textContent = '✕';
      del.addEventListener('click', () => this._deleteSlotType(t.id));
      hdr.append(name, del);
      item.appendChild(hdr);
      list.appendChild(item);
    });
    container.appendChild(list);

    // Formulaire ajout type
    const form = document.createElement('div'); form.className = 'fg-add-form';
    const formLbl = document.createElement('div'); formLbl.className = 'fg-label'; formLbl.textContent = 'Nouveau type';
    const nameInp = document.createElement('input'); nameInp.className = 'fg-input'; nameInp.placeholder = 'Nom du type…';
    const addBtn  = document.createElement('button'); addBtn.className = 'fg-btn w100 accent'; addBtn.textContent = '+ Ajouter';
    addBtn.addEventListener('click', () => {
      const n = nameInp.value.trim();
      if (n) { this._addSlotType(n); nameInp.value = ''; this._renderMecaTab(); }
    });
    form.append(formLbl, nameInp, addBtn);
    container.appendChild(form);

    // Export/Import méca
    const mecaActions = document.createElement('div'); mecaActions.className = 'fg-row';
    const exportMecaBtn = document.createElement('button'); exportMecaBtn.className = 'fg-btn'; exportMecaBtn.style.flex='1'; exportMecaBtn.textContent = '↓ Export méca';
    exportMecaBtn.addEventListener('click', () => this._exportMeca());
    const importMecaInput = document.createElement('input'); importMecaInput.type='file'; importMecaInput.accept='.json'; importMecaInput.style.display='none';
    importMecaInput.addEventListener('change', e => { if (e.target.files[0]) this._importMeca(e.target.files[0]); });
    const importMecaBtn = document.createElement('button'); importMecaBtn.className = 'fg-btn'; importMecaBtn.style.flex='1'; importMecaBtn.textContent = '↑ Import méca';
    importMecaBtn.addEventListener('click', () => importMecaInput.click());
    mecaActions.append(exportMecaBtn, importMecaBtn, importMecaInput);
    container.appendChild(mecaActions);
  }

  _renderMecaLiaisonsSubTab(container) {
    const liaisons  = this._liaisons();
    const slotTypes = this._slotTypes();

    const list = document.createElement('div');
    Object.values(liaisons).forEach(li => {
      const item = document.createElement('div'); item.className = 'fg-meca-item';

      // En-tête : nom + supprimer
      const hdr  = document.createElement('div'); hdr.className = 'fg-meca-hdr';
      const nameInp = document.createElement('input'); nameInp.className = 'fg-input'; nameInp.style.flex='1';
      nameInp.value = li.name;
      nameInp.addEventListener('change', e => this._patchLiaison(li.id, { name: e.target.value }));
      const del = document.createElement('button'); del.className = 'fg-btn'; del.textContent = '✕';
      del.addEventListener('click', () => this._deleteLiaison(li.id));
      hdr.append(nameInp, del);
      item.appendChild(hdr);

      // Couples compatibles
      const pairsLbl = document.createElement('div'); pairsLbl.className = 'fg-meca-row';
      pairsLbl.innerHTML = '<span class="fg-meca-key">Couples</span>';
      const pairsTags = document.createElement('div');
      pairsTags.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
      (li.pairs || []).forEach((p, idx) => {
        const tag = document.createElement('span'); tag.className = 'fg-pair-tag';
        const tA  = slotTypes[p.typeA]?.name ?? p.typeA;
        const tB  = slotTypes[p.typeB]?.name ?? p.typeB;
        tag.innerHTML = `${tA} ↔ ${tB} <span class="fg-pair-del" data-idx="${idx}">✕</span>`;
        tag.querySelector('.fg-pair-del').addEventListener('click', () => this._removeLiaisonPair(li.id, idx));
        pairsTags.appendChild(tag);
      });
      pairsLbl.appendChild(pairsTags);
      item.appendChild(pairsLbl);

      // Formulaire ajout couple
      if (Object.keys(slotTypes).length >= 2) {
        const pairForm = document.createElement('div'); pairForm.className = 'fg-row'; pairForm.style.marginLeft='72px';
        const selA = document.createElement('select'); selA.className = 'fg-select'; selA.style.flex='1';
        const selB = document.createElement('select'); selB.className = 'fg-select'; selB.style.flex='1';
        Object.values(slotTypes).forEach(t => {
          [selA, selB].forEach(sel => {
            const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o);
          });
        });
        const addPairBtn = document.createElement('button'); addPairBtn.className = 'fg-btn'; addPairBtn.textContent = '+';
        addPairBtn.addEventListener('click', () => this._addLiaisonPair(li.id, selA.value, selB.value));
        pairForm.append(selA, selB, addPairBtn);
        item.appendChild(pairForm);
      }

      // DOF
      const dofLbl = document.createElement('div'); dofLbl.className = 'fg-meca-row'; dofLbl.style.marginTop='6px';
      dofLbl.innerHTML = '<span class="fg-meca-key">DOF</span>';
      const dofTags = document.createElement('div'); dofTags.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
      (li.dof || []).forEach((d, idx) => {
        const tag = document.createElement('span'); tag.className = 'fg-dof-tag';
        const col = DOF_COLOR[d.type] ?? 0xffffff;
        tag.style.borderColor = '#' + col.toString(16).padStart(6, '0');
        const label = DOF_LABELS[d.type] ?? d.type;
        const axStr = d.axis ? `[${d.axis.map(v => v.toFixed(2)).join(', ')}]` : '';
        const bound = (d.min != null && d.max != null) ? ` ${d.min}…${d.max}` : '';
        const step  = d.step != null ? ` step ${d.step}` : '';
        tag.innerHTML = `${label} ${axStr}${bound}${step} <span class="fg-pair-del" data-idx="${idx}">✕</span>`;
        tag.querySelector('.fg-pair-del').addEventListener('click', () => this._removeLiaisonDof(li.id, idx));
        dofTags.appendChild(tag);
      });
      dofLbl.appendChild(dofTags);
      item.appendChild(dofLbl);

      // Formulaire ajout DOF
      const dofForm = document.createElement('div'); dofForm.className = 'fg-add-form'; dofForm.style.marginTop='6px';
      const dofRow1 = document.createElement('div'); dofRow1.className = 'fg-row';
      const typeSel = document.createElement('select'); typeSel.className = 'fg-select'; typeSel.style.flex='1';
      Object.entries(DOF_LABELS).forEach(([val, lbl]) => {
        const o = document.createElement('option'); o.value = val; o.textContent = lbl; typeSel.appendChild(o);
      });
      dofRow1.appendChild(typeSel);

      const dofRow2 = document.createElement('div'); dofRow2.className = 'fg-row';
      const axisRow = document.createElement('div'); axisRow.className = 'fg-row'; axisRow.style.flex='1';
      const axLabel = document.createElement('span'); axLabel.style.cssText='font:9px sans-serif;color:var(--fg-dim);min-width:28px;'; axLabel.textContent='Axe';
      const axInputs = ['X','Y','Z'].map((a, i) => {
        const inp = document.createElement('input'); inp.className='fg-coord'; inp.type='text'; inp.placeholder=a;
        inp.value = i === 2 ? '1' : '0';
        return inp;
      });
      axisRow.append(axLabel, ...axInputs);
      dofRow2.appendChild(axisRow);

      const dofRow3 = document.createElement('div'); dofRow3.className = 'fg-row';
      const minInp  = document.createElement('input'); minInp.className='fg-coord'; minInp.type='text'; minInp.placeholder='min';
      const maxInp  = document.createElement('input'); maxInp.className='fg-coord'; maxInp.type='text'; maxInp.placeholder='max';
      const stepInp = document.createElement('input'); stepInp.className='fg-coord'; stepInp.type='text'; stepInp.placeholder='step';
      dofRow3.append(minInp, maxInp, stepInp);

      const addDofBtn = document.createElement('button'); addDofBtn.className='fg-btn w100 accent'; addDofBtn.textContent='+ Ajouter DOF';
      addDofBtn.addEventListener('click', () => {
        const type  = typeSel.value;
        const axis  = axInputs.map(inp => parseFloat(inp.value) || 0);
        const min   = minInp.value  !== '' ? parseFloat(minInp.value)  : null;
        const max   = maxInp.value  !== '' ? parseFloat(maxInp.value)  : null;
        const step  = stepInp.value !== '' ? parseFloat(stepInp.value) : null;
        this._addLiaisonDof(li.id, { type, axis, min, max, step });
      });

      dofForm.append(dofRow1, dofRow2, dofRow3, addDofBtn);
      item.appendChild(dofForm);

      list.appendChild(item);
    });
    container.appendChild(list);

    // Bouton nouvelle liaison
    const addLiBtn = document.createElement('button'); addLiBtn.className='fg-btn w100 accent'; addLiBtn.textContent='+ Nouvelle liaison';
    addLiBtn.addEventListener('click', () => this._addLiaison());
    container.appendChild(addLiBtn);
  }

  // ─── Statut ───────────────────────────────────────────────────────────────

  _setStatus(msg) {
    if (!this._barTitle) return;
    this._barTitle.textContent = msg;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { if (this._barTitle) this._barTitle.textContent = 'Forge'; }, 2500);
  }

  // ─── Resize panels ────────────────────────────────────────────────────────

  _applyPanelWidths() {
    document.documentElement.style.setProperty('--fg-left-w',  this._leftW  + 'px');
    document.documentElement.style.setProperty('--fg-right-w', this._rightW + 'px');
    this.engine.resizeViewport(this._leftW, this._rightW);
  }

  _setupResizeHandles() {
    const MIN = 40, MAX = innerWidth - 40;
    const makeHandle = (side) => {
      const h = document.createElement('div');
      h.className = `fg-handle fg-handle-${side}`;
      document.body.appendChild(h);
      this._ui.push(h);
      let startX, startW;
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        startX = e.clientX;
        startW = side === 'left' ? this._leftW : this._rightW;
      });
      h.addEventListener('pointermove', (e) => {
        if (!h.hasPointerCapture(e.pointerId)) return;
        const delta = e.clientX - startX;
        if (side === 'left')  this._leftW  = Math.max(MIN, Math.min(MAX, startW + delta));
        else                  this._rightW = Math.max(MIN, Math.min(MAX, startW - delta));
        this._applyPanelWidths();
      });
      h.addEventListener('pointerup',     () => {});
      h.addEventListener('pointercancel', () => {});
    };
    makeHandle('left');
    makeHandle('right');
  }

  // ─── Widget vues + verrous ────────────────────────────────────────────────

  _setupViewWidget() {
    const style = document.createElement('style');
    style.textContent = `
      .fg-viewwidget { position:fixed; top:44px; right:calc(var(--fg-right-w,300px) + 8px);
        display:flex; flex-direction:column; gap:4px; z-index:55; }
      .fg-vwrow { display:flex; gap:3px; }
      .fg-vbtn  { width:34px; height:28px;
        background:linear-gradient(to bottom,#484848,#383838);
        border:1px solid var(--fg-border); border-radius:2px;
        box-shadow:inset 0 1px 0 var(--fg-bevel), 0 1px 2px #0004;
        cursor:pointer; font:10px/1 sans-serif; color:var(--fg-text);
        display:flex; align-items:center; justify-content:center; }
      .fg-vbtn:active { background:#2a2a2a; box-shadow:inset 0 1px 3px #0006; }
      .fg-vbtn.lock-active { background:var(--fg-sel); color:var(--fg-accent);
        border-color:var(--fg-accent); box-shadow:inset 0 1px 3px #0006; }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    const widget = document.createElement('div');
    widget.className = 'fg-viewwidget';

    const presetRow = document.createElement('div');
    presetRow.className = 'fg-vwrow';
    [
      { label: '+X', axis: 'x', sign:  1 },
      { label: '−X', axis: 'x', sign: -1 },
      { label: '+Y', axis: 'y', sign:  1 },
      { label: '−Y', axis: 'y', sign: -1 },
      { label: '+Z', axis: 'z', sign:  1 },
      { label: '−Z', axis: 'z', sign: -1 },
      { label: '⟳',  axis: null },
    ].forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'fg-vbtn'; btn.textContent = p.label;
      btn.addEventListener('click', () => this._snapView(p.axis, p.sign));
      presetRow.appendChild(btn);
    });

    const lockRow = document.createElement('div');
    lockRow.className = 'fg-vwrow';
    const lockLbl = document.createElement('div');
    lockLbl.className = 'fg-vbtn';
    lockLbl.style.cssText = 'cursor:default;width:auto;padding:0 6px;font-size:9px;';
    lockLbl.textContent = '🔒';
    lockRow.appendChild(lockLbl);

    this._lockBtns = {};
    ['X', 'Y', 'Z'].forEach(ax => {
      const btn = document.createElement('button');
      btn.className = 'fg-vbtn'; btn.textContent = ax;
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
      pos = new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(dist).add(target);
    } else {
      pos = target.clone();
      pos[axis] += dist * sign;
    }
    cam.position.copy(pos);
    cam.lookAt(target);
  }

  _toggleAxisLock(axis) {
    if (this._lockedAxis === axis) {
      this._lockedAxis = null;
      Object.values(this._lockBtns).forEach(b => b.classList.remove('lock-active'));
    } else {
      this._lockedAxis = axis;
      const offset = this.engine.camera.position.clone().sub(this.engine.controls.target);
      this._lockOffset = offset[axis];
      Object.entries(this._lockBtns).forEach(([k, b]) => b.classList.toggle('lock-active', k === axis));
    }
  }

  _applyAxisLock() {
    if (!this._lockedAxis) return;
    const cam    = this.engine.camera;
    const target = this.engine.controls.target;
    const offset = cam.position.clone().sub(target);
    const dist   = offset.length();
    const ax     = this._lockedAxis;
    const locked = this._lockOffset;
    const perpR  = Math.sqrt(Math.max(0, dist * dist - locked * locked));
    const perp   = offset.clone();
    perp[ax]     = 0;
    const perpLen = perp.length();
    if (perpLen > 1e-6) {
      perp.multiplyScalar(perpR / perpLen);
    } else {
      perp.set(0, 0, 0);
      perp[ax === 'y' ? 'z' : 'y'] = perpR;
    }
    perp[ax] = locked;
    cam.position.copy(target.clone().add(perp));
    cam.lookAt(target);
  }
}
