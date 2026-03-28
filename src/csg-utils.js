import * as THREE from 'three';

// ─── Manifold (WASM) ──────────────────────────────────────────────────────────

let _M = null;

export async function getManifold() {
  if (_M) return _M;
  const Module = (await import(window.RBANG_BASE + 'manifold/manifold.js')).default;
  const wasm = await Module();
  wasm.setup();
  _M = wasm;
  return _M;
}

// ─── Évaluation CSG ───────────────────────────────────────────────────────────

export function evalStep(step, cache, M) {
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
      result = a && b ? M.Manifold.union(a, b) : (a || b || M.Manifold.cube([0, 0, 0]));
      break;
    }
    case 'subtract': {
      const a = cache.get(p.a); const b = cache.get(p.b);
      result = a && b ? M.Manifold.difference(a, b) : (a || M.Manifold.cube([0, 0, 0]));
      break;
    }
    case 'intersect': {
      const a = cache.get(p.a); const b = cache.get(p.b);
      result = a && b ? M.Manifold.intersection(a, b) : M.Manifold.cube([0, 0, 0]);
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

  // Transformations (translate, rotate en degrés, scale)
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

export function buildCache(steps, M) {
  const cache = new Map();
  for (const s of steps) evalStep(s, cache, M);
  return cache;
}

export function manifoldToGeometry(manifold) {
  const mesh     = manifold.getMesh();
  const verts    = mesh.vertProperties;  // Float32Array
  const tris     = mesh.triVerts;        // Uint32Array, 3 indices per tri
  const stride   = mesh.numProp ?? 3;
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

/** Extrait les positions xyz uniques d'un Manifold (pour convexHull Rapier). */
export function manifoldToPoints(manifold) {
  const mesh   = manifold.getMesh();
  const verts  = mesh.vertProperties;
  const stride = mesh.numProp ?? 3;
  const n      = verts.length / stride;
  const pts    = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i*3]   = verts[i*stride];
    pts[i*3+1] = verts[i*stride+1];
    pts[i*3+2] = verts[i*stride+2];
  }
  return pts;
}
