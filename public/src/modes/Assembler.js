import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { BrickDock } from './BrickDock.js';
import { AsmHandlers } from './AsmDofHandler.js';
import { AsmVerse } from './AsmVerse.js';

// ─── Couleurs thème Industrial ────────────────────────────────────────────────
const C = {
  bg:        '#2e2e2e',
  bgDark:    '#1e1e1e',
  border:    '#555',
  fg:        '#d0d0d0',
  dim:       '#888',
  accent:    '#7aafc8',
  worldSlot:    0x7aafc8,
  snapRing:     0x00ff88,
  jointExplicit: 0x00ccff,
};

// Hauteur de la barre de titre — rogne le viewport rendu et le dock
const BAR_H = 32;

// Persistance de la configuration de l'Assembler
const CFG_KEY   = 'rbang_asm_cfg';
const SCENE_KEY = 'rbang_asm_scene';
const CFG_DEFAULTS = {
  dockEdge             : 'bottom',
  dockAlign            : 'center',
  activateOnOutsideTap : true,
  planY                : 0.25,
  snapR                : 1.2,
  planVisible          : true,
  accent               : '#7aafc8',
  stackPersist         : false,
  asmHelperStepsRot    : 16,   // nombre de divisions sur 360°
  asmHelperStepsTrans  : 20,   // nombre de divisions sur la plage
  // ── Apparence des cellules dock ───────────────────────────────────────────
  cellBgColor            : '#1e1e1e',
  cellBgOpacity          : 0.82,
  cellBorderVisible      : true,
  cellBorderColor        : '#555555',
  cellBorderWidth        : 1,
  cellActiveBgColor      : '#1e1e1e',
  cellActiveBgOpacity    : 0.82,
  cellActiveBorderVisible: true,
  cellActiveBorderColor  : '#7aafc8',
  cellActiveBorderWidth  : 1,
  cellBorderRadius       : 4,
  // ── Label des cellules ────────────────────────────────────────────────────
  cellLabelBgColor       : '#0a0a0f',
  cellLabelBgOpacity     : 0.75,
  cellLabelColor         : '#888888',
  cellLabelFontSize      : 8,
  cellLabelVisible       : true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Assembler
// ═══════════════════════════════════════════════════════════════════════════════

export class Assembler {

  constructor(engine) {
    this.engine       = engine;
    this._ui          = [];
    this._asmVerse    = null;
    this._dock        = null; // BrickDock
    this._configOverlay = null; // modale configuration
    this._raycaster   = new THREE.Raycaster();
    this._mouse       = new THREE.Vector2(-9999, -9999);
    this._snapHelpers = [];
    this._stackCandidate = null; // { inst, startX, startY } — brique saisie en cours de drag
    this._tapStart       = null; // { x, y } — début de geste en zone vide (pour détecter un tap)
    this._asmHandlers   = null; // AsmHandlers actifs (DOF d'assemblage)

    // ── État global des modes ──────────────────────────────────────────────────
    this._mode               = 'brick';  // 'brick' | 'component'
    this._process            = 'idle';   // 'idle' | 'dragging' | 'trackball' | 'assembling'
    this._selectedBrick      = null;     // AsmBrick | null
    this._selectedComponent  = null;     // AsmEquivalenceClass | null
    this._previewHelper      = null;     // THREE.Mesh — anneau de preview snap
  }

  // ─── Cycle de vie ──────────────────────────────────────────────────────────

  async start() {
    this._setupScene();
    this._setupManagers();
    this._applyConfig();
    this._setupUI();
    this._setupEvents();
    this.engine.start();
    await this._restoreScene();
  }

  _loadConfig() {
    try { return { ...CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
    catch { return { ...CFG_DEFAULTS }; }
  }

  _saveConfig(patch) {
    const cfg = this._loadConfig();
    localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign(cfg, patch)));
  }

  _applyConfig() {
    const cfg = this._loadConfig();
    this._dock.setPosition(cfg.dockEdge, cfg.dockAlign);
    this._dock.setActivateOnOutsideTap(cfg.activateOnOutsideTap);
    this._dock.setStackPersist(cfg.stackPersist);
    this._dock.setCellStyles(cfg);
    this._asmVerse.worldSlots.planY = cfg.planY;
    this._asmVerse.worldSlots.snapR = cfg.snapR;
    if (this._asmVerse.worldSlots.planMesh) this._asmVerse.worldSlots.planMesh.visible = cfg.planVisible;
  }

  // ─── Persistance de la scène ───────────────────────────────────────────────

  _saveScene() {
    try {
      localStorage.setItem(SCENE_KEY, JSON.stringify(this._asmVerse.serialize()));
    } catch { /* quota exceeded */ }
  }

  async _restoreScene() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(SCENE_KEY) || 'null'); } catch { return; }
    if (!saved?.instances?.length) return;
    const bricksStore   = this._loadStore('rbang_bricks');
    const shapesStore   = this._loadStore('rbang_shapes');
    const liaisonsStore = this._loadStore('rbang_liaisons');
    await this._asmVerse.restore(saved, bricksStore, shapesStore, liaisonsStore);
    this._updateCount();
  }

  _serializeSceneJSON() {
    return JSON.stringify(this._asmVerse.serialize(), null, 2);
  }

  _exportScene() {
    const blob = new Blob([this._serializeSceneJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rbang-scene.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _importScene() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        localStorage.setItem(SCENE_KEY, text);
        this._clearAll();
        await this._restoreScene();
      } catch (e) { console.error('[Assembler] import', e); }
    });
    input.click();
  }

  stop() {
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    this.engine.resizeViewport(0, 0, 0);
    this._asmVerse.dispose();
    this._dock?.destroy();
    if (this._previewHelper) {
      this.engine.scene.remove(this._previewHelper);
      this._previewHelper.geometry.dispose();
      this._previewHelper.material.dispose();
      this._previewHelper = null;
    }
    this._clearSnapHelpers();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup',   this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMoveStack, { capture: true });
    window.removeEventListener('pointerup',   this._onPointerUpStack,   { capture: true });
    this.engine.controls.enabled = true;
    this._stackCandidate = null;
  }

  // ─── Scène ─────────────────────────────────────────────────────────────────

  _setupScene() {
    const e = this.engine;
    e.addStaticBox(24, 0.5, 24, 0, 0, 0, 0x2a3a2a); // dessus à Y = 0.25
    e.camera.position.set(0, 8, 14);
    e.controls.target.set(0, 0, 0);
    e.controls.update();
  }

  // ─── Managers ──────────────────────────────────────────────────────────────

  _setupManagers() {
    this._asmVerse = new AsmVerse(this.engine.scene);
    // Lors d'un ajout ou déplacement de brique, si une nouvelle liaison est créée,
    // activer les AsmHandlers DOF. Retourner true empêche la création du disque marqueur
    // (les handlers le remplacent). Retourner false (liaison rigide) → disque créé.
    this._asmVerse.joints.onConnect = (conn) => this._activateAsmHandlers(conn);
    this._dock = new BrickDock(this.engine, { edge: 'bottom', align: 'center' });
    this._dock.onPickBrick((brickId, gesture) => {
      this._activeGesture = null;
      this._handleScreenSlotDrop(gesture);
    });
    const bricks = this._loadStore('rbang_bricks');
    this._dock.load(bricks);
  }

  // ─── Gestion du drop depuis un screen slot ──────────────────────────────────

  async _handleScreenSlotDrop(gesture) {
    const { brickId, nearSlots, endX, endY } = gesture;

    if (this._isOverScreenSlot(endX, endY)) return;

    this._mouse.x =  (endX / innerWidth)  * 2 - 1;
    this._mouse.y = -(endY / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    const meshes = [...this._asmVerse.bricks.values()].map(i => i.mesh);
    const hits   = this._raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      const targetMesh = hits[0].object;
      const targetInst = [...this._asmVerse.bricks.values()].find(i => i.mesh === targetMesh);
      if (targetInst) {
        await this._assembleTo(brickId, nearSlots, targetInst, endX, endY);
        return;
      }
    }

    const pt = this._asmVerse.worldSlots.raycastPlane(this._raycaster);
    if (pt) {
      const brickData = this._loadStore('rbang_bricks')[brickId];
      if (!brickData) return;
      const wslot = this._asmVerse.worldSlots.addWorldSlot(pt);
      const brick = await this._asmVerse.spawnBrick(brickId, brickData, wslot.position);
      if (brick) {
        this._asmVerse.bindWorldSlot(wslot, brick, (gesture.nearSlots || [])[0] ?? null);
        this._updateCount();
      }
    }
  }

  // ─── Assembler une brique sur une instance existante ────────────────────────

  async _assembleTo(brickId, nearSlotsA, targetInst, endX, endY) {
    const nearSlotsB = this._asmVerse.slots.nearSlotsOf(targetInst, endX, endY, this.engine.camera, true);
    const result = this._asmVerse.worldSlots.resolve(nearSlotsA, nearSlotsB);
    const brickData = this._loadStore('rbang_bricks')[brickId];
    if (!brickData) return;

    if (result) {
      const snap = this._asmVerse.worldSlots.computeSnap(result.slotA, result.slotB, targetInst);
      const brick = await this._asmVerse.spawnBrick(brickId, brickData, null, snap);
      if (brick) {
        this._asmVerse.joints.observe(this._asmVerse.slots, true, brick);
        this._showSnapHelper(brick.mesh.position.clone());
        this._updateCount();
      }
    } else {
      this._asmVerse._solver.diagnose(nearSlotsA, nearSlotsB, this._asmVerse.slots.typeIds);
      const pos = targetInst.mesh.position.clone().add(new THREE.Vector3(2, 0, 0));
      await this._spawnBrick(brickId, pos);
    }
  }

  // ─── Spawn d'une brique dans la scène ───────────────────────────────────────

  async _spawnBrick(brickId, pos, snapTransform = null) {
    const brickData = this._loadStore('rbang_bricks')[brickId];
    if (!brickData) return null;
    const brick = await this._asmVerse.spawnBrick(brickId, brickData, pos, snapTransform);
    if (brick) this._updateCount();
    return brick;
  }

  // ─── Trackball sur un world slot ─────────────────────────────────────────────

  _startWorldSlotTrackball(wslot, e) {
    const pivot   = wslot.position.clone();
    const startX  = e.clientX;
    let   lastX   = startX;

    const onMove = (ev) => {
      const dx   = ev.clientX - lastX;
      lastX      = ev.clientX;
      const angle = dx * 0.01;
      if (wslot.brickInstanceId) {
        const inst = this._asmVerse.bricks.get(wslot.brickInstanceId);
        if (inst) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), angle);
          inst.mesh.position.sub(pivot).applyQuaternion(q).add(pivot);
          inst.mesh.quaternion.premultiply(q);
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      this._setProcess('idle');
    };
    this._setProcess('trackball');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
  }

  // ─── Événements principaux ───────────────────────────────────────────────────

  _setupEvents() {
    this._onPointerDown = (e) => {
      if (this._isOverScreenSlot(e.clientX, e.clientY)) return;
      if (this._isOverUI(e.target)) return;

      this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
      this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
      this._raycaster.setFromCamera(this._mouse, this.engine.camera);

      // Priorité 1 : brique existante
      const meshes = [...this._asmVerse.bricks.values()].map(i => i.mesh);
      const hits   = this._raycaster.intersectObjects(meshes, false);
      if (hits.length > 0) {
        const hitMesh = hits[0].object;
        const hitInst = [...this._asmVerse.bricks.values()].find(i => i.mesh === hitMesh);
        if (hitInst) {
          // Sélection différée au pointerup (clic confirmé, sans drag)
          this._stackCandidate = { inst: hitInst, startX: e.clientX, startY: e.clientY };
          this.engine.controls.enabled = false;
        }
        return;
      }

      // Zone vide — enregistrer pour détecter un tap (désélection différée au pointerup)
      this._tapStart = { x: e.clientX, y: e.clientY };

      // Priorité 2 : world slot proche
      const pt = this._asmVerse.worldSlots.raycastPlane(this._raycaster);
      if (pt) {
        const nearest = this._asmVerse.worldSlots.nearest(pt, this._asmVerse.worldSlots.snapR);
        if (nearest) {
          e.stopPropagation();
          this._startWorldSlotTrackball(nearest, e);
          return;
        }
      }
      // Sinon : OrbitControls gère la caméra
    };

    this._onPointerMoveStack = (e) => {
      if (!this._stackCandidate) return;
      const { inst, startX, startY } = this._stackCandidate;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) >= 12) {
        if (this._process !== 'dragging') {
          // Mémoriser la position courante (peut être post-DOF) comme référence de retour
          this._stackCandidate.restorePos  = inst.mesh.position.clone();
          this._stackCandidate.restoreQuat = inst.mesh.quaternion.clone();
          inst.mesh.material.transparent = true;
          inst.mesh.material.opacity     = 0.4;
          inst.mesh.material.needsUpdate = true;
          this._setProcess('dragging');
        }
        this._updateSnapPreview(inst, startX, startY, e.clientX, e.clientY);
      }
    };

    this._onPointerUpStack = (e) => {
      // Tap en zone vide → désélection (seulement si peu de mouvement = pas un orbit caméra)
      if (!this._stackCandidate) {
        if (this._tapStart) {
          const dx = e.clientX - this._tapStart.x, dy = e.clientY - this._tapStart.y;
          if (Math.sqrt(dx * dx + dy * dy) < 12) this._selectBrick(null);
          this._tapStart = null;
        }
        return;
      }

      const wasDragging = this._process === 'dragging';
      this._setProcess('idle');
      const { inst, startX, startY } = this._stackCandidate;

      const under  = document.elementFromPoint(e.clientX, e.clientY);
      const onDock = under?.closest?.('.brick-dock');

      this._hidePreviewHelper();

      if (onDock) {
        // ── Drop sur le dock → empiler
        this._removeFromScene(inst);
        this._dock.pushToStack(inst.brickTypeId, inst.brickData);
        e.stopPropagation();
      } else {
        // ── Tap sans drag → sélection confirmée
        if (!wasDragging) {
          this._selectBrick(inst);
        } else {
          // ── Drop sur une autre brique → assembler
          this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
          this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
          this._raycaster.setFromCamera(this._mouse, this.engine.camera);
          const others = [...this._asmVerse.bricks.values()].filter(i => i !== inst);
          const hits   = this._raycaster.intersectObjects(others.map(i => i.mesh), false);
          let connected = false;
          if (hits.length > 0) {
            const target = others.find(i => i.mesh === hits[0].object);
            if (target) connected = this._connectDrag(inst, startX, startY, target, e.clientX, e.clientY);
          }
          if (connected) {
            // Connexion créée → sélectionner la brique déplacée (helpers DOF visibles)
            this._selectBrick(inst);
          } else if (this._stackCandidate?.restorePos) {
            // Pas de connexion → remettre la brique à sa position de départ du drag
            inst.mesh.position.copy(this._stackCandidate.restorePos);
            inst.mesh.quaternion.copy(this._stackCandidate.restoreQuat);
          }
        }
        // Restaurer opacité dans tous les cas (drag ou tap)
        inst.mesh.material.transparent = false;
        inst.mesh.material.opacity     = 1;
        inst.mesh.material.needsUpdate = true;
      }

      this.engine.controls.enabled = true;
      this._stackCandidate = null;
    };

    window.addEventListener('pointercancel', () => {
      this._tapStart = null;
      if (this._stackCandidate) {
        const { inst, restorePos, restoreQuat } = this._stackCandidate;
        if (inst?.mesh) {
          if (restorePos) {
            inst.mesh.position.copy(restorePos);
            inst.mesh.quaternion.copy(restoreQuat);
          }
          inst.mesh.material.transparent = false;
          inst.mesh.material.opacity     = 1;
          inst.mesh.material.needsUpdate = true;
        }
        this._stackCandidate = null;
        this._setProcess('idle');
      }
      this._hidePreviewHelper();
      this.engine.controls.enabled = true;
    }, { capture: true });

    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointermove', this._onPointerMoveStack, { capture: true });
    window.addEventListener('pointerup',   this._onPointerUpStack,   { capture: true });
  }

  // ─── DOF assemblage ───────────────────────────────────────────────────────────

  _activateAsmHandlers(conn, mobileInst = null) {
    this._asmHandlers?.detach();
    this._asmHandlers = null;

    // instA doit être la brique mobile (initiatrice ou sélectionnée).
    // coincidentPairs() retourne les briques dans l'ordre d'insertion,
    // pas forcément dans l'ordre mobile/pivot — on réoriente si besoin.
    const mobile = mobileInst ?? this._asmVerse.joints.lastInitiator;
    const oriented = (mobile && conn.instB === mobile)
      ? { ...conn, instA: conn.instB, slotA: conn.slotB, instB: conn.instA, slotB: conn.slotA }
      : conn;

    const cfg        = this._loadConfig();
    const stepsRot   = cfg.asmHelperStepsRot   ?? 16;
    const stepsTrans = cfg.asmHelperStepsTrans  ?? 20;
    const handlers = new AsmHandlers({ conn: oriented, engine: this.engine, topOffset: BAR_H, stepsRot, stepsTrans });
    if (handlers.active) {
      handlers.attach();
      this._asmHandlers = handlers;
      return true; // AsmHandlers remplace le disque marqueur
    }
    return false; // liaison rigide → le disque marqueur sera créé
  }

  // ─── Preview de snap ─────────────────────────────────────────────────────────

  /**
   * Met à jour le preview en temps réel pendant le drag d'une brique.
   * Déplace inst.mesh vers la position snappée si une cible est trouvée,
   * sinon la rétablit à la position de départ du drag (_stackCandidate.restorePos).
   */
  _updateSnapPreview(inst, grabX, grabY, cx, cy) {
    this._mouse.x =  (cx / innerWidth)  * 2 - 1;
    this._mouse.y = -(cy / innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);

    const others = [...this._asmVerse.bricks.values()].filter(i => i !== inst);
    const hits   = this._raycaster.intersectObjects(others.map(i => i.mesh), false);

    if (hits.length > 0) {
      const target = others.find(i => i.mesh === hits[0].object);
      if (target) {
        const snap = this._asmVerse.previewSnap(inst, grabX, grabY, target, cx, cy, this.engine.camera);
        if (snap) {
          inst.mesh.position.copy(snap.position);
          inst.mesh.quaternion.copy(snap.quaternion);
          this._showPreviewHelper(snap.position);
          return;
        }
      }
    }
    // Pas de snap candidat → brique revient à sa position de départ du drag
    const sc = this._stackCandidate;
    if (sc?.restorePos) {
      inst.mesh.position.copy(sc.restorePos);
      inst.mesh.quaternion.copy(sc.restoreQuat);
    }
    this._hidePreviewHelper();
  }

  _showPreviewHelper(pos) {
    if (!this._previewHelper) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.18, 0.28, 32),
        new THREE.MeshBasicMaterial({ color: C.snapRing, side: THREE.DoubleSide, depthWrite: false })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 999;
      this.engine.scene.add(mesh);
      this._previewHelper = mesh;
    }
    this._previewHelper.position.copy(pos);
    this._previewHelper.visible = true;
  }

  _hidePreviewHelper() {
    if (this._previewHelper) this._previewHelper.visible = false;
  }

  // ─── Helpers visuels ─────────────────────────────────────────────────────────

  _showSnapHelper(pos) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.22, 24),
      new THREE.MeshBasicMaterial({ color: C.snapRing, side: THREE.DoubleSide, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(pos);
    this.engine.scene.add(mesh);
    this._snapHelpers.push(mesh);
    setTimeout(() => {
      this.engine.scene.remove(mesh);
      mesh.geometry.dispose(); mesh.material.dispose();
      const i = this._snapHelpers.indexOf(mesh);
      if (i !== -1) this._snapHelpers.splice(i, 1);
    }, 1200);
  }

  _clearSnapHelpers() {
    for (const h of this._snapHelpers) {
      this.engine.scene.remove(h);
      h.geometry.dispose(); h.material.dispose();
    }
    this._snapHelpers = [];
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────

  _setupUI() {
    const style = document.createElement('style');
    style.textContent = `
      :root { --asm-accent: ${C.accent}; }
      .asm-bar {
        position:fixed; top:0; left:0; right:0; height:${BAR_H}px;
        background:${C.bgDark}ee; border-bottom:1px solid ${C.border};
        display:flex; align-items:center; padding:0 6px;
        z-index:54; pointer-events:auto;
        font:10px sans-serif; color:${C.dim};
      }
      .asm-bar-btn {
        background:transparent; border:none; color:${C.dim};
        font-size:16px; cursor:pointer; padding:0 8px; height:100%;
        line-height:1; flex-shrink:0;
      }
      .asm-bar-btn:active { color:${C.fg}; }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // ── Barre du haut ─────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'asm-bar';

    const fsBtn = document.createElement('button');
    fsBtn.className = 'asm-bar-btn';
    fsBtn.title = 'Plein écran';
    fsBtn.textContent = '⛶';
    fsBtn.addEventListener('click', () => this._toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      fsBtn.textContent = document.fullscreenElement ? '⊡' : '⛶';
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'asm-bar-btn';
    reloadBtn.title = 'Recharger (vide le cache)';
    reloadBtn.textContent = '↺';
    reloadBtn.addEventListener('click', async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      location.reload();
    });

    // ── Sélecteur de mode ────────────────────────────────────────────────────────
    const modeStrip = document.createElement('div');
    modeStrip.style.cssText = [
      'display:flex', `border:1px solid ${C.border}`, 'border-radius:3px',
      'overflow:hidden', 'flex-shrink:0', 'margin:0 4px',
    ].join(';');
    const _modeBtn = (icon, title, key) => {
      const btn = document.createElement('button');
      btn.dataset.modeKey = key;
      btn.title = title;
      btn.textContent = icon;
      btn.style.cssText = [
        'background:transparent', 'border:none', `color:${C.dim}`,
        'font-size:13px', 'cursor:pointer', 'padding:0 7px', 'height:100%', 'line-height:1',
      ].join(';');
      btn.addEventListener('click', () => this._setMode(key));
      return btn;
    };
    const _brickModeBtn = _modeBtn('▦', 'Mode Brique',      'brick');
    const _compModeBtn  = _modeBtn('⬡', 'Mode Composante',  'component');
    modeStrip.append(_brickModeBtn, _compModeBtn);

    this._updateModeBtns = () => {
      for (const btn of modeStrip.querySelectorAll('button')) {
        const active = btn.dataset.modeKey === this._mode;
        btn.style.color      = active ? C.accent : C.dim;
        btn.style.background = active ? `${C.bg}` : 'transparent';
      }
    };
    this._updateModeBtns();

    this._countEl = document.createElement('span');
    this._countEl.style.cssText = 'flex:1;text-align:center;pointer-events:none;';

    const bricksBtn = document.createElement('button');
    bricksBtn.className = 'asm-bar-btn';
    bricksBtn.title = 'Liste des briques';
    bricksBtn.textContent = '⊞';
    bricksBtn.addEventListener('click', () => this._togglePanel('bricks'));

    const compBtn = document.createElement('button');
    compBtn.className = 'asm-bar-btn';
    compBtn.title = 'Classes d\'équivalence';
    compBtn.textContent = '⬡';
    compBtn.addEventListener('click', () => this._togglePanel('components'));

    const jointsBtn = document.createElement('button');
    jointsBtn.className = 'asm-bar-btn';
    jointsBtn.title = 'Liaisons';
    jointsBtn.textContent = '⇄';
    jointsBtn.addEventListener('click', () => this._togglePanel('joints'));

    const stateBtn = document.createElement('button');
    stateBtn.className = 'asm-bar-btn';
    stateBtn.title = 'État interne';
    stateBtn.textContent = '◉';
    stateBtn.addEventListener('click', () => this._togglePanel('state'));

    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'asm-bar-btn';
    cfgBtn.title = 'Configuration';
    cfgBtn.textContent = '⚙';
    cfgBtn.addEventListener('click', () => this._openConfigModal());

    bar.append(fsBtn, reloadBtn, modeStrip, this._countEl, bricksBtn, compBtn, jointsBtn, stateBtn, cfgBtn);
    document.body.appendChild(bar);
    this._ui.push(bar);

    // ── Modale de configuration ───────────────────────────────────────────────
    this._setupConfigModal();

    // ── Rogner le viewport rendu + dock sous la barre ─────────────────────────
    this.engine.resizeViewport(0, 0, BAR_H);
    this._dock.setInsets({ top: BAR_H });

    // ── onUpdate ──────────────────────────────────────────────────────────────
    this.engine.onUpdate = () => {
      const n = this._asmVerse.bricks.size;
      const c = n ? this._asmVerse.componentCount() : 0;
      const nConn = this._asmVerse.joints.connections.length;
      this._countEl.textContent = `Briques : ${n}` + (n ? `  |  Liaisons : ${nConn}  |  Composants : ${c}` : '');
    };
  }

  _setupConfigModal() {
    // ── Overlay ──────────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'asm-modal-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0',
      'background:rgba(0,0,0,.65)',
      'backdrop-filter:blur(4px)',
      'display:none', 'align-items:center', 'justify-content:center',
      'z-index:200',
    ].join(';');
    overlay.addEventListener('pointerdown', e => {
      if (e.target === overlay) this._closeConfigModal();
    });

    // ── Modal ────────────────────────────────────────────────────────────────
    const modal = document.createElement('div');
    modal.style.cssText = [
      'width:80vw', 'max-height:80vh',
      `background:${C.bgDark}`, `border:1px solid ${C.border}`,
      'border-radius:4px',
      'display:flex', 'flex-direction:column',
      'overflow:hidden',
      'box-shadow:0 8px 32px rgba(0,0,0,.7)',
    ].join(';');

    // ── En-tête ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:10px 16px',
      `border-bottom:1px solid ${C.border}`,
      'flex-shrink:0',
    ].join(';');
    const htitle = document.createElement('span');
    htitle.textContent = 'Configuration';
    htitle.style.cssText = `color:${C.fg};font:bold 13px sans-serif;letter-spacing:.05em;`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `background:transparent;border:none;color:${C.dim};font-size:18px;cursor:pointer;padding:0 4px;line-height:1;`;
    closeBtn.addEventListener('click', () => this._closeConfigModal());
    header.append(htitle, closeBtn);

    // ── Corps (flex-wrap, cartes) ────────────────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = [
      'display:flex', 'flex-wrap:wrap',
      'gap:14px', 'padding:16px',
      'overflow-y:auto', 'flex:1',
      'align-items:flex-start',
    ].join(';');

    const cfg = this._loadConfig();

    // Helpers locaux
    const makeCard = label => {
      const card = document.createElement('div');
      card.style.cssText = [
        `background:${C.bg}`, `border:1px solid ${C.border}`,
        'border-radius:3px', 'padding:14px 16px',
        'min-width:220px', 'flex:1 1 220px',
      ].join(';');
      const h = document.createElement('div');
      h.textContent = label;
      h.style.cssText = `font-size:9px;color:${C.dim};text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;`;
      card.appendChild(h);
      return card;
    };

    const makeSelect = (label, options, value, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex-shrink:0;min-width:70px;`;
      const sel = document.createElement('select');
      sel.style.cssText = [
        'flex:1', `background:${C.bgDark}`, `color:${C.fg}`,
        `border:1px solid ${C.border}`, 'border-radius:2px',
        'padding:4px 6px', 'font-size:11px', 'cursor:pointer',
      ].join(';');
      for (const [val, txt] of options) {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = txt;
        if (val === value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      row.append(lbl, sel);
      return row;
    };

    const makeSlider = (label, min, max, step, init, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex-shrink:0;min-width:70px;`;
      const sl = document.createElement('input');
      sl.type = 'range';
      sl.min = String(min); sl.max = String(max); sl.step = String(step);
      sl.value = String(init);
      sl.style.cssText = 'flex:1;cursor:pointer;accent-color:var(--asm-accent);';
      const fmt = v => Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2);
      const val = document.createElement('span');
      val.textContent = fmt(init);
      val.style.cssText = `color:var(--asm-accent);min-width:34px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;`;
      sl.addEventListener('input', () => { const v = parseFloat(sl.value); val.textContent = fmt(v); onChange(v); });
      row.append(lbl, sl, val);
      return row;
    };

    // ── Carte : Dock ─────────────────────────────────────────────────────────
    const dockCard = makeCard('Dock');

    const makeToggle = (label, init, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
      const track = document.createElement('div');
      let on = init;
      const update = () => {
        track.style.background = on ? C.accent : C.border;
        thumb.style.transform = on ? 'translateX(14px)' : 'translateX(0)';
      };
      track.style.cssText = [
        'width:28px', 'height:14px', 'border-radius:7px',
        'position:relative', 'cursor:pointer', 'flex-shrink:0',
        'transition:background .15s',
      ].join(';');
      const thumb = document.createElement('div');
      thumb.style.cssText = [
        'position:absolute', 'top:1px', 'left:1px',
        'width:12px', 'height:12px', 'border-radius:50%',
        'background:#fff', 'transition:transform .15s',
      ].join(';');
      track.appendChild(thumb);
      update();
      track.addEventListener('click', () => { on = !on; update(); onChange(on); });
      row.append(lbl, track);
      return row;
    };

    dockCard.append(
      makeSelect('Bord', [
        ['bottom','Bas'], ['top','Haut'], ['left','Gauche'], ['right','Droite'],
      ], this._dock._edge, v => { this._dock.setPosition(v, this._dock._align); this._dock.setInsets({ top: BAR_H }); this._saveConfig({ dockEdge: v }); }),
      makeSelect('Alignement', [
        ['center','Centre'], ['start','Début'], ['end','Fin'],
      ], this._dock._align, v => { this._dock.setPosition(this._dock._edge, v); this._dock.setInsets({ top: BAR_H }); this._saveConfig({ dockAlign: v }); }),
      makeToggle('Activer au tap extérieur', this._dock._activateOnOutsideTap,
        v => { this._dock.setActivateOnOutsideTap(v); this._saveConfig({ activateOnOutsideTap: v }); }),
    );
    body.append(dockCard);

    // ── Carte : Cellules ──────────────────────────────────────────────────────
    const cellCard = makeCard('Cellules');

    const makeColorRow = (label, init, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = init;
      inp.style.cssText = 'width:36px;height:24px;border:none;background:none;cursor:pointer;padding:0;';
      inp.addEventListener('input', () => onChange(inp.value));
      row.append(lbl, inp);
      return row;
    };

    const makeSectionLabel = txt => {
      const s = document.createElement('div');
      s.textContent = txt;
      s.style.cssText = [
        'font-size:9px', `color:${C.dim}`,
        'text-transform:uppercase', 'letter-spacing:.08em',
        'margin:8px 0 6px',
      ].join(';');
      return s;
    };

    const cellCfg = this._loadConfig();

    cellCard.append(makeSectionLabel('Inactif'));
    cellCard.append(makeColorRow('Fond', cellCfg.cellBgColor,
      v => { this._saveConfig({ cellBgColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Opacité fond', 0, 1, 0.05, cellCfg.cellBgOpacity,
      v => { this._saveConfig({ cellBgOpacity: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeToggle('Bordure', cellCfg.cellBorderVisible,
      v => { this._saveConfig({ cellBorderVisible: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Couleur bordure', cellCfg.cellBorderColor,
      v => { this._saveConfig({ cellBorderColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Épaisseur bordure', 0, 6, 0.5, cellCfg.cellBorderWidth,
      v => { this._saveConfig({ cellBorderWidth: v }); this._dock.setCellStyles(this._loadConfig()); }));

    cellCard.append(makeSectionLabel('Actif'));
    cellCard.append(makeColorRow('Fond', cellCfg.cellActiveBgColor,
      v => { this._saveConfig({ cellActiveBgColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Opacité fond', 0, 1, 0.05, cellCfg.cellActiveBgOpacity,
      v => { this._saveConfig({ cellActiveBgOpacity: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeToggle('Bordure', cellCfg.cellActiveBorderVisible,
      v => { this._saveConfig({ cellActiveBorderVisible: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Couleur bordure', cellCfg.cellActiveBorderColor,
      v => { this._saveConfig({ cellActiveBorderColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Épaisseur bordure', 0, 6, 0.5, cellCfg.cellActiveBorderWidth,
      v => { this._saveConfig({ cellActiveBorderWidth: v }); this._dock.setCellStyles(this._loadConfig()); }));

    cellCard.append(makeSectionLabel('Forme'));
    cellCard.append(makeSlider('Border radius', 0, 30, 1, cellCfg.cellBorderRadius,
      v => { this._saveConfig({ cellBorderRadius: v }); this._dock.setCellStyles(this._loadConfig()); }));

    cellCard.append(makeSectionLabel('Label'));
    cellCard.append(makeToggle('Visible', cellCfg.cellLabelVisible,
      v => { this._saveConfig({ cellLabelVisible: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Fond', cellCfg.cellLabelBgColor,
      v => { this._saveConfig({ cellLabelBgColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Opacité fond', 0, 1, 0.05, cellCfg.cellLabelBgOpacity,
      v => { this._saveConfig({ cellLabelBgOpacity: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeColorRow('Couleur police', cellCfg.cellLabelColor,
      v => { this._saveConfig({ cellLabelColor: v }); this._dock.setCellStyles(this._loadConfig()); }));
    cellCard.append(makeSlider('Taille police', 5, 20, 1, cellCfg.cellLabelFontSize,
      v => { this._saveConfig({ cellLabelFontSize: v }); this._dock.setCellStyles(this._loadConfig()); }));

    body.append(cellCard);

    // ── Carte : Stack ─────────────────────────────────────────────────────────
    const stackCard = makeCard('Stack');
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Vider la pile';
    clearBtn.style.cssText = [
      'width:100%', 'padding:6px 10px', 'margin-top:4px',
      `background:${C.bgDark}`, `border:1px solid ${C.border}`,
      `color:${C.dim}`, 'border-radius:2px', 'font-size:10px',
      'cursor:pointer', 'text-align:center',
    ].join(';');
    clearBtn.addEventListener('click', () => this._dock.clearStack());
    stackCard.append(
      makeToggle('Persistance', this._loadConfig().stackPersist,
        v => { this._dock.setStackPersist(v); this._saveConfig({ stackPersist: v }); }),
      clearBtn,
    );
    body.append(stackCard);

    // ── Carte : World Slots ───────────────────────────────────────────────────
    const wsCard = makeCard('World Slots');
    wsCard.append(
      makeSlider('Plan Y', -2, 5, 0.05, this._asmVerse.worldSlots.planY, v => { this._asmVerse.worldSlots.planY = v; this._saveConfig({ planY: v }); }),
      makeSlider('Rayon snap', 0.3, 4, 0.1, this._asmVerse.worldSlots.snapR, v => { this._asmVerse.worldSlots.snapR = v; this._saveConfig({ snapR: v }); }),
      makeToggle('Plan visible', this._asmVerse.worldSlots.planMesh?.visible ?? true,
        v => { if (this._asmVerse.worldSlots.planMesh) this._asmVerse.worldSlots.planMesh.visible = v; this._saveConfig({ planVisible: v }); }),
    );
    body.append(wsCard);

    // ── Carte : Asm Helpers ───────────────────────────────────────────────────
    const helpersCard = makeCard('Asm Helpers');

    const makeStepsInput = (label, hint, initSteps, onHint, onChange) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `color:${C.dim};font-size:10px;flex:1;`;
      const hintEl = document.createElement('span');
      hintEl.textContent = onHint(initSteps);
      hintEl.style.cssText = `color:${C.dim};font-size:9px;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;`;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.step = '1';
      inp.value = String(initSteps);
      inp.style.cssText = [
        'width:52px', `background:${C.bgDark}`, `color:${C.fg}`,
        `border:1px solid ${C.border}`, 'border-radius:2px',
        'padding:3px 6px', 'font-size:11px', 'text-align:right',
        'font-variant-numeric:tabular-nums',
      ].join(';');
      inp.addEventListener('change', () => {
        const v = Math.max(1, parseInt(inp.value) || 1);
        inp.value = String(v);
        hintEl.textContent = onHint(v);
        onChange(v);
      });
      row.append(lbl, hintEl, inp);
      return row;
    };

    helpersCard.append(
      makeStepsInput(
        'Rotation (étapes)', '',
        cfg.asmHelperStepsRot ?? 16,
        n => `${(360 / n).toFixed(2)}°`,
        v => this._saveConfig({ asmHelperStepsRot: v }),
      ),
      makeStepsInput(
        'Translation (étapes)', '',
        cfg.asmHelperStepsTrans ?? 20,
        n => `÷ ${n}`,
        v => this._saveConfig({ asmHelperStepsTrans: v }),
      ),
    );
    body.append(helpersCard);

    // ── Carte : Thème ────────────────────────────────────────────────────────
    const themeCard = makeCard('Thème');
    const themeStyle = document.createElement('style');
    document.head.appendChild(themeStyle);
    this._ui.push(themeStyle);

    const accents = [
      ['#7aafc8', 'Acier'],
      ['#6abf8a', 'Jade'],
      ['#d4884a', 'Forge'],
      ['#9b7fc8', 'Violet'],
      ['#c87a7a', 'Brique'],
    ];
    const swatchRow = document.createElement('div');
    swatchRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';
    let currentAccent = this._loadConfig().accent;
    if (currentAccent !== C.accent) themeStyle.textContent = `:root { --asm-accent: ${currentAccent}; }`;
    for (const [color, name] of accents) {
      const sw = document.createElement('button');
      sw.title = name;
      sw.style.cssText = [
        `background:${color}`, 'width:32px', 'height:32px',
        'border-radius:50%', 'cursor:pointer',
        `border:2px solid ${color === currentAccent ? '#fff' : 'transparent'}`,
        'transition:border-color .15s',
      ].join(';');
      sw.addEventListener('click', () => {
        currentAccent = color;
        themeStyle.textContent = `:root { --asm-accent: ${color}; }`;
        swatchRow.querySelectorAll('button').forEach(b => { b.style.borderColor = 'transparent'; });
        sw.style.borderColor = '#fff';
        this._saveConfig({ accent: color });
      });
      swatchRow.append(sw);
    }
    themeCard.append(swatchRow);
    body.append(themeCard);

    // ── Carte : Scène ─────────────────────────────────────────────────────────
    const sceneCard = makeCard('Scène');
    const makeActionBtn = (label, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = [
        'width:100%', 'padding:6px 10px', 'margin-bottom:6px',
        `background:${C.bgDark}`, `border:1px solid ${C.border}`,
        `color:${C.fg}`, 'border-radius:2px', 'font-size:10px',
        'cursor:pointer', 'text-align:left',
      ].join(';');
      btn.addEventListener('click', onClick);
      return btn;
    };
    const resetBtn = makeActionBtn('Réinitialiser la scène', () => {
      this._closeConfigModal();
      this._clearAll();
    });
    resetBtn.style.color = '#e07070';
    resetBtn.style.borderColor = '#884444';
    sceneCard.append(
      makeActionBtn('Exporter (.json)', () => { this._closeConfigModal(); this._exportScene(); }),
      makeActionBtn('Importer (.json)', () => { this._closeConfigModal(); this._importScene(); }),
      resetBtn,
    );
    body.append(sceneCard);

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._ui.push(overlay);
    this._configOverlay = overlay;
  }

  _openConfigModal() {
    if (this._configOverlay) this._configOverlay.style.display = 'flex';
  }

  _closeConfigModal() {
    if (this._configOverlay) this._configOverlay.style.display = 'none';
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  _clearAll() {
    this._asmHandlers?.detach();
    this._asmHandlers = null;
    this._asmVerse.clear();
    this._updateCount();
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────────────

  // Assemble instA (brique saisie) sur instB (brique cible) après un drag-drop scène→scène
  _connectDrag(instA, grabX, grabY, instB, dropX, dropY) {
    const conn = this._asmVerse.connectDrag(instA, grabX, grabY, instB, dropX, dropY, this.engine.camera);
    if (conn) {
      this._showSnapHelper(instA.mesh.position.clone());
      this._updateCount();
      return true;
    }
    this._asmVerse._solver.diagnose(
      this._asmVerse.slots.nearSlotsOf(instA, grabX, grabY, this.engine.camera),
      this._asmVerse.slots.nearSlotsOf(instB, dropX, dropY, this.engine.camera),
      this._asmVerse.slots.typeIds
    );
    return false;
  }

  _removeFromScene(inst) {
    // Nettoyage AsmHandlers (UI, reste dans l'Assembler)
    if (this._asmHandlers) {
      const conn = this._asmHandlers._handlers[0]?._conn;
      if (conn && (conn.instA === inst || conn.instB === inst)) {
        this._asmHandlers.detach();
        this._asmHandlers = null;
      }
    }
    if (this._selectedBrick === inst) this._selectBrick(null);
    this._asmVerse.removeBrick(inst);
    this._updateCount();
  }

  _isOverScreenSlot(cx, cy) {
    if (!this._dock?.el) return false;
    const rect = this._dock.el.getBoundingClientRect();
    return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
  }

  _isOverUI(target) {
    return target.closest?.('.brick-dock, .asm-bar, .asm-modal-overlay, .asm-panel, .asm-dof-strip');
  }

  _updateCount() {
    if (this._countEl) this._countEl.textContent = `Briques : ${this._asmVerse.bricks.size}`;
    this._saveScene();
    for (const name of ['bricks', 'components', 'joints', 'state']) {
      const p = this._panels?.[name];
      if (p?.style.display === 'flex') this._refreshPanel(name);
    }
  }

  _loadStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }

  // ─── Panels flottants (briques / composantes) ─────────────────────────────

  _togglePanel(name) {
    if (!this._panels) this._panels = {};
    if (!this._panels[name]) {
      this._panels[name] = this._createPanel(name);
      if (name === 'joints') this._initJointsHeaderToggle(this._panels[name]);
    }
    const p = this._panels[name];
    const open = p.style.display === 'none' || !p.style.display;
    p.style.display = open ? 'flex' : 'none';
    if (open) this._refreshPanel(name);
  }

  _createPanel(name) {
    const widths = { state: 'min(240px,85vw)', bricks: 'min(320px,90vw)', components: 'min(320px,90vw)' };
    const panel = document.createElement('div');
    panel.className = 'asm-panel';
    panel.style.cssText = [
      'position:fixed',
      `top:${BAR_H}px`, 'right:0',
      `width:${widths[name] || 'min(320px,90vw)'}`, 'max-height:calc(100dvh - ' + BAR_H + 'px)',
      `background:${C.bgDark}ee`,
      `border-left:1px solid ${C.border}`,
      `border-bottom:1px solid ${C.border}`,
      'display:none', 'flex-direction:column',
      'z-index:52', 'pointer-events:auto',
      'font:11px sans-serif',
    ].join(';');

    // En-tête
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:6px 10px', 'flex-shrink:0',
      `border-bottom:1px solid ${C.border}`,
    ].join(';');
    const title = document.createElement('span');
    title.style.cssText = `color:${C.dim};font-size:9px;text-transform:uppercase;letter-spacing:.1em;`;
    const panelTitles = { bricks: 'Briques', components: 'Composantes', joints: 'Liaisons', state: 'État interne' };
    title.textContent = panelTitles[name] ?? name;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `background:transparent;border:none;color:${C.dim};font-size:14px;cursor:pointer;padding:0 2px;line-height:1;`;
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    header.append(title, closeBtn);
    panel._header = header;

    // Corps scrollable
    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;padding:8px 0;';
    panel._body = body;

    panel.append(header, body);
    document.body.appendChild(panel);
    this._ui.push(panel);
    return panel;
  }

  _refreshPanel(name) {
    const panel = this._panels?.[name];
    if (!panel) return;
    const body = panel._body;
    body.innerHTML = '';

    if (name === 'bricks')           this._fillBricksPanel(body);
    else if (name === 'joints')    { this._syncJointsHeaderToggle(panel); this._fillJointsPanel(body); }
    else if (name === 'state')       this._fillStatePanel(body);
    else                             this._fillComponentsPanel(body);
  }

  _fillBricksPanel(body) {
    if (!this._asmVerse.bricks.size) {
      body.appendChild(this._panelEmpty('Aucune brique dans la scène'));
      return;
    }
    for (const inst of this._asmVerse.bricks.values()) {
      const conns = inst.connections.length;
      const isSelected = inst === this._selectedBrick;
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:5px 12px',
        `border-bottom:1px solid ${C.border}22`,
        `background:${isSelected ? C.accent + '22' : 'transparent'}`,
        `border-left:2px solid ${isSelected ? C.accent : 'transparent'}`,
      ].join(';');

      // Pastille couleur brique
      const swatch = document.createElement('span');
      swatch.style.cssText = [
        'width:10px', 'height:10px', 'border-radius:2px', 'flex-shrink:0',
        `background:${inst.brickData.color || '#888'}`,
        `border:1px solid ${C.border}`,
      ].join(';');

      // Nom + id
      const info = document.createElement('span');
      info.style.cssText = `flex:1;color:${C.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      info.textContent = inst.brickData.name || inst.brickTypeId;

      // Compteur de connexions
      const badge = document.createElement('span');
      badge.style.cssText = `color:${conns ? C.accent : C.dim};flex-shrink:0;`;
      badge.textContent = conns ? `${conns} ⇄` : '—';

      row.append(swatch, info, badge);
      body.appendChild(row);
    }
  }

  _initJointsHeaderToggle(panel) {
    const btn = document.createElement('button');
    btn.style.cssText = [
      'background:transparent', 'border:none', 'cursor:pointer',
      'font-size:13px', 'padding:0 4px', 'line-height:1',
    ].join(';');
    // Insérer avant le bouton ✕ (dernier enfant du header)
    panel._header.insertBefore(btn, panel._header.lastChild);
    panel._globalToggleBtn = btn;
    this._syncJointsHeaderToggle(panel);
  }

  _syncJointsHeaderToggle(panel) {
    const btn = panel._globalToggleBtn;
    if (!btn) return;
    const visible = this._asmVerse?.joints.allMarkersVisible ?? true;
    btn.textContent = '◉';
    btn.title = visible ? 'Masquer tous les helpers' : 'Afficher tous les helpers';
    btn.style.color = visible ? C.accent : C.dim;
    btn.onclick = () => {
      this._asmVerse.joints.setAllMarkersVisible(!this._asmVerse.joints.allMarkersVisible);
      this._refreshPanel('joints');
    };
  }

  _fillJointsPanel(body) {
    const conns = this._asmVerse.joints.connections;
    if (!conns.length) {
      body.appendChild(this._panelEmpty('Aucune liaison'));
      return;
    }
    for (const conn of conns) {
      const { instA, instB, liaison } = conn;
      const involvesSel = instA === this._selectedBrick || instB === this._selectedBrick;
      const dofs  = liaison?.dof ?? [];
      const label = liaison?.name || liaison?.id || '—';

      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'flex-direction:column', 'gap:3px',
        'padding:5px 12px',
        `border-bottom:1px solid ${C.border}22`,
        `background:${involvesSel ? C.accent + '22' : 'transparent'}`,
        `border-left:2px solid ${involvesSel ? C.accent : 'transparent'}`,
      ].join(';');

      // Ligne brique A → brique B
      const bricks = document.createElement('div');
      bricks.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const mkDot = (inst) => {
        const dot = document.createElement('span');
        dot.style.cssText = [
          'display:inline-block', 'width:8px', 'height:8px',
          'border-radius:2px', 'flex-shrink:0',
          `background:${inst.brickData.color || '#888'}`,
        ].join(';');
        return dot;
      };
      const nameA = document.createElement('span');
      nameA.style.color = C.fg;
      nameA.textContent = instA.brickData.name || instA.brickTypeId;
      const arrow = document.createElement('span');
      arrow.style.cssText = `color:${C.dim};flex-shrink:0;`;
      arrow.textContent = '⇄';
      const nameB = document.createElement('span');
      nameB.style.cssText = `color:${C.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      nameB.textContent = instB.brickData.name || instB.brickTypeId;
      bricks.append(mkDot(instA), nameA, arrow, mkDot(instB), nameB);

      // Ligne liaison + DOF + toggle marqueur
      const meta = document.createElement('div');
      meta.style.cssText = `display:flex;align-items:center;gap:6px;padding-left:14px;`;
      const liaisonLabel = document.createElement('span');
      liaisonLabel.style.cssText = `color:${dofs.length ? C.accent : C.dim};font-size:10px;flex:1;`;
      liaisonLabel.textContent = label;
      meta.appendChild(liaisonLabel);
      if (dofs.length) {
        const dofBadge = document.createElement('span');
        dofBadge.style.cssText = `color:${C.dim};font-size:10px;`;
        dofBadge.textContent = dofs.map(d => d.type).join(' · ');
        meta.appendChild(dofBadge);
      }

      // Bouton toggle rendu 3D
      const visible = this._asmVerse.joints.isMarkerVisible(conn);
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = '◉';
      toggleBtn.title = visible ? 'Masquer le helper' : 'Afficher le helper';
      toggleBtn.style.cssText = [
        'background:transparent', 'border:none', 'cursor:pointer',
        'font-size:12px', 'padding:0 2px', 'flex-shrink:0', 'line-height:1',
        `color:${visible ? C.accent : C.dim}`,
      ].join(';');
      toggleBtn.addEventListener('click', () => {
        this._asmVerse.joints.setMarkerVisible(conn, !this._asmVerse.joints.isMarkerVisible(conn));
        this._refreshPanel('joints');
      });
      meta.appendChild(toggleBtn);

      row.append(bricks, meta);
      body.appendChild(row);
    }
  }

  _fillComponentsPanel(body) {
    const components = this._asmVerse.computeComponents();
    if (!components.length) {
      body.appendChild(this._panelEmpty('Aucune composante'));
      return;
    }
    components.forEach((comp, idx) => {
      const section = document.createElement('div');
      section.style.cssText = `padding:6px 12px;border-bottom:1px solid ${C.border}44;`;
      const heading = document.createElement('div');
      heading.style.cssText = `color:${C.accent};font-size:10px;font-weight:bold;margin-bottom:4px;`;
      heading.textContent = `Composante ${idx + 1}  (${comp.size} brique${comp.size > 1 ? 's' : ''})`;
      section.appendChild(heading);
      for (const brick of comp.bricks) {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:6px;padding:2px 0;`;
        const swatch = document.createElement('span');
        swatch.style.cssText = `width:8px;height:8px;border-radius:1px;flex-shrink:0;background:${brick.brickData.color || '#888'};border:1px solid ${C.border};`;
        const name = document.createElement('span');
        name.style.cssText = `color:${C.fg};`;
        name.textContent = brick.brickData.name || brick.brickTypeId;
        row.append(swatch, name);
        section.appendChild(row);
      }
      if (comp.links.length) {
        const links = document.createElement('div');
        links.style.cssText = `margin-top:4px;color:${C.dim};font-size:10px;`;
        links.textContent = `⇌ ${comp.links.length} lien(s) DOF`;
        section.appendChild(links);
      }
      body.appendChild(section);
    });
  }

  // ─── Gestion des modes et de l'état interne ──────────────────────────────────

  /** Bascule entre 'brick' et 'component'. Réinitialise processus et sélection. */
  _setMode(mode) {
    this._mode = mode;
    this._process = 'idle';
    this._selectBrick(null);
    this._selectedComponent = null;
    this._updateModeBtns?.();
    // Rafraîchir le panel état s'il est ouvert
    const p = this._panels?.state;
    if (p?.style.display === 'flex') this._refreshPanel('state');
  }

  /** Met à jour le processus en cours et rafraîchit le panel état. */
  _setProcess(proc) {
    this._process = proc;
    const p = this._panels?.state;
    if (p?.style.display === 'flex') this._refreshPanel('state');
  }

  /** Sélectionne une brique (mode brick). null = désélection. */
  _selectBrick(brick) {
    // Effacer le highlight de la sélection précédente
    if (this._selectedBrick) {
      const m = this._selectedBrick.mesh.material;
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
    }
    this._selectedBrick = brick;
    // Appliquer le highlight à la nouvelle sélection
    if (brick) {
      const m = brick.mesh.material;
      m.emissive.setHex(C.worldSlot);
      m.emissiveIntensity = 0.3;
    }
    // Activer les handlers DOF pour la première connexion avec DOF de cette brique
    if (brick) {
      const conn = brick.connections.find(c => c.liaison?.asmDof?.length > 0);
      if (conn) {
        this._activateAsmHandlers(conn, brick);
      } else {
        this._asmHandlers?.detach();
        this._asmHandlers = null;
      }
    } else {
      this._asmHandlers?.detach();
      this._asmHandlers = null;
    }
    if (this._panels?.bricks?.style.display  === 'flex') this._refreshPanel('bricks');
    if (this._panels?.joints?.style.display  === 'flex') this._refreshPanel('joints');
    if (this._panels?.state?.style.display   === 'flex') this._refreshPanel('state');
  }

  /** Sélectionne une composante (mode component). */
  _selectComponent(comp) {
    this._selectedComponent = comp;
    const p = this._panels?.state;
    if (p?.style.display === 'flex') this._refreshPanel('state');
  }

  _fillStatePanel(body) {
    const MODE_LABELS = { brick: 'Brique', component: 'Composante' };
    const PROC_LABELS = {
      idle:       'Repos',
      dragging:   'Déplacement',
      trackball:  'Rotation (world slot)',
      assembling: 'Assemblage',
    };

    const rows = [
      ['MODE',      MODE_LABELS[this._mode]   || this._mode],
      ['PROCESSUS', PROC_LABELS[this._process] || this._process],
    ];

    if (this._mode === 'brick') {
      const sel = this._selectedBrick;
      rows.push(['SÉLECTION', sel ? (sel.brickData.name || sel.brickTypeId) : '—']);
      if (this._stackCandidate) {
        const b = this._stackCandidate.inst;
        rows.push(['EN COURS', b.brickData.name || b.brickTypeId]);
      }
    } else {
      const comp = this._selectedComponent;
      rows.push(['SÉLECTION', comp ? `Composante (${comp.size} briques)` : '—']);
    }

    // Séparateur
    rows.push(null);

    // Contexte AsmVerse
    rows.push(['BRIQUES',     String(this._asmVerse.bricks.size)]);
    rows.push(['LIAISONS',    String(this._asmVerse.joints.connections.length)]);
    rows.push(['COMPOSANTES', String(this._asmVerse.componentCount())]);

    for (const row of rows) {
      if (!row) {
        // Séparateur
        const sep = document.createElement('div');
        sep.style.cssText = `height:1px;background:${C.border};margin:4px 0;`;
        body.appendChild(sep);
        continue;
      }
      const [key, val] = row;
      const el = document.createElement('div');
      el.style.cssText = `display:flex;justify-content:space-between;align-items:baseline;padding:5px 12px;border-bottom:1px solid ${C.border}22;`;
      const k = document.createElement('span');
      k.style.cssText = `color:${C.dim};font-size:9px;text-transform:uppercase;letter-spacing:.1em;flex-shrink:0;`;
      k.textContent = key;
      const v = document.createElement('span');
      v.style.cssText = `color:${C.fg};font-size:11px;text-align:right;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      v.textContent = val;
      el.append(k, v);
      body.appendChild(el);
    }
  }

  _panelEmpty(msg) {
    const el = document.createElement('div');
    el.style.cssText = `color:${C.dim};padding:16px 12px;text-align:center;font-size:10px;`;
    el.textContent = msg;
    return el;
  }
}
