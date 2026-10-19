import { describe, expect, it } from 'vitest';
import { alongLines, distM, lineLengthM, mergeLines, omtClass, streetFromTiles, TileRoad } from '../web/src/osm';

describe('streets from map tiles', () => {
  const road = (name: string, cls: string, line: [number, number][], subclass?: string): TileRoad => ({ name, cls, subclass, lines: [line] });
  // High St split into pieces at junctions/tile edges, one piece repeated by an
  // overlapping tile, a disjoint High St 5km away, a crossing road, a footpath.
  const roads = [
    road('High St', 'minor', [[0, 51], [0.001, 51], [0.002, 51]]),
    road('High St', 'minor', [[0.002, 51], [0.003, 51]]),
    road('High St', 'minor', [[0.002, 51], [0.003, 51]]),
    road('High St', 'tertiary', [[0.003, 51], [0.004, 51], [0.009, 51]]),
    road('High St', 'minor', [[0.07, 51], [0.071, 51]]),
    road('Cross Rd', 'secondary', [[0.0015, 50.999], [0.0015, 51.001]]),
    road('Garden Path', 'path', [[0.0005, 51.0001], [0.0009, 51.0001]], 'footway'),
  ];

  it('picks the nearest named road and joins its connected pieces', () => {
    const s = streetFromTiles(roads, [0.0025, 51.00005])!;
    expect(s.name).toBe('High St');
    expect(s.lines).toHaveLength(1);                     // merged into one line, duplicate dropped
    expect(Math.round(lineLengthM(s.lines[0]))).toBe(Math.round(distM([0, 51], [0.009, 51])));
    expect(s.highway).toBe('tertiary');                  // the class covering most length
  });

  it('ignores footpaths and returns nothing far from roads', () => {
    expect(streetFromTiles(roads, [0.0007, 51.0001])?.name).toBe('High St');
    expect(streetFromTiles(roads, [0.03, 51.01])).toBeNull();
  });

  it('can prefer a name (search results)', () => {
    expect(streetFromTiles(roads, [0.0015, 51.0000], 30, 'Cross Rd')!.name).toBe('Cross Rd');
  });

  it('maps OpenMapTiles classes to buyable road classes', () => {
    expect(omtClass('minor')).toBe('residential');
    expect(omtClass('minor', 'living_street')).toBe('living_street');
    expect(omtClass('primary')).toBe('primary');
    expect(omtClass('path', 'pedestrian')).toBe('pedestrian');
    expect(omtClass('motorway')).toBeNull();
    expect(omtClass('service')).toBeNull();
    expect(omtClass('path', 'footway')).toBeNull();
  });
});

describe('line helpers', () => {
  it('joins line parts end to end, in either direction', () => {
    const merged = mergeLines([
      [[0, 0], [1, 0]],
      [[2, 0], [1, 0]],
      [[2, 0], [3, 0]],
      [[10, 10], [11, 10]],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it('walks along lines', () => {
    const line: [number, number][] = [[0, 51], [0.01, 51]];
    const len = lineLengthM(line);
    const mid = alongLines([line], len / 2);
    expect(distM(mid.p, [0.005, 51])).toBeLessThan(1);
    expect(Math.round(mid.bearing)).toBe(90);
  });
});
