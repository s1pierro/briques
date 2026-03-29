import * as THREE from 'three';
import { InvolvedBricksSolver }      from './InvolvedBricksSolver.js';
import { InvolvedBricksSolverAsm }   from './InvolvedBricksSolverAsm.js';
import { InvolvedComponentsSolver }  from './InvolvedComponentsSolver.js';

// ─── Constantes visuelles ──────────────────────────────────────────────────────

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

const DISC_R      = 0.75;  // rayon du disque de liaison (identique au joint marker)
const MARKER_R    = 0.95;  // rayon du cercle des sphères de pas (à l'extérieur du disque)
const CURSOR_R    = 0.95;  // rayon du curseur (même cercle que les marqueurs)

// ─── AsmDofHandler ────────────────────────────────────────────────────────────
//
// Gère UN degré de liberté d'assemblage :
//   • un helper 3D positionné au pivot (slot B en world)
//   • un bandeau tactile (4vh, 50 % largeur) sous la barre Assembler
//
// Paramètres :
//   dof        — entrée asmDof  { type, axis, min, max, step }
//   conn       — connexion      { instA, instB, slotA, slotB, liaison }
//   engine     — GameEngine
//   stripIndex — rang vertical du bandeau
//   topOffset  — px avant le premier bandeau (hauteur barre Assembler)
//   steps      — nombre de divisions fourni par la config (0 = fallback dof.step)
//                rotation : 2π / steps  |  translation : range / steps

export class AsmDofHandler {

  constructor({ dof, conn, engine, stripIndex = 0, topOffset = 0, steps = 0, connections = [], solver = 'physics', xray = false, stripBg = '#12121899', stripFont = '#cccccc' }) {
    this._dof         = dof;
    this._conn        = conn;
    this._engine      = engine;
    this._stripIndex  = stripIndex;
    this._topOffset   = topOffset;
    this._connections = connections; // toutes les connexions de la scène (pour InvolvedBricksSolver)
    this._solver      = solver;      // 'physics' | 'asm' | 'component'
    this._xray        = xray;        // true → helper visible à travers la géométrie
    this._stripBg     = stripBg;
    this._stripFont   = stripFont;
    this._helper        = null;
    this._strip         = null;
    this._rawTotal      = 0;
    this._valEl         = null;
    this._cursorMeshes  = []; // 4 sphères pour rotation, 1 pour translation
    this._refAxis       = null; // axe monde du DOF
    this._refU          = null; // vecteur "zéro" dans le plan du disque
    this._refV          = null; // vecteur orthogonal dans le plan du disque
    this._involvedBricks = [conn.instA]; // briques à déplacer (résolu à l'attach)

    this._lblEl    = null;
    this._limEl    = null;
    this._hintEl   = null;
    this._stepBtn  = null;
    this._applyStepStyle = null;

    if (steps > 0) {
      if (dof.type === 'translation') {
        const range = (dof.max != null && dof.min != null) ? (dof.max - dof.min) : 4;
        this._stepSize = range / steps;
      } else {
        this._stepSize = (2 * Math.PI) / steps;
      }
    } else {
      this._stepSize = dof.step ?? 0;
    }
    this._stepActive = this._stepSize > 0;
  }

  attach() {
    this._buildHelper();
    this._buildStrip();
  }

  /** Switch vers un DOF colinéaire : aligne l'axe source sur l'axe cible,
   *  ce qui retourne naturellement la brique autour du pivot. */
  switchDof(newDof) {
    const oldWorldAxis = this._worldAxis();
    const pivotWorld   = this._pivotWorld();

    // Calculer le nouvel axe monde depuis newDof
    const { instB, slotB } = this._conn;
    const [ax, ay, az] = newDof.axis ?? [0, 0, 1];
    const slotBQ = new THREE.Quaternion(...slotB.quaternion);
    const worldQ = slotBQ.premultiply(instB.mesh.quaternion.clone());
    const newWorldAxis = new THREE.Vector3(ax, ay, az).normalize().applyQuaternion(worldQ).normalize();

    // Rotation qui amène l'ancien axe sur le nouveau
    const flip = new THREE.Quaternion().setFromUnitVectors(oldWorldAxis, newWorldAxis);
    for (const brick of this._involvedBricks) {
      brick.mesh.position.sub(pivotWorld).applyQuaternion(flip).add(pivotWorld);
      brick.mesh.quaternion.premultiply(flip);
    }

    this.detach();
    this._dof      = newDof;
    this._rawTotal = 0;
    if (newDof.step != null && newDof.step > 0) {
      this._stepSize = newDof.step;
    }
    this._stepActive = this._stepSize > 0;
    this.attach();
  }

  detach() {
    if (this._helper) {
      this._engine.scene.remove(this._helper);
      this._helper.traverse(o => {
        o.geometry?.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material])
            .forEach(m => m.dispose());
        }
      });
      this._helper = null;
    }
    this._cursorMeshes = [];
    this._strip?.remove();
    this._strip = null;
  }

  // ── Helper 3D ───────────────────────────────────────────────────────────────

  _buildHelper() {
    const { instB, slotB } = this._conn;
    const dof   = this._dof;
    const color = DOF_COLOR[dof.type] ?? 0xffffff;

    const worldAxis  = this._worldAxis();
    const pivotWorld = this._pivotWorld();

    // Repère de référence (direction zéro = axe X du slot B projeté dans le plan)
    this._refAxis = worldAxis.clone();
    if (dof.type !== 'ball') this._buildRefFrame();

    const mat = () => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.70,
      depthWrite: false, side: THREE.DoubleSide,
    });

    const group = new THREE.Group();
    group.position.copy(pivotWorld);

    // ── Géométrie principale ──────────────────────────────────────────────────
    switch (dof.type) {

      case 'rotation': {
        const torus = new THREE.Mesh(
          new THREE.TorusGeometry(DISC_R, 0.03, 8, 64), mat());
        torus.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldAxis);
        torus.renderOrder = 997;
        group.add(torus);
        break;
      }

      case 'translation': {
        [worldAxis.clone(), worldAxis.clone().negate()].forEach(dir => {
          const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 0.9, color, 0.22, 0.12);
          arrow.traverse(o => {
            if (o.material) { o.material = o.material.clone(); o.material.depthWrite = false; }
            o.renderOrder = 997;
          });
          group.add(arrow);
        });
        break;
      }

      case 'ball': {
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(0.50, 16, 12), mat());
        sphere.renderOrder = 997;
        group.add(sphere);
        break;
      }

      case 'cylindrical': {
        const cyl = new THREE.Mesh(
          new THREE.CylinderGeometry(0.32, 0.32, 1.20, 32), mat());
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldAxis);
        cyl.renderOrder = 997;
        group.add(cyl);
        [worldAxis.clone(), worldAxis.clone().negate()].forEach(dir => {
          const arrow = new THREE.ArrowHelper(
            dir, new THREE.Vector3(0, 0.60, 0).applyQuaternion(cyl.quaternion),
            0.40, color, 0.14, 0.08,
          );
          arrow.traverse(o => {
            if (o.material) { o.material = o.material.clone(); o.material.depthWrite = false; }
            o.renderOrder = 997;
          });
          group.add(arrow);
        });
        break;
      }
    }

    // ── Briques embarquées ────────────────────────────────────────────────────
    // null pour ball (pas d'axe unique → fallback instA seule)
    const solverAxis = (dof.type === 'ball') ? null : this._refAxis;
    const solverInst = this._solver === 'component'
      ? new InvolvedComponentsSolver()
      : this._solver === 'asm'
      ? new InvolvedBricksSolverAsm()
      : new InvolvedBricksSolver();
    this._involvedBricks = solverInst.solve(this._conn, this._connections, solverAxis);

    // ── Offset initial (brique déjà en position post-DOF) ────────────────────
    if (dof.type !== 'ball') this._computeInitialOffset();

    // ── Sphères de pas + curseur ──────────────────────────────────────────────
    if (dof.type === 'rotation' || dof.type === 'cylindrical') {
      this._addDiscMarkers(group, color);
      this._addCursor(group);
    } else if (dof.type === 'translation') {
      this._addAxisMarkers(group, color);
      this._addCursor(group);
    }

    if (this._xray) {
      group.traverse(o => {
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material])
            .forEach(m => { m.depthTest = false; });
        }
      });
    }

    this._engine.scene.add(group);
    this._helper = group;
  }

  /** Calcule _refU et _refV : repère orthonormé dans le plan du disque,
   *  direction zéro alignée sur l'axe X local du slot B. */
  _buildRefFrame() {
    const { instB, slotB } = this._conn;
    const slotBQ  = new THREE.Quaternion(...slotB.quaternion);
    const worldBQ = slotBQ.clone().premultiply(instB.mesh.quaternion.clone());
    const wa = this._refAxis;

    // Axe X du slot B en world, projeté dans le plan perpendiculaire à wa
    let u = new THREE.Vector3(1, 0, 0).applyQuaternion(worldBQ);
    u.addScaledVector(wa, -u.dot(wa));
    if (u.lengthSq() < 1e-4) {
      // Cas dégénéré : wa colinéaire avec X → utiliser Y
      u = new THREE.Vector3(0, 1, 0).applyQuaternion(worldBQ);
      u.addScaledVector(wa, -u.dot(wa));
    }
    u.normalize();
    this._refU = u;
    this._refV = wa.clone().cross(u).normalize();
  }

  /** Sphères réparties sur le cercle MARKER_R pour les DOF de rotation. */
  _addDiscMarkers(group, color) {
    if (this._stepSize <= 0) return;
    const N = Math.round((2 * Math.PI) / this._stepSize);
    if (N < 2 || N > 72) return;

    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, depthWrite: false,
    });
    for (let i = 0; i < N; i++) {
      const a = i * this._stepSize;
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 5), mat);
      m.position
        .copy(this._refU).multiplyScalar(Math.cos(a) * MARKER_R)
        .addScaledVector(this._refV, Math.sin(a) * MARKER_R);
      m.renderOrder = 997;
      group.add(m);
    }
  }

  /** Sphères le long de l'axe pour les DOF de translation bornés. */
  _addAxisMarkers(group, color) {
    if (this._stepSize <= 0) return;
    const dof = this._dof;
    if (dof.min == null || dof.max == null) return;
    const N = Math.round((dof.max - dof.min) / this._stepSize) + 1;
    if (N < 2 || N > 60) return;

    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, depthWrite: false,
    });
    for (let i = 0; i < N; i++) {
      const t = dof.min + i * this._stepSize;
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 5), mat);
      m.position.copy(this._refAxis).multiplyScalar(t);
      m.renderOrder = 997;
      group.add(m);
    }
  }

  /** Sphères blanches indiquant la position courante.
   *  Rotation/cylindrical : 4 sphères espacées de 90°.
   *  Translation          : 1 sphère sur l'axe. */
  _addCursor(group) {
    const isRot  = this._dof.type !== 'translation';
    const count  = isRot ? 4 : 1;
    const mat    = new THREE.MeshBasicMaterial({
      color: 0xffffff, depthWrite: false, transparent: true, opacity: 0.9,
    });
    for (let k = 0; k < count; k++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), mat);
      m.renderOrder = 998;
      group.add(m);
      this._cursorMeshes.push(m);
    }
    this._updateCursor();
  }

  /** Initialise _rawTotal depuis la géométrie réelle de la scène.
   *
   *  Source de vérité : AsmBrick.worldSlotPos / worldSlotQuat (pose courante du mesh).
   *
   *  Translation : projection de (slotA_monde − slotB_monde) sur l'axe DOF.
   *  Rotation    : angle extrait du quaternion relatif qA * qB⁻¹ autour de l'axe DOF.
   *                L'axe est défini dans rbang_liaisons (dof.axis) et déjà transformé
   *                dans _refAxis (espace monde via le repère du slot B fixe).
   */
  _computeInitialOffset() {
    const { instA, instB, slotA, slotB } = this._conn;
    const dof = this._dof;

    if (dof.type === 'translation') {
      const posA = instA.worldSlotPos(slotA);
      const posB = instB.worldSlotPos(slotB);
      this._rawTotal = posA.clone().sub(posB).dot(this._refAxis);

    } else {
      // rotation / cylindrical
      // qDiff = qA * qB⁻¹ : rotation de B vers A autour de l'axe DOF (≈ _refAxis)
      const qA    = instA.worldSlotQuat(slotA);
      const qB    = instB.worldSlotQuat(slotB);
      const qDiff = qA.clone().multiply(qB.clone().invert());
      // Projection sur l'axe DOF monde → sin(θ/2)
      const sinHalf = new THREE.Vector3(qDiff.x, qDiff.y, qDiff.z)
        .dot(this._refAxis);
      this._rawTotal = 2 * Math.atan2(sinHalf, qDiff.w);
    }
  }

  /** Repositionne les sphères curseur sur la position réellement engagée. */
  _updateCursor() {
    if (!this._cursorMeshes.length) return;

    // Position réelle = snapped si step actif, sinon rawTotal (déjà clampé)
    let pos = this._rawTotal;
    if (this._stepActive && this._stepSize > 0) {
      pos = Math.round(pos / this._stepSize) * this._stepSize;
    }
    const dof = this._dof;
    if (dof.min != null) pos = Math.max(dof.min, pos);
    if (dof.max != null) pos = Math.min(dof.max, pos);

    if (dof.type === 'translation') {
      this._cursorMeshes[0].position.copy(this._refAxis).multiplyScalar(pos);
    } else {
      // 4 sphères espacées de 90°
      for (let k = 0; k < this._cursorMeshes.length; k++) {
        const a = pos + k * Math.PI / 2;
        this._cursorMeshes[k].position
          .copy(this._refU).multiplyScalar(Math.cos(a) * CURSOR_R)
          .addScaledVector(this._refV, Math.sin(a) * CURSOR_R);
      }
    }
  }

  // ── Bandeau tactile ─────────────────────────────────────────────────────────

  _buildStrip() {
    const dof   = this._dof;
    const color = '#' + (DOF_COLOR[dof.type] ?? 0x888888).toString(16).padStart(6, '0');
    const label = DOF_LABELS[dof.type] ?? dof.type;
    const axStr = dof.axis ? `[${dof.axis.map(v => v.toFixed(2)).join(', ')}]` : '';

    const strip = document.createElement('div');
    strip.className = 'asm-dof-strip';
    strip.style.cssText = [
      'position:fixed', 'right:12px',
      `top:calc(${this._topOffset + 8}px + ${this._stripIndex} * 6vh)`,
      'width:50vw', 'height:5.5vh',
      'display:flex', 'align-items:center', 'padding:0 10px', 'gap:6px',
      `background:${this._stripBg}`,
      `border-left:6px solid ${color}`,
      'z-index:130',
      'touch-action:none', 'cursor:ew-resize',
      'user-select:none', 'pointer-events:auto',
      `font:11px sans-serif`, `color:${this._stripFont}`,
      'border-radius:4px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    ].join(';');

    // ── Bouton step ────────────────────────────────────────────────────────
    const stepBtn = document.createElement('button');
    stepBtn.textContent = this._stepSize > 0 ? this._formatVal(this._stepSize) : '—';
    const applyStepStyle = (active) => {
      const font = this._stripFont;
      stepBtn.style.cssText = [
        'flex-shrink:0', 'border-radius:3px', 'font-size:9px',
        'padding:1px 6px', 'cursor:pointer', 'line-height:1.4',
        `border:1px solid ${active ? font : font + '55'}`,
        `background:${active ? font + '22' : 'transparent'}`,
        `color:${active ? font : font + '88'}`,
        'transition:background .1s,border-color .1s,color .1s',
        'touch-action:auto',
      ].join(';');
    };
    applyStepStyle(this._stepActive);
    this._stepBtn = stepBtn;
    this._applyStepStyle = applyStepStyle;

    stepBtn.addEventListener('pointerdown', e => e.stopPropagation());
    stepBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._stepActive = !this._stepActive;
      applyStepStyle(this._stepActive);
      if (this._stepActive && this._stepSize > 0) {
        // Recaler sur le pas le plus proche depuis l'alignement (zéro)
        const snapped = Math.round(this._rawTotal / this._stepSize) * this._stepSize;
        const diff = snapped - this._rawTotal;
        if (Math.abs(diff) > 1e-9) {
          this._moveDelta(diff);
          this._rawTotal = snapped;
          if (this._valEl) this._valEl.textContent = this._formatVal(this._rawTotal);
        }
        this._updateCursor();
      }
    });
    strip.appendChild(stepBtn);

    // Étiquette type + axe
    const lbl = document.createElement('span');
    lbl.style.cssText = `color:${this._stripFont};font-weight:bold;flex-shrink:0;letter-spacing:.04em;`;
    lbl.textContent   = `${label} ${axStr}`;
    strip.appendChild(lbl);
    this._lblEl = lbl;

    // Limites si définies
    if (dof.min != null || dof.max != null) {
      const limEl = document.createElement('span');
      limEl.style.cssText = `color:${this._stripFont};opacity:0.5;font-size:9px;flex-shrink:0;`;
      const minStr = dof.min != null ? dof.min : '−∞';
      const maxStr = dof.max != null ? dof.max : '+∞';
      const unit   = dof.type === 'rotation' ? '°' : 'm';
      limEl.textContent = `${minStr}${unit} … ${maxStr}${unit}`;
      strip.appendChild(limEl);
      this._limEl = limEl;
    }

    // Valeur courante (position effective à l'attach, peut être post-DOF)
    const valEl = document.createElement('span');
    valEl.style.cssText = `flex:1;text-align:right;font-variant-numeric:tabular-nums;font-size:10px;color:${this._stripFont};opacity:0.7;`;
    {
      let displayed = this._rawTotal;
      if (this._stepActive && this._stepSize > 0)
        displayed = Math.round(displayed / this._stepSize) * this._stepSize;
      if (dof.min != null) displayed = Math.max(dof.min, displayed);
      if (dof.max != null) displayed = Math.min(dof.max, displayed);
      valEl.textContent = this._formatVal(displayed);
    }
    strip.appendChild(valEl);
    this._valEl = valEl;

    // Hint
    const hint = document.createElement('span');
    hint.style.cssText = `color:${this._stripFont};opacity:0.35;font-size:12px;flex-shrink:0;`;
    hint.textContent   = '◀ ▶';
    strip.appendChild(hint);
    this._hintEl = hint;

    // ── Geste pointer ──────────────────────────────────────────────────────
    let lastX = 0;

    strip.addEventListener('pointerdown', e => {
      e.stopPropagation();
      strip.setPointerCapture(e.pointerId);
      lastX = e.clientX;
      strip.style.filter = 'brightness(1.3)';
    }, { passive: false });

    strip.addEventListener('pointermove', e => {
      if (!strip.hasPointerCapture(e.pointerId)) return;
      const dx    = e.clientX - lastX;
      lastX       = e.clientX;
      const delta = this._pxToRaw(dx);
      this._applyDelta(delta);
      // Afficher la position effective (snappée + clampée), pas le brut
      let displayed = this._rawTotal;
      if (this._stepActive && this._stepSize > 0) {
        displayed = Math.round(displayed / this._stepSize) * this._stepSize;
      }
      const dof = this._dof;
      if (dof.min != null) displayed = Math.max(dof.min, displayed);
      if (dof.max != null) displayed = Math.min(dof.max, displayed);
      valEl.textContent = this._formatVal(displayed);
    }, { passive: false });

    const onRelease = () => {
      strip.style.filter = '';
      this.onRelease?.();
    };
    strip.addEventListener('pointerup',     onRelease);
    strip.addEventListener('pointercancel', onRelease);

    document.body.appendChild(strip);
    this._strip = strip;
  }

  // ── Maths ───────────────────────────────────────────────────────────────────

  /** Axe du DOF en coordonnées monde. */
  _worldAxis() {
    const { instB, slotB } = this._conn;
    const [ax, ay, az] = this._dof.axis ?? [0, 0, 1];
    const slotBQ = new THREE.Quaternion(...slotB.quaternion);
    const worldQ = slotBQ.premultiply(instB.mesh.quaternion.clone());
    return new THREE.Vector3(ax, ay, az).normalize().applyQuaternion(worldQ).normalize();
  }

  /** Position monde du slot B (pivot fixe). */
  _pivotWorld() {
    const { instB, slotB } = this._conn;
    return new THREE.Vector3(...slotB.position)
      .applyQuaternion(instB.mesh.quaternion)
      .add(instB.mesh.position);
  }

  /** Convertit un delta pixel en valeur brute (rad ou unités monde). */
  _pxToRaw(px) {
    const dof = this._dof;
    if (dof.type === 'translation') {
      const range = (dof.max != null && dof.min != null) ? (dof.max - dof.min) : 4;
      return (px / innerWidth) * range;
    }
    return (px / innerWidth) * Math.PI * 2;
  }

  /** Applique un déplacement effectif à toutes les briques embarquées (sans snap ni clamp). */
  _moveDelta(effective) {
    const worldAxis  = this._worldAxis();
    const pivotWorld = this._pivotWorld();
    if (this._dof.type === 'translation') {
      for (const brick of this._involvedBricks) {
        brick.mesh.position.addScaledVector(worldAxis, effective);
      }
    } else {
      const q = new THREE.Quaternion().setFromAxisAngle(worldAxis, effective);
      for (const brick of this._involvedBricks) {
        brick.mesh.position.sub(pivotWorld).applyQuaternion(q).add(pivotWorld);
        brick.mesh.quaternion.premultiply(q);
      }
    }
  }

  /** Applique un delta brut en respectant le mode step et min/max. */
  _applyDelta(rawDelta) {
    const dof = this._dof;
    let effective = rawDelta;

    const snap = this._stepActive && this._stepSize > 0 ? this._stepSize : 0;

    if (snap > 0) {
      const prevSnapped = Math.round(this._rawTotal / snap) * snap;
      this._rawTotal   += rawDelta;
      const newSnapped  = Math.round(this._rawTotal / snap) * snap;
      effective = newSnapped - prevSnapped;
      if (effective === 0) return;
    } else {
      this._rawTotal += rawDelta;
    }

    // Clamp min/max
    if (dof.min != null && this._rawTotal < dof.min) {
      effective    -= this._rawTotal - dof.min;
      this._rawTotal = dof.min;
    }
    if (dof.max != null && this._rawTotal > dof.max) {
      effective    -= this._rawTotal - dof.max;
      this._rawTotal = dof.max;
    }
    if (effective === 0) return;

    this._moveDelta(effective);
    this._updateCursor();
  }

  /** Formate la valeur accumulée pour affichage. */
  _formatVal(raw) {
    const dof = this._dof;
    if (dof.type === 'rotation' || dof.type === 'ball' || dof.type === 'cylindrical') {
      return (raw * 180 / Math.PI).toFixed(1) + '°';
    }
    return raw.toFixed(3) + ' m';
  }

  /** Met à jour les couleurs du strip en live (appelé depuis AsmHandlers). */
  updateStripStyle(stripBg, stripFont) {
    this._stripBg   = stripBg;
    this._stripFont = stripFont;
    const s = this._strip;
    if (!s) return;
    s.style.background = stripBg;
    s.style.color      = stripFont;
    if (this._lblEl)  this._lblEl.style.color  = stripFont;
    if (this._limEl)  this._limEl.style.color  = stripFont;
    if (this._valEl)  this._valEl.style.color  = stripFont;
    if (this._hintEl) this._hintEl.style.color = stripFont;
    // re-appliquer le style du bouton step avec la nouvelle couleur font
    if (this._applyStepStyle) this._applyStepStyle(this._stepActive);
    // bouton switch ⇅ (ajouté par AsmHandlers, 2e enfant du strip)
    const switchBtn = s.querySelector('.asm-switch-btn');
    if (switchBtn) {
      switchBtn.style.color       = stripFont;
      switchBtn.style.borderColor = stripFont;
    }
  }
}

// ─── AsmHandlers ──────────────────────────────────────────────────────────────
//
// Orchestre les AsmDofHandler d'une connexion.
// Détecte les DOFs colinéaires (axes parallèles ou antiparallèles) et les
// regroupe : un seul handler actif à la fois, avec un bouton ⇅ pour switcher.

/** Deux axes sont colinéaires si |dot| ≈ 1. */
function _areColinear(axA, axB, eps = 0.99) {
  const a = new THREE.Vector3(...(axA ?? [0, 0, 1])).normalize();
  const b = new THREE.Vector3(...(axB ?? [0, 0, 1])).normalize();
  return Math.abs(a.dot(b)) >= eps;
}

export class AsmHandlers {

  constructor({ conn, engine, topOffset = 0, stepsRot = 0, stepsTrans = 0, connections = [], solver = 'physics', xray = false, stripBg = '#12121899', stripFont = '#cccccc' }) {
    this._conn        = conn;
    this._engine      = engine;
    this._topOffset   = topOffset;
    this._stepsRot    = stepsRot;
    this._stepsTrans  = stepsTrans;
    this._connections = connections;
    this._solver      = solver;
    this._xray        = xray;
    this._stripBg     = stripBg;
    this._stripFont   = stripFont;
    this._onReleaseFn = null;

    // Grouper les DOFs : colinéaires ensemble, indépendants seuls
    const allDofs = conn.liaison?.asmDof ?? [];
    console.log(`[AsmHandlers] liaison "${conn.liaison?.name}" — ${allDofs.length} DOF(s)`, allDofs.map(d => `${d.type} [${d.axis}]`));
    this._groups   = this._buildGroups(allDofs);
    console.log(`[AsmHandlers] → ${this._groups.length} groupe(s)`, this._groups.map(g => `${g.dofs.length} DOF(s)`));
    this._handlers = [];
  }

  get active() { return this._groups.length > 0; }
  get conn() { return this._conn; }

  /** Callback appelé après chaque release du strip (pointerup/cancel). */
  set onRelease(fn) {
    this._onReleaseFn = fn;
    this._handlers.forEach(h => h.onRelease = fn);
  }

  attach() {
    this._handlers = [];
    let stripIndex = 0;
    for (const group of this._groups) {
      const dof     = group.dofs[group.activeIndex];
      const steps   = dof.type === 'translation' ? this._stepsTrans : this._stepsRot;
      const handler = new AsmDofHandler({
        dof, conn: this._conn, engine: this._engine,
        stripIndex, topOffset: this._topOffset,
        steps, connections: this._connections,
        solver: this._solver, xray: this._xray,
        stripBg: this._stripBg, stripFont: this._stripFont,
      });
      handler.onRelease = this._onReleaseFn;
      handler.attach();

      // Si le groupe a des alternatives colinéaires → bouton switch dans le strip
      if (group.dofs.length > 1 && handler._strip) {
        this._addSwitchBtn(handler._strip, group, stripIndex);
      }

      this._handlers.push(handler);
      group.handler = handler;
      stripIndex++;
    }
  }

  /** Met à jour le style des strips actifs en live. */
  updateStripStyle(stripBg, stripFont) {
    this._stripBg   = stripBg;
    this._stripFont = stripFont;
    this._handlers.forEach(h => h.updateStripStyle(stripBg, stripFont));
  }

  detach() {
    this._handlers.forEach(h => h.detach());
    this._handlers = [];
  }

  // ── Groupement colinéaire ──────────────────────────────────────────────────

  _buildGroups(dofs) {
    const groups = [];   // [{ dofs: [dof, …], activeIndex: 0 }]
    const used   = new Set();

    for (let i = 0; i < dofs.length; i++) {
      if (used.has(i)) continue;
      const group = { dofs: [dofs[i]], activeIndex: 0, handler: null };
      used.add(i);
      for (let j = i + 1; j < dofs.length; j++) {
        if (used.has(j)) continue;
        if (dofs[i].type === dofs[j].type && _areColinear(dofs[i].axis, dofs[j].axis)) {
          console.log(`[AsmHandlers] colinéaire détecté : DOF#${i} axis=[${dofs[i].axis}] ↔ DOF#${j} axis=[${dofs[j].axis}]`);
          group.dofs.push(dofs[j]);
          used.add(j);
        }
      }
      groups.push(group);
    }
    return groups;
  }

  // ── Bouton switch ──────────────────────────────────────────────────────────

  _addSwitchBtn(strip, group, stripIndex) {
    const btn = document.createElement('button');
    btn.className   = 'asm-switch-btn';
    btn.textContent = '⇅';
    btn.title       = `Repère alternatif (${group.dofs.length} alignements)`;
    const font = this._stripFont;
    btn.style.cssText = [
      'flex-shrink:0', 'border-radius:3px', 'font-size:12px',
      'padding:1px 6px', 'cursor:pointer', 'line-height:1.4',
      `border:1px solid ${font}`, 'background:transparent',
      `color:${font}`, 'touch-action:auto',
    ].join(';');

    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const next = (group.activeIndex + 1) % group.dofs.length;
      console.log(`[AsmHandlers] switch DOF ${group.activeIndex} → ${next}, axis=[${group.dofs[next].axis}]`);
      this._switchGroup(group, stripIndex);
    });

    // Insérer après le bouton step (premier enfant)
    if (strip.children.length > 1) {
      strip.insertBefore(btn, strip.children[1]);
    } else {
      strip.appendChild(btn);
    }
  }

  _switchGroup(group, stripIndex) {
    // Avancer au DOF suivant dans le groupe
    group.activeIndex = (group.activeIndex + 1) % group.dofs.length;
    const newDof = group.dofs[group.activeIndex];
    console.log(`[AsmHandlers] switch effectif → DOF axis=[${newDof.axis}]`);

    // Switcher le DOF sur le handler existant (rebuild helper + strip)
    group.handler.switchDof(newDof);

    // Ré-injecter le bouton switch dans le nouveau strip
    if (group.dofs.length > 1 && group.handler._strip) {
      this._addSwitchBtn(group.handler._strip, group, stripIndex);
    }
  }
}
