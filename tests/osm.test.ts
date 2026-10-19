import { describe, expect, it } from 'vitest';
import { alongLines, distM, lineLengthM, mergeLines, OsmWay, streetComponent, toCandidate } from '../web/src/osm';

const way = (id: number, name: string, nodes: number[], coords: [number, number][], highway = 'residential'): OsmWay => ({
  id, nodes, tags: { name, highway }, geometry: coords.map(([lon, lat]) => ({ lon, lat })),
});

describe('street merging', () => {
  // Oxford Street split into 3 ways at junctions, plus a disjoint
  // same-named street 5km away, plus a parallel dual carriageway.
  const ways = [
    way(1, 'High St', [1, 2, 3], [[0, 51], [0.001, 51], [0.002, 51]]),
    way(2, 'High St', [3, 4], [[0.002, 51], [0.003, 51]]),
    way(3, 'High St', [4, 5, 6], [[0.003, 51], [0.004, 51], [0.005, 51]]),
    way(4, 'High St', [100, 101], [[0.07, 51], [0.071, 51]]),
    way(5, 'High St', [200, 201], [[0.0049, 51.0002], [0.0061, 51.0002]]),
  ];

  it('merges connected ways into one street and keeps disjoint ones apart', () => {
    const comp = streetComponent(ways, 2).map((w) => w.id).sort();
    expect(comp).toEqual([1, 2, 3, 5]);
    expect(streetComponent(ways, 4).map((w) => w.id)).toEqual([4]);
  });

  it('builds a claim candidate from the component', () => {
    const c = toCandidate(streetComponent(ways, 1), 1);
    expect(c.name).toBe('High St');
    expect(c.anchorWay).toBe(1);
    expect(c.ways).toHaveLength(4);
    expect(c.ways[0].coords[0]).toEqual([0, 51]);
  });

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
