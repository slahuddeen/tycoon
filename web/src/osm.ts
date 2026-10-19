// Street lookup against free OpenStreetMap services (no API keys):
//  - Overpass API: street geometry by location / name / way id
//  - Nominatim: place search and reverse geocoding (suburb names)
// OSM splits one real street into many ways at every junction, so we merge
// all same-named ways that connect to the one you clicked into one street.

export type LonLat = [number, number];

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
}

export interface StreetCandidate {
  name: string;
  anchorWay: number;
  ways: { id: number; highway: string; coords: LonLat[] }[];
}

export const CLAIMABLE_CLASSES = [
  'trunk', 'primary', 'secondary', 'tertiary', 'residential',
  'unclassified', 'living_street', 'pedestrian',
];

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

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

const wayCoords = (w: OsmWay): LonLat[] => w.geometry.map((g) => [g.lon, g.lat]);

/**
 * All same-named ways connected to the anchor: sharing a node, or with an
 * endpoint within `gapM` metres of the other way (dual carriageways, small
 * gaps in the data).
 */
export function streetComponent(ways: OsmWay[], anchorId: number, gapM = 30): OsmWay[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  for (const w of ways) parent.set(w.id, w.id);

  const byNode = new Map<number, number>();
  for (const w of ways) {
    for (const n of w.nodes ?? []) {
      const other = byNode.get(n);
      if (other !== undefined) union(other, w.id);
      else byNode.set(n, w.id);
    }
  }
  const coords = new Map(ways.map((w) => [w.id, wayCoords(w)]));
  for (const a of ways) {
    const ca = coords.get(a.id)!;
    if (!ca.length) continue;
    const ends = [ca[0], ca[ca.length - 1]];
    for (const b of ways) {
      if (a.id === b.id || find(a.id) === find(b.id)) continue;
      const cb = coords.get(b.id)!;
      if (ends.some((e) => pointLineDistM(e, cb) <= gapM)) union(a.id, b.id);
    }
  }
  if (!parent.has(anchorId)) return [];
  const root = find(anchorId);
  return ways.filter((w) => find(w.id) === root);
}

export function toCandidate(component: OsmWay[], anchorId: number): StreetCandidate {
  const anchor = component.find((w) => w.id === anchorId) ?? component[0];
  return {
    name: anchor.tags.name,
    anchorWay: anchor.id,
    ways: component
      .filter((w) => w.geometry?.length >= 2)
      .map((w) => ({ id: w.id, highway: w.tags.highway, coords: wayCoords(w) })),
  };
}

// --------------------------------------------------------------- network

async function overpass(query: string): Promise<OsmWay[]> {
  let lastErr: unknown = null;
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      return (json.elements ?? []).filter((e: any) => e.type === 'way');
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('street_lookup_failed: ' + String((lastErr as Error)?.message ?? lastErr));
}

const classRegex = () => `^(${CLAIMABLE_CLASSES.join('|')})$`;
const quote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function sameNamedAround(name: string, at: LonLat, anchorId: number): Promise<StreetCandidate | null> {
  const ways = await overpass(
    `[out:json][timeout:25];way(around:3000,${at[1]},${at[0]})[highway~"${classRegex()}"]["name"=${quote(name)}];out geom;`,
  );
  const comp = streetComponent(ways, anchorId);
  return comp.length ? toCandidate(comp, anchorId) : null;
}

/** The named, buyable street nearest to a clicked point (or null). */
export async function findStreetAt(at: LonLat, radiusM = 40): Promise<StreetCandidate | null> {
  const near = await overpass(
    `[out:json][timeout:20];way(around:${radiusM},${at[1]},${at[0]})[highway~"${classRegex()}"][name];out geom;`,
  );
  if (!near.length) return null;
  let best = near[0], bestD = Infinity;
  for (const w of near) {
    const d = pointLineDistM(at, wayCoords(w));
    if (d < bestD) { bestD = d; best = w; }
  }
  return sameNamedAround(best.tags.name, at, best.id);
}

/** Resolve a street from an OSM way id (e.g. from a search result). */
export async function findStreetByWay(wayId: number): Promise<StreetCandidate | null> {
  const ways = await overpass(`[out:json][timeout:20];way(${wayId});out geom;`);
  const w = ways[0];
  if (!w || !w.tags?.name || !CLAIMABLE_CLASSES.includes(w.tags.highway)) return null;
  const mid = w.geometry[Math.floor(w.geometry.length / 2)];
  return sameNamedAround(w.tags.name, [mid.lon, mid.lat], w.id);
}

export interface PlaceResult {
  label: string;
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
    const timer = setTimeout(() => ctrl.abort(), 6000);
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
