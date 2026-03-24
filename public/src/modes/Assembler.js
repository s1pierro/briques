import * as THREE from 'three';
import * as dynamics from '../dynamics.js';

const SCALE = 0.008;

const SNAP_DIST = 0.15; // distance max pour snap (en unités Three.js)

// ─── Construit un BufferGeometry depuis les données JSON ─────────────────────
function buildGeometry(obj) {
  const verts = obj.vertices;
  const tris  = obj.triangles;

  const positions = new Float32Array(tris.length * 9);
  const normals   = new Float32Array(tris.length * 9);

  for (let i = 0; i < tris.length; i++) {
    const t  = tris[i];
    const v0 = verts[t['0']], v1 = verts[t['1']], v2 = verts[t['2']];

    const ax = v0['0']*SCALE, ay = v0['1']*SCALE, az = v0['2']*SCALE;
    const bx = v1['0']*SCALE, by = v1['1']*SCALE, bz = v1['2']*SCALE;
    const cx = v2['0']*SCALE, cy = v2['1']*SCALE, cz = v2['2']*SCALE;

    positions[i*9+0] = ax; positions[i*9+1] = ay; positions[i*9+2] = az;
    positions[i*9+3] = bx; positions[i*9+4] = by; positions[i*9+5] = bz;
    positions[i*9+6] = cx; positions[i*9+7] = cy; positions[i*9+8] = cz;

    // Normale par produit vectoriel
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    const nx = uy*vz - uz*vy;
    const ny = uz*vx - ux*vz;
    const nz = ux*vy - uy*vx;
    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    for (let k = 0; k < 3; k++) {
      normals[i*9+k*3+0] = nx/nl;
      normals[i*9+k*3+1] = ny/nl;
      normals[i*9+k*3+2] = nz/nl;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  return geo;
}

// ─── Extrait les slots avec leur position/axe monde ─────────────────────────
function parseSlots(slots) {
  return slots.map(s => {
    const e = s.mat.elements;
    // matrice 4x4 column-major → position = col 3
    const pos  = new THREE.Vector3(e[12]*SCALE, e[13]*SCALE, e[14]*SCALE);
    // axe normal = colonne Y (index 4,5,6 = row 0,1,2 de col 1)
    const axis = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    return { pos, axis, type: s.type, uid: s.uid };
  });
}

// ─── Mode Assembleur ─────────────────────────────────────────────────────────
export class Assembler {

  constructor(engine) {
    this.engine        = engine;
    this._ui           = [];
    this._bricks       = [];   // { mesh, body, data, slots, origPos, origQuat }
    this._ghost        = null;
    this._ghostData    = null; // données JSON de la brique sélectionnée
    this._ghostSlots   = [];
    this._bankList     = [];
    this._simulating   = false;
    this._raycaster    = new THREE.Raycaster();
    this._mouse        = new THREE.Vector2(-9999, -9999);
    this._planeY       = 0.26; // top de la baseplate (h=0.5, pos y=0)
    this._snapResult   = null; // { localSlot, targetSlot, targetBrick, matrix }
    this._snapHelpers  = [];
  }

  // ─── Cycle de vie ──────────────────────────────────────────────────────────

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
    this._removeGhost();
    this._clearSnapHelpers();
    this._ui.forEach(el => el.remove());
    this._ui = [];
    window.removeEventListener('mousemove',    this._onMouseMove);
    window.removeEventListener('click',        this._onClick);
    window.removeEventListener('contextmenu',  this._onRightClick);
    window.removeEventListener('keydown',      this._onKeyDown);
    this.engine.renderer.domElement.removeEventListener('touchend',  this._onTouchEnd);
    this.engine.renderer.domElement.removeEventListener('touchmove', this._onTouchMove);
  }

  // ─── Scène ─────────────────────────────────────────────────────────────────

  _setupScene() {
    const e = this.engine;
    e.addStaticBox(24, 0.5, 24, 0, 0, 0, 0x3a6b28);
    e.camera.position.set(4, 6, 6);
    e.controls.target.set(0, 0.5, 0);
    e.controls.maxPolarAngle = Math.PI / 2 - 0.01;
    e.controls.update();
  }

  // ─── Chargement de la banque ────────────────────────────────────────────────

  async _loadBankList() {
    try {
      const res = await fetch('/bank-index');
      this._bankList = await res.json();
      this._populateBankUI();
    } catch(err) {
      console.error('Erreur chargement banque:', err);
    }
  }

  async _loadBrick(name) {
    const res  = await fetch(`/bank/${encodeURIComponent(name)}.json`);
    return await res.json();
  }

  // ─── Géométrie Three.js ────────────────────────────────────────────────────

  _makeMesh(data, opacity = 1) {
    const geo = buildGeometry(data.object);
    const col = data.color ? parseInt(data.color.replace('#',''), 16) : 0x888888;
    const mat = new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.55,
      metalness: 0.0,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // ─── Ghost brick ───────────────────────────────────────────────────────────

  async _selectBrick(name) {
    this._removeGhost();
    this._clearSnapHelpers();
    this._snapResult = null;

    const data = await this._loadBrick(name);
    this._ghostData  = data;
    this._ghostSlots = parseSlots(data.slots || []);

    const mesh = this._makeMesh(data, 0.4);
    this.engine.scene.add(mesh);
    this._ghost = mesh;
    this._updateGhost();
  }

  _removeGhost() {
    if (!this._ghost) return;
    this.engine.scene.remove(this._ghost);
    this._ghost.geometry.dispose();
    this._ghost.material.dispose();
    this._ghost = null;
    this._ghostData  = null;
    this._ghostSlots = [];
  }

  _updateGhost() {
    if (!this._ghost || this._simulating) return;

    // Position de base : plan Y
    const pt = this._getPlanePoint();
    if (!pt) return;

    this._ghost.position.set(pt.x, this._planeY, pt.z);
    this._ghost.quaternion.identity();

    // Tentative de snap sur slots existants
    this._snapResult = this._findSnap();
    this._clearSnapHelpers();

    if (this._snapResult) {
      // Applique la transformation de snap
      const { matrix } = this._snapResult;
      this._ghost.position.setFromMatrixPosition(matrix);
      this._ghost.quaternion.setFromRotationMatrix(matrix);
      this._showSnapHelper(this._snapResult);
    }
  }

  // ─── Snap par slots ────────────────────────────────────────────────────────

  _findSnap() {
    if (!this._ghost || this._bricks.length === 0) return null;

    const ghostWorldPos = this._ghost.position.clone();
    let best = null;
    let bestDist = SNAP_DIST;

    for (const brick of this._bricks) {
      const brickMat = new THREE.Matrix4().compose(
        brick.mesh.position, brick.mesh.quaternion, new THREE.Vector3(1,1,1)
      );

      for (const ts of brick.slots) {
        // Position monde du slot cible
        const tWorldPos = ts.pos.clone().applyMatrix4(brickMat);

        for (const gs of this._ghostSlots) {
          if (!dynamics.isCompatible(gs.type, ts.type)) continue;

          // Distance approximative entre le slot ghost (en coords locales ghost) et le slot cible
          const gsWorld = gs.pos.clone().add(ghostWorldPos);
          const d = gsWorld.distanceTo(tWorldPos);
          if (d < bestDist) {
            bestDist = d;
            // Calcule la matrice de placement du ghost pour que gs coïncide avec ts
            const snapMatrix = this._computeSnapMatrix(gs, ts, brickMat);
            if (snapMatrix) {
              best = { localSlot: gs, targetSlot: ts, targetBrick: brick, matrix: snapMatrix };
            }
          }
        }
      }
    }
    return best;
  }

  _computeSnapMatrix(ghostSlot, targetSlot, targetBrickMat) {
    // Axe du slot cible en espace monde
    const tWorldAxis = targetSlot.axis.clone().transformDirection(targetBrickMat);
    // Le slot ghost doit pointer dans la direction opposée
    const desiredGhostAxis = tWorldAxis.clone().negate();

    // Rotation pour aligner l'axe du slot ghost avec desiredGhostAxis
    const fromAxis = ghostSlot.axis.clone().normalize();
    const toAxis   = desiredGhostAxis.normalize();

    const q = new THREE.Quaternion().setFromUnitVectors(fromAxis, toAxis);

    // Position cible : le slot ghost, après rotation, doit coïncider avec le slot cible monde
    const tWorldPos = targetSlot.pos.clone().applyMatrix4(targetBrickMat);
    // Position du slot ghost en espace monde (après rotation ghost depuis origine)
    const ghostSlotRotated = ghostSlot.pos.clone().applyQuaternion(q);
    const ghostPos = tWorldPos.clone().sub(ghostSlotRotated);

    const mat = new THREE.Matrix4().compose(ghostPos, q, new THREE.Vector3(1,1,1));
    return mat;
  }

  // ─── Helpers visuels de snap ────────────────────────────────────────────────

  _showSnapHelper(snap) {
    const pos = snap.targetSlot.pos.clone().applyMatrix4(
      new THREE.Matrix4().compose(
        snap.targetBrick.mesh.position,
        snap.targetBrick.mesh.quaternion,
        new THREE.Vector3(1,1,1)
      )
    );
    const geo  = new THREE.SphereGeometry(0.05, 8, 8);
    const mat  = new THREE.MeshBasicMaterial({ color: 0x00ffaa });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    this.engine.scene.add(mesh);
    this._snapHelpers.push(mesh);
  }

  _clearSnapHelpers() {
    for (const h of this._snapHelpers) {
      this.engine.scene.remove(h);
      h.geometry.dispose();
      h.material.dispose();
    }
    this._snapHelpers = [];
  }

  // ─── Raycasting ────────────────────────────────────────────────────────────

  _getPlanePoint() {
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._planeY);
    const pt    = new THREE.Vector3();
    return this._raycaster.ray.intersectPlane(plane, pt) ? pt : null;
  }

  // ─── Placement ─────────────────────────────────────────────────────────────

  _placeBrick() {
    if (this._simulating || !this._ghost || !this._ghostData) return;

    const mesh = this._makeMesh(this._ghostData);
    mesh.position.copy(this._ghost.position);
    mesh.quaternion.copy(this._ghost.quaternion);
    this.engine.scene.add(mesh);

    // Corps physique : bounding box simplifiée
    const obj   = this._ghostData.object;
    const hx    = (obj.sx || 100) * SCALE / 2;
    const hy    = (obj.sy || 100) * SCALE / 2;
    const hz    = (obj.sz || 100) * SCALE / 2;
    const { x, y, z } = mesh.position;
    const body  = this.engine.world.createRigidBody(
      this.engine.R.RigidBodyDesc.fixed().setTranslation(x, y + hy, z)
    );
    const q = mesh.quaternion;
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.engine.world.createCollider(
      this.engine.R.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.7),
      body
    );

    const slots = parseSlots(this._ghostData.slots || []);
    this._bricks.push({ mesh, body, data: this._ghostData, slots,
      origPos: mesh.position.clone(), origQuat: mesh.quaternion.clone() });

    this._snapResult = null;
    this._clearSnapHelpers();
    // Recharge un nouveau ghost du même type
    this._selectBrick(this._ghostData.name || this._currentBrickName);
  }

  // ─── Suppression ───────────────────────────────────────────────────────────

  _deleteBrickAtCursor() {
    if (this._simulating) return;
    this._raycaster.setFromCamera(this._mouse, this.engine.camera);
    const meshes = this._bricks.map(b => b.mesh);
    const hits   = this._raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;
    const brick = this._bricks.find(b => b.mesh === hits[0].object);
    if (brick) this._removeBrick(brick);
  }

  _removeBrick(brick) {
    this.engine.scene.remove(brick.mesh);
    brick.mesh.geometry.dispose();
    brick.mesh.material.dispose();
    this.engine.world.removeRigidBody(brick.body);
    const idx = this.engine._bodies.findIndex(b => b.body === brick.body);
    if (idx !== -1) this.engine._bodies.splice(idx, 1);
    this._bricks.splice(this._bricks.indexOf(brick), 1);
  }

  _clearAll() {
    [...this._bricks].forEach(b => this._removeBrick(b));
  }

  // ─── Simulation ────────────────────────────────────────────────────────────

  _startSimulation() {
    this._simulating = true;
    this._removeGhost();
    this._clearSnapHelpers();

    for (const brick of this._bricks) {
      this.engine.world.removeRigidBody(brick.body);
      const { x, y, z } = brick.origPos;
      const obj = brick.data.object;
      const hx  = (obj.sx || 100) * SCALE / 2;
      const hy  = (obj.sy || 100) * SCALE / 2;
      const hz  = (obj.sz || 100) * SCALE / 2;
      const newBody = this.engine.world.createRigidBody(
        this.engine.R.RigidBodyDesc.dynamic().setTranslation(x, y + hy, z)
      );
      const q = brick.origQuat;
      newBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      this.engine.world.createCollider(
        this.engine.R.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.7).setRestitution(0.1),
        newBody
      );
      brick.body = newBody;
      this.engine._bodies.push({ mesh: brick.mesh, body: newBody, isStatic: false });
    }
  }

  _stopSimulation() {
    for (const brick of this._bricks) {
      const idx = this.engine._bodies.findIndex(b => b.body === brick.body);
      if (idx !== -1) this.engine._bodies.splice(idx, 1);
      this.engine.world.removeRigidBody(brick.body);

      brick.mesh.position.copy(brick.origPos);
      brick.mesh.quaternion.copy(brick.origQuat);

      const { x, y, z } = brick.origPos;
      const obj = brick.data.object;
      const hx  = (obj.sx || 100) * SCALE / 2;
      const hy  = (obj.sy || 100) * SCALE / 2;
      const hz  = (obj.sz || 100) * SCALE / 2;
      const newBody = this.engine.world.createRigidBody(
        this.engine.R.RigidBodyDesc.fixed().setTranslation(x, y + hy, z)
      );
      const q = brick.origQuat;
      newBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      this.engine.world.createCollider(
        this.engine.R.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.7),
        newBody
      );
      brick.body = newBody;
    }
    this._simulating = false;
  }

  // ─── Événements ────────────────────────────────────────────────────────────

  _setupEvents() {
    this._onMouseMove = (e) => {
      this._mouse.x =  (e.clientX / innerWidth)  * 2 - 1;
      this._mouse.y = -(e.clientY / innerHeight) * 2 + 1;
      this._updateGhost();
    };

    this._onClick = (e) => {
      if (e.target !== this.engine.renderer.domElement) return;
      if (e.button !== 0) return;
      this._placeBrick();
    };

    this._onRightClick = (e) => {
      e.preventDefault();
      if (e.target !== this.engine.renderer.domElement) return;
      this._deleteBrickAtCursor();
    };

    this._onKeyDown = (e) => {
      if (e.key === 'Escape') { this._removeGhost(); this._clearSnapHelpers(); }
    };

    this._onTouchMove = (e) => {
      const t = e.touches[0];
      this._mouse.x =  (t.clientX / innerWidth)  * 2 - 1;
      this._mouse.y = -(t.clientY / innerHeight) * 2 + 1;
      this._updateGhost();
    };

    this._onTouchEnd = (e) => {
      const t = e.changedTouches[0];
      this._mouse.x =  (t.clientX / innerWidth)  * 2 - 1;
      this._mouse.y = -(t.clientY / innerHeight) * 2 + 1;
      this._placeBrick();
    };

    window.addEventListener('mousemove',   this._onMouseMove);
    window.addEventListener('click',       this._onClick);
    window.addEventListener('contextmenu', this._onRightClick);
    window.addEventListener('keydown',     this._onKeyDown);
    const canvas = this.engine.renderer.domElement;
    canvas.addEventListener('touchmove', this._onTouchMove, { passive: true });
    canvas.addEventListener('touchend',  this._onTouchEnd,  { passive: true });
  }

  // ─── Interface ─────────────────────────────────────────────────────────────

  _setupUI() {
    const style = document.createElement('style');
    style.textContent = `
      .asm-panel { position:fixed; left:0; top:0; bottom:0; width:180px;
        background:rgba(10,10,16,0.88); backdrop-filter:blur(10px);
        border-right:1px solid #1e1e2e;
        display:flex; flex-direction:column; z-index:50; overflow:hidden; }
      .asm-panel-header { padding:10px 12px 6px;
        font-family:monospace; font-size:11px; color:#556;
        text-transform:uppercase; letter-spacing:.1em;
        border-bottom:1px solid #1e1e2e; flex-shrink:0; }
      .asm-list { flex:1; overflow-y:auto; padding:6px 0; }
      .asm-list::-webkit-scrollbar { width:4px; }
      .asm-list::-webkit-scrollbar-thumb { background:#2a2a3a; border-radius:2px; }
      .asm-item { padding:6px 14px; cursor:pointer;
        font-family:monospace; font-size:11px; color:#889; line-height:1.4;
        transition:background .12s, color .12s; border-left:2px solid transparent; }
      .asm-item:hover { background:#ffffff08; color:#bbb; }
      .asm-item.sel { background:#00aaff14; color:#00aaff;
        border-left-color:#00aaff; }
      .asm-footer { position:fixed; bottom:16px; right:16px;
        display:flex; gap:10px; z-index:50; }
      .asm-footer button { padding:13px 22px; border:none; border-radius:10px;
        font-size:15px; font-weight:700; cursor:pointer;
        box-shadow:0 4px 14px rgba(0,0,0,.4); }
      .asm-bar { position:fixed; top:0; left:180px; right:0; height:34px;
        background:rgba(0,0,0,0.5); backdrop-filter:blur(6px);
        display:flex; align-items:center; justify-content:center;
        gap:2rem; z-index:40; font-family:monospace; font-size:11px;
        color:#556; pointer-events:none; }
    `;
    document.head.appendChild(style);
    this._ui.push(style);

    // ── Panneau gauche : liste de briques ─────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'asm-panel';

    const header = document.createElement('div');
    header.className = 'asm-panel-header';
    header.textContent = 'Briques';
    panel.appendChild(header);

    this._listEl = document.createElement('div');
    this._listEl.className = 'asm-list';
    panel.appendChild(this._listEl);

    document.body.appendChild(panel);
    this._ui.push(panel);

    // ── Barre du haut ────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'asm-bar';
    const hint  = document.createElement('span');
    hint.textContent = 'Clic: placer  •  Clic droit: effacer  •  Échap: annuler sélection';
    const count = document.createElement('span');
    count.id = 'asm-count';
    bar.append(hint, count);
    document.body.appendChild(bar);
    this._ui.push(bar);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'asm-footer';

    const clearBtn = document.createElement('button');
    clearBtn.textContent = '🗑 Effacer';
    clearBtn.style.cssText = 'background:#333; color:#ccc;';
    clearBtn.addEventListener('click', () => { if (!this._simulating) this._clearAll(); });

    const simBtn = document.createElement('button');
    simBtn.textContent = '▶ Simuler';
    simBtn.style.cssText = 'background:#00aaff; color:#000;';
    simBtn.addEventListener('click', () => {
      if (!this._simulating) {
        if (!this._bricks.length) return;
        this._startSimulation();
        simBtn.textContent   = '⏹ Arrêter';
        simBtn.style.background = '#e74c3c';
        simBtn.style.color      = '#fff';
        clearBtn.disabled = true;
      } else {
        this._stopSimulation();
        simBtn.textContent   = '▶ Simuler';
        simBtn.style.background = '#00aaff';
        simBtn.style.color      = '#000';
        clearBtn.disabled = false;
      }
    });

    footer.append(clearBtn, simBtn);
    document.body.appendChild(footer);
    this._ui.push(footer);

    this.engine.onUpdate = () => {
      count.textContent = `Briques : ${this._bricks.length}`;
    };
  }

  _populateBankUI() {
    this._listEl.innerHTML = '';
    for (const name of this._bankList) {
      const item = document.createElement('div');
      item.className = 'asm-item';
      item.textContent = name;
      item.addEventListener('click', () => {
        this._currentBrickName = name;
        document.querySelectorAll('.asm-item').forEach(el => el.classList.remove('sel'));
        item.classList.add('sel');
        this._selectBrick(name);
      });
      this._listEl.appendChild(item);
    }
  }
}
