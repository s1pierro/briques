import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

export const R = RAPIER;

export const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeStaticBox(hx, hy, hz, x, y, z) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
  const shape = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
  world.createCollider(shape, body);
  return body;
}

export function makeDynamicBox(hx, hy, hz, x, y, z) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  const shape = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setRestitution(0.3).setFriction(0.6);
  world.createCollider(shape, body);
  return body;
}

export function makeDynamicSphere(radius, x, y, z) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  const shape = RAPIER.ColliderDesc.ball(radius).setRestitution(0.4).setFriction(0.5);
  world.createCollider(shape, body);
  return body;
}
