import * as THREE from 'three';
import { Rng } from '../core/Rng';
import { PLAYER_COLORS } from '../entities/Player';
import {
  animateMutant,
  box,
  cliff,
  helicopter,
  obstacleMesh,
  palm,
  playerVehicleMesh,
  pursuerMesh,
  rampMesh,
  setSiren,
  type HeliMesh,
  type PursuerMesh,
} from '../fx/Meshes';
import { Effects } from '../fx/Particles';

/*
 * Cinemática del menú: en una carretera del desierto al atardecer, el vehículo
 * del jugador escapa de una patrulla, un auto de la banda, un mutante y el
 * helicóptero; salta una rampa en cámara lenta mientras la patrulla choca unos
 * bidones y estalla detrás. Se repite de fondo detrás del menú.
 *
 * La carretera corre a lo largo de +X (los modelos miran a -Z, así que se giran
 * -90°). Todo se calcula a partir del tiempo de la cinemática, no de la física.
 */

/** Velocidad del vehículo (m/s) y dónde empieza. */
const SPEED = 24;
const START_X = -55;
/** Borde de entrada y de salida de la rampa (en X), y altura de su labio. */
const RAMP_IN = -1.7;
const RAMP_OUT = 1.7;
const RAMP_TOP = 1.0;
/** Despegue (s) y duración del vuelo (s, en tiempo de la cinemática). */
const TAKEOFF = (RAMP_OUT - START_X) / SPEED;
const FLIGHT = 1.6;
const PEAK = 5.5;
/** Explosión de los bidones (s) y fin del ciclo (s). */
const BLAST_AT = TAKEOFF + 0.32;
const LOOP_END = TAKEOFF + FLIGHT + 2.6;
/** Instante que queda congelado detrás del menú: el vehículo en lo alto y la explosión detrás. */
const HOLD_AT = TAKEOFF + 0.62;
/** Velocidad del tiempo mientras está congelado (el humo apenas se mueve). */
const HOLD_SPEED = 0.025;
/** Bidones pasada la rampa, en el carril de la patrulla: estallan detrás del vehículo en vuelo. */
const BARRELS: [number, number][] = [
  [5.2, -6.2],
  [6.4, -7.0],
  [5.8, -7.9],
];
const FACE_X = -Math.PI / 2;

interface Chaser {
  mesh: PursuerMesh;
  lane: number;
  /** Metros por detrás del jugador. */
  lag: number;
  /** Lo alcanza la explosión: sale volando y queda ardiendo. */
  blown?: { t: number; x: number; vy: number; spin: number; y: number; landed: boolean };
}

export class MenuScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 500);
  /** Llamado cuando estallan los bidones (el juego pone el sonido durante la intro). */
  onBlast: (() => void) | null = null;
  /** Llamado al aterrizar el vehículo (fin del momento culminante). */
  onLanded: (() => void) | null = null;
  private fx: Effects;
  private car = new THREE.Group();
  private carId = '';
  private chasers: Chaser[] = [];
  /** Mutantes corriendo por la arena: carril, ventaja y velocidad. */
  private mutants: { mesh: PursuerMesh; z: number; lead: number; speed: number }[] = [];
  private heli: HeliMesh;
  private barrels: THREE.Object3D[] = [];
  private fade: HTMLElement;
  /** Bola de fuego de la explosión y su destello de luz. */
  private fireball: THREE.Mesh;
  private flash: THREE.PointLight;
  /** Luz de relleno desde la cámara en el plano congelado (el sol queda a contraluz). */
  private fill = new THREE.DirectionalLight(0xffc896, 0);
  private blastT = -1;
  /** Tiempo dentro del ciclo (con cámara lenta) y tiempo real total. */
  private t = 0;
  private clock = 0;
  private blasted = false;
  private landed = false;
  private trail = 0;

  constructor() {
    const s = this.scene;
    // Atardecer con bruma: el horizonte se funde con el cielo.
    s.background = new THREE.Color(0xd98a5a);
    s.fog = new THREE.Fog(0xd98a5a, 60, 230);
    s.add(new THREE.HemisphereLight(0xffd2a8, 0x6a4a3a, 1.5));
    const sun = new THREE.DirectionalLight(0xffb070, 2.6);
    sun.position.set(-40, 50, -60);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 40, bottom: -40, near: 1, far: 200 });
    sun.shadow.camera.updateProjectionMatrix();
    s.add(sun, sun.target);

    this.buildWorld();
    this.fx = new Effects(s);

    // Perseguidores: patrulla (en el carril de los bidones), auto de la banda y, por la arena, un mutante.
    // Carriles: negativo = derecha de la toma congelada (detrás de la explosión), positivo = izquierda.
    // Ninguno pasa por la rampa (|carril| > 3.3); los de más de 6 m van por la arena levantando polvo.
    this.chasers = [
      { mesh: pursuerMesh('patrol'), lane: -3.8, lag: 3.5 },
      { mesh: pursuerMesh('swat'), lane: -8, lag: 13 },
      { mesh: pursuerMesh('suv'), lane: 3.6, lag: 15 },
      { mesh: pursuerMesh('muscle'), lane: 3.6, lag: 25 },
      // A la izquierda de la toma congelada, repartidos en profundidad para llenar el espacio junto al menú.
      { mesh: pursuerMesh('moto'), lane: 4.8, lag: 7 },
      { mesh: pursuerMesh('biker'), lane: 6.6, lag: 2 },
      { mesh: pursuerMesh('raider'), lane: 8.4, lag: -1.5 },
      { mesh: pursuerMesh('buggy'), lane: 9.4, lag: 8 },
      { mesh: pursuerMesh('pickup'), lane: 7.4, lag: 14 },
    ];
    for (const c of this.chasers) {
      c.mesh.group.rotation.order = 'YXZ';
      s.add(c.mesh.group);
    }
    for (const [z, lead, speed] of [
      [-13, -6, 10.5],
      [7.6, -10, 11.5],
      [10.5, -18, 12],
    ]) {
      const m = { mesh: pursuerMesh('mutant'), z, lead, speed };
      s.add(m.mesh.group);
      this.mutants.push(m);
    }
    this.heli = helicopter();
    s.add(this.heli.group, this.heli.shadow, this.heli.spot);

    this.fireball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.fireball.visible = false;
    this.flash = new THREE.PointLight(0xff8a3a, 0, 60, 1.6);
    s.add(this.fireball, this.flash, this.fill, this.fill.target);

    this.car.rotation.order = 'YXZ';
    s.add(this.car);
    this.setVehicle('cacharro');

    // Fundido entre ciclos (una capa negra sobre el lienzo).
    this.fade = document.createElement('div');
    this.fade.id = 'cine-fade';
    document.querySelector('#app')!.appendChild(this.fade);
    this.reset();
  }

  /** Vehículo protagonista (el elegido en el garaje). */
  setVehicle(id: string): void {
    if (id === this.carId) return;
    this.carId = id;
    this.car.clear();
    this.car.add(playerVehicleMesh(id, PLAYER_COLORS[0].body, PLAYER_COLORS[0].accent));
  }

  /** Muestra u oculta la capa de fundido (solo mientras la cinemática está en pantalla). */
  setVisible(on: boolean): void {
    this.fade.classList.toggle('hidden', !on);
  }

  private buildWorld(): void {
    const s = this.scene;
    const rng = new Rng(20261022);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 400), new THREE.MeshLambertMaterial({ color: 0xc8955e }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    s.add(ground);
    // Carretera con bordes claros y línea central discontinua.
    const road = box(900, 0.04, 12, 0x3a3836, 0, 0, 0);
    road.receiveShadow = true;
    s.add(road);
    for (const z of [-5.8, 5.8]) s.add(box(900, 0.05, 0.25, 0xe8e2d0, 0, 0, z));
    for (let x = -300; x < 300; x += 8) s.add(box(4, 0.05, 0.22, 0xf1c40f, x, 0, 1.9));
    // Rampa en el carril central, subiendo hacia +X.
    const ramp = rampMesh();
    ramp.rotation.y = FACE_X;
    s.add(ramp);
    // Bidones de combustible junto a la rampa.
    for (const [x, z] of BARRELS) {
      const b = obstacleMesh('fuelBarrel', rng.next());
      b.position.set(x, 0, z);
      s.add(b);
      this.barrels.push(b);
    }
    // Desierto: montañas al fondo, rocas, cactus y algunas palmeras.
    for (let x = -260; x < 300; x += rng.range(28, 46)) {
      const c = cliff(rng.range(24, 40), rng.range(12, 30), rng.range(14, 24), rng.next());
      c.position.set(x, 0, rng.range(-120, -85));
      c.rotation.y = rng.range(-0.3, 0.3);
      s.add(c);
    }
    for (let i = 0; i < 90; i++) {
      const far = rng.chance(0.65);
      // Del lado de las cámaras solo hay cosas lejos, para que no tapen la toma.
      const z = far ? rng.range(-60, -11) : rng.range(28, 60);
      const x = rng.range(-140, 160);
      const k = rng.next();
      const o = k < 0.45 ? obstacleMesh('cactus', rng.next()) : k < 0.9 ? obstacleMesh('rock', rng.next()) : palm();
      o.position.set(x, 0, z);
      o.rotation.y = rng.range(0, Math.PI * 2);
      s.add(o);
    }
  }

  /**
   * Con el menú en pantalla la escena queda congelada en su momento culminante
   * (vehículo suspendido en el aire, explosión detrás, perseguidores en la
   * vía) mientras la cámara gira despacio. Si la cinemática ya pasó de ese
   * momento, se vuelve a él tras un fundido.
   */
  hold(): void {
    if (this.holding) return;
    this.holding = true;
    if (this.t > HOLD_AT) {
      this.fadeIn = 1;
      this.jumpTo(HOLD_AT);
    }
  }

  /** Congela la escena directamente en su momento culminante (sin la aproximación). */
  holdNow(fade = true): void {
    this.holding = true;
    this.fadeIn = fade ? 1 : 0;
    this.jumpTo(HOLD_AT);
  }

  /** Vuelve a reproducir la cinemática completa (al abrir la aplicación). */
  play(): void {
    this.holding = false;
    this.fill.intensity = 0;
    this.reset();
  }

  /** Avanza la simulación desde el principio hasta el instante `t` (sin dibujar). */
  private jumpTo(t: number): void {
    this.reset();
    while (this.t < t) this.simulate(1 / 60);
  }

  /** Solo desarrollo: congela la cinemática en el instante `t` para revisarla. */
  freezeAt(t: number): void {
    this.jumpTo(t);
    this.frozen = true;
  }

  private frozen = false;
  private holding = false;
  /** Fundido desde negro al volver al instante congelado (1 → 0). */
  private fadeIn = 0;

  /** Vuelve todo al principio del ciclo. */
  private reset(): void {
    this.t = 0;
    this.blasted = false;
    this.landed = false;
    this.blastT = -1;
    this.fireball.visible = false;
    this.flash.intensity = 0;
    for (const b of this.barrels) b.visible = true;
    for (const c of this.chasers) {
      c.blown = undefined;
      c.mesh.group.rotation.set(0, FACE_X, 0);
      c.mesh.group.position.y = 0;
    }
  }

  /** Posición del vehículo en el tiempo `t` de la cinemática: x, altura y cabeceo. */
  private carAt(t: number): { x: number; y: number; pitch: number } {
    if (t < TAKEOFF) {
      const x = START_X + SPEED * t;
      // Subiendo la rampa.
      if (x > RAMP_IN) {
        const k = (x - RAMP_IN) / (RAMP_OUT - RAMP_IN);
        return { x, y: k * RAMP_TOP, pitch: 0.26 };
      }
      return { x, y: 0, pitch: 0 };
    }
    const u = (t - TAKEOFF) / FLIGHT;
    const x = RAMP_OUT + SPEED * (t - TAKEOFF);
    if (u < 1) return { x, y: RAMP_TOP * (1 - u) + 4 * PEAK * u * (1 - u), pitch: 0.3 * (1 - 2 * u) };
    return { x, y: 0, pitch: 0 };
  }

  /** Cámara lenta alrededor del punto más alto del salto. */
  private timeScale(t: number): number {
    const a = TAKEOFF + 0.15;
    const b = TAKEOFF + FLIGHT * 0.8;
    if (t < a - 0.25 || t > b + 0.3) return 1;
    if (t < a) return 1 - ((t - (a - 0.25)) / 0.25) * 0.78;
    if (t > b) return 0.22 + ((t - b) / 0.3) * 0.78;
    return 0.22;
  }

  update(dt: number, aspect: number): void {
    if (this.frozen) {
      this.shoot(this.t, this.carAt(this.t), aspect);
      return;
    }
    if (this.holding) {
      this.updateHold(dt, aspect);
      return;
    }
    const car = this.simulate(dt);
    this.shoot(this.t, car, aspect);
    // Fundido al cerrar y abrir cada ciclo.
    const fade = Math.max(0, 1 - this.t / 0.35, (this.t - (LOOP_END - 0.45)) / 0.45);
    this.fade.style.opacity = Math.min(1, fade).toFixed(3);
  }

  /**
   * Tiempo congelado: la cinemática avanza a la velocidad de un suspiro hasta el
   * instante elegido y se queda ahí; la cámara gira alrededor y las sirenas y
   * el rotor siguen vivos.
   */
  private updateHold(dt: number, aspect: number): void {
    this.clock += dt;
    if (this.t < HOLD_AT) this.simulate(dt);
    else {
      // Todo quieto salvo un leve movimiento del humo y del fuego.
      this.fx.update(dt * HOLD_SPEED);
      const siren = Math.floor(this.clock * 6) % 2 === 0;
      for (const c of this.chasers) setSiren(c.mesh, siren);
      this.heli.rotor.rotation.y += dt * 2;
      this.heli.tailRotor.rotation.x += dt * 4;
    }
    const car = this.carAt(this.t);
    const cam = this.camera;
    cam.aspect = aspect;
    cam.fov = aspect < 1 ? 64 : 42;
    cam.updateProjectionMatrix();
    // De frente: la cámara está delante del vehículo y mira hacia atrás, así salta hacia ella con la
    // explosión y los perseguidores detrás. Mirando hacia -X, la derecha de la pantalla es -Z: el punto de
    // mira se corre hacia +Z para que la acción quede a la derecha, libre del menú.
    // A media altura del salto: se ve el frente (cofre y faros) y la explosión queda debajo y detrás.
    const portrait = aspect < 1;
    const ahead = portrait ? 21 : 16;
    const swing = Math.sin(this.clock * 0.14) * 3;
    cam.position.set(car.x + ahead, car.y * 0.78 + 0.9 + Math.sin(this.clock * 0.23) * 0.4, 0.8 + swing);
    cam.lookAt(car.x - 6, car.y * 0.55, portrait ? 0 : 4.6 + swing * 0.3);
    // Relleno cálido desde la cámara: el frente del vehículo no queda en sombra.
    this.fill.intensity = Math.min(2.2, this.fill.intensity + dt * 3);
    this.fill.position.set(cam.position.x, cam.position.y + 8, cam.position.z + 4);
    this.fill.target.position.set(car.x, car.y, 0);
    this.fadeIn = Math.max(0, this.fadeIn - dt * 2.2);
    this.fade.style.opacity = this.fadeIn.toFixed(3);
  }

  /** Avanza la cinemática `dt` segundos reales (con su cámara lenta); devuelve la posición del vehículo. */
  private simulate(dt: number): { x: number; y: number; pitch: number } {
    this.clock += this.holding ? 0 : dt;
    const step = dt * this.timeScale(this.t);
    this.t += step;
    if (this.t >= LOOP_END) this.reset();
    const t = this.t;

    // Vehículo del jugador.
    const car = this.carAt(t);
    this.car.position.set(car.x, car.y, 0);
    this.car.rotation.set(car.pitch, FACE_X, 0);
    this.trail -= step;
    if (car.y < 0.05 && this.trail <= 0) {
      this.trail = 0.05;
      this.fx.dust(car.x - 2.2, 0, 0xd9b98a, 2, 1.4);
      this.fx.turbo(car.x - 2.3, 0, Math.PI / 2);
    }
    if (!this.landed && t > TAKEOFF + FLIGHT) {
      this.landed = true;
      this.fx.dust(car.x, 0, 0xc9a77a, 16, 2.6);
      this.fx.sparks(car.x, 0, 14);
      this.onLanded?.();
    }

    // Perseguidores con sirenas; la patrulla sale volando con la explosión.
    const siren = Math.floor(this.clock * 6) % 2 === 0;
    for (const c of this.chasers) {
      setSiren(c.mesh, siren);
      const g = c.mesh.group;
      if (c.blown) {
        const b = c.blown;
        const k = t - b.t;
        if (!b.landed) {
          b.y = Math.max(0, b.vy * k - 9.8 * k * k * 0.5);
          g.position.set(b.x + 6 * k, b.y, c.lane - 1.5 * k);
          g.rotation.set(-b.spin * k, FACE_X + 0.6 * k, b.spin * 0.6 * k);
          if (k > 0.3 && b.y <= 0) {
            b.landed = true;
            b.x = g.position.x;
            this.fx.explosion(b.x, c.lane - 1.5 * k, 0.8);
          }
        }
        // Queda volcado y ardiendo.
        if (this.chasers.indexOf(c) === 0 && Math.random() < step * 18) this.fx.smokeTrail(g.position.x, g.position.z);
        continue;
      }
      // Arrancan un poco más lento que el jugador y se van quedando atrás.
      const x = START_X - c.lag + (SPEED - 1.2) * t;
      g.position.set(x, 0, c.lane);
      g.rotation.set(0, FACE_X, 0);
      if (Math.abs(c.lane) > 6 && Math.random() < step * 14) this.fx.dust(x - 2, c.lane, 0xd9b98a, 2, 1.6);
    }
    if (!this.blasted && t >= BLAST_AT) {
      this.blasted = true;
      for (const b of this.barrels) b.visible = false;
      const patrol = this.chasers[0];
      this.fx.blast(BARRELS[0][0], BARRELS[0][1], 1.5);
      this.fx.blast(BARRELS[2][0] + 1.5, BARRELS[2][1] - 1, 1);
      patrol.blown = { t, x: patrol.mesh.group.position.x, vy: 11, spin: 2.6, y: 0, landed: false };
      this.blastT = t;
      this.fireball.position.set(BARRELS[1][0], 1.2, BARRELS[1][1]);
      this.flash.position.set(BARRELS[1][0], 4, BARRELS[1][1] + 2);
      this.onBlast?.();
    }
    // La bola de fuego crece, sube y se apaga; el destello ilumina la escena un instante.
    if (this.blastT >= 0) {
      const k = (t - this.blastT) / 0.9;
      const mat = this.fireball.material as THREE.MeshBasicMaterial;
      this.fireball.visible = k < 1;
      this.fireball.scale.setScalar(1 + 4.8 * Math.sqrt(Math.min(1, k)));
      this.fireball.position.y = 1.2 + k * 3;
      mat.opacity = Math.max(0, 0.95 * (1 - k));
      mat.color.setHSL(0.09 - k * 0.06, 1, 0.62 - k * 0.25);
      this.flash.intensity = Math.max(0, 900 * (1 - k * 1.4));
    }

    // Mutantes corriendo por la arena.
    this.mutants.forEach((m, i) => {
      m.mesh.group.position.set(START_X + m.lead + m.speed * t, 0, m.z);
      m.mesh.group.rotation.y = FACE_X;
      if (m.mesh.rig) animateMutant(m.mesh.rig, this.clock * 9 + i * 1.7, 1);
    });

    // Helicóptero detrás, con el reflector sobre la carretera.
    const hx = car.x - 18 + Math.sin(this.clock * 0.6) * 4;
    this.heli.group.position.set(hx, 24 + Math.sin(this.clock * 1.7) * 0.4, -34);
    this.heli.group.rotation.set(0, FACE_X, 0.12);
    this.heli.rotor.rotation.y += dt * 25;
    this.heli.tailRotor.rotation.x += dt * 45;
    this.heli.shadow.position.set(hx + 5, 0.06, -28);
    this.heli.spot.position.set(car.x - 4, 0.07, -1);

    this.fx.update(step);
    return car;
  }

  /** Planos: seguimiento lateral, contrapicado en la rampa durante el salto y plano abierto al escapar. */
  private shoot(t: number, car: { x: number; y: number }, aspect: number): void {
    const cam = this.camera;
    cam.aspect = aspect;
    // En pantallas angostas se abre el lente para que el salto quepa.
    cam.fov = aspect < 1 ? 62 : 40;
    cam.updateProjectionMatrix();
    const sway = Math.sin(this.clock * 1.3) * 0.15;
    if (t < TAKEOFF - 0.45) {
      // Seguimiento lateral bajo, un poco por delante.
      cam.position.set(car.x + 9, 1.5 + sway, 9.5);
      cam.lookAt(car.x - 2, 1.1, -1.5);
    } else if (t < TAKEOFF + FLIGHT + 0.25) {
      // Contrapicado junto a la rampa: el vehículo cruza el cielo con la explosión detrás.
      const k = (t - (TAKEOFF - 0.45)) / (FLIGHT + 0.7);
      cam.position.set(6 + k * 10, 1.3, 15 - k * 2);
      cam.lookAt(car.x * 0.75 + 2, car.y * 0.45 + 2.2, -3);
    } else {
      // Plano abierto: escapa y atrás queda la patrulla ardiendo.
      cam.position.set(car.x - 6, 7 + sway, 17);
      cam.lookAt(car.x - 10, 1, -3);
    }
  }
}
