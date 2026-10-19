// The world map: free OpenFreeMap vector tiles (no API key), owned streets
// drawn on top coloured by ownership, and 3D player buildings when zoomed in.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LngLatBoundsLike, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 runs its tile parser in a separate module worker; point it at
// the copy Vite emits so it also works from a GitHub Pages sub-path.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { BuildingLayer, CITY_MIN_ZOOM, COLORS, footprint, MIN_3D_ZOOM, placeImprovements, type BuildingSpec } from './buildings3d';
import { buildTile, TileFrame, tileFootprints, type CityStats, type Ownership } from './city3d';
import type { Parcel } from './format';
import { streetFromTiles, type LonLat, type StreetCandidate, type TileRoad } from './osm';

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const PARCEL_MIN_ZOOM = 11;
/** Real buildings within this many metres of a street count as "on" it. */
const FRONTAGE_M = 22;
const CITY_COLORS = { base: '#e3e2de', baseTall: '#cfd3d9', mine: '#3fcf98', other: '#f2837b' };
// `distance` needs some geometry; this point is nowhere near anything.
const NOWHERE: GeoJSON.Geometry = { type: 'Point', coordinates: [0, -84] };

type OwnedPoint = [number, number, number, string];   // id, lon, lat, owner

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
  private cityBuilt = new Map<string, { sig: string; stats: CityStats }>();
  private cityPending = new Map<string, { z: number; x: number; y: number; extent: number; feats: any[]; sig: string }>();
  private cityTimer = 0;

  onParcelClick: (id: number) => void = () => {};
  onEmptyClick: (at: LonLat, zoom: number) => void = () => {};
  onViewChange: () => void = () => {};

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [-0.1276, 51.5072],
      zoom: 1.6,
      maxPitch: 60,
      attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.addControl(new maplibregl.GeolocateControl({ fitBoundsOptions: { maxZoom: 16 } }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    this.ready = new Promise((resolve) => {
      this.map.once('load', () => {
        this.styleBasemap();
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

  /** Recolour real buildings when what's owned or built in view changes. */
  private updateCity(specs: BuildingSpec[]) {
    const mine: LonLat[][] = [], other: LonLat[][] = [];
    const sig: string[] = [];
    for (const p of this.parcels.values()) {
      if (!p.owner_id) continue;
      (p.owner_id === this.myPlayerId ? mine : other).push(...p.geom);
      sig.push(`${p.id}:${p.owner_id === this.myPlayerId ? 'm' : 'o'}`);
    }
    for (const b of specs) sig.push(b.key);
    const signature = sig.sort().join(',');
    if (signature === this.citySignature) return;
    this.citySignature = signature;
    const lines = (l: LonLat[][]): GeoJSON.Geometry => (l.length ? { type: 'MultiLineString', coordinates: l } : NOWHERE);
    const cleared: GeoJSON.Geometry = specs.length
      ? { type: 'MultiPolygon', coordinates: specs.map((b) => [footprint(b)]) }
      : NOWHERE;
    this.setCityFilters(lines(mine), lines(other), cleared);
    this.cityOwn = { mine, other, cleared: specs.map((b) => footprint(b)) };
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
      const { geometry, stats } = buildTile(frame, fps, this.cityOwn, FRONTAGE_M);
      this.buildings.setCityTile(key, frame.anchor, geometry);
      this.cityBuilt.set(key, { sig: t.sig, stats });
      this.pumpCity();
    });
  }

  /** Totals across built tiles (used by tests and for debugging). */
  cityStats(): CityStats {
    const total: CityStats = { buildings: 0, mine: 0, other: 0, cleared: 0, kinds: {} };
    for (const { stats } of this.cityBuilt.values()) {
      total.buildings += stats.buildings; total.mine += stats.mine; total.other += stats.other; total.cleared += stats.cleared;
      for (const [k, n] of Object.entries(stats.kinds)) total.kinds[k as keyof CityStats['kinds']] = (total.kinds[k as keyof CityStats['kinds']] ?? 0) + (n ?? 0);
    }
    return total;
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
