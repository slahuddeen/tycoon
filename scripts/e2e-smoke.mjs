// End-to-end smoke test in headless Chromium against the built site
// (`npm run build` first). The map service is replaced by a fake city served
// as real vector tiles in the same OpenMapTiles format OpenFreeMap uses
// (roads, street names, buildings with heights), so it runs offline:
//   node scripts/e2e-smoke.mjs [outDir]
// Set E2E_REST=http://localhost:3000 to play in online mode against a local
// PostgREST serving the game database (stands in for Supabase).
// Plays a full round: register, pick a world, click a street, buy it, build
// on it, run ticks, a rival player, ledger, search, mobile. Saves screenshots.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const OUT = process.argv[2] ?? 'e2e-shots';
mkdirSync(OUT, { recursive: true });
const PORT = 4179;
const CENTER = [-0.13, 51.51];

// -------------------------------------------------------------- fake city
const dLat = 0.0018, dLon = 0.0029;                       // ~200m blocks
const mPerLat = 111320, mPerLon = 111320 * Math.cos((CENTER[1] * Math.PI) / 180);
const roads = [];        // transportation + transportation_name features
const H = ['Alpha Street', 'Bridge Road', 'Crown Lane', 'Duke Street', 'Elm Row'];
const V = ['Kings Avenue', 'Market Street', 'Old Road', 'Park Lane', 'Queens Walk'];
function addStreet(name, cls, pts) {
  // Each street arrives in several pieces, like real tiles split at junctions.
  for (let i = 0; i < pts.length - 1; i += 2) {
    roads.push({ type: 'Feature', properties: { name, class: cls },
      geometry: { type: 'LineString', coordinates: pts.slice(i, Math.min(i + 3, pts.length)) } });
  }
}
for (let r = 0; r < H.length; r++) {
  const lat = CENTER[1] + (r - 2) * dLat;
  addStreet(H[r], r === 2 ? 'secondary' : 'minor', Array.from({ length: 7 }, (_, i) => [CENTER[0] + (i - 3) * dLon, lat]));
}
for (let c = 0; c < V.length; c++) {
  const lon = CENTER[0] + (c - 2) * dLon;
  addStreet(V[c], c === 0 ? 'primary' : 'tertiary', Array.from({ length: 7 }, (_, i) => [lon, CENTER[1] + (i - 3) * dLat]));
}
roads.push({ type: 'Feature', properties: { name: 'Ring Motorway', class: 'motorway' },
  geometry: { type: 'LineString', coordinates: [[CENTER[0] - 4 * dLon, CENTER[1] - 3.2 * dLat], [CENTER[0] + 4 * dLon, CENTER[1] - 3.2 * dLat]] } });

// Buildings: rows of varied heights fronting every street, plus some towers.
const buildings = [];
let n = 0;
const rect = (lon0, lat0, wM, hM) => [[[lon0, lat0], [lon0 + wM / mPerLon, lat0], [lon0 + wM / mPerLon, lat0 + hM / mPerLat], [lon0, lat0 + hM / mPerLat], [lon0, lat0]]];
for (let r = -3; r < 3; r++) for (let c = -3; c < 3; c++) {
  const x0 = CENTER[0] + c * dLon, y0 = CENTER[1] + r * dLat;
  const residential = c < 0;   // western blocks: rows of houses; eastern: offices and towers
  if (residential) {
    for (let k = 0; k < 13; k++) {
      const lon = x0 + (10 + k * 14) / mPerLon;
      const h = () => 5 + ((++n * 13) % 5);
      buildings.push({ type: 'Feature', properties: { render_height: h(), render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: rect(lon, y0 + 9 / mPerLat, 10, 12) } });
      buildings.push({ type: 'Feature', properties: { render_height: h(), render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: rect(lon, y0 + dLat - 21 / mPerLat, 10, 12) } });
    }
    buildings.push({ type: 'Feature', properties: { render_height: 8, render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: rect(x0 + 30 / mPerLon, y0 + 60 / mPerLat, 60, 8) } });
  } else {
    for (let k = 0; k < 7; k++) {
      const lon = x0 + (14 + k * 25) / mPerLon;
      const h = () => (++n % 11 === 0 ? 110 + (n % 5) * 25 : 9 + ((n * 37) % 45));
      buildings.push({ type: 'Feature', properties: { render_height: h(), render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: rect(lon, y0 + 8 / mPerLat, 21, 16) } });
      buildings.push({ type: 'Feature', properties: { render_height: h(), render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: rect(lon, y0 + dLat - 24 / mPerLat, 21, 16) } });
    }
  }
}
const indexes = {
  transportation: new geojsonvt({ type: 'FeatureCollection', features: roads.map((f) => ({ ...f, properties: { class: f.properties.class } })) }, { maxZoom: 14, indexMaxZoom: 14 }),
  transportation_name: new geojsonvt({ type: 'FeatureCollection', features: roads }, { maxZoom: 14, indexMaxZoom: 14 }),
  building: new geojsonvt({ type: 'FeatureCollection', features: buildings }, { maxZoom: 14, indexMaxZoom: 14 }),
};
function tile(z, x, y) {
  const layers = {};
  for (const [name, idx] of Object.entries(indexes)) {
    const t = idx.getTile(z, x, y);
    if (t) layers[name] = t;
  }
  return Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2 }));
}
const style = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: { openmaptiles: { type: 'vector', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#f2f1ee' } },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', paint: { 'fill-color': '#e6e6e3' } },
    { id: 'road-case', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#d8d8d4', 'line-width': 14 } },
    { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#ffffff', 'line-width': 11 } },
  ],
};

// ------------------------------------------------------------------ server
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  server.on('exit', reject);
  setTimeout(resolve, 8000);
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
let ok = true;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/fonts|glyph|Failed to load resource/i.test(m.text()) && errors.push(m.text()));
  const REST = process.env.E2E_REST;
  if (REST) {
    await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript',
      body: `window.TYCOON_CONFIG = { supabaseUrl: 'https://fake-project.supabase.co', supabaseKey: 'sb_publishable_test' };` }));
    await page.route('https://fake-project.supabase.co/rest/v1/rpc/**', async (r) => {
      const fn = new URL(r.request().url()).pathname.split('/').pop();
      if (r.request().headers().apikey !== 'sb_publishable_test') return r.abort();
      r.fulfill({ response: await r.fetch({ url: `${REST}/rpc/${fn}` }) });
    });
  }
  await page.route('https://tiles.openfreemap.org/styles/**', (r) => r.fulfill({ json: style }));
  await page.route('https://tiles.openfreemap.org/fonts/**', (r) => r.fulfill({ status: 200, body: Buffer.alloc(0), contentType: 'application/x-protobuf' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await page.route('https://tiles.openfreemap.org/planet/**', (r) => {
    const [z, x, y] = new URL(r.request().url()).pathname.match(/(\d+)\/(\d+)\/(\d+)\.pbf$/).slice(1).map(Number);
    r.fulfill({ body: tile(z, x, y), contentType: 'application/x-protobuf' });
  });
  let overpassCalls = 0;
  await page.route('**/api/interpreter', (r) => { overpassCalls++; r.abort(); });
  await page.route('https://nominatim.openstreetmap.org/reverse**', (r) => r.fulfill({ json: { address: { suburb: 'Soho', city: 'London' } } }));
  await page.route('https://nominatim.openstreetmap.org/search**', (r) => r.fulfill({ json: [
    { display_name: 'Market Street, Soho, London', name: 'Market Street', lat: String(CENTER[1] + 0.5 * dLat), lon: String(CENTER[0] - dLon), osm_type: 'way', osm_id: 1, category: 'highway' },
  ] }));

  const shot = (n) => page.screenshot({ path: join(OUT, n) });
  const step = (s) => console.log('•', s);

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#auth-form');
  await page.waitForTimeout(1200);
  await shot('1-login.png');
  step('login screen');

  await page.click('[data-action=tab-register]');
  await page.fill('input[name=username]', 'mayfair_mogul');
  await page.fill('input[name=password]', 'secret123');
  await page.click('#auth-form button[type=submit]');
  await page.waitForSelector('.world-grid', { timeout: 60000 });
  await shot('2-worlds.png');
  step('registered, world picker');

  await page.click('.world >> nth=0');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#modal:not([hidden])');
  await page.click('[data-action=close-modal]');
  step('entered world');

  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: c, zoom: 16.6, pitch: 0, bearing: -20 }), CENTER);
  await page.waitForTimeout(1500);
  const clickAt = async (lonlat) => {
    let pt = await page.evaluate((ll) => { const p = window.tycoon.gm.map.project(ll); return [p.x, p.y]; }, lonlat);
    // Something (the live feed, a panel) covering that spot? Bring it to the middle of the map first.
    if (!(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', pt))) {
      await page.evaluate((ll) => window.tycoon.gm.map.jumpTo({ center: ll }), lonlat);
      await page.waitForTimeout(1200);
      pt = await page.evaluate((ll) => { const p = window.tycoon.gm.map.project(ll); return [p.x, p.y]; }, lonlat);
    }
    await page.mouse.click(pt[0], pt[1]);
  };
  async function buyAndBuild(lonlat, expect, plan) {
    await clickAt(lonlat);
    await page.waitForFunction((n) => document.querySelector('#panel h2')?.textContent === n, expect, { timeout: 20000 });
    await page.waitForSelector('[data-action=buy]', { timeout: 20000 });
    await page.click('[data-action=buy]');
    await page.waitForSelector('.owner.mine', { timeout: 15000 });
    for (const t of plan) {
      const btn = await page.$(`[data-action=build][data-type=${t}]:not([disabled])`);
      if (!btn) continue;
      await btn.click();
      await page.waitForTimeout(600);
    }
    return page.$$eval('.blist li', (l) => l.length);
  }

  // Player 1 buys "Duke Street" (row 3) and builds on it.
  const n1 = await buyAndBuild([CENTER[0] + 0.0012, CENTER[1] + dLat], 'Duke Street', ['shops', 'terrace', 'house', 'cottage']);
  if (n1 < 3) throw new Error('expected buildings, got ' + n1);
  await shot('3-street.png');
  step(`player 1 bought Duke Street, ${n1} buildings`);
  for (let i = 0; i < 12 && !REST; i++) { await page.click('[data-action=force-tick]'); await page.waitForTimeout(150); }
  await page.waitForTimeout(800);
  const tickText = await page.textContent('.stat.tick');
  step('12 ticks ran: ' + tickText.replace(/\s+/g, ' ').trim());
  await page.click('[data-action=pick-plot] >> nth=0');
  for (const t of ['apartments', 'house', 'cottage']) {
    const btn = await page.$(`[data-action=build][data-type=${t}]:not([disabled])`);
    if (btn) { await btn.click(); await page.waitForTimeout(600); }
  }
  await page.waitForTimeout(1200);
  await shot('4-built.png');
  const placed = await page.evaluate(() => [...window.tycoon.gm.buildings['live'].values()].filter((l) => l.spec.placed).length);
  step(`player buildings on open ground: ${placed}`);
  if (placed < 3) throw new Error('expected new buildings to be placed on open ground');

  // Buy a real house on Duke Street: look straight down on it and click its roof.
  const office = [CENTER[0] - dLon + 29 / mPerLon, CENTER[1] + dLat + 15 / mPerLat];
  await page.click('[data-action=close-panel]');
  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: c, zoom: 18, pitch: 0, bearing: 0 }), office);
  await page.waitForTimeout(2500);
  await clickAt(office);
  await page.waitForSelector('[data-action=buy-building]', { timeout: 20000 });
  await shot('4b-real-building.png');
  const quoted = await page.evaluate(() => window.tycoon.state.building?.quote);
  const off = Math.hypot((quoted.lon - office[0]) * mPerLon, (quoted.lat - office[1]) * mPerLat);
  step(`picked the building under the cursor (${off.toFixed(1)} m off, ${quoted.area_m2} m², ${quoted.floors} floors)`);
  if (off > 3 || Math.abs(quoted.area_m2 - 120) > 8) throw new Error('picked the wrong building');
  await page.click('[data-action=buy-building]');
  await page.waitForFunction(() => document.querySelector('#panel .owner.mine')?.textContent?.includes('You own this building'), null, { timeout: 15000 });
  await page.waitForFunction(() => window.tycoon.gm.cityStats().bought > 0, null, { timeout: 20000 }).catch(() => {});
  const bought = await page.evaluate(() => window.tycoon.gm.cityStats().bought);
  step(`bought a real building (${bought} shown as bought)`);
  if (bought < 1) throw new Error('bought building should be drawn in the owner colour');
  await page.click('[data-action=close-panel]');

  // The camera can come right down to street level.
  await page.click('.camera-ctrl button >> nth=0');
  await page.waitForTimeout(2000);
  const pitch = await page.evaluate(() => window.tycoon.gm.map.getPitch());
  step(`street-level camera pitch: ${pitch.toFixed(0)}°`);
  if (pitch < 75) throw new Error('camera should tilt down to street level');
  await shot('4c-street-level.png');

  // Player 2 (a rival in the same browser sandbox) buys the next street.
  if (await page.isVisible('#panel')) await page.click('[data-action=close-panel]');
  await page.click('[data-action=switch-world]');
  await page.click('[data-action=logout]');
  await page.click('[data-action=tab-register]');
  await page.fill('input[name=username]', 'rival');
  await page.fill('input[name=password]', 'secret123');
  await page.click('#auth-form button[type=submit]');
  await page.waitForSelector('.world-grid', { timeout: 60000 });
  await page.click('.world >> nth=0');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 30000 });
  if (await page.$('#modal:not([hidden])')) await page.click('[data-action=close-modal]');
  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: c, zoom: 16.6, pitch: 0, bearing: -20 }), CENTER);
  await page.waitForTimeout(1500);
  const n2 = await buyAndBuild([CENTER[0] - 0.0012, CENTER[1] + 2 * dLat], 'Elm Row', ['shops', 'terrace', 'house', 'cottage', 'cottage']);
  step(`player 2 bought Elm Row, ${n2} buildings`);
  const others = await page.evaluate(() => [...window.tycoon.gm.parcels.values()].filter((p) => p.owner_id && p.owner_id !== window.tycoon.state.me.player.id).length);
  if (others < 1) throw new Error('rival cannot see player 1 street');
  step('rival sees player 1 street in red');

  await page.click('[data-action=close-panel]');
  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: [c[0], c[1] + 1.5 * 0.0018], zoom: 17.3, pitch: 60, bearing: 160 }), CENTER);
  await page.waitForTimeout(2000);
  await shot('5-city-3d.png');
  const visible = await page.evaluate(() => window.tycoon.gm.buildings['live'].size);
  step(`3D buildings in scene: ${visible}`);
  if (visible < 5) throw new Error('expected 3D buildings in the scene');
  // Software rendering is slow: let every tile in view finish rebuilding first.
  await page.waitForFunction(() => window.tycoon.gm['cityPending'].size === 0 && !window.tycoon.gm['pumping'], null, { timeout: 30000 });
  const city = await page.evaluate(() => window.tycoon.gm.cityStats());
  step(`real buildings modelled: ${city.buildings} (${city.mine} yours, ${city.other} rival's, ${city.bought} bought, ${city.cleared} cleared) kinds=${JSON.stringify(city.kinds)}`);
  if (city.cleared) throw new Error('real buildings should never be cleared for new ones');
  if (city.buildings < 20 || city.mine < 1 || city.other < 1) throw new Error('expected coloured real 3D buildings');
  if (!city.kinds.house || !(city.kinds.tower || city.kinds.skyscraper)) throw new Error('expected houses and towers');
  // Close-up of the rooftops.
  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: [c[0] - 0.0035, c[1] + 0.0012], zoom: 18, pitch: 58, bearing: 30 }), CENTER);
  await page.waitForTimeout(2500);
  await shot('5b-rooftops.png');
  if (overpassCalls) throw new Error(`street lookup should not call Overpass (${overpassCalls} calls)`);

  await page.click('[data-action=open-ledger]');
  await page.waitForSelector('.ledger');
  await shot('6-ledger.png');
  const rows = await page.$$eval('.ledger tbody tr', (l) => l.length);
  step(`ledger rows: ${rows}`);
  await page.click('[data-action=close-modal]');

  await page.fill('#search input', 'Market Street');
  await page.press('#search input', 'Enter');
  await page.waitForSelector('[data-action=search-place]', { timeout: 10000 });
  await shot('7-search.png');
  step('search works');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.click('[data-action=search-place]');
  await page.waitForSelector('#panel h2', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot('8-mobile.png');
  step('mobile layout: ' + (await page.textContent('#panel h2')));
} catch (e) {
  ok = false;
  console.error('FAILED:', e);
  try {
    const pg = browser.contexts()[0].pages()[0];
    await pg.screenshot({ path: join(OUT, 'fail.png') });
    console.error('debug:', JSON.stringify(await pg.evaluate((c) => {
      const gm = window.tycoon.gm;
      const src = gm.tiles;
      const feats = src ? gm.map.querySourceFeatures(src, { sourceLayer: 'transportation_name' }) : [];
      const roadsDrawn = gm.map.querySourceFeatures(src, { sourceLayer: 'transportation' }).length;
      const bld = gm.map.querySourceFeatures(src, { sourceLayer: 'building' }).length;
      return { roadsDrawn, bld, src, zoom: gm.map.getZoom(), feats: feats.length, sample: feats.slice(0, 2).map((f) => f.properties),
        cand: gm.findStreetAt([c[0] + 0.0012, c[1] + 0.0018])?.name ?? null,
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
        panel: document.querySelector('#panel')?.textContent?.slice(0, 200) };
    }, CENTER)));
  } catch (err) { console.error('debug failed', err); }
} finally {
  if (errors.length) {
    console.error('Page errors:\n' + errors.join('\n'));
    ok = false;
  }
  await browser.close();
  server.kill();
}
console.log(ok ? 'E2E OK' : 'E2E FAILED');
process.exit(ok ? 0 : 1);
