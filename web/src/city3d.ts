// Real buildings as detailed low-poly models.
//
// The free map tiles give every building its outline and height, but not
// its OSM type, so we infer one from shape and size: small and low is a
// house (pitched roof, sometimes a cross-gable and chimney), long and
// narrow is a terrace, big and low is a hall, then flats, towers and
// skyscrapers (window bands, setbacks, rooftop plant, spires).
// Each building is a single colour (owner colour or neutral) with shading.
// Player-built buildings use these same models (see buildings3d.ts).
import * as THREE from 'three';
import type { LonLat } from './osm';

/** Local metres within a tile: x east, z south. */
export type V2 = [number, number];

export type Kind = 'shed' | 'house' | 'terrace' | 'hall' | 'lowrise' | 'midrise' | 'tower' | 'skyscraper';
export type Owner = 'none' | 'mine' | 'other';

export interface Footprint {
  outer: V2[];
  holes: V2[][];
  height: number;
  minHeight: number;
  /** Stable per-building number for picking style variants. */
  seed: number;
  /** Model it as this kind instead of guessing from its shape (player buildings). */
  kind?: Kind;
}

/** Bought buildings take the owner's colour; ones merely on an owned street a paler shade of it. */
export const CITY_TINTS: Record<Owner | 'mineFront' | 'otherFront', string> = {
  none: '#f1eee8', mine: '#3fcf98', other: '#f2837b', mineFront: '#c9ecd9', otherFront: '#f6d2cd',
};

// ------------------------------------------------------------------ maths

export function ringArea(r: V2[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

export function centroid(r: V2[]): V2 {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}

export interface Box2 { c: V2; u: V2; v: V2; len: number; wid: number; area: number }

/** Minimum-area bounding rectangle, long axis `u`. */
export function orientedBox(r: V2[]): Box2 {
  let best: Box2 | null = null;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const u: V2 = [dx / l, dz / l], v: V2 = [-u[1], u[0]];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of r) {
      const pu = p[0] * u[0] + p[1] * u[1], pv = p[0] * v[0] + p[1] * v[1];
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu); minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      const c: V2 = [cu * u[0] + cv * v[0], cu * u[1] + cv * v[1]];
      const lu = maxU - minU, lv = maxV - minV;
      best = lu >= lv ? { c, u, v, len: lu, wid: lv, area } : { c, u: v, v: [-u[0], -u[1]], len: lv, wid: lu, area };
    }
  }
  return best ?? { c: centroid(r), u: [1, 0], v: [0, 1], len: 1, wid: 1, area: 1 };
}

/** Clip a ring to the square [lo, hi]² (Sutherland–Hodgman). */
export function clipRing(ring: V2[], lo: number, hi: number): V2[] {
  let out = ring;
  const edges: [number, number, boolean][] = [[0, lo, true], [0, hi, false], [1, lo, true], [1, hi, false]];
  for (const [axis, val, keepAbove] of edges) {
    const inp = out;
    out = [];
    if (!inp.length) break;
    const inside = (p: V2) => (keepAbove ? p[axis] >= val : p[axis] <= val);
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const cIn = inside(cur), pIn = inside(prev);
      if (cIn !== pIn) {
        const t = (val - prev[axis]) / (cur[axis] - prev[axis]);
        out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
      }
      if (cIn) out.push(cur);
    }
  }
  return out;
}

export function classify(fp: Footprint): { kind: Kind; box: Box2; area: number } {
  const area = Math.abs(ringArea(fp.outer));
  const box = orientedBox(fp.outer);
  const h = fp.height;
  let kind: Kind;
  if (fp.kind) kind = fp.kind;
  else if (area < 30 || h < 3.5) kind = 'shed';
  else if (h <= 14) {
    if (area > 1500) kind = 'hall';
    else if (area > 450) kind = 'lowrise';
    else if (box.len / Math.max(box.wid, 1) >= 2.6 && box.wid < 14) kind = 'terrace';
    else kind = 'house';
  } else if (h <= 40) kind = area > 4000 ? 'hall' : 'midrise';
  else if (h <= 120) kind = 'tower';
  else kind = 'skyscraper';
  return { kind, box, area };
}

// ------------------------------------------------------------ mesh builder

type V3 = [number, number, number];

export class MeshBuilder {
  pos: number[] = [];
  col: number[] = [];
  private tint = new THREE.Color();

  setTint(hex: string) { this.tint.set(hex); }

  tri(a: V3, b: V3, c: V3, shade: number) {
    this.pos.push(...a, ...b, ...c);
    const r = this.tint.r * shade, g = this.tint.g * shade, bl = this.tint.b * shade;
    for (let i = 0; i < 3; i++) this.col.push(r, g, bl);
  }

  quad(a: V3, b: V3, c: V3, d: V3, shade: number) {
    this.tri(a, b, c, shade);
    this.tri(a, c, d, shade);
  }

  walls(ring: V2[], y0: number, y1: number, shade: number) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], shade);
    }
  }

  /** Walls with horizontal window bands, `floorH` per band pair. */
  bandedWalls(ring: V2[], y0: number, y1: number, floorH: number, winFrac: number, wall: number, win: number) {
    const bands = Math.max(1, Math.min(40, Math.round((y1 - y0) / floorH)));
    const step = (y1 - y0) / bands;
    for (let i = 0; i < bands; i++) {
      const b0 = y0 + i * step;
      const split = b0 + step * (1 - winFrac);
      this.walls(ring, b0, split, wall);
      this.walls(ring, split, b0 + step, win);
    }
  }

  cap(outer: V2[], holes: V2[][], y: number, shade: number) {
    const tris = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p[0], p[1])),
      holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1]))),
    );
    const pts = [...outer, ...holes.flat()];
    for (const [a, b, c] of tris) {
      this.tri([pts[a][0], y, pts[a][1]], [pts[b][0], y, pts[b][1]], [pts[c][0], y, pts[c][1]], shade);
    }
  }

  /** Oriented box (for plant rooms, chimneys, spires). */
  box(c: V2, u: V2, len: number, wid: number, y0: number, y1: number, shade: number, topShade = shade) {
    const v: V2 = [-u[1], u[0]];
    const corner = (su: number, sv: number): V2 => [c[0] + u[0] * su * len / 2 + v[0] * sv * wid / 2, c[1] + u[1] * su * len / 2 + v[1] * sv * wid / 2];
    const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    this.walls(ring, y0, y1, shade);
    this.cap(ring, [], y1, topShade);
  }

  /** Pitched roof over a box: gable ends, or hipped. */
  roof(b: Box2, eave: number, rise: number, hip: boolean, shade: number, gableShade: number, overhang = 0.5) {
    const L = b.len / 2 + overhang, W = b.wid / 2 + overhang;
    const at = (su: number, sv: number, y: number): V3 => [b.c[0] + b.u[0] * su + b.v[0] * sv, y, b.c[1] + b.u[1] * su + b.v[1] * sv];
    const ridge = hip ? Math.max(L - W, L * 0.25) : L;
    const top = eave + rise;
    const r1 = at(-ridge, 0, top), r2 = at(ridge, 0, top);
    const c1 = at(-L, -W, eave), c2 = at(L, -W, eave), c3 = at(L, W, eave), c4 = at(-L, W, eave);
    this.quad(c1, c2, r2, r1, shade);
    this.quad(c3, c4, r1, r2, shade);
    this.tri(c4, c1, r1, hip ? shade : gableShade);
    this.tri(c2, c3, r2, hip ? shade : gableShade);
  }

  /** Pyramid roof for irregular footprints. */
  tent(ring: V2[], eave: number, rise: number, apex: V2, shade: number) {
    const top: V3 = [apex[0], eave + rise, apex[1]];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      this.tri([a[0], eave, a[1]], [b[0], eave, b[1]], top, shade);
    }
  }
}

const scaleRing = (r: V2[], c: V2, k: number): V2[] => r.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);

// Shades: walls are full colour, windows and roofs darker.
const S = { wall: 1, win: 0.86, glass: 0.8, roof: 0.76, flat: 0.9, gable: 0.95, trim: 0.7 };

/** One building's model on its own (e.g. to highlight it). */
export function buildingGeometry(fp: Footprint, tint = '#ffffff'): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.setTint(tint);
  buildBuilding(m, fp);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
  g.computeVertexNormals();
  return g;
}

/** Append one building's model to the mesh builder. */
export function buildBuilding(m: MeshBuilder, fp: Footprint): Kind {
  const { kind, box, area } = classify(fp);
  const y0 = fp.minHeight, h = Math.max(fp.height, y0 + 2.5);
  const outer = fp.outer, holes = fp.holes;
  const variant = fp.seed % 6;
  const rect = area / Math.max(box.area, 1);
  switch (kind) {
    case 'shed':
      m.walls(outer, y0, h, S.wall);
      m.cap(outer, holes, h, S.flat);
      break;
    case 'house':
    case 'terrace': {
      // Walls to the eaves, then a pitched roof on top.
      m.walls(outer, y0, h, S.wall);
      for (const hole of holes) m.walls(hole, y0, h, S.wall);
      const rise = Math.min(Math.max(box.wid * 0.42, 2), 6.5);
      if (rect < 0.72 && kind === 'house') {
        m.cap(outer, holes, h, S.flat);
        m.tent(outer, h, rise, box.c, S.roof);
      } else {
        m.roof(box, h, rise, kind === 'house' && variant % 3 === 1, S.roof, S.gable);
        if (kind === 'house' && variant >= 3 && box.len > 9) {
          // A lower cross-gable wing: roofs at two different levels.
          const wing: Box2 = { ...box, c: [box.c[0] + box.u[0] * box.len * 0.22, box.c[1] + box.u[1] * box.len * 0.22],
            u: box.v, v: [-box.u[0], -box.u[1]], len: box.wid * 1.05, wid: box.len * 0.36 };
          m.roof(wing, h - 0.9, rise * 0.75, false, S.roof, S.gable, 0.3);
        }
      }
      // Chimneys: one per house, several along a terrace.
      const n = kind === 'terrace' ? Math.max(2, Math.round(box.len / 7)) : variant % 2 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.28 : -0.5 + (i + 0.5) / n;
        const c: V2 = [box.c[0] + box.u[0] * box.len * t + box.v[0] * box.wid * 0.18, box.c[1] + box.u[1] * box.len * t + box.v[1] * box.wid * 0.18];
        m.box(c, box.u, 0.9, 0.9, h + rise * 0.4, h + rise + 0.9, S.trim);
      }
      break;
    }
    case 'hall':
    case 'lowrise': {
      if (kind === 'lowrise') m.bandedWalls(outer, y0, h, 3.2, 0.42, S.wall, S.win);
      else m.walls(outer, y0, h, S.wall);
      for (const hole of holes) m.walls(hole, y0, h, S.wall);
      m.cap(outer, holes, h, S.flat);
      // Rooftop plant.
      const n = kind === 'hall' ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : -0.3 + i * 0.3;
        const c: V2 = [box.c[0] + box.u[0] * box.len * t, box.c[1] + box.u[1] * box.len * t];
        m.box(c, box.u, Math.min(6, box.len * 0.2), Math.min(4, box.wid * 0.3), h, h + 2, S.trim, S.flat);
      }
      break;
    }
    case 'midrise': {
      m.bandedWalls(outer, y0, h, 3.2, 0.45, S.wall, S.win);
      for (const hole of holes) m.walls(hole, y0, h, S.wall);
      m.cap(outer, holes, h, S.flat);
      // Parapet and a plant room.
      m.walls(scaleRing(outer, box.c, 0.97), h, h + 1, S.trim);
      m.box(box.c, box.u, Math.min(8, box.len * 0.3), Math.min(6, box.wid * 0.35), h, h + 3.2, S.trim, S.flat);
      break;
    }
    case 'tower':
    case 'skyscraper': {
      // Shaft with tall glass bands, then setback tiers towards the top.
      const tiers = kind === 'skyscraper' ? [0.62, 0.84, 1] : [0.85, 1];
      const scales = kind === 'skyscraper' ? [1, 0.86, 0.7] : [1, 0.8];
      let base = y0;
      tiers.forEach((frac, i) => {
        const top = y0 + (h - y0) * frac;
        const ring = scaleRing(outer, box.c, scales[i]);
        m.bandedWalls(ring, base, top, 4, 0.62, S.wall, S.glass);
        if (i === 0) for (const hole of holes) m.walls(hole, base, top, S.wall);
        m.cap(ring, i === 0 ? holes : [], top, S.flat);
        base = top;
      });
      const sTop = scales[scales.length - 1];
      m.box(box.c, box.u, box.len * sTop * 0.45, box.wid * sTop * 0.45, h, h + 4, S.trim, S.flat);
      if (h > 120 && area < 2500) m.box(box.c, box.u, 1.2, 1.2, h + 4, h + Math.min(h * 0.14, 60), S.trim);
      break;
    }
  }
  return kind;
}

// ------------------------------------------------- tiles to local metres

const R = 6378137;
export const mercX = (lon: number) => (lon + 180) / 360;
export const mercY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
export const lonOfMercX = (x: number) => x * 360 - 180;
export const latOfMercY = (y: number) => (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90;

/** Converts between lon/lat and metres local to a map tile's north-west corner. */
export class TileFrame {
  readonly anchor: LonLat;
  private mx0: number;
  private my0: number;
  private metresPerMerc: number;
  readonly unitM: number;     // metres per tile geometry unit
  readonly sizeM: number;

  constructor(readonly z: number, readonly x: number, readonly y: number, readonly extent = 4096) {
    const n = 2 ** z;
    this.mx0 = x / n;
    this.my0 = y / n;
    this.anchor = [lonOfMercX(this.mx0), latOfMercY(this.my0)];
    const midLat = latOfMercY((y + 0.5) / n);
    this.metresPerMerc = 2 * Math.PI * R * Math.cos((midLat * Math.PI) / 180);
    this.sizeM = this.metresPerMerc / n;
    this.unitM = this.sizeM / extent;
  }

  fromTile(p: { x: number; y: number }): V2 {
    return [p.x * this.unitM, p.y * this.unitM];
  }

  fromLonLat(p: LonLat): V2 {
    return [(mercX(p[0]) - this.mx0) * this.metresPerMerc, (mercY(p[1]) - this.my0) * this.metresPerMerc];
  }

  toLonLat(p: V2): LonLat {
    return [lonOfMercX(this.mx0 + p[0] / this.metresPerMerc), latOfMercY(this.my0 + p[1] / this.metresPerMerc)];
  }
}

// ------------------------------------------------------------- ownership

function segDist(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

export function pointInRing(p: V2, r: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) &&
        p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a building outline to a line (0 if they touch). */
export function ringToLineDist(ring: V2[], line: V2[]): number {
  let best = Infinity;
  for (const p of line) {
    if (pointInRing(p, ring)) return 0;
  }
  for (let i = 1; i < line.length; i++) for (const p of ring) best = Math.min(best, segDist(p, line[i - 1], line[i]));
  for (let i = 0; i < ring.length; i++) for (const p of line) best = Math.min(best, segDist(p, ring[i], ring[(i + 1) % ring.length]));
  return best;
}

const bboxOf = (pts: V2[]) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  return { x0, z0, x1, z1 };
};

export interface Ownership {
  mine: LonLat[][];
  other: LonLat[][];
  /** Footprints of older game-built buildings that stand on their plot: real buildings there are hidden. */
  cleared: LonLat[][];
  /** Where real buildings that players bought stand (a point inside or at the middle of each). */
  bought?: { mine: LonLat[]; other: LonLat[] };
}

export interface CityStats { buildings: number; mine: number; other: number; bought: number; cleared: number; kinds: Partial<Record<Kind, number>> }

/** A building drawn in a tile, and the first triangle of its model (for picking). */
export interface Drawn { fp: Footprint; tri: number }

/** Build one tile's worth of buildings into a single geometry. */
export function buildTile(frame: TileFrame, footprints: Footprint[], own: Ownership, frontageM: number): { geometry: THREE.BufferGeometry; stats: CityStats; drawn: Drawn[] } {
  const toLines = (ls: LonLat[][]) => ls.map((l) => l.map((p) => frame.fromLonLat(p)))
    .filter((l) => { const b = bboxOf(l); return b.x1 > -100 && b.z1 > -100 && b.x0 < frame.sizeM + 100 && b.z0 < frame.sizeM + 100; });
  const mine = toLines(own.mine), other = toLines(own.other), cleared = toLines(own.cleared);
  const toPts = (ps: LonLat[] = []) => ps.map((p) => frame.fromLonLat(p))
    .filter((p) => p[0] > -50 && p[1] > -50 && p[0] < frame.sizeM + 50 && p[1] < frame.sizeM + 50);
  const boughtMine = toPts(own.bought?.mine), boughtOther = toPts(own.bought?.other);
  const isBought = (fp: Footprint, pts: V2[]) => {
    if (!pts.length) return false;
    const c = centroid(fp.outer);
    return pts.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < 4 || pointInRing(p, fp.outer));
  };
  const m = new MeshBuilder();
  const drawn: Drawn[] = [];
  const stats: CityStats = { buildings: 0, mine: 0, other: 0, bought: 0, cleared: 0, kinds: {} };
  const near = (fp: Footprint, lines: V2[][], d: number) => {
    const b = bboxOf(fp.outer);
    return lines.some((l) => {
      const lb = bboxOf(l);
      if (lb.x0 > b.x1 + d || lb.x1 < b.x0 - d || lb.z0 > b.z1 + d || lb.z1 < b.z0 - d) return false;
      return ringToLineDist(fp.outer, l) < d;
    });
  };
  for (const fp of footprints) {
    if (cleared.length && cleared.some((c) => near(fp, [c], 0.5) || fp.outer.some((p) => pointInRing(p, c)))) {
      stats.cleared++;
      continue;
    }
    const bought: Owner = isBought(fp, boughtMine) ? 'mine' : isBought(fp, boughtOther) ? 'other' : 'none';
    const owner: Owner = bought !== 'none' ? bought
      : near(fp, mine, frontageM) ? 'mine' : near(fp, other, frontageM) ? 'other' : 'none';
    m.setTint(CITY_TINTS[bought !== 'none' || owner === 'none' ? owner : owner === 'mine' ? 'mineFront' : 'otherFront']);
    drawn.push({ fp, tri: m.pos.length / 9 });
    const kind = buildBuilding(m, fp);
    stats.buildings++;
    if (owner !== 'none') stats[owner]++;
    if (bought !== 'none') stats.bought++;
    stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
  g.computeVertexNormals();
  return { geometry: g, stats, drawn };
}

/**
 * Turn raw vector-tile building features into footprints in tile metres,
 * clipped to the tile so neighbouring tiles never overlap.
 */
export function tileFootprints(frame: TileFrame, features: { rings: { x: number; y: number }[][]; height: number; minHeight: number }[]): Footprint[] {
  const out: Footprint[] = [];
  const lo = 0, hi = frame.sizeM;
  let seed = frame.x * 7919 + frame.y * 104729;
  for (const f of features) {
    let cur: Footprint | null = null;
    for (const raw of f.rings) {
      const ring = clipRing(raw.map((p) => frame.fromTile(p)), lo, hi);
      if (ring.length < 3) continue;
      if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      const a = ringArea(ring);
      if (Math.abs(a) < 2) continue;
      // Vector tiles: outer rings and holes have opposite winding.
      if (!cur || Math.sign(a) === Math.sign(ringArea(cur.outer))) {
        if (cur) out.push(cur);
        cur = { outer: ring, holes: [], height: f.height, minHeight: f.minHeight, seed: (seed = (seed * 48271 + 11) % 2147483647) };
      } else {
        cur.holes.push(ring);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}
