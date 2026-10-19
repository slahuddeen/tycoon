// End-to-end smoke test in headless Chromium against the built site
// (`npm run build` first). External map services are replaced by a fake
// street grid so it runs offline:
//   node scripts/e2e-smoke.mjs [outDir]
// Set E2E_REST=http://localhost:3000 to play in online mode against a local
// PostgREST serving the game database (stands in for Supabase).
// Plays a full round in the offline sandbox: register, pick a world, click a
// street, buy it, build on it, run a tick, open the ledger. Saves screenshots.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'e2e-shots';
mkdirSync(OUT, { recursive: true });
const PORT = 4179;
const CENTER = [-0.13, 51.51];

// ------------------------------------------------------------ fake streets
const dLat = 0.0018, dLon = 0.0029;                       // ~200m blocks
const ways = [];
let nodeId = 1, wayId = 100;
const H = ['Alpha Street', 'Bridge Road', 'Crown Lane', 'Duke Street', 'Elm Row'];
const V = ['Kings Avenue', 'Market Street', 'Old Road', 'Park Lane', 'Queens Walk'];
function addStreet(name, highway, pts) {
  // Split every street into several OSM ways that share junction nodes.
  const nodes = pts.map(() => nodeId++);
  for (let i = 0; i < pts.length - 1; i += 2) {
    const slice = pts.slice(i, Math.min(i + 3, pts.length));
    ways.push({ type: 'way', id: wayId++, tags: { name, highway }, nodes: nodes.slice(i, i + slice.length),
      geometry: slice.map(([lon, lat]) => ({ lon, lat })) });
  }
}
for (let r = 0; r < H.length; r++) {
  const lat = CENTER[1] + (r - 2) * dLat;
  addStreet(H[r], r === 2 ? 'secondary' : 'residential', Array.from({ length: 7 }, (_, i) => [CENTER[0] + (i - 3) * dLon, lat]));
}
for (let c = 0; c < V.length; c++) {
  const lon = CENTER[0] + (c - 2) * dLon;
  addStreet(V[c], c === 0 ? 'primary' : 'tertiary', Array.from({ length: 7 }, (_, i) => [lon, CENTER[1] + (i - 3) * dLat]));
}

const rad = (d) => (d * Math.PI) / 180;
function segDist([px, py], [ax, ay], [bx, by]) {
  const k = Math.cos(rad(py));
  const x1 = (ax - px) * k, y1 = ay - py, x2 = (bx - px) * k, y2 = by - py;
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / l2)) : 0;
  return Math.hypot(x1 + t * dx, y1 + t * dy) * 111320;
}
const wayDist = (p, w) => Math.min(...w.geometry.slice(1).map((g, i) => segDist(p, [w.geometry[i].lon, w.geometry[i].lat], [g.lon, g.lat])));

function overpass(q) {
  const id = q.match(/way\((\d+)\)/);
  if (id) return ways.filter((w) => w.id === Number(id[1]));
  const name = q.match(/\["name"="([^"]+)"\]/);
  if (name) return ways.filter((w) => w.tags.name === name[1]);
  const m = q.match(/around:(\d+),([-\d.]+),([-\d.]+)/);
  const p = [Number(m[3]), Number(m[2])];
  return ways.filter((w) => wayDist(p, w) <= Number(m[1]));
}

// Building blocks between streets, so the fake basemap looks like a city.
const blocks = [];
for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
  const x0 = CENTER[0] + (c - 2) * dLon + 0.0004, y0 = CENTER[1] + (r - 2) * dLat + 0.0003;
  const x1 = x0 + dLon - 0.0008, y1 = y0 + dLat - 0.0006;
  blocks.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } });
}
const style = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    roads: { type: 'geojson', data: { type: 'FeatureCollection', features: ways.map((w) => ({ type: 'Feature', properties: { name: w.tags.name }, geometry: { type: 'LineString', coordinates: w.geometry.map((g) => [g.lon, g.lat]) } })) } },
    blocks: { type: 'geojson', data: { type: 'FeatureCollection', features: blocks } },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#f2f1ee' } },
    { id: 'blocks', type: 'fill', source: 'blocks', paint: { 'fill-color': '#e6e6e3', 'fill-outline-color': '#d6d6d2' } },
    { id: 'roads-case', type: 'line', source: 'roads', paint: { 'line-color': '#d8d8d4', 'line-width': 14 } },
    { id: 'roads', type: 'line', source: 'roads', paint: { 'line-color': '#ffffff', 'line-width': 11 } },
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
  await page.route('**/api/interpreter', async (r) => {
    const q = decodeURIComponent(r.request().postData().replace(/^data=/, ''));
    r.fulfill({ json: { elements: overpass(q) } });
  });
  await page.route('https://nominatim.openstreetmap.org/reverse**', (r) => r.fulfill({ json: { address: { suburb: 'Soho', city: 'London' } } }));
  await page.route('https://nominatim.openstreetmap.org/search**', (r) => r.fulfill({ json: [
    { display_name: 'Market Street, Soho, London', lat: String(CENTER[1]), lon: String(CENTER[0]), osm_type: 'way', osm_id: ways.find((w) => w.tags.name === 'Market Street').id, category: 'highway' },
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

  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: c, zoom: 16.6, pitch: 50, bearing: -20 }), CENTER);
  await page.waitForTimeout(1500);
  const clickAt = async (lonlat) => {
    const pt = await page.evaluate((ll) => { const p = window.tycoon.gm.map.project(ll); return [p.x, p.y]; }, lonlat);
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

  // Player 2 (a rival in the same browser sandbox) buys the next street.
  await page.click('[data-action=close-panel]');
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
  await page.evaluate((c) => window.tycoon.gm.map.jumpTo({ center: c, zoom: 16.6, pitch: 50, bearing: -20 }), CENTER);
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
