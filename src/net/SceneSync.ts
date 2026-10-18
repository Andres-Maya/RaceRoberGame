import * as THREE from 'three';

/*
 * Réplica de la escena del anfitrión en el invitado.
 *
 * El anfitrión simula la partida completa; en cada envío recorre su escena y
 * manda solo lo que cambió: objetos nuevos (con su geometría y material la
 * primera vez que aparecen), posiciones, visibilidad, cambios de material,
 * luces y objetos retirados. El invitado reconstruye y suaviza esa escena.
 * Los objetos con `userData.noSync` (las partículas) no se envían: los
 * efectos se repiten como llamadas en el invitado.
 */

type ArrType = 'f32' | 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32';

export interface GeoDef {
  id: number;
  /** [nombre, componentes, tipo, datos en base64, normalizado] */
  a: [string, number, ArrType, string, 0 | 1][];
  ix?: [ArrType, string];
  gr?: [number, number, number][];
}

export interface TexDef {
  id: number;
  url: string;
  srgb: 0 | 1;
}

export interface MatDef {
  id: number;
  k: 'lambert' | 'basic' | 'standard' | 'phong';
  c: number;
  e: number;
  ei: number;
  o: number;
  /** Bits: 1 transparente, 2 depthWrite, 4 depthTest, 8 flatShading, 16 vertexColors, 32 toneMapped, 64 visible. */
  f: number;
  b: number;
  sd: number;
  map: number;
}

export interface LightDef {
  c: number;
  i: number;
  gc?: number;
  /** Sombra: [left, right, top, bottom, near, far, bias] */
  sh?: number[];
  /** Posición del objetivo de la luz direccional. */
  tg?: number[];
}

export interface NodeDef {
  id: number;
  /** o: grupo, m: malla, h: luz hemisférica, d: luz direccional */
  k: 'o' | 'm' | 'h' | 'd';
  tr: number[];
  v: 0 | 1;
  /** Bits: 1 castShadow, 2 receiveShadow, 4 frustumCulled */
  f: number;
  ro?: number;
  g?: number;
  m?: number;
  l?: LightDef;
  ch?: NodeDef[];
}

export interface SceneDelta {
  geos?: GeoDef[];
  texs?: TexDef[];
  mats?: MatDef[];
  /** [padre, nodo]; el padre 0 es la escena. */
  add?: [number, NodeDef][];
  /** Pares (id, padre) de objetos que cambiaron de padre. */
  par?: number[];
  /** Bloques de 11 números: id y la transformación (posición, cuaternión, escala). */
  tr?: number[];
  /** Pares (id, visible). */
  vis?: number[];
  /** Pares (id, material). */
  mat?: number[];
  /** Propiedades de material: [id, color, emisivo, opacidad, visible]. */
  mp?: number[][];
  /** Luces: [id, color, intensidad, color del suelo, objetivo x, y, z]. */
  lp?: number[][];
  rm?: number[];
  bg?: number;
}

const TR = 10;
const ARRAYS: Record<ArrType, { new (b: ArrayBuffer): ArrayLike<number> & { buffer: ArrayBufferLike } }> = {
  f32: Float32Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
};

function arrType(a: ArrayLike<number>): ArrType {
  if (a instanceof Float32Array) return 'f32';
  if (a instanceof Uint16Array) return 'u16';
  if (a instanceof Uint32Array) return 'u32';
  if (a instanceof Uint8Array) return 'u8';
  if (a instanceof Int8Array) return 'i8';
  if (a instanceof Int16Array) return 'i16';
  if (a instanceof Int32Array) return 'i32';
  return 'f32';
}

function toBase64(a: ArrayLike<number>, type: ArrType): string {
  const typed = type === 'f32' && !(a instanceof Float32Array) ? new Float32Array(Array.from(a)) : (a as unknown as ArrayBufferView);
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(data: string, type: ArrType): ArrayLike<number> {
  const s = atob(data);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new ARRAYS[type](bytes.buffer);
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

type AnyMaterial = THREE.Material & {
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  flatShading?: boolean;
  map?: THREE.Texture | null;
};

interface Rec {
  id: number;
  last: Float64Array;
  v: number;
  m: number;
  parent: number;
  seen: number;
  geo: number;
  light: string;
}

// ------------------------------------------------------------ anfitrión

export class SceneEncoder {
  private recs = new Map<THREE.Object3D, Rec>();
  private nextId = 1;
  private geos = new Map<THREE.BufferGeometry, number>();
  private geoRefs = new Map<number, number>();
  private nextGeo = 1;
  private mats = new Map<THREE.Material, { id: number; sig: string }>();
  private nextMat = 1;
  private texs = new Map<THREE.Texture, number>();
  private nextTex = 1;
  private sync = 0;
  private bg = -1;

  /** Cambios desde el envío anterior (el primero contiene la escena entera). */
  encode(scene: THREE.Scene): SceneDelta {
    this.sync++;
    const d: SceneDelta = {};
    this.visit(scene, 0, d);

    for (const [obj, rec] of this.recs) {
      if (rec.seen === this.sync) continue;
      (d.rm ??= []).push(rec.id);
      this.recs.delete(obj);
      if (rec.geo) this.releaseGeo(obj as THREE.Mesh, rec.geo);
    }
    for (const [m, entry] of this.mats) {
      const sig = this.matSig(m);
      if (sig === entry.sig) continue;
      entry.sig = sig;
      const am = m as AnyMaterial;
      (d.mp ??= []).push([entry.id, am.color ? am.color.getHex() : -1, am.emissive ? am.emissive.getHex() : -1, r3(m.opacity), m.visible ? 1 : 0]);
    }
    const bg = scene.background instanceof THREE.Color ? scene.background.getHex() : -1;
    if (bg !== this.bg) {
      this.bg = bg;
      if (bg >= 0) d.bg = bg;
    }
    return d;
  }

  private visit(obj: THREE.Object3D, parentId: number, d: SceneDelta): void {
    for (const child of obj.children) {
      if (child.userData.noSync) continue;
      const rec = this.recs.get(child);
      if (!rec) {
        (d.add ??= []).push([parentId, this.define(child, parentId, d)]);
        continue;
      }
      rec.seen = this.sync;
      if (rec.parent !== parentId) {
        rec.parent = parentId;
        (d.par ??= []).push(rec.id, parentId);
      }
      if (this.transformChanged(child, rec.last)) {
        (d.tr ??= []).push(rec.id, ...rec.last);
      }
      const v = child.visible ? 1 : 0;
      if (v !== rec.v) {
        rec.v = v;
        (d.vis ??= []).push(rec.id, v);
      }
      const mesh = child as THREE.Mesh;
      if (rec.geo) {
        const mid = this.matRef(mesh.material, d);
        if (mid !== rec.m) {
          rec.m = mid;
          (d.mat ??= []).push(rec.id, mid);
        }
      }
      const light = child as THREE.Light;
      if (light.isLight) {
        const lp = this.lightProps(light);
        const sig = lp.join(',');
        if (sig !== rec.light) {
          rec.light = sig;
          (d.lp ??= []).push([rec.id, ...lp]);
        }
      }
      this.visit(child, rec.id, d);
    }
  }

  /** Compara la transformación con la última enviada; si cambió, la guarda redondeada. */
  private transformChanged(o: THREE.Object3D, last: Float64Array): boolean {
    const p = o.position;
    const q = o.quaternion;
    const s = o.scale;
    let changed = false;
    const put = (i: number, v: number) => {
      if (last[i] !== v) {
        last[i] = v;
        changed = true;
      }
    };
    put(0, r3(p.x));
    put(1, r3(p.y));
    put(2, r3(p.z));
    put(3, r4(q.x));
    put(4, r4(q.y));
    put(5, r4(q.z));
    put(6, r4(q.w));
    put(7, r3(s.x));
    put(8, r3(s.y));
    put(9, r3(s.z));
    return changed;
  }

  private define(o: THREE.Object3D, parentId: number, d: SceneDelta): NodeDef {
    const rec: Rec = { id: this.nextId++, last: new Float64Array(TR), v: o.visible ? 1 : 0, m: 0, parent: parentId, seen: this.sync, geo: 0, light: '' };
    this.transformChanged(o, rec.last);
    this.recs.set(o, rec);
    const def: NodeDef = {
      id: rec.id,
      k: 'o',
      tr: Array.from(rec.last),
      v: rec.v as 0 | 1,
      f: (o.castShadow ? 1 : 0) | (o.receiveShadow ? 2 : 0) | (o.frustumCulled ? 4 : 0),
    };
    if (o.renderOrder) def.ro = o.renderOrder;
    const mesh = o as THREE.Mesh;
    const light = o as THREE.Light;
    if (mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) {
      def.k = 'm';
      def.g = rec.geo = this.geoRef(mesh.geometry, d);
      def.m = rec.m = this.matRef(mesh.material, d);
    } else if ((light as THREE.HemisphereLight).isHemisphereLight || (light as THREE.DirectionalLight).isDirectionalLight) {
      def.k = (light as THREE.HemisphereLight).isHemisphereLight ? 'h' : 'd';
      const lp = this.lightProps(light);
      rec.light = lp.join(',');
      def.l = { c: lp[0], i: lp[1], gc: lp[2], tg: lp.slice(3) };
      const dl = light as THREE.DirectionalLight;
      if (dl.isDirectionalLight && dl.castShadow) {
        const c = dl.shadow.camera;
        def.l.sh = [c.left, c.right, c.top, c.bottom, c.near, c.far, dl.shadow.bias];
      }
    }
    const ch = o.children.filter((c) => !c.userData.noSync).map((c) => this.define(c, rec.id, d));
    if (ch.length) def.ch = ch;
    return def;
  }

  private lightProps(l: THREE.Light): number[] {
    const hemi = l as THREE.HemisphereLight;
    const dir = l as THREE.DirectionalLight;
    const t = dir.isDirectionalLight ? dir.target.position : null;
    return [l.color.getHex(), r3(l.intensity), hemi.isHemisphereLight ? hemi.groundColor.getHex() : -1, ...(t ? [r3(t.x), r3(t.y), r3(t.z)] : [])];
  }

  private geoRef(g: THREE.BufferGeometry, d: SceneDelta): number {
    let id = this.geos.get(g);
    if (id === undefined) {
      id = this.nextGeo++;
      this.geos.set(g, id);
      const def: GeoDef = { id, a: [] };
      for (const [name, attr] of Object.entries(g.attributes)) {
        const a = attr as THREE.BufferAttribute;
        if (!a.array) continue;
        const type = arrType(a.array);
        def.a.push([name, a.itemSize, type, toBase64(a.array, type), a.normalized ? 1 : 0]);
      }
      if (g.index) {
        const type = arrType(g.index.array);
        def.ix = [type, toBase64(g.index.array, type)];
      }
      if (g.groups.length) def.gr = g.groups.map((gr) => [gr.start, gr.count, gr.materialIndex ?? 0]);
      (d.geos ??= []).push(def);
    }
    this.geoRefs.set(id, (this.geoRefs.get(id) ?? 0) + 1);
    return id;
  }

  private releaseGeo(mesh: THREE.Mesh, id: number): void {
    const n = (this.geoRefs.get(id) ?? 1) - 1;
    if (n > 0) {
      this.geoRefs.set(id, n);
      return;
    }
    this.geoRefs.delete(id);
    for (const [g, gid] of this.geos) {
      if (gid === id) {
        this.geos.delete(g);
        break;
      }
    }
    void mesh;
  }

  private matRef(material: THREE.Material | THREE.Material[], d: SceneDelta): number {
    const m = (Array.isArray(material) ? material[0] : material) as AnyMaterial;
    const entry = this.mats.get(m);
    if (entry) return entry.id;
    const id = this.nextMat++;
    const k: MatDef['k'] = m.type === 'MeshLambertMaterial' ? 'lambert' : m.type === 'MeshStandardMaterial' ? 'standard' : m.type === 'MeshPhongMaterial' ? 'phong' : 'basic';
    const def: MatDef = {
      id,
      k,
      c: m.color ? m.color.getHex() : 0xffffff,
      e: m.emissive ? m.emissive.getHex() : -1,
      ei: m.emissiveIntensity ?? 1,
      o: r3(m.opacity),
      f:
        (m.transparent ? 1 : 0) |
        (m.depthWrite ? 2 : 0) |
        (m.depthTest ? 4 : 0) |
        (m.flatShading ? 8 : 0) |
        (m.vertexColors ? 16 : 0) |
        (m.toneMapped ? 32 : 0) |
        (m.visible ? 64 : 0),
      b: m.blending,
      sd: m.side,
      map: m.map ? this.texRef(m.map, d) : 0,
    };
    (d.mats ??= []).push(def);
    this.mats.set(m, { id, sig: this.matSig(m) });
    return id;
  }

  private matSig(m: THREE.Material): string {
    const am = m as AnyMaterial;
    return `${am.color?.getHex() ?? ''}|${am.emissive?.getHex() ?? ''}|${r3(m.opacity)}|${m.visible ? 1 : 0}`;
  }

  private texRef(t: THREE.Texture, d: SceneDelta): number {
    let id = this.texs.get(t);
    if (id !== undefined) return id;
    id = this.nextTex++;
    this.texs.set(t, id);
    let url = '';
    try {
      const img = t.image as HTMLCanvasElement | HTMLImageElement;
      if (img && 'toDataURL' in img) url = img.toDataURL('image/png');
      else if (img) {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')?.drawImage(img, 0, 0);
        url = c.toDataURL('image/png');
      }
    } catch {
      url = '';
    }
    (d.texs ??= []).push({ id, url, srgb: t.colorSpace === THREE.SRGBColorSpace ? 1 : 0 });
    return id;
  }
}

// ------------------------------------------------------------ invitado

interface Smooth {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

export class SceneDecoder {
  private nodes = new Map<number, THREE.Object3D>();
  private geos = new Map<number, { g: THREE.BufferGeometry; refs: number }>();
  private mats = new Map<number, THREE.Material>();
  private texs = new Map<number, THREE.Texture>();
  private moving = new Map<THREE.Object3D, Smooth>();
  private placeholder = new THREE.MeshBasicMaterial({ color: 0xff00ff });

  constructor(
    readonly scene: THREE.Scene,
    /** Tamaño del mapa de sombras del invitado (en celulares, menor). */
    private shadowSize = 2048,
  ) {}

  /** Aplica los cambios recibidos. `smooth`: interpolar los movimientos en lugar de saltar. */
  apply(d: SceneDelta, smooth = true): void {
    for (const g of d.geos ?? []) this.geos.set(g.id, { g: this.buildGeo(g), refs: 0 });
    for (const t of d.texs ?? []) this.texs.set(t.id, this.buildTex(t));
    for (const m of d.mats ?? []) this.mats.set(m.id, this.buildMat(m));
    for (const [parent, def] of d.add ?? []) (this.nodes.get(parent) ?? this.scene).add(this.build(def));

    const par = d.par ?? [];
    for (let i = 0; i < par.length; i += 2) {
      const o = this.nodes.get(par[i]);
      if (o) (this.nodes.get(par[i + 1]) ?? this.scene).add(o);
    }
    const tr = d.tr ?? [];
    for (let i = 0; i < tr.length; i += TR + 1) {
      const o = this.nodes.get(tr[i]);
      if (o) this.setTransform(o, tr, i + 1, smooth);
    }
    const vis = d.vis ?? [];
    for (let i = 0; i < vis.length; i += 2) {
      const o = this.nodes.get(vis[i]);
      if (o) o.visible = vis[i + 1] === 1;
    }
    const mat = d.mat ?? [];
    for (let i = 0; i < mat.length; i += 2) {
      const o = this.nodes.get(mat[i]) as THREE.Mesh | undefined;
      if (o?.isMesh) o.material = this.mats.get(mat[i + 1]) ?? this.placeholder;
    }
    for (const [id, color, emissive, opacity, visible] of d.mp ?? []) {
      const m = this.mats.get(id) as AnyMaterial | undefined;
      if (!m) continue;
      if (color >= 0) m.color?.setHex(color);
      if (emissive >= 0) m.emissive?.setHex(emissive);
      m.opacity = opacity;
      m.visible = visible === 1;
    }
    for (const lp of d.lp ?? []) {
      const l = this.nodes.get(lp[0]) as THREE.Light | undefined;
      if (l?.isLight) this.setLight(l, lp.slice(1));
    }
    for (const id of d.rm ?? []) {
      const o = this.nodes.get(id);
      if (!o) continue;
      this.nodes.delete(id);
      this.moving.delete(o);
      o.parent?.remove(o);
      const dl = o as THREE.DirectionalLight;
      if (dl.isDirectionalLight) this.scene.remove(dl.target);
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) this.releaseGeo(o.userData.geo as number);
    }
    if (d.bg !== undefined) this.scene.background = new THREE.Color(d.bg);
  }

  /** Suaviza los movimientos pendientes. */
  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 20);
    for (const [o, t] of this.moving) {
      o.position.lerp(t.p, k);
      o.quaternion.slerp(t.q, k);
      o.scale.lerp(t.s, k);
      if (o.position.distanceToSquared(t.p) < 1e-5 && o.quaternion.angleTo(t.q) < 1e-3) {
        o.position.copy(t.p);
        o.quaternion.copy(t.q);
        o.scale.copy(t.s);
        this.moving.delete(o);
      }
    }
  }

  private setTransform(o: THREE.Object3D, a: number[], i: number, smooth: boolean): void {
    const p = new THREE.Vector3(a[i], a[i + 1], a[i + 2]);
    const q = new THREE.Quaternion(a[i + 3], a[i + 4], a[i + 5], a[i + 6]);
    const s = new THREE.Vector3(a[i + 7], a[i + 8], a[i + 9]);
    // Saltos grandes (reapariciones, teletransportes) no se interpolan.
    if (!smooth || o.position.distanceToSquared(p) > 36) {
      o.position.copy(p);
      o.quaternion.copy(q);
      o.scale.copy(s);
      this.moving.delete(o);
      return;
    }
    this.moving.set(o, { p, q, s });
  }

  private build(def: NodeDef): THREE.Object3D {
    let o: THREE.Object3D;
    if (def.k === 'm') {
      const entry = this.geos.get(def.g!);
      if (entry) entry.refs++;
      o = new THREE.Mesh(entry?.g, this.mats.get(def.m!) ?? this.placeholder);
      o.userData.geo = def.g;
    } else if (def.k === 'h') {
      o = new THREE.HemisphereLight();
      this.setLight(o as THREE.Light, [def.l!.c, def.l!.i, def.l!.gc ?? -1]);
    } else if (def.k === 'd') {
      const l = new THREE.DirectionalLight();
      if (def.l?.sh) {
        const [left, right, top, bottom, near, far, bias] = def.l.sh;
        l.castShadow = true;
        l.shadow.mapSize.set(this.shadowSize, this.shadowSize);
        Object.assign(l.shadow.camera, { left, right, top, bottom, near, far });
        l.shadow.camera.updateProjectionMatrix();
        l.shadow.bias = bias;
      }
      this.scene.add(l.target);
      this.setLight(l, [def.l!.c, def.l!.i, -1, ...(def.l!.tg ?? [])]);
      o = l;
    } else {
      o = new THREE.Group();
    }
    o.userData.netId = def.id;
    this.nodes.set(def.id, o);
    o.position.set(def.tr[0], def.tr[1], def.tr[2]);
    o.quaternion.set(def.tr[3], def.tr[4], def.tr[5], def.tr[6]);
    o.scale.set(def.tr[7], def.tr[8], def.tr[9]);
    o.visible = def.v === 1;
    o.castShadow = (def.f & 1) !== 0;
    o.receiveShadow = (def.f & 2) !== 0;
    o.frustumCulled = (def.f & 4) !== 0;
    if (def.ro) o.renderOrder = def.ro;
    for (const c of def.ch ?? []) o.add(this.build(c));
    return o;
  }

  private setLight(l: THREE.Light, p: number[]): void {
    l.color.setHex(p[0]);
    l.intensity = p[1];
    const hemi = l as THREE.HemisphereLight;
    if (hemi.isHemisphereLight && p[2] >= 0) hemi.groundColor.setHex(p[2]);
    const dir = l as THREE.DirectionalLight;
    if (dir.isDirectionalLight && p.length >= 6) dir.target.position.set(p[3], p[4], p[5]);
  }

  private buildGeo(def: GeoDef): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    for (const [name, size, type, data, norm] of def.a) {
      g.setAttribute(name, new THREE.BufferAttribute(fromBase64(data, type) as unknown as THREE.TypedArray, size, norm === 1));
    }
    if (def.ix) g.setIndex(new THREE.BufferAttribute(fromBase64(def.ix[1], def.ix[0]) as unknown as THREE.TypedArray, 1));
    for (const [start, count, mi] of def.gr ?? []) g.addGroup(start, count, mi);
    g.computeBoundingSphere();
    return g;
  }

  private releaseGeo(id: number): void {
    const entry = this.geos.get(id);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    entry.g.dispose();
    this.geos.delete(id);
  }

  private buildTex(def: TexDef): THREE.Texture {
    const tex = new THREE.Texture();
    if (def.srgb) tex.colorSpace = THREE.SRGBColorSpace;
    if (def.url && typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = () => {
        tex.image = img;
        tex.needsUpdate = true;
      };
      img.src = def.url;
    }
    return tex;
  }

  private buildMat(def: MatDef): THREE.Material {
    const common = {
      color: def.c,
      transparent: (def.f & 1) !== 0,
      opacity: def.o,
      depthWrite: (def.f & 2) !== 0,
      depthTest: (def.f & 4) !== 0,
      vertexColors: (def.f & 16) !== 0,
      toneMapped: (def.f & 32) !== 0,
      visible: (def.f & 64) !== 0,
      blending: def.b as THREE.Blending,
      side: def.sd as THREE.Side,
      map: def.map ? (this.texs.get(def.map) ?? null) : null,
    };
    const lit = { ...common, flatShading: (def.f & 8) !== 0, ...(def.e >= 0 ? { emissive: def.e, emissiveIntensity: def.ei } : {}) };
    switch (def.k) {
      case 'lambert':
        return new THREE.MeshLambertMaterial(lit);
      case 'standard':
        return new THREE.MeshStandardMaterial(lit);
      case 'phong':
        return new THREE.MeshPhongMaterial(lit);
      default:
        return new THREE.MeshBasicMaterial(common);
    }
  }

  /** Cantidad de objetos replicados (para pruebas). */
  get size(): number {
    return this.nodes.size;
  }

  dispose(): void {
    for (const { g } of this.geos.values()) g.dispose();
    for (const m of this.mats.values()) m.dispose();
    for (const t of this.texs.values()) t.dispose();
    this.placeholder.dispose();
    this.geos.clear();
    this.mats.clear();
    this.texs.clear();
    this.nodes.clear();
    this.moving.clear();
    this.scene.clear();
  }
}
