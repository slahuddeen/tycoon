// The world map: free OpenFreeMap vector tiles (no API key), owned streets
// drawn on top coloured by ownership, and 3D player buildings when zoomed in.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LngLatBoundsLike, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 runs its tile parser in a separate module worker; point it at
// the copy Vite emits so it also works from a GitHub Pages sub-path.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { BuildingLayer, CITY_MIN_ZOOM, COLORS, footprint, MIN_3D_ZOOM, placeImprovements, type BuildingSpec } from './buildings3d';
import { buildingGeometry, buildTile, classify, TileFrame, tileFootprints, type CityStats, type Drawn, type Footprint, type Kind, type Ownership } from './city3d';
import type { Parcel } from './format';
import { streetFromTiles, type LonLat, type StreetCandidate, type TileRoad } from './osm';
import type { Obstacles } from './placement';

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const PARCEL_MIN_ZOOM = 11;
/** Real buildings within this many metres of a street count as "on" it. */
const FRONTAGE_M = 22;
const CITY_COLORS = { base: '#e3e2de', baseTall: '#cfd3d9', mine: '#a9e3c6', other: '#f2bdb6' };
// `distance` needs some geometry; this point is nowhere near anything.
const NOWHERE: GeoJSON.Geometry = { type: 'Point', coordinates: [0, -84] };

type OwnedPoint = [number, number, number, string];   // id, lon, lat, owner

/** A real building picked on the map. */
export interface RealBuilding {
  outline: LonLat[];
  centre: LonLat;
  height: number;
  kind: Kind;
  /** For drawing its highlight. */
  fp: Footprint;
  anchor: LonLat;
}

// Roughly how wide each kind of road is, either side of its centreline.
const ROAD_HALF_WIDTH: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 6.5, secondary: 6, tertiary: 5, minor: 4, service: 2.5,
  track: 1.5, path: 1, rail: 3, transit: 2.5, busway: 4, raceway: 5,
};

/** Low-angle and overhead camera presets (drag with the right mouse button, or Ctrl+drag, to orbit freely). */
class CameraControl implements maplibregl.IControl {
  private el!: HTMLElement;
  onAdd(map: MlMap) {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group camera-ctrl';
    const button = (label: string, title: string, go: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.textContent = label;
      b.addEventListener('click', go);
      this.el.appendChild(b);
    };
    button('🚶', 'Street level: tilt right down', () =>
      map.easeTo({ pitch: 80, zoom: Math.max(map.getZoom(), 17.5), duration: 1200 }));
    button('🏙️', 'Angled view', () => map.easeTo({ pitch: 55, duration: 1000 }));
    button('🛰️', 'Straight down, north up', () => map.easeTo({ pitch: 0, bearing: 0, duration: 1000 }));
    return this.el;
  }
  onRemove() { this.el.remove(); }
}
maplibregl.setWorkerUrl(workerUrl);

export class GameMap {
  readonly map: MlMap;
  readonly buildings = new BuildingLayer();
  readonly parcels = new Map<number, Parcel>();
  readonly ready: Promise<void>;
  myPlayerId: string | null = null;
  selectedId: number | null = null;
  /** The basemap's vector tile source (OpenMapTiles schema). */
  private tiles: string | null = null;
  private citySignature = '';
  private cityOwn: Ownership = { mine: [], other: [], cleared: [] };
  private cityBuilt = new Map<string, { sig: string; stats: CityStats; frame: TileFrame; drawn: Drawn[] }>();
  private specs: BuildingSpec[] = [];
  private cityPending = new Map<string, { z: number; x: number; y: number; extent: number; feats: any[]; sig: string }>();
  private cityTimer = 0;

  onParcelClick: (id: number) => void = () => {};
  onBuildingClick: (b: RealBuilding) => void = () => {};
  onEmptyClick: (at: LonLat, zoom: number) => void = () => {};
  onViewChange: () => void = () => {};

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [-0.1276, 51.5072],
      zoom: 1.6,
      // Tilt right down to street level (MapLibre allows up to 85° without looking underground).
      maxPitch: 85,
      maxZoom: 21,
      attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.addControl(new CameraControl(), 'bottom-right');
    this.map.addControl(new maplibregl.GeolocateControl({ fitBoundsOptions: { maxZoom: 16 } }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    this.ready = new Promise((resolve) => {
      this.map.once('load', () => {
        this.styleBasemap();
        // A soft sky for low camera angles.
        try {
          this.map.setSky({
            'sky-color': '#bcd7ee', 'sky-horizon-blend': 0.6, 'horizon-color': '#eef2f5',
            'horizon-fog-blend': 0.7, 'fog-color': '#eceeec', 'fog-ground-blend': 0.75,
          } as any);
        } catch { /* older style spec */ }
        this.addLayers();
        resolve();
      });
    });
    this.map.on('moveend', () => this.onViewChange());
    this.map.on('idle', () => this.scheduleCity());
    this.map.on('click', (e) => this.handleClick(e.point, [e.lngLat.lng, e.lngLat.lat]));
    for (const id of ['parcels-line', 'owned-dots']) {
      this.map.on('mouseenter', id, () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', id, () => (this.map.getCanvas().style.cursor = ''));
    }
  }

  /** Flat grey buildings when zoomed out; find the tile source we read streets and buildings from. */
  private styleBasemap() {
    for (const layer of this.map.getStyle().layers ?? []) {
      const sl = (layer as any)['source-layer'];
      if (sl === 'transportation' || sl === 'transportation_name' || sl === 'building') this.tiles ??= (layer as any).source;
      if (sl === 'building') {
        if (layer.type === 'fill-extrusion') this.map.setLayoutProperty(layer.id, 'visibility', 'none');
        if (layer.type === 'fill') {
          this.map.setPaintProperty(layer.id, 'fill-color', '#e6e6e3');
          this.map.setPaintProperty(layer.id, 'fill-outline-color', '#dcdcd8');
        }
      }
    }
  }

  /**
   * Real buildings in 3D, at their real heights, straight from the map tiles.
   * Buildings fronting a street you own are green, a rival's are red, and
   * real buildings where someone has built are cleared to make room.
   */
  private addCityLayers() {
    if (!this.tiles) return;
    const height = ['coalesce', ['get', 'render_height'], ['get', 'height'], 6];
    const base = ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0];
    const layer = (id: string, color: any) => this.map.addLayer({
      id, type: 'fill-extrusion', source: this.tiles!, 'source-layer': 'building', minzoom: 13, maxzoom: CITY_MIN_ZOOM,
      paint: {
        'fill-extrusion-color': color,
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, height] as any,
        'fill-extrusion-base': base as any,
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    // Invisible: makes sure street names are loaded so clicks can read them.
    this.map.addLayer({
      id: 'street-names-probe', type: 'line', source: this.tiles, 'source-layer': 'transportation_name', minzoom: 12,
      paint: { 'line-opacity': 0, 'line-width': 1 },
    });
    layer('city-3d', ['interpolate', ['linear'], height, 0, CITY_COLORS.base, 120, CITY_COLORS.baseTall]);
    layer('city-3d-other', CITY_COLORS.other);
    layer('city-3d-mine', CITY_COLORS.mine);
    this.setCityFilters(NOWHERE, NOWHERE, NOWHERE);
  }

  private setCityFilters(mine: GeoJSON.Geometry, other: GeoJSON.Geometry, cleared: GeoJSON.Geometry) {
    if (!this.map.getLayer('city-3d')) return;
    const near = (g: GeoJSON.Geometry, m: number) => ['<', ['distance', g], m];
    const not = (e: any) => ['!', e];
    const shown = ['all', not(['to-boolean', ['get', 'hide_3d']]), not(near(cleared, 1))];
    this.map.setFilter('city-3d', [...shown, not(near(mine, FRONTAGE_M)), not(near(other, FRONTAGE_M))] as any);
    this.map.setFilter('city-3d-mine', [...shown, near(mine, FRONTAGE_M)] as any);
    this.map.setFilter('city-3d-other', [...shown, not(near(mine, FRONTAGE_M)), near(other, FRONTAGE_M)] as any);
  }

  /**
   * Recolour real buildings when what's owned, bought or built in view
   * changes. Real buildings are never knocked down, except under the few
   * older player buildings that were put on their plot before buildings
   * went on empty ground.
   */
  private updateCity(specs: BuildingSpec[]) {
    const mine: LonLat[][] = [], other: LonLat[][] = [];
    const bought = { mine: [] as LonLat[], other: [] as LonLat[] };
    const sig: string[] = [];
    for (const p of this.parcels.values()) {
      if (!p.owner_id) continue;
      const isMine = p.owner_id === this.myPlayerId;
      (isMine ? mine : other).push(...p.geom);
      sig.push(`${p.id}:${isMine ? 'm' : 'o'}`);
      for (const i of p.improvements ?? []) {
        if (i.type_id !== 'real' || i.lon == null || i.lat == null) continue;
        (isMine ? bought.mine : bought.other).push([i.lon, i.lat]);
        sig.push(`r${i.id}`);
      }
    }
    const legacy = specs.filter((b) => !b.placed);
    for (const b of legacy) sig.push(b.key);
    const signature = sig.sort().join(',');
    if (signature === this.citySignature) return;
    this.citySignature = signature;
    const lines = (l: LonLat[][]): GeoJSON.Geometry => (l.length ? { type: 'MultiLineString', coordinates: l } : NOWHERE);
    const cleared: GeoJSON.Geometry = legacy.length
      ? { type: 'MultiPolygon', coordinates: legacy.map((b) => [footprint(b)]) }
      : NOWHERE;
    this.setCityFilters(lines(mine), lines(other), cleared);
    this.cityOwn = { mine, other, cleared: legacy.map((b) => footprint(b)), bought };
    this.scheduleCity();
  }

  // ----------------------------------------- detailed real buildings (≥ z15)

  private scheduleCity() {
    clearTimeout(this.cityTimer);
    this.cityTimer = window.setTimeout(() => this.refreshCity(), 150);
  }

  /** Work out which map tiles need their buildings (re)built. */
  private refreshCity() {
    if (!this.tiles || this.map.getZoom() < CITY_MIN_ZOOM - 0.5) return;
    const byTile = new Map<string, { z: number; x: number; y: number; extent: number; feats: any[] }>();
    let maxZ = 0;
    for (const f of this.map.querySourceFeatures(this.tiles, { sourceLayer: 'building' }) as any[]) {
      const vt = f._vectorTileFeature;
      if (!vt || f.properties?.hide_3d) continue;
      const key = `${f._z}/${f._x}/${f._y}`;
      let t = byTile.get(key);
      if (!t) byTile.set(key, (t = { z: f._z, x: f._x, y: f._y, extent: vt.extent ?? 4096, feats: [] }));
      t.feats.push(f);
      maxZ = Math.max(maxZ, f._z);
    }
    const wanted = new Set<string>();
    for (const [key, t] of byTile) {
      if (t.z !== maxZ) continue;   // only the most detailed tiles
      wanted.add(key);
      const sig = `${t.feats.length}|${this.citySignature}`;
      if (this.cityBuilt.get(key)?.sig !== sig) this.cityPending.set(key, { ...t, sig });
    }
    // Forget tiles well out of view once we're holding plenty.
    if (this.cityBuilt.size > 24) {
      for (const key of this.cityBuilt.keys()) {
        if (!wanted.has(key)) { this.buildings.setCityTile(key, [0, 0], null); this.cityBuilt.delete(key); }
      }
    }
    this.pumpCity();
  }

  private pumping = false;
  /** Build one tile per animation frame so the map never stalls. */
  private pumpCity() {
    if (this.pumping) return;
    const next = this.cityPending.entries().next();
    if (next.done) return;
    this.pumping = true;
    requestAnimationFrame(() => {
      this.pumping = false;
      const [key, t] = next.value;
      this.cityPending.delete(key);
      const frame = new TileFrame(t.z, t.x, t.y, t.extent);
      const fps = tileFootprints(frame, t.feats.map((f) => ({
        rings: f._vectorTileFeature.loadGeometry(),
        height: Number(f.properties.render_height ?? f.properties.height ?? 6),
        minHeight: Number(f.properties.render_min_height ?? f.properties.min_height ?? 0),
      })));
      const { geometry, stats, drawn } = buildTile(frame, fps, this.cityOwn, FRONTAGE_M);
      this.buildings.setCityTile(key, frame.anchor, geometry);
      this.cityBuilt.set(key, { sig: t.sig, stats, frame, drawn });
      this.pumpCity();
    });
  }

  /** Totals across built tiles (used by tests and for debugging). */
  cityStats(): CityStats {
    const total: CityStats = { buildings: 0, mine: 0, other: 0, bought: 0, cleared: 0, kinds: {} };
    for (const { stats } of this.cityBuilt.values()) {
      total.buildings += stats.buildings; total.mine += stats.mine; total.other += stats.other;
      total.bought += stats.bought; total.cleared += stats.cleared;
      for (const [k, n] of Object.entries(stats.kinds)) total.kinds[k as keyof CityStats['kinds']] = (total.kinds[k as keyof CityStats['kinds']] ?? 0) + (n ?? 0);
    }
    return total;
  }

  /** The real building drawn under a screen point, if any. */
  realBuildingAt(x: number, y: number): RealBuilding | null {
    const hit = this.buildings.pickCity(x, y);
    const t = hit && this.cityBuilt.get(hit.tile);
    if (!hit || !t || !t.drawn.length) return null;
    let lo = 0, hi = t.drawn.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.drawn[mid].tri <= hit.face) lo = mid; else hi = mid - 1;
    }
    const fp = t.drawn[lo].fp;
    let cx = 0, cz = 0;
    for (const p of fp.outer) { cx += p[0]; cz += p[1]; }
    return {
      outline: fp.outer.map((p) => t.frame.toLonLat(p)),
      centre: t.frame.toLonLat([cx / fp.outer.length, cz / fp.outer.length]),
      height: fp.height,
      kind: classify(fp).kind,
      fp,
      anchor: t.frame.anchor,
    };
  }

  /** Light up one real building (null clears it). */
  highlightBuilding(b: RealBuilding | null) {
    this.buildings.setHighlight(b?.anchor ?? null, b ? buildingGeometry(b.fp) : null);
  }

  /** What a new building must keep clear of, from the loaded map tiles. */
  obstacles(): Obstacles {
    const buildings: LonLat[][] = [];
    const roads: Obstacles['roads'] = [];
    if (this.tiles) {
      for (const layer of ['building', 'water']) {
        for (const f of this.map.querySourceFeatures(this.tiles, { sourceLayer: layer })) {
          const g = f.geometry;
          if (g.type === 'Polygon') buildings.push(g.coordinates[0] as LonLat[]);
          else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) buildings.push(poly[0] as LonLat[]);
        }
      }
      for (const f of this.map.querySourceFeatures(this.tiles, { sourceLayer: 'transportation' })) {
        if (f.properties.brunnel === 'tunnel') continue;
        const hw = ROAD_HALF_WIDTH[String(f.properties.class)];
        if (!hw) continue;
        const g = f.geometry;
        if (g.type === 'LineString') roads.push({ line: g.coordinates as LonLat[], halfWidth: hw });
        else if (g.type === 'MultiLineString') for (const line of g.coordinates) roads.push({ line: line as LonLat[], halfWidth: hw });
      }
    }
    for (const s of this.specs) buildings.push(footprint(s, 0));
    return { buildings, roads };
  }

  /** The map view's bounds, slightly inset. */
  visibleBounds() {
    const b = this.map.getBounds();
    const padLon = (b.getEast() - b.getWest()) * 0.05, padLat = (b.getNorth() - b.getSouth()) * 0.05;
    return { west: b.getWest() + padLon, south: b.getSouth() + padLat, east: b.getEast() - padLon, north: b.getNorth() - padLat };
  }

  /**
   * The named, buyable street at a point, read from the loaded map tiles.
   * Instant: no network request.
   */
  findStreetAt(at: LonLat, preferName?: string, radiusM?: number): StreetCandidate | null {
    if (!this.tiles) return null;
    const metresPerPx = (40075016 * Math.cos((at[1] * Math.PI) / 180)) / (512 * 2 ** this.map.getZoom());
    const roads: TileRoad[] = [];
    for (const f of this.map.querySourceFeatures(this.tiles, { sourceLayer: 'transportation_name' })) {
      const g = f.geometry;
      const name = (f.properties.name ?? f.properties['name:latin'] ?? f.properties.name_en) as string | undefined;
      if (!name) continue;
      const lines = g.type === 'LineString' ? [g.coordinates as LonLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LonLat[][]) : [];
      if (lines.length) roads.push({ name, cls: String(f.properties.class ?? ''), subclass: f.properties.subclass as string | undefined, lines });
    }
    return streetFromTiles(roads, at, radiusM ?? Math.max(20, metresPerPx * 14), preferName);
  }

  private addLayers() {
    const m = this.map;
    const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
    m.addSource('parcels', { type: 'geojson', data: empty });
    m.addSource('pending', { type: 'geojson', data: empty });
    m.addSource('owned', { type: 'geojson', data: empty });

    const width = (k: number) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, 1.5 * k, 14, 4 * k, 17, 9 * k] as any;
    // Unowned streets are drawn thinner. (Only one zoom interpolation is
    // allowed per expression, so the ownership test goes inside each stop.)
    const isNone = ['==', ['get', 'state'], 'none'];
    const ownedWidth = ['interpolate', ['exponential', 1.6], ['zoom'],
      10, ['case', isNone, 0.9, 1.5], 14, ['case', isNone, 2.4, 4], 17, ['case', isNone, 5.4, 9]] as any;
    const stateColor = ['match', ['get', 'state'], 'mine', COLORS.mine, 'other', COLORS.other, COLORS.none] as any;

    m.addLayer({
      id: 'parcels-selected', type: 'line', source: 'parcels', minzoom: PARCEL_MIN_ZOOM,
      filter: ['==', ['get', 'id'], -1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.selected, 'line-width': width(2.4), 'line-opacity': 0.55, 'line-blur': 2 },
    });
    m.addLayer({
      id: 'parcels-casing', type: 'line', source: 'parcels', minzoom: PARCEL_MIN_ZOOM,
      filter: ['!=', ['get', 'state'], 'none'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': width(1.5) },
    });
    m.addLayer({
      id: 'parcels-line', type: 'line', source: 'parcels', minzoom: PARCEL_MIN_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': stateColor,
        'line-width': ownedWidth,
        'line-opacity': ['case', ['==', ['get', 'state'], 'none'], 0.55, 0.95],
      },
    });
    m.addLayer({
      id: 'pending-line', type: 'line', source: 'pending',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': COLORS.selected, 'line-width': width(1), 'line-dasharray': [1, 1.5] },
    });
    this.addCityLayers();
    m.addLayer({
      id: 'parcels-label', type: 'symbol', source: 'parcels', minzoom: 15,
      filter: ['!=', ['get', 'state'], 'none'],
      layout: {
        'symbol-placement': 'line', 'text-field': ['get', 'handle'], 'text-size': 12,
        'text-font': ['Noto Sans Bold'], 'text-offset': [0, -1.1], 'symbol-spacing': 400,
      },
      paint: { 'text-color': stateColor, 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
    m.addLayer({
      id: 'owned-dots', type: 'circle', source: 'owned', maxzoom: PARCEL_MIN_ZOOM + 1,
      paint: {
        'circle-color': stateColor,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 8, 5, 12, 7],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9,
      },
    });
    m.addLayer(this.buildings);
  }

  private stateOf(ownerId: string | null) {
    return ownerId == null ? 'none' : ownerId === this.myPlayerId ? 'mine' : 'other';
  }

  private redraw() {
    const features: GeoJSON.Feature[] = [];
    const specs: BuildingSpec[] = [];
    for (const p of this.parcels.values()) {
      features.push({
        type: 'Feature',
        properties: { id: p.id, state: this.stateOf(p.owner_id), handle: p.owner_handle ?? '', name: p.name },
        geometry: { type: 'MultiLineString', coordinates: p.geom },
      });
      specs.push(...placeImprovements(p, this.myPlayerId));
    }
    (this.map.getSource('parcels') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    this.specs = specs;
    this.buildings.setBuildings(specs);
    this.updateCity(specs);
  }

  /** Replace what's shown in the current view. */
  setParcels(list: Parcel[]) {
    this.parcels.clear();
    for (const p of list) this.parcels.set(p.id, p);
    if (this.selectedId != null && !this.parcels.has(this.selectedId) && this.selectedParcel) {
      this.parcels.set(this.selectedId, this.selectedParcel);
    }
    this.redraw();
  }

  private selectedParcel: Parcel | null = null;

  upsertParcel(p: Parcel) {
    this.parcels.set(p.id, p);
    if (p.id === this.selectedId) this.selectedParcel = p;
    this.redraw();
  }

  setOwnedPoints(points: OwnedPoint[]) {
    (this.map.getSource('owned') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: points.map(([id, lon, lat, owner]) => ({
        type: 'Feature', properties: { id, state: this.stateOf(owner) },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      })),
    });
  }

  setPending(ways: LonLat[][] | null) {
    (this.map.getSource('pending') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: ways ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: ways } }] : [],
    });
  }

  select(p: Parcel | null) {
    this.selectedId = p?.id ?? null;
    this.selectedParcel = p;
    if (p) this.parcels.set(p.id, p);
    if (this.map.getLayer('parcels-selected')) this.map.setFilter('parcels-selected', ['==', ['get', 'id'], p?.id ?? -1]);
    this.buildings.setSelected(this.selectedId);
    this.redraw();
  }

  viewBounds() {
    const b = this.map.getBounds();
    const padLon = (b.getEast() - b.getWest()) * 0.25;
    const padLat = (b.getNorth() - b.getSouth()) * 0.25;
    return { west: b.getWest() - padLon, south: b.getSouth() - padLat, east: b.getEast() + padLon, north: b.getNorth() + padLat };
  }

  zoom() {
    return this.map.getZoom();
  }

  /** Resolves once the camera has stopped and the tiles in view have loaded. */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.map.off('idle', done); resolve(); }, 12000);
      this.map.once('moveend', () => this.map.once('idle', done));
      if (!this.map.isMoving()) this.map.once('idle', done);
    });
  }

  flyToParcel(p: { c_lon: number; c_lat: number; geom?: LonLat[][] }) {
    if (p.geom?.length) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const l of p.geom) for (const [x, y] of l) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      this.map.fitBounds([[w, s], [e, n]], { padding: { top: 120, bottom: 80, left: 60, right: 440 }, maxZoom: 17, pitch: 55, duration: 1800 });
    } else {
      this.map.flyTo({ center: [p.c_lon, p.c_lat], zoom: 16.2, pitch: 55, duration: 1800 });
    }
  }

  flyTo(center: LonLat, zoom: number, bbox?: [number, number, number, number]) {
    if (bbox && zoom < 15) this.map.fitBounds(bbox as LngLatBoundsLike, { maxZoom: 15, duration: 1600 });
    else this.map.flyTo({ center, zoom, pitch: zoom >= MIN_3D_ZOOM ? 55 : 0, duration: 1800 });
  }

  private handleClick(point: maplibregl.Point, at: LonLat) {
    const hit = this.buildings.hitTest(point.x, point.y);
    if (hit != null) return this.onParcelClick(hit);
    const real = this.map.getZoom() >= CITY_MIN_ZOOM ? this.realBuildingAt(point.x, point.y) : null;
    if (real) return this.onBuildingClick(real);
    const pad = 10;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
    const dots = this.map.getLayer('owned-dots') ? this.map.queryRenderedFeatures(box, { layers: ['owned-dots'] }) : [];
    if (dots.length && this.map.getZoom() < PARCEL_MIN_ZOOM + 1) {
      const [lon, lat] = (dots[0].geometry as GeoJSON.Point).coordinates;
      this.map.flyTo({ center: [lon, lat], zoom: 16, pitch: 55, duration: 2000 });
      return this.onParcelClick(Number(dots[0].properties.id));
    }
    const lines = this.map.getLayer('parcels-line') ? this.map.queryRenderedFeatures(box, { layers: ['parcels-line'] }) : [];
    if (lines.length) {
      // Prefer owned streets when several overlap.
      lines.sort((a, b) => (a.properties.state === 'none' ? 1 : 0) - (b.properties.state === 'none' ? 1 : 0));
      return this.onParcelClick(Number(lines[0].properties.id));
    }
    this.onEmptyClick(at, this.map.getZoom());
  }
}
