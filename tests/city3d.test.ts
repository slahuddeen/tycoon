import { describe, expect, it } from 'vitest';
import { buildBuilding, buildTile, classify, clipRing, Footprint, MeshBuilder, orientedBox, TileFrame, tileFootprints, V2 } from '../web/src/city3d';

const rect = (w: number, d: number, x = 0, z = 0): V2[] => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
const fp = (outer: V2[], height: number, minHeight = 0, seed = 1): Footprint => ({ outer, holes: [], height, minHeight, seed });
const maxY = (m: MeshBuilder) => Math.max(...m.pos.filter((_, i) => i % 3 === 1));

describe('building classification', () => {
  it.each([
    [rect(10, 8), 6, 'house'],
    [rect(40, 7), 9, 'terrace'],
    [rect(4, 5), 3, 'shed'],
    [rect(60, 40), 9, 'hall'],
    [rect(25, 22), 11, 'lowrise'],
    [rect(30, 20), 25, 'midrise'],
    [rect(35, 35), 90, 'tower'],
    [rect(45, 45), 300, 'skyscraper'],
  ] as const)('%j at %dm is a %s', (outer, h, kind) => {
    expect(classify(fp(outer as V2[], h)).kind).toBe(kind);
  });

  it('finds the long axis of a rotated rectangle', () => {
    const a = Math.PI / 6, u: V2 = [Math.cos(a), Math.sin(a)], v: V2 = [-u[1], u[0]];
    const ring: V2[] = [[0, 0], [20 * u[0], 20 * u[1]], [20 * u[0] + 8 * v[0], 20 * u[1] + 8 * v[1]], [8 * v[0], 8 * v[1]]];
    const b = orientedBox(ring);
    expect(b.len).toBeCloseTo(20);
    expect(b.wid).toBeCloseTo(8);
    expect(Math.abs(b.u[0] * u[0] + b.u[1] * u[1])).toBeCloseTo(1);
  });
});

describe('building models', () => {
  it('houses get a pointed roof above their walls', () => {
    const m = new MeshBuilder();
    m.setTint('#ffffff');
    buildBuilding(m, fp(rect(10, 8), 6, 0, 2));
    expect(maxY(m)).toBeGreaterThan(8);          // ridge above the 6m eaves
    expect(maxY(m)).toBeLessThan(14);
  });

  it('some houses have a second, lower roof (cross-gable)', () => {
    const plain = new MeshBuilder(), fancy = new MeshBuilder();
    buildBuilding(plain, fp(rect(12, 9), 6, 0, 0));
    buildBuilding(fancy, fp(rect(12, 9), 6, 0, 4));
    expect(fancy.pos.length).toBeGreaterThan(plain.pos.length);
  });

  it('towers have window bands and taper towards the top; skyscrapers get a spire', () => {
    const t = new MeshBuilder();
    buildBuilding(t, fp(rect(30, 30), 80));
    expect(t.pos.length / 9).toBeGreaterThan(200);   // many triangles from banding
    const s = new MeshBuilder();
    buildBuilding(s, fp(rect(40, 40), 250));
    expect(maxY(s)).toBeGreaterThan(260);
  });

  it('respects building parts that start above ground', () => {
    const m = new MeshBuilder();
    buildBuilding(m, fp(rect(20, 20), 120, 80));
    expect(Math.min(...m.pos.filter((_, i) => i % 3 === 1))).toBeCloseTo(80);
  });
});

describe('tiles', () => {
  it('clips outlines to the tile square', () => {
    const r = clipRing([[-10, 10], [50, 10], [50, 40], [-10, 40]], 0, 100);
    expect(Math.min(...r.map((p) => p[0]))).toBe(0);
    expect(r.length).toBe(4);
  });

  it('turns tile features into footprints and colours buildings on owned streets', () => {
    const frame = new TileFrame(14, 8186, 5448);
    const u = 1 / frame.unitM;   // tile units per metre
    const square = (x: number, z: number, s: number) => [[{ x, y: z }, { x: x + s * u, y: z }, { x: x + s * u, y: z + s * u }, { x, y: z + s * u }, { x, y: z }]];
    const fps = tileFootprints(frame, [
      { rings: square(1000, 1000, 10), height: 6, minHeight: 0 },
      { rings: square(3000, 3000, 30), height: 90, minHeight: 0 },
      { rings: square(-20, 2000, 20), height: 8, minHeight: 0 },   // straddles the tile edge
    ]);
    expect(fps).toHaveLength(3);
    expect(Math.min(...fps[2].outer.map((p) => p[0]))).toBe(0);
    // A street running right past the first building.
    const a = frame.anchor;
    const toLonLat = (x: number, z: number): [number, number] => {
      const n = 2 ** 14, mx = (frame.x + x / 4096) / n, my = (frame.y + z / 4096) / n;
      return [mx * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * my) * Math.PI)) - 90];
    };
    const street = [toLonLat(900, 1000 - 5 * u), toLonLat(1200, 1000 - 5 * u)];
    const { stats, geometry } = buildTile(frame, fps, { mine: [street], other: [], cleared: [] }, 22);
    expect(a[0]).toBeLessThan(street[0][0]);
    expect(stats.buildings).toBe(3);
    expect(stats.mine).toBe(1);
    expect(stats.kinds.tower).toBe(1);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(100);
  });
});
