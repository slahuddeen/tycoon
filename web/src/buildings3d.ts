// Player buildings in 3D, rendered by Three.js inside a MapLibre custom
// layer together with the real city. They're modelled exactly like the real
// buildings around them (city3d.ts): real-world sizes, the same roofs and
// shading, one colour per owner, drawn double-sided.
import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { buildingGeometry, CITY_TINTS, type Footprint, type Kind } from './city3d';
import { alongLines, lineLengthM, mergeLines, offset, type LonLat } from './osm';

export const COLORS = {
  mine: '#10b981',
  other: '#ef4444',
  none: '#94a3b8',
  selected: '#f59e0b',
};

export const MIN_3D_ZOOM = 14;
/** Zoom from which real buildings are drawn as detailed models. */
export const CITY_MIN_ZOOM = 15;

export interface BuildingSpec {
  key: string;          // improvement id
  parcelId: number;
  typeId: string;
  lonLat: LonLat;       // middle of the building
  /** Direction its sides run in: the street's bearing, turned round on the far side. */
  bearing: number;
  mine: boolean;
  /** Stood on a spot chosen clear of the real buildings (older ones sit on their plot). */
  placed: boolean;
  seed: number;
}

/** Real-world sizes: w along the street, d deep, h to the eaves or roof. */
export const SIZES: Record<string, { w: number; d: number; h: number; kind: Kind }> = {
  cottage:    { w: 7,   d: 7.5, h: 4.8, kind: 'house' },
  house:      { w: 8.5, d: 9,   h: 6.2, kind: 'house' },
  terrace:    { w: 19,  d: 8.5, h: 7,   kind: 'terrace' },
  shops:      { w: 22,  d: 13,  h: 7.5, kind: 'lowrise' },
  apartments: { w: 22,  d: 15,  h: 21,  kind: 'midrise' },
  office:     { w: 28,  d: 22,  h: 48,  kind: 'tower' },
  tower:      { w: 28,  d: 26,  h: 110, kind: 'tower' },
  skyscraper: { w: 36,  d: 32,  h: 240, kind: 'skyscraper' },
};
export const sizeOf = (typeId: string) => SIZES[typeId] ?? SIZES.house;

// ------------------------------------------------------------- the models

interface Model { geometry: THREE.BufferGeometry; height: number }

// Shapes vary a little (roof style, chimney) like the real houses do: six variants per type.
const modelCache = new Map<string, Model>();
function model(typeId: string, seed: number): Model {
  const k = `${typeId}:${seed % 6}`;
  let m = modelCache.get(k);
  if (!m) {
    const s = sizeOf(typeId), hw = s.w / 2, hd = s.d / 2;
    const fp: Footprint = { outer: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]], holes: [], height: s.h, minHeight: 0, seed: seed % 6, kind: s.kind };
    // White vertex colours carry the shading; the material supplies the owner's colour.
    const geometry = buildingGeometry(fp);
    geometry.computeBoundingBox();
    m = { geometry, height: geometry.boundingBox!.max.y };
    modelCache.set(k, m);
  }
  return m;
}

/** Ground rectangle a player building covers, as a closed GeoJSON ring (with a margin). */
export function footprint(spec: Pick<BuildingSpec, 'typeId' | 'lonLat' | 'bearing'>, margin = 3): LonLat[] {
  const s = sizeOf(spec.typeId);
  const halfW = s.w / 2 + margin, halfD = s.d / 2 + margin;
  const along = spec.bearing, across = spec.bearing + 90;
  const c = (a: number, b: number) => offset(offset(spec.lonLat, along, a), across, b);
  const ring = [c(-halfW, -halfD), c(halfW, -halfD), c(halfW, halfD), c(-halfW, halfD)];
  return [...ring, ring[0]];
}

const seedOf = (id: number) => Math.abs(Math.imul(id, 2654435761) | 0);

// ------------------------------------------------------ placement on streets

/** Where along the street (metres) the middle of a run of plots is. */
export function plotCentre(parcel: { geom: LonLat[][]; slots_total: number }, slot: number, slotsUsed: number) {
  const lines = mergeLines(parcel.geom);
  const total = lines.reduce((s, l) => s + lineLengthM(l), 0);
  return { lines, total, d: ((slot + slotsUsed / 2) * total) / parcel.slots_total };
}

/**
 * Where each player building on a parcel stands: the spot it was built on,
 * or for older buildings, their plot, alternating sides of the road.
 * Real buildings bought off the map are drawn by the city, not here.
 */
export function placeImprovements(parcel: {
  id: number; geom: LonLat[][]; slots_total: number; owner_id: string | null;
  improvements: { id: number; type_id: string; slot_index: number; slots_used: number; lon?: number | null; lat?: number | null; bearing?: number | null }[];
}, myPlayerId: string | null): BuildingSpec[] {
  if (!parcel.improvements?.length) return [];
  const mine = !!myPlayerId && parcel.owner_id === myPlayerId;
  return parcel.improvements.filter((imp) => imp.type_id !== 'real').map((imp) => {
    const base = { key: String(imp.id), parcelId: parcel.id, typeId: imp.type_id, mine, seed: seedOf(imp.id) };
    if (imp.lon != null && imp.lat != null && imp.bearing != null) {
      return { ...base, lonLat: [imp.lon, imp.lat] as LonLat, bearing: imp.bearing, placed: true };
    }
    const { lines, d } = plotCentre(parcel, imp.slot_index, imp.slots_used);
    const at = alongLines(lines, d);
    const side = imp.slot_index % 2 === 0 ? 1 : -1;
    return {
      ...base,
      lonLat: offset(at.p, at.bearing + 90 * side, 8 + sizeOf(imp.type_id).d / 2),
      bearing: at.bearing + (side === -1 ? 180 : 0),
      placed: false,
    };
  });
}

// --------------------------------------------------------------- the layer

interface Live {
  spec: BuildingSpec;
  mesh: THREE.Mesh;
  born: number;
  height: number;
}

export class BuildingLayer implements CustomLayerInterface {
  id = 'tycoon-buildings';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private origin: LonLat = [0, 0];
  private originMerc = MercatorCoordinate.fromLngLat([0, 0], 0);
  private live = new Map<string, Live>();
  private cityMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private city = new Map<string, { mesh: THREE.Mesh; anchor: LonLat }>();
  private cityGroup = new THREE.Group();
  private playerMats = {
    mine: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, color: CITY_TINTS.mine }),
    other: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, color: CITY_TINTS.other }),
  };
  private selectedMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, color: COLORS.selected, emissive: '#5a3500' });
  // Drawn over a real building's own model, so it wins the depth test.
  private highlightMat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, color: COLORS.selected, emissive: '#5a3500',
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  private highlight: { mesh: THREE.Mesh; anchor: LonLat } | null = null;
  private selectedParcel: number | null = null;
  private animating = false;

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.scene.add(this.cityGroup);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-60, 120, -40);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(80, 60, 90);
    this.scene.add(fill);
  }

  private toScene(p: LonLat): THREE.Vector3 {
    const m = MercatorCoordinate.fromLngLat(p, 0);
    const s = this.originMerc.meterInMercatorCoordinateUnits();
    return new THREE.Vector3((m.x - this.originMerc.x) / s, 0, (m.y - this.originMerc.y) / s);
  }

  private resetOrigin(p: LonLat) {
    this.origin = p;
    this.originMerc = MercatorCoordinate.fromLngLat(p, 0);
    for (const l of this.live.values()) l.mesh.position.copy(this.toScene(l.spec.lonLat));
    for (const c of this.city.values()) c.mesh.position.copy(this.toScene(c.anchor));
    if (this.highlight) this.highlight.mesh.position.copy(this.toScene(this.highlight.anchor));
  }

  private ensureOrigin() {
    const c = this.map.getCenter();
    if (Math.abs(c.lat - this.origin[1]) > 0.2 || Math.abs(c.lng - this.origin[0]) > 0.3) {
      this.resetOrigin([c.lng, c.lat]);
    }
  }

  // ------------------------------------------------ real city, per map tile

  hasCityTile(key: string) {
    return this.city.has(key);
  }

  cityTileKeys() {
    return [...this.city.keys()];
  }

  /** Add or replace one map tile's worth of real buildings (null removes it). */
  setCityTile(key: string, anchor: LonLat, geometry: THREE.BufferGeometry | null) {
    if (!this.map) return;
    this.ensureOrigin();
    const old = this.city.get(key);
    if (old) {
      this.cityGroup.remove(old.mesh);
      old.mesh.geometry.dispose();
      this.city.delete(key);
    }
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, this.cityMat);
      mesh.position.copy(this.toScene(anchor));
      mesh.userData.tile = key;
      this.city.set(key, { mesh, anchor });
      this.cityGroup.add(mesh);
    }
    this.map.triggerRepaint();
  }

  /** Outline one real building in the selection colour (null clears it). */
  setHighlight(anchor: LonLat | null, geometry: THREE.BufferGeometry | null) {
    if (this.highlight) {
      this.scene.remove(this.highlight.mesh);
      this.highlight.mesh.geometry.dispose();
      this.highlight = null;
    }
    if (anchor && geometry && this.map) {
      this.ensureOrigin();
      const mesh = new THREE.Mesh(geometry, this.highlightMat);
      mesh.position.copy(this.toScene(anchor));
      this.highlight = { mesh, anchor };
      this.scene.add(mesh);
    }
    this.map?.triggerRepaint();
  }

  /** The real-city triangle under a screen point: which tile, and which triangle. */
  pickCity(x: number, y: number): { tile: string; face: number } | null {
    if (!this.map || !this.cityGroup.visible || !this.city.size) return null;
    const canvas = this.map.getCanvas();
    const ndc = new THREE.Vector2((x / canvas.clientWidth) * 2 - 1, 1 - (y / canvas.clientHeight) * 2);
    const inv = this.camera.projectionMatrix.clone().invert();
    const a = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inv);
    const b = new THREE.Vector3(ndc.x, ndc.y, 0.5).applyMatrix4(inv);
    if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return null;
    this.scene.updateMatrixWorld();
    const ray = new THREE.Raycaster(a, b.sub(a).normalize());
    const hit = ray.intersectObjects(this.cityGroup.children, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    return { tile: hit.object.userData.tile as string, face: hit.faceIndex };
  }

  setSelected(parcelId: number | null) {
    this.selectedParcel = parcelId;
    for (const l of this.live.values()) this.applyMaterial(l);
    this.map?.triggerRepaint();
  }

  private applyMaterial(l: Live) {
    l.mesh.material = l.spec.parcelId === this.selectedParcel
      ? this.selectedMat
      : l.spec.mine ? this.playerMats.mine : this.playerMats.other;
  }

  /** Replace the set of visible buildings; new ones grow out of the ground. */
  setBuildings(specs: BuildingSpec[], animateNew = true) {
    if (!this.map) return;
    this.ensureOrigin();
    const seen = new Set<string>();
    const now = performance.now();
    for (const spec of specs) {
      seen.add(spec.key);
      const old = this.live.get(spec.key);
      if (old && old.spec.mine === spec.mine && old.spec.typeId === spec.typeId && old.spec.bearing === spec.bearing &&
          old.spec.lonLat[0] === spec.lonLat[0] && old.spec.lonLat[1] === spec.lonLat[1]) continue;
      if (old) this.scene.remove(old.mesh);
      const m = model(spec.typeId, spec.seed);
      const mesh = new THREE.Mesh(m.geometry, this.playerMats.mine);
      mesh.position.copy(this.toScene(spec.lonLat));
      mesh.rotation.y = ((90 - spec.bearing) * Math.PI) / 180;
      const l: Live = { spec, mesh, born: animateNew && !old ? now : 0, height: m.height };
      this.applyMaterial(l);
      this.live.set(spec.key, l);
      this.scene.add(mesh);
    }
    for (const [k, l] of this.live) {
      if (!seen.has(k)) {
        this.scene.remove(l.mesh);
        this.live.delete(k);
      }
    }
    this.map.triggerRepaint();
  }

  /** Screen-space hit test so clicking a tower selects its street. */
  hitTest(x: number, y: number): number | null {
    if (!this.map || this.map.getZoom() < MIN_3D_ZOOM) return null;
    let best: number | null = null;
    let bestD = Infinity;
    const metresPerPx = 40075016 * Math.cos((this.map.getCenter().lat * Math.PI) / 180) / (512 * 2 ** this.map.getZoom());
    for (const l of this.live.values()) {
      const base = this.map.project(l.spec.lonLat as [number, number]);
      const s = sizeOf(l.spec.typeId);
      const radius = Math.max(14, Math.min(s.w, s.d) / 2 / metresPerPx);
      // Tall buildings: also accept clicks up the facade.
      const up = Math.min(l.height / metresPerPx, 400) * Math.sin((this.map.getPitch() * Math.PI) / 180);
      const dx = x - base.x;
      const dy = Math.max(0, Math.min(up, base.y - y));
      const d = Math.hypot(dx, base.y - y - dy);
      if (d < radius && d < bestD) {
        bestD = d;
        best = l.spec.parcelId;
      }
    }
    return best;
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const zoom = this.map.getZoom();
    this.cityGroup.visible = zoom >= CITY_MIN_ZOOM;
    if (this.highlight) this.highlight.mesh.visible = this.cityGroup.visible;
    if ((!this.live.size && !(this.city.size && this.cityGroup.visible)) || zoom < MIN_3D_ZOOM) return;
    const now = performance.now();
    let anim = false;
    for (const l of this.live.values()) {
      if (!l.born) continue;
      const t = Math.min(1, (now - l.born) / 900);
      const c1 = 1.70158, c3 = c1 + 1;
      const e = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);   // easeOutBack
      l.mesh.scale.set(1, Math.max(0.001, e), 1);
      if (t >= 1) l.born = 0; else anim = true;
    }
    const s = this.originMerc.meterInMercatorCoordinateUnits();
    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    const l = new THREE.Matrix4()
      .makeTranslation(this.originMerc.x, this.originMerc.y, this.originMerc.z)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    if (anim || anim !== this.animating) this.map.triggerRepaint();
    this.animating = anim;
  }
}
