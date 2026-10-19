// Finding an empty spot beside a street for a new player building.
//
// Real buildings are never moved or knocked down: a new building has to go
// on open ground. We walk along the street from the chosen plot, trying
// both sides and a few setbacks, and take the first spot whose rectangle
// clears every real building, every road and every other player building.
import { alongLines, offset, type LonLat } from './osm';
import { plotCentre, sizeOf } from './buildings3d';

type P = [number, number];   // local metres: x east, y north

export interface Obstacles {
  /** Outlines of real buildings and other player buildings. */
  buildings: LonLat[][];
  /** Road centrelines with half their width in metres. */
  roads: { line: LonLat[]; halfWidth: number }[];
}

export interface Spot { lonLat: LonLat; bearing: number }

interface Box { x0: number; y0: number; x1: number; y1: number }
const boxOf = (pts: P[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
};
const overlaps = (a: Box, b: Box, pad = 0) => a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1;

function inPoly(p: P, r: P[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) &&
        p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
}

function segsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

function pointSeg(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Two closed polygons touch or overlap. */
function polysMeet(a: P[], b: P[]): boolean {
  if (a.some((p) => inPoly(p, b)) || b.some((p) => inPoly(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Shortest distance from a polyline to a convex polygon (0 if it crosses it). */
function lineToPoly(line: P[], poly: P[]): number {
  if (line.some((p) => inPoly(p, poly))) return 0;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j], d = poly[(j + 1) % poly.length];
      if (segsCross(line[i - 1], line[i], c, d)) return 0;
      best = Math.min(best, pointSeg(c, line[i - 1], line[i]), pointSeg(line[i - 1], c, d), pointSeg(line[i], c, d));
    }
  }
  return best;
}

/**
 * The free run of plots a building would take: the one containing the
 * picked plot, or else the one nearest the middle of the street. Same rule
 * as the server's, so the building lands where the player expects.
 */
export function chooseSlot(parcel: { slots_total: number; improvements: { slot_index: number; slots_used: number }[] },
                           slotsUsed: number, picked: number | null): number | null {
  const free: number[] = [];
  for (let s = 0; s + slotsUsed <= parcel.slots_total; s++) {
    if (picked != null && !(picked >= s && picked < s + slotsUsed)) continue;
    if (parcel.improvements.some((i) => i.slots_used > 0 && i.slot_index < s + slotsUsed && s < i.slot_index + i.slots_used)) continue;
    free.push(s);
  }
  const score = (s: number) => (picked == null ? Math.abs(2 * s + slotsUsed - parcel.slots_total) : Math.abs(s - picked));
  free.sort((a, b) => score(a) - score(b) || a - b);
  return free[0] ?? null;
}

/**
 * An empty spot beside the street for a building of `typeId` on plot `slot`,
 * or null if there's no room. `within` limits the search to ground whose
 * buildings are actually loaded (the map view).
 */
export function findSpot(parcel: { geom: LonLat[][]; slots_total: number }, typeId: string, slot: number, slotsUsed: number,
                         obstacles: Obstacles, within?: { west: number; south: number; east: number; north: number }): Spot | null {
  const { lines, total, d: centre } = plotCentre(parcel, slot, slotsUsed);
  if (!(total > 0)) return null;
  const size = sizeOf(typeId);
  const origin = alongLines(lines, centre).p;
  const kx = 111320 * Math.cos((origin[1] * Math.PI) / 180), ky = 110574;
  const local = (p: LonLat): P => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky];

  // Only obstacles anywhere near the street matter.
  const reach = Math.max(size.w, size.d) + 60;
  const streetBox = boxOf(lines.flat().map(local));
  const blds = obstacles.buildings.map((r) => r.map(local))
    .map((r) => ({ r, b: boxOf(r) })).filter((o) => overlaps(o.b, streetBox, reach));
  const roads = [...obstacles.roads, ...lines.map((line) => ({ line, halfWidth: 4 }))]
    .map((o) => ({ l: o.line.map(local), hw: o.halfWidth }))
    .map((o) => ({ ...o, b: boxOf(o.l) })).filter((o) => overlaps(o.b, streetBox, reach));

  const CLEAR = 1.5;        // metres kept free around a new building
  const step = 3;
  const firstSide = slot % 2 === 0 ? 1 : -1;
  const setbacks: number[] = [];
  for (let s = 0; s <= 24; s += 2.5) setbacks.push(5 + size.d / 2 + s);

  const ds: number[] = [centre];
  for (let k = 1; k * step <= total; k++) ds.push(centre + k * step, centre - k * step);
  for (const d of ds) {
    if (d < size.w / 2 || d > total - size.w / 2) continue;
    const at = alongLines(lines, d);
    for (const side of [firstSide, -firstSide]) {
      for (const back of setbacks) {
        const c = offset(at.p, at.bearing + 90 * side, back);
        if (within && (c[0] < within.west || c[0] > within.east || c[1] < within.south || c[1] > within.north)) continue;
        const bearing = at.bearing + (side === -1 ? 180 : 0);
        const corner = (a: number, b: number, m: number) => local(offset(offset(c, bearing, a * (size.w / 2 + m)), bearing + 90, b * (size.d / 2 + m)));
        const rect = (m: number): P[] => [corner(-1, -1, m), corner(1, -1, m), corner(1, 1, m), corner(-1, 1, m)];
        const outer = rect(CLEAR), inner = rect(0);
        const ob = boxOf(outer);
        if (blds.some((o) => overlaps(o.b, ob) && polysMeet(outer, o.r))) continue;
        if (roads.some((o) => overlaps(o.b, ob, o.hw + 1) && lineToPoly(o.l, inner) < o.hw + 1)) continue;
        return { lonLat: c, bearing: ((bearing % 360) + 360) % 360 };
      }
    }
  }
  return null;
}
