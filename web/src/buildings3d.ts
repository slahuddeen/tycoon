// Player buildings in 3D: procedural low-poly models rendered by Three.js
// inside a MapLibre custom layer. Walls/windows are vertex-coloured; roofs
// and trims use the owner colour (yours vs everyone else's).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { alongLines, lineLengthM, mergeLines, offset, type LonLat } from './osm';

export const COLORS = {
  mine: '#10b981',
  other: '#ef4444',
  none: '#94a3b8',
  selected: '#f59e0b',
};

export const MIN_3D_ZOOM = 14;

export interface BuildingSpec {
  key: string;          // improvement id
  parcelId: number;
  typeId: string;
  lonLat: LonLat;
  bearing: number;      // street direction at this point
  side: 1 | -1;         // which side of the street
  width: number;        // metres along the street
  mine: boolean;
}

// ------------------------------------------------------------ geometry kit

type Geo = THREE.BufferGeometry;
const C = (hex: string) => new THREE.Color(hex);
const PALETTE = {
  cream: C('#f4ecdc'), brick: C('#d7a283'), stone: C('#e8e2d6'), glass: C('#9fbdd6'),
  darkGlass: C('#6f8fae'), window: C('#8aa3ba'), door: C('#6b4f3a'), concrete: C('#cfd4da'),
  steel: C('#9aa5b1'), white: C('#ffffff'),
};

function colorize(g: Geo, color: THREE.Color): Geo {
  const g2 = g.index ? g.toNonIndexed() : g;
  const n = g2.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([color.r, color.g, color.b], i * 3);
  g2.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g2.deleteAttribute('uv');
  return g2;
}

/** Box with its base at y0 (x along street, z depth, y up). */
function box(w: number, h: number, d: number, x: number, y0: number, z: number, color = PALETTE.cream): Geo {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y0 + h / 2, z);
  return colorize(g, color);
}

/** Gabled roof running along x. */
function gable(w: number, h: number, d: number, x: number, y0: number, z: number, color = PALETTE.white): Geo {
  const hw = w / 2, hd = d / 2;
  const p = [
    // two sloped faces
    -hw, 0, -hd, hw, 0, -hd, hw, h, 0, -hw, 0, -hd, hw, h, 0, -hw, h, 0,
    -hw, 0, hd, -hw, h, 0, hw, h, 0, -hw, 0, hd, hw, h, 0, hw, 0, hd,
    // gable ends
    -hw, 0, -hd, -hw, h, 0, -hw, 0, hd,
    hw, 0, -hd, hw, 0, hd, hw, h, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  g.translate(x, y0, z);
  return colorize(g, color);
}

/** Stack of floors with inset window bands. */
function floors(n: number, fh: number, w: number, d: number, y0: number, wall: THREE.Color, win: THREE.Color, x = 0, z = 0): Geo[] {
  const parts: Geo[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 + i * fh;
    parts.push(box(w, fh * 0.55, d, x, y, z, wall));
    parts.push(box(w - 0.6, fh * 0.45, d - 0.6, x, y + fh * 0.55, z, win));
  }
  return parts;
}

interface Model { body: Geo; accent: Geo; height: number }

function merge(parts: Geo[]): Geo {
  return mergeGeometries(parts.filter(Boolean), false)!;
}

// The front of every model faces -z (towards the street).
function buildModel(type: string, slotWidth: number): Model {
  const W = (max: number, min = 8) => Math.max(min, Math.min(max, slotWidth * 0.85));
  const body: Geo[] = [];
  const accent: Geo[] = [];
  let height = 10;
  switch (type) {
    case 'cottage': {
      const w = W(13), d = 10;
      body.push(box(w, 5, d, 0, 0, 0, PALETTE.cream));
      body.push(box(2, 3, 0.4, 0, 0, -d / 2 - 0.1, PALETTE.door));
      body.push(box(2.2, 1.8, 0.3, -w / 4, 1.8, -d / 2 - 0.1, PALETTE.window), box(2.2, 1.8, 0.3, w / 4, 1.8, -d / 2 - 0.1, PALETTE.window));
      accent.push(gable(w + 1, 4.5, d + 1.2, 0, 5, 0));
      body.push(box(1.2, 3, 1.2, w / 3, 6.5, 2, PALETTE.brick));
      height = 9.5;
      break;
    }
    case 'house': {
      const w = W(15), d = 12;
      body.push(box(w, 4, d, 0, 0, 0, PALETTE.brick), box(w, 4, d, 0, 4, 0, PALETTE.brick));
      body.push(box(2.2, 3.2, 0.4, 0, 0, -d / 2 - 0.1, PALETTE.door));
      for (const fx of [-w / 3.2, w / 3.2]) {
        body.push(box(2.4, 2, 0.3, fx, 1.2, -d / 2 - 0.1, PALETTE.window));
        body.push(box(2.4, 2, 0.3, fx, 5.2, -d / 2 - 0.1, PALETTE.window));
      }
      body.push(box(2.4, 2, 0.3, 0, 5.2, -d / 2 - 0.1, PALETTE.window));
      accent.push(gable(w + 1.2, 5, d + 1.4, 0, 8, 0));
      height = 13;
      break;
    }
    case 'terrace': {
      const w = W(40, 16), d = 12, n = 3, uw = w / n;
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + uw * (i + 0.5);
        const wall = i % 2 ? PALETTE.cream : PALETTE.brick;
        body.push(...floors(2, 4.5, uw - 0.2, d, 0, wall, PALETTE.window, x));
        body.push(box(1.8, 3, 0.4, x, 0, -d / 2 - 0.1, PALETTE.door));
        accent.push(gable(uw + 0.2, 4.5, d + 1.2, x, 9, 0));
      }
      height = 13.5;
      break;
    }
    case 'shops': {
      const w = W(36, 16), d = 14;
      body.push(box(w, 4.5, d, 0, 0, 0, PALETTE.stone));
      body.push(box(w - 1, 3.2, 0.3, 0, 0.3, -d / 2 - 0.1, PALETTE.glass));
      body.push(...floors(1, 4.5, w, d, 4.5, PALETTE.stone, PALETTE.window));
      accent.push(box(w, 0.5, 2.6, 0, 3.8, -d / 2 - 1.2));            // awning
      accent.push(box(w + 0.6, 0.8, d + 0.6, 0, 9, 0));              // roof trim
      height = 10;
      break;
    }
    case 'apartments': {
      const w = W(34, 16), d = 18;
      body.push(box(w, 3.5, d, 0, 0, 0, PALETTE.concrete));
      body.push(...floors(6, 4, w, d, 3.5, PALETTE.cream, PALETTE.window));
      accent.push(box(w + 0.8, 1, d + 0.8, 0, 27.5, 0));
      accent.push(box(w / 3, 3, d / 3, w / 5, 28.5, 0));
      height = 31.5;
      break;
    }
    case 'office': {
      const w = W(36, 18), d = 24;
      body.push(box(w, 5, d, 0, 0, 0, PALETTE.steel));
      body.push(...floors(10, 4, w, d, 5, PALETTE.steel, PALETTE.glass));
      body.push(...floors(3, 4, w * 0.7, d * 0.7, 45, PALETTE.steel, PALETTE.glass));
      accent.push(box(w * 0.7 + 0.8, 1.2, d * 0.7 + 0.8, 0, 57, 0));
      height = 58;
      break;
    }
    case 'tower': {
      const w = W(34, 22), d = 30;
      body.push(box(w, 6, d, 0, 0, 0, PALETTE.steel));
      body.push(...floors(14, 4, w * 0.85, d * 0.85, 6, PALETTE.white, PALETTE.darkGlass));
      body.push(...floors(7, 4, w * 0.65, d * 0.65, 62, PALETTE.white, PALETTE.darkGlass));
      body.push(...floors(4, 4, w * 0.45, d * 0.45, 90, PALETTE.white, PALETTE.darkGlass));
      accent.push(box(w * 0.45 + 1, 2, d * 0.45 + 1, 0, 106, 0));
      accent.push(box(0.8, 22, 0.8, 0, 108, 0));
      height = 130;
      break;
    }
    case 'skyscraper':
    default: {
      const w = W(46, 26), d = 40;
      body.push(box(w, 8, d, 0, 0, 0, PALETTE.steel));
      body.push(...floors(18, 4.5, w * 0.8, d * 0.8, 8, PALETTE.steel, PALETTE.glass));
      body.push(...floors(14, 4.5, w * 0.62, d * 0.62, 89, PALETTE.steel, PALETTE.glass));
      body.push(...floors(10, 4.5, w * 0.45, d * 0.45, 152, PALETTE.steel, PALETTE.glass));
      body.push(...floors(6, 4.5, w * 0.3, d * 0.3, 197, PALETTE.steel, PALETTE.glass));
      accent.push(box(w * 0.3 + 1, 3, d * 0.3 + 1, 0, 224, 0));
      accent.push(box(1.4, 45, 1.4, 0, 227, 0));
      height = 272;
      break;
    }
  }
  return { body: merge(body), accent: merge(accent), height };
}

const modelCache = new Map<string, Model>();
function model(type: string, slotWidth: number): Model {
  const bucket = Math.round(slotWidth / 4) * 4;
  const k = `${type}:${bucket}`;
  let m = modelCache.get(k);
  if (!m) {
    m = buildModel(type, bucket);
    modelCache.set(k, m);
  }
  return m;
}

/** Depth of a building's footprint (for setting it back from the street). */
const DEPTH: Record<string, number> = {
  cottage: 10, house: 12, terrace: 12, shops: 14, apartments: 18, office: 24, tower: 30, skyscraper: 40,
};

// ------------------------------------------------------ placement on streets

/**
 * Where each improvement on a parcel goes: slots are spread evenly along
 * the street; buildings alternate sides of the road.
 */
export function placeImprovements(parcel: {
  id: number; geom: LonLat[][]; slots_total: number; owner_id: string | null;
  improvements: { id: number; type_id: string; slot_index: number; slots_used: number }[];
}, myPlayerId: string | null): BuildingSpec[] {
  if (!parcel.improvements?.length) return [];
  const lines = mergeLines(parcel.geom);
  const total = lines.reduce((s, l) => s + lineLengthM(l), 0);
  const slotLen = total / parcel.slots_total;
  return parcel.improvements.map((imp) => {
    const centre = (imp.slot_index + imp.slots_used / 2) * slotLen;
    const at = alongLines(lines, centre);
    const side: 1 | -1 = imp.slot_index % 2 === 0 ? 1 : -1;
    const depth = DEPTH[imp.type_id] ?? 14;
    const setback = 9 + depth / 2;
    return {
      key: String(imp.id),
      parcelId: parcel.id,
      typeId: imp.type_id,
      lonLat: offset(at.p, at.bearing + 90 * side, setback),
      bearing: at.bearing,
      side,
      width: imp.slots_used * slotLen,
      mine: !!myPlayerId && parcel.owner_id === myPlayerId,
    };
  });
}

// --------------------------------------------------------------- the layer

interface Live {
  spec: BuildingSpec;
  group: THREE.Group;
  born: number;
  height: number;
}

export class BuildingLayer implements CustomLayerInterface {
  id = 'tycoon-buildings';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private origin: LonLat = [0, 0];
  private originMerc = MercatorCoordinate.fromLngLat([0, 0], 0);
  private live = new Map<string, Live>();
  private bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private accentMats = {
    mine: new THREE.MeshLambertMaterial({ color: COLORS.mine }),
    other: new THREE.MeshLambertMaterial({ color: COLORS.other }),
  };
  private highlightMat = new THREE.MeshLambertMaterial({ color: COLORS.selected, emissive: '#7c4a00' });
  private selectedParcel: number | null = null;
  private animating = false;

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-60, 120, -40);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(80, 60, 90);
    this.scene.add(fill);
  }

  private toScene(p: LonLat): THREE.Vector3 {
    const m = MercatorCoordinate.fromLngLat(p, 0);
    const s = this.originMerc.meterInMercatorCoordinateUnits();
    return new THREE.Vector3((m.x - this.originMerc.x) / s, 0, (m.y - this.originMerc.y) / s);
  }

  private resetOrigin(p: LonLat) {
    this.origin = p;
    this.originMerc = MercatorCoordinate.fromLngLat(p, 0);
    for (const l of this.live.values()) l.group.position.copy(this.toScene(l.spec.lonLat));
  }

  setSelected(parcelId: number | null) {
    this.selectedParcel = parcelId;
    for (const l of this.live.values()) this.applyAccent(l);
    this.map?.triggerRepaint();
  }

  private applyAccent(l: Live) {
    const accent = l.group.children[1] as THREE.Mesh;
    accent.material = l.spec.parcelId === this.selectedParcel
      ? this.highlightMat
      : l.spec.mine ? this.accentMats.mine : this.accentMats.other;
  }

  /** Replace the set of visible buildings; new ones grow out of the ground. */
  setBuildings(specs: BuildingSpec[], animateNew = true) {
    if (!this.map) return;
    const c = this.map.getCenter();
    if (Math.abs(c.lat - this.origin[1]) > 0.2 || Math.abs(c.lng - this.origin[0]) > 0.3) {
      this.resetOrigin([c.lng, c.lat]);
    }
    const seen = new Set<string>();
    const now = performance.now();
    for (const spec of specs) {
      seen.add(spec.key);
      const old = this.live.get(spec.key);
      if (old && old.spec.mine === spec.mine && old.spec.typeId === spec.typeId &&
          old.spec.lonLat[0] === spec.lonLat[0] && old.spec.lonLat[1] === spec.lonLat[1]) continue;
      if (old) this.scene.remove(old.group);
      const m = model(spec.typeId, spec.width);
      const group = new THREE.Group();
      group.add(new THREE.Mesh(m.body, this.bodyMat));
      group.add(new THREE.Mesh(m.accent, this.accentMats.mine));
      group.position.copy(this.toScene(spec.lonLat));
      group.rotation.y = ((90 - spec.bearing) * Math.PI) / 180 + (spec.side === -1 ? Math.PI : 0);
      const l: Live = { spec, group, born: animateNew && !old ? now : 0, height: m.height };
      this.applyAccent(l);
      this.live.set(spec.key, l);
      this.scene.add(group);
    }
    for (const [k, l] of this.live) {
      if (!seen.has(k)) {
        this.scene.remove(l.group);
        this.live.delete(k);
      }
    }
    this.map.triggerRepaint();
  }

  /** Screen-space hit test so clicking a tower selects its street. */
  hitTest(x: number, y: number): number | null {
    if (!this.map || this.map.getZoom() < MIN_3D_ZOOM) return null;
    let best: number | null = null;
    let bestD = Infinity;
    const metresPerPx = 40075016 * Math.cos((this.map.getCenter().lat * Math.PI) / 180) / (512 * 2 ** this.map.getZoom());
    for (const l of this.live.values()) {
      const base = this.map.project(l.spec.lonLat as [number, number]);
      const radius = Math.max(14, 12 / metresPerPx);
      // Tall buildings: also accept clicks up the facade.
      const up = Math.min(l.height / metresPerPx, 400) * Math.sin((this.map.getPitch() * Math.PI) / 180);
      const dx = x - base.x;
      const dy = Math.max(0, Math.min(up, base.y - y));
      const d = Math.hypot(dx, base.y - y - dy);
      if (d < radius && d < bestD) {
        bestD = d;
        best = l.spec.parcelId;
      }
    }
    return best;
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.live.size || this.map.getZoom() < MIN_3D_ZOOM) return;
    const now = performance.now();
    let anim = false;
    for (const l of this.live.values()) {
      if (!l.born) continue;
      const t = Math.min(1, (now - l.born) / 900);
      const c1 = 1.70158, c3 = c1 + 1;
      const e = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);   // easeOutBack
      l.group.scale.set(1, Math.max(0.001, e), 1);
      if (t >= 1) l.born = 0; else anim = true;
    }
    const s = this.originMerc.meterInMercatorCoordinateUnits();
    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    const l = new THREE.Matrix4()
      .makeTranslation(this.originMerc.x, this.originMerc.y, this.originMerc.z)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    if (anim || anim !== this.animating) this.map.triggerRepaint();
    this.animating = anim;
  }
}
