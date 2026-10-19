import { describe, expect, it } from 'vitest';
import { footprint, placeImprovements, SIZES } from '../web/src/buildings3d';
import { offset, pointLineDistM, type LonLat } from '../web/src/osm';
import { chooseSlot, findSpot } from '../web/src/placement';

// A straight 400 m street running east from (0.1, 51.5), 10 plots.
const start: LonLat = [0.1, 51.5];
const end = offset(start, 90, 400);
const parcel = { id: 1, geom: [[start, end]], slots_total: 10, owner_id: 'me', improvements: [] as any[] };

/** A square real building `size` metres across, centred `back` metres north of the street, `along` metres in. */
const block = (along: number, back: number, size = 12): LonLat[] => {
  const c = offset(offset(start, 90, along), 0, back);
  const h = size / 2;
  const ring = [offset(offset(c, 0, -h), 90, -h), offset(offset(c, 0, -h), 90, h), offset(offset(c, 0, h), 90, h), offset(offset(c, 0, h), 90, -h)];
  return [...ring, ring[0]];
};

const inRing = (p: LonLat, r: LonLat[]) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
};

describe('choosing plots', () => {
  it('matches the server: middle of the street, or the run containing the picked plot', () => {
    expect(chooseSlot(parcel, 1, null)).toBe(4);
    expect(chooseSlot(parcel, 1, 9)).toBe(9);
    const p = { ...parcel, improvements: [{ slot_index: 9, slots_used: 1 }, { slot_index: -1, slots_used: 0 }] };
    expect(chooseSlot(p, 1, 9)).toBeNull();
    expect(chooseSlot(p, 2, 3)).toBe(3);
    expect(chooseSlot({ ...p, improvements: [{ slot_index: 4, slots_used: 1 }] }, 2, 3)).toBe(2);
  });
});

describe('finding open ground', () => {
  it('puts a house beside the street on empty land', () => {
    const spot = findSpot(parcel, 'house', 4, 1, { buildings: [], roads: [] })!;
    expect(spot).not.toBeNull();
    const d = pointLineDistM(spot.lonLat, [start, end]);
    expect(d).toBeGreaterThan(SIZES.house.d / 2 + 4);
    expect(d).toBeLessThan(SIZES.house.d / 2 + 8);
  });

  it('never lands on a real building', () => {
    // Real houses packed along both sides of the street except one gap.
    const buildings: LonLat[][] = [];
    for (let a = 10; a < 390; a += 14) {
      if (a > 290 && a < 330) continue;           // the gap, north side only
      buildings.push(block(a, 12), block(a, -12));
    }
    const spot = findSpot(parcel, 'house', 4, 1, { buildings, roads: [] })!;
    expect(spot).not.toBeNull();
    const rect = footprint({ typeId: 'house', lonLat: spot.lonLat, bearing: spot.bearing }, 0);
    for (const b of buildings) {
      expect(b.some((p) => inRing(p, rect))).toBe(false);
      expect(rect.some((p) => inRing(p, b))).toBe(false);
    }
  });

  it('keeps off other roads, and gives up when there is no room', () => {
    const side = offset(start, 0, 14);
    const roads = [{ line: [side, offset(side, 90, 400)], halfWidth: 4 }, { line: [offset(start, 180, 14), offset(offset(start, 180, 14), 90, 400)], halfWidth: 4 }];
    // Roads 14 m either side leave too little room for a 22 m deep apartment block close in...
    const spot = findSpot(parcel, 'apartments', 4, 3, { buildings: [], roads });
    if (spot) for (const r of roads) expect(pointLineDistM(spot.lonLat, r.line)).toBeGreaterThan(SIZES.apartments.d / 2 + 4);
    // ...and solid buildings everywhere leave none.
    const wall = [offset(offset(start, 180, 60), 90, -50), offset(offset(start, 180, 60), 90, 450), offset(offset(start, 0, 60), 90, 450), offset(offset(start, 0, 60), 90, -50)];
    expect(findSpot(parcel, 'house', 4, 1, { buildings: [[...wall, wall[0]]], roads: [] })).toBeNull();
  });
});

describe('placing player buildings', () => {
  it('uses the stored spot, and leaves real buildings to the city', () => {
    const specs = placeImprovements({
      ...parcel,
      improvements: [
        { id: 7, type_id: 'house', slot_index: 4, slots_used: 1, lon: 0.102, lat: 51.5001, bearing: 270 },
        { id: 8, type_id: 'cottage', slot_index: 6, slots_used: 1 },
        { id: 9, type_id: 'real', slot_index: -1, slots_used: 0, lon: 0.103, lat: 51.5002 },
      ],
    }, 'me');
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ lonLat: [0.102, 51.5001], bearing: 270, placed: true, mine: true });
    expect(specs[1].placed).toBe(false);
  });
});
