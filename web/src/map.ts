// The world map: free OpenFreeMap vector tiles (no API key), owned streets
// drawn on top coloured by ownership, and 3D player buildings when zoomed in.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LngLatBoundsLike, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 runs its tile parser in a separate module worker; point it at
// the copy Vite emits so it also works from a GitHub Pages sub-path.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { BuildingLayer, COLORS, MIN_3D_ZOOM, placeImprovements } from './buildings3d';
import type { Parcel } from './format';
import type { LonLat } from './osm';

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const PARCEL_MIN_ZOOM = 11;

type OwnedPoint = [number, number, number, string];   // id, lon, lat, owner

maplibregl.setWorkerUrl(workerUrl);

export class GameMap {
  readonly map: MlMap;
  readonly buildings = new BuildingLayer();
  readonly parcels = new Map<number, Parcel>();
  readonly ready: Promise<void>;
  myPlayerId: string | null = null;
  selectedId: number | null = null;

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
    this.map.on('click', (e) => this.handleClick(e.point, [e.lngLat.lng, e.lngLat.lat]));
    for (const id of ['parcels-line', 'owned-dots']) {
      this.map.on('mouseenter', id, () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', id, () => (this.map.getCanvas().style.cursor = ''));
    }
  }

  /** Make the basemap recede: flat grey buildings, no 3D, muted colours. */
  private styleBasemap() {
    for (const layer of this.map.getStyle().layers ?? []) {
      const sl = (layer as any)['source-layer'];
      if (sl === 'building') {
        if (layer.type === 'fill-extrusion') this.map.setLayoutProperty(layer.id, 'visibility', 'none');
        if (layer.type === 'fill') {
          this.map.setPaintProperty(layer.id, 'fill-color', '#e6e6e3');
          this.map.setPaintProperty(layer.id, 'fill-outline-color', '#dcdcd8');
        }
      }
    }
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
    const specs = [];
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
