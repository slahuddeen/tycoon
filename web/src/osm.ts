// Streets and places from free OpenStreetMap-based sources (no API keys):
//  - Street names and shapes come straight from the vector map tiles the
//    browser has already downloaded (OpenMapTiles schema), so picking a
//    street is instant and needs no extra server.
//  - Nominatim: place search and reverse geocoding (suburb names).
// A real street is usually split into many pieces (at junctions and tile
// edges), so we join every same-named piece connected to the one clicked.

export type LonLat = [number, number];

export interface StreetCandidate {
  name: string;
  highway: string;          // our road class, e.g. 'residential'
  lines: LonLat[][];
}

/** A named road piece as read from the map tiles. */
export interface TileRoad {
  name: string;
  cls: string;              // OpenMapTiles `class`
  subclass?: string;
  lines: LonLat[][];
}

export const CLAIMABLE_CLASSES = [
  'trunk', 'primary', 'secondary', 'tertiary', 'residential',
  'unclassified', 'living_street', 'pedestrian',
];

/** OpenMapTiles road class -> our (OSM highway) class, or null if not for sale. */
export function omtClass(cls: string, subclass?: string): string | null {
  const c = cls.replace(/_construction$/, '');
  if (['trunk', 'primary', 'secondary', 'tertiary'].includes(c)) return c;
  if (c === 'minor') return subclass && CLAIMABLE_CLASSES.includes(subclass) ? subclass : 'residential';
  if (c === 'path' && subclass === 'pedestrian') return 'pedestrian';
  return null;
}

// ----------------------------------------------------------------- geometry

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distM(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b in degrees clockwise from north. */
export function bearing(a: LonLat, b: LonLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) -
    Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Move from a point by `metres` along `bearingDeg` (small distances). */
export function offset(p: LonLat, bearingDeg: number, metres: number): LonLat {
  const b = rad(bearingDeg);
  const dLat = (metres * Math.cos(b)) / R;
  const dLon = (metres * Math.sin(b)) / (R * Math.cos(rad(p[1])));
  return [p[0] + (dLon * 180) / Math.PI, p[1] + (dLat * 180) / Math.PI];
}

/** Distance in metres from point p to segment ab (local flat approximation). */
export function pointSegDistM(p: LonLat, a: LonLat, b: LonLat): number {
  const k = Math.cos(rad(p[1]));
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy) * 111320;
}

export function pointLineDistM(p: LonLat, line: LonLat[]): number {
  if (line.length === 1) return distM(p, line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, pointSegDistM(p, line[i - 1], line[i]));
  return best;
}

export function lineLengthM(line: LonLat[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += distM(line[i - 1], line[i]);
  return s;
}

/** Join line parts that share endpoints into longer continuous lines. */
export function mergeLines(lines: LonLat[][]): LonLat[][] {
  const key = (p: LonLat) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const out: LonLat[][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        const cs = key(cur[0]), ce = key(cur[cur.length - 1]);
        const ls = key(l[0]), le = key(l[l.length - 1]);
        let joined: LonLat[] | null = null;
        if (ce === ls) joined = cur.concat(l.slice(1));
        else if (ce === le) joined = cur.concat(l.slice(0, -1).reverse());
        else if (cs === le) joined = l.concat(cur.slice(1));
        else if (cs === ls) joined = l.slice().reverse().concat(cur.slice(1));
        if (joined) {
          cur = joined;
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    out.push(cur);
  }
  return out.sort((a, b) => lineLengthM(b) - lineLengthM(a));
}

/** Point and bearing at distance `d` along a set of lines laid end to end. */
export function alongLines(lines: LonLat[][], d: number): { p: LonLat; bearing: number } {
  let rest = d;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const seg = distM(line[i - 1], line[i]);
      if (rest <= seg || (line === lines[lines.length - 1] && i === line.length - 1)) {
        const t = seg > 0 ? Math.min(1, Math.max(0, rest / seg)) : 0;
        const p: LonLat = [
          line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
          line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
        ];
        return { p, bearing: bearing(line[i - 1], line[i]) };
      }
      rest -= seg;
    }
  }
  const last = lines[lines.length - 1];
  return { p: last[last.length - 1], bearing: 0 };
}

// ------------------------------------------------------- street components

/**
 * The buyable street at a point: the nearest named road piece within
 * `radiusM`, plus every same-named piece connected to it (ends within
 * `gapM` of each other). Duplicate pieces from overlapping tiles are dropped.
 */
export function streetFromTiles(roads: TileRoad[], at: LonLat, radiusM = 30, preferName?: string, gapM = 30): StreetCandidate | null {
  const pieces: { name: string; cls: string; line: LonLat[] }[] = [];
  const seen = new Set<string>();
  for (const r of roads) {
    const cls = omtClass(r.cls, r.subclass);
    if (!cls || !r.name) continue;
    for (const line of r.lines) {
      if (line.length < 2) continue;
      const key = r.name + '|' + line.map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
      if (seen.has(key)) continue;
      seen.add(key);
      pieces.push({ name: r.name, cls, line });
    }
  }
  let anchor = -1, best = Infinity;
  pieces.forEach((pc, i) => {
    let d = pointLineDistM(at, pc.line);
    if (preferName && pc.name.toLowerCase() !== preferName.toLowerCase()) d += radiusM;
    if (d < best) { best = d; anchor = i; }
  });
  if (anchor < 0 || best > radiusM) return null;
  const name = pieces[anchor].name;
  const same = pieces.filter((p) => p.name === name);
  const start = same.indexOf(pieces[anchor]);
  const inComp = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const a = same[queue.pop()!].line;
    for (let j = 0; j < same.length; j++) {
      if (inComp.has(j)) continue;
      const b = same[j].line;
      const touch = [a[0], a[a.length - 1]].some((e) => pointLineDistM(e, b) <= gapM) ||
        [b[0], b[b.length - 1]].some((e) => pointLineDistM(e, a) <= gapM);
      if (touch) { inComp.add(j); queue.push(j); }
    }
  }
  const comp = [...inComp].map((i) => same[i]);
  // Road class = the class covering the most length.
  const byClass = new Map<string, number>();
  for (const p of comp) byClass.set(p.cls, (byClass.get(p.cls) ?? 0) + lineLengthM(p.line));
  const highway = [...byClass.entries()].sort((x, y) => y[1] - x[1])[0][0];
  return { name, highway, lines: mergeLines(comp.map((p) => p.line)) };
}

// --------------------------------------------------------------- network

export interface PlaceResult {
  label: string;
  name?: string;
  lon: number;
  lat: number;
  bbox?: [number, number, number, number];
  wayId?: number;
  isStreet: boolean;
}

export async function searchPlaces(q: string): Promise<PlaceResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('search_failed');
  const rows: any[] = await res.json();
  return rows.map((r) => ({
    label: r.display_name,
    name: r.name || undefined,
    lon: Number(r.lon),
    lat: Number(r.lat),
    bbox: r.boundingbox
      ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])]
      : undefined,
    wayId: r.osm_type === 'way' ? Number(r.osm_id) : undefined,
    isStreet: r.category === 'highway' || r.class === 'highway',
  }));
}

/** "Soho, London"-style locality for a point, best effort. */
export async function reverseLocality(at: LonLat): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${at[1]}&lon=${at[0]}`,
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const a = (await res.json()).address ?? {};
    const local = a.suburb ?? a.city_district ?? a.neighbourhood ?? a.quarter ?? a.village ?? a.town;
    const city = a.city ?? a.town ?? a.county ?? a.state;
    const parts = [local, city].filter((x, i, arr) => x && arr.indexOf(x) === i);
    return parts.length ? parts.join(', ') : null;
  } catch {
    return null;
  }
}
