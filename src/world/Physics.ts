import RAPIER from '@dimforge/rapier3d-compat';
import { quatY } from '../core/math';

export type TagKind = 'player' | 'police' | 'civilian' | 'obstacle' | 'prop' | 'wall';

/** Metadatos asociados a cada collider para resolver colisiones de juego. */
export interface Tag {
  kind: TagKind;
  /** Entidad dueña (Player, PoliceUnit, Civilian u ObstacleRecord). */
  ref?: unknown;
}

export interface DynamicOptions {
  density?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** Permite girar sobre el eje Y por las colisiones (props sueltos). */
  rotates?: boolean;
  events?: boolean;
  ccd?: boolean;
  friction?: number;
  restitution?: number;
}

/**
 * Todo el juego ocurre en el plano XZ. Todos los colliders tienen la misma
 * altura física (centro y=1, semialtura 1) para que los contactos sean
 * siempre horizontales; la altura visual de cada objeto es independiente.
 */
const HY = 1;

export class Physics {
  readonly world: RAPIER.World;
  private queue: RAPIER.EventQueue;
  private tags = new Map<number, Tag>();
  private readonly ray = new RAPIER.Ray({ x: 0, y: HY, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = 1 / 60;
    this.queue = new RAPIER.EventQueue(true);
  }

  tagOf(handle: number): Tag | undefined {
    return this.tags.get(handle);
  }

  fixedBox(x: number, z: number, hx: number, hz: number, rotY: number, tag: Tag): RAPIER.RigidBody {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, HY, z).setRotation(quatY(rotY)));
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, HY, hz).setFriction(0.2), body);
    this.tags.set(col.handle, tag);
    return body;
  }

  fixedBall(x: number, z: number, r: number, tag: Tag): RAPIER.RigidBody {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, HY, z));
    const col = this.world.createCollider(RAPIER.ColliderDesc.cylinder(HY, r).setFriction(0.2), body);
    this.tags.set(col.handle, tag);
    return body;
  }

  dynamicBox(x: number, z: number, hx: number, hz: number, rotY: number, tag: Tag, o: DynamicOptions = {}): RAPIER.RigidBody {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, HY, z)
      .setRotation(quatY(rotY))
      .enabledTranslations(true, false, true)
      .enabledRotations(false, o.rotates ?? false, false)
      .setLinearDamping(o.linearDamping ?? 0)
      .setAngularDamping(o.angularDamping ?? 2)
      .setCcdEnabled(o.ccd ?? false);
    const body = this.world.createRigidBody(desc);
    let cd = RAPIER.ColliderDesc.cuboid(hx, HY, hz)
      .setDensity(o.density ?? 1)
      .setFriction(o.friction ?? 0.3)
      .setRestitution(o.restitution ?? 0.2);
    if (o.events) cd = cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const col = this.world.createCollider(cd, body);
    this.tags.set(col.handle, tag);
    return body;
  }

  remove(body: RAPIER.RigidBody): void {
    for (let i = 0; i < body.numColliders(); i++) this.tags.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  /** Avanza un paso fijo y notifica los contactos que comienzan. */
  step(onContact: (a: Tag, b: Tag) => void): void {
    this.world.step(this.queue);
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.tags.get(h1);
      const b = this.tags.get(h2);
      if (a && b) onContact(a, b);
    });
  }

  /** Distancia hasta el primer obstáculo fijo en una dirección, o null. */
  rayFixed(ox: number, oz: number, dx: number, dz: number, maxDist: number): number | null {
    this.ray.origin = { x: ox, y: HY, z: oz };
    this.ray.dir = { x: dx, y: 0, z: dz };
    const hit = this.world.castRay(
      this.ray,
      maxDist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    return hit ? hit.timeOfImpact : null;
  }

  dispose(): void {
    this.queue.free();
    this.world.free();
    this.tags.clear();
  }
}
