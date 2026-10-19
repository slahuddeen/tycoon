import './style.css';
import { Backend, makeBackend, saveServerOverride, serverConfig } from './backend';
import { BuildingType, errorText, Me, money, Parcel, reasonLabel, setCurrency, World, countdown } from './format';
import { GameMap, PARCEL_MIN_ZOOM } from './map';
import * as osm from './osm';
import * as ui from './ui';
import { $ } from './ui';

interface Session { token: string; account: { id: string; username: string } }

const backend: Backend = makeBackend();
const store = {
  get<T>(k: string): T | null {
    try { return JSON.parse(localStorage.getItem(`${k}:${backend.id}`) ?? 'null'); } catch { return null; }
  },
  set(k: string, v: unknown) {
    try {
      if (v == null) localStorage.removeItem(`${k}:${backend.id}`);
      else localStorage.setItem(`${k}:${backend.id}`, JSON.stringify(v));
    } catch { /* storage blocked */ }
  },
};

const state = {
  session: null as Session | null,
  worlds: [] as World[],
  world: null as World | null,
  me: null as Me | null,
  types: [] as BuildingType[],
  ruleset: null as any,
  panel: null as Parcel | null,
  pickedPlot: null as number | null,
  lookup: 0,
  searchGame: [] as any[],
  searchPlaces: [] as osm.PlaceResult[],
  lastTickSeen: 0,
  timers: [] as number[],
};

const gm = new GameMap($('#map'));

// ------------------------------------------------------------------ helpers

function toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

async function api<T = any>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
  const full = { ...p };
  if (state.session) full.token = state.session.token;
  if (state.world) full.world_id ??= state.world.id;
  try {
    return await backend.call<T>(fn, full);
  } catch (e: any) {
    if (e?.code === 'not_logged_in') {
      logout(false);
      toast(errorText(e), 'bad');
    }
    throw e;
  }
}

function showOverlay(html: string | null) {
  const o = $('#overlay');
  o.hidden = html == null;
  if (html != null) o.innerHTML = html;
}

function showModal(title: string | null, body = '') {
  const m = $('#modal');
  m.hidden = title == null;
  if (title != null) m.innerHTML = ui.modal(title, body);
}

// ----------------------------------------------------------- auth screens

let authTab: 'login' | 'register' = 'login';
function showLogin(error = '') {
  const host = (() => { try { return new URL(serverConfig().supabaseUrl).host; } catch { return ''; } })();
  showOverlay(ui.loginScreen(backend.mode, host, authTab, error));
  document.body.classList.add('pregame');
  spinGlobe();
  ($('#auth-form') as HTMLFormElement).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const btn = (ev.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = backend.mode === 'offline' ? 'Starting your sandbox…' : 'One moment…';
    try {
      const s = await backend.call<Session>(authTab === 'login' ? 'tycoon_login' : 'tycoon_register', {
        username: String(f.get('username')), password: String(f.get('password')),
      });
      state.session = s;
      store.set('tycoon-session', s);
      await showWorlds(true);
    } catch (e) {
      showLogin(errorText(e));
    }
  });
}

async function showWorlds(autoEnter: boolean): Promise<void> {
  state.worlds = await backend.call<World[]>('tycoon_worlds', {});
  const saved = store.get<string>('tycoon-world');
  const w = state.worlds.find((x) => x.id === saved);
  if (autoEnter && w) return enterWorld(w);
  showOverlay(ui.worldPicker(state.worlds, state.session!.account.username));
}

function logout(callServer = true) {
  if (callServer && state.session) backend.call('tycoon_logout', { token: state.session.token }).catch(() => {});
  state.session = null;
  state.world = null;
  state.me = null;
  store.set('tycoon-session', null);
  leaveWorld();
  showLogin();
}

let spinning = false;
function spinGlobe() {
  if (spinning) return;
  spinning = true;
  const step = () => {
    if (!document.body.classList.contains('pregame')) { spinning = false; return; }
    if (!gm.map.isMoving()) {
      const c = gm.map.getCenter();
      gm.map.jumpTo({ center: [c.lng + 0.04, c.lat] });
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------- game

async function enterWorld(w: World): Promise<void> {
  state.world = w;
  store.set('tycoon-world', w.id);
  showOverlay(`<div class="card login"><div class="loading"><div class="spinner"></div><p>Entering ${w.name}…</p></div></div>`);
  try {
    const [me, types, ruleset] = await Promise.all([
      api<Me>('tycoon_join'),
      api<BuildingType[]>('tycoon_building_types'),
      api<any>('tycoon_ruleset'),
    ]);
    state.types = types;
    state.ruleset = ruleset;
    setMe(me);
  } catch (e) {
    toast(errorText(e), 'bad');
    state.world = null;
    store.set('tycoon-world', null);
    return showWorlds(false);
  }
  document.body.classList.remove('pregame');
  showOverlay(null);
  gm.myPlayerId = state.me!.player.id;
  $('#hud').hidden = false;
  $('#search').hidden = false;
  $('#feed').hidden = false;
  await gm.ready;
  refreshView();
  refreshOwned();
  refreshFeed();
  state.timers.push(
    window.setInterval(() => refreshMe(), 15000),
    window.setInterval(() => refreshView(), 20000),
    window.setInterval(() => refreshOwned(), 60000),
    window.setInterval(() => refreshFeed(), 20000),
    window.setInterval(tickClock, 1000),
  );
  if (state.me!.parcel_count === 0 && !store.get('tycoon-helped')) {
    store.set('tycoon-helped', true);
    showModal('How to play', ui.HELP);
  }
  // Start somewhere useful: your best street, or central London.
  if (gm.zoom() < 6) {
    const mine = state.me!.parcel_count ? await api<any[]>('tycoon_my_parcels').catch(() => []) : [];
    if (mine.length) gm.map.flyTo({ center: [mine[0].c_lon, mine[0].c_lat], zoom: 16, pitch: 55, duration: 3000 });
    else gm.map.flyTo({ center: [-0.1281, 51.508], zoom: 14.5, pitch: 45, duration: 3000 });
  }
}

function leaveWorld() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  $('#hud').hidden = true;
  $('#search').hidden = true;
  $('#feed').hidden = true;
  closePanel();
  showModal(null);
  gm.setParcels([]);
  gm.setOwnedPoints([]);
}

function setMe(me: Me) {
  const prevTick = state.lastTickSeen;
  state.me = me;
  setCurrency(me.currency);
  $('#hud').innerHTML = ui.hud(me, backend.mode === 'offline');
  const t = me.last_tick;
  if (t && prevTick && t.tick_number > prevTick && (t.income.length || t.taxes.length)) {
    const inc = t.income.reduce((s, x) => s + x.amount, 0);
    const tax = t.taxes.reduce((s, x) => s + x.amount, 0);
    toast(`Tick #${t.tick_number}: ${money(inc, { sign: true })} income, ${money(-tax)} tax`, inc >= tax ? 'good' : 'bad', 6000);
  }
  if (t) state.lastTickSeen = t.tick_number;
  else state.lastTickSeen = state.lastTickSeen || -1;
}

async function refreshMe() {
  if (!state.world) return;
  try {
    const before = state.me?.world.tick_count;
    setMe(await api<Me>('tycoon_me'));
    if (before != null && state.me!.world.tick_count !== before) {
      refreshView();
      if (state.panel) openParcel(state.panel.id, false);
    }
  } catch { /* transient */ }
}

let lastAutoRefresh = 0;
function tickClock() {
  const el = document.getElementById('countdown');
  if (!el || !state.me) return;
  el.textContent = countdown(state.me.world.next_tick_at);
  if (new Date(state.me.world.next_tick_at).getTime() < Date.now() - 2000 && Date.now() - lastAutoRefresh > 10000) {
    lastAutoRefresh = Date.now();
    refreshMe();
  }
}

let viewSeq = 0;
async function refreshView() {
  if (!state.world || gm.zoom() < PARCEL_MIN_ZOOM) {
    if (state.world) gm.setParcels(state.panel ? [state.panel] : []);
    return;
  }
  const seq = ++viewSeq;
  try {
    const list = await api<Parcel[]>('tycoon_parcels_bbox', { ...gm.viewBounds(), limit: 800 });
    if (seq === viewSeq) gm.setParcels(list);
  } catch { /* transient */ }
}

async function refreshOwned() {
  if (!state.world) return;
  try { gm.setOwnedPoints(await api('tycoon_owned_points')); } catch { /* transient */ }
}

async function refreshFeed() {
  if (!state.world) return;
  try { $('#feed-list').innerHTML = ui.feed(await api('tycoon_events', { limit: 12 })); } catch { /* transient */ }
}

let viewTimer = 0;
gm.onViewChange = () => {
  clearTimeout(viewTimer);
  viewTimer = window.setTimeout(refreshView, 250);
};

// ----------------------------------------------------------------- panel

function openPanelHtml(html: string) {
  const p = $('#panel');
  p.hidden = false;
  p.innerHTML = html;
  document.body.classList.add('panel-open');
}

function closePanel() {
  state.panel = null;
  state.lookup++;
  $('#panel').hidden = true;
  document.body.classList.remove('panel-open');
  gm.select(null);
  gm.setPending(null);
}

async function openParcel(id: number, fly = false) {
  if (!state.panel || state.panel.id !== id) openPanelHtml(ui.panelLoading('Loading street…'));
  try {
    const p = await api<Parcel>('tycoon_parcel', { parcel_id: id });
    showParcel(p);
    if (fly) gm.flyToParcel(p);
  } catch (e) {
    toast(errorText(e), 'bad');
    closePanel();
  }
}

function showParcel(p: Parcel) {
  if (state.panel?.id !== p.id || p.improvements.some((i) => i.slot_index <= (state.pickedPlot ?? -1) && (state.pickedPlot ?? -1) < i.slot_index + i.slots_used)) {
    state.pickedPlot = null;
  }
  state.panel = p;
  gm.select(p);
  gm.upsertParcel(p);
  const scroll = $('#panel').scrollTop;
  openPanelHtml(ui.parcelPanel(p, state.me!, state.types, state.ruleset, state.pickedPlot));
  $('#panel').scrollTop = scroll;
}

async function claimCandidate(cand: osm.StreetCandidate, seq: number) {
  gm.setPending(cand.ways.map((w) => w.coords));
  openPanelHtml(ui.panelLoading(`Found ${cand.name}. Checking the land registry…`));
  const all = cand.ways.flatMap((w) => w.coords);
  const mid = all[Math.floor(all.length / 2)];
  const suburb = await osm.reverseLocality(mid);
  if (seq !== state.lookup) return;
  const p = await api<Parcel>('tycoon_claim', { name: cand.name, suburb, anchor_way: cand.anchorWay, ways: cand.ways });
  if (seq !== state.lookup) return;
  gm.setPending(null);
  showParcel(p);
}

gm.onParcelClick = (id) => { state.lookup++; gm.setPending(null); openParcel(id); };

gm.onEmptyClick = async (at, zoom) => {
  if (!state.world) return;
  if (zoom < 14) {
    toast('Zoom in closer to pick a street.');
    gm.map.easeTo({ center: at, zoom: Math.min(zoom + 3, 16), duration: 900 });
    return;
  }
  const seq = ++state.lookup;
  openPanelHtml(ui.panelLoading('Looking up this street in OpenStreetMap…'));
  try {
    const cand = await osm.findStreetAt(at);
    if (seq !== state.lookup) return;
    if (!cand) {
      closePanel();
      toast('No buyable street right there. Click directly on a named road.');
      return;
    }
    await claimCandidate(cand, seq);
  } catch (e) {
    if (seq !== state.lookup) return;
    closePanel();
    toast(errorText(e), 'bad', 6000);
  }
};

// ---------------------------------------------------------------- actions

async function act(fn: string, p: Record<string, unknown>, ok: (r: any) => string) {
  try {
    const r = await api<any>(fn, p);
    if (r?.parcel) showParcel(r.parcel);
    toast(ok(r), 'good');
    refreshMe();
    refreshFeed();
    if (fn !== 'tycoon_build' && fn !== 'tycoon_demolish') refreshOwned();
  } catch (e) {
    toast(errorText(e), 'bad');
  }
}

const actions: Record<string, (el: HTMLElement, ev: Event) => void> = {
  'tab-login': () => { authTab = 'login'; showLogin(); },
  'tab-register': () => { authTab = 'register'; showLogin(); },
  'server-settings': () => {
    const c = serverConfig();
    showOverlay(ui.serverSettings(c.supabaseUrl, c.supabaseKey));
    ($('#server-form') as HTMLFormElement).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target as HTMLFormElement);
      saveServerOverride({ supabaseUrl: String(f.get('url')).trim(), supabaseKey: String(f.get('key')).trim() });
      location.reload();
    });
  },
  'server-offline': () => { saveServerOverride({ supabaseUrl: '', supabaseKey: '' }); location.reload(); },
  'server-reset': () => { saveServerOverride(null); location.reload(); },
  'back-login': () => showLogin(),
  logout: () => logout(),
  'pick-world': (el) => {
    const w = state.worlds.find((x) => x.id === el.dataset.id);
    if (w) enterWorld(w);
  },
  'switch-world': async () => {
    leaveWorld();
    state.world = null;
    store.set('tycoon-world', null);
    document.body.classList.add('pregame');
    await showWorlds(false);
  },
  'close-panel': () => closePanel(),
  'close-modal': () => showModal(null),
  buy: (el) => act('tycoon_buy', { parcel_id: Number(el.dataset.id) }, () => `You bought ${state.panel?.name}! 🎉`),
  build: (el) => {
    const t = state.types.find((x) => x.id === el.dataset.type);
    act('tycoon_build', { parcel_id: Number(el.dataset.id), type_id: el.dataset.type, slot: state.pickedPlot },
      () => `${t?.name ?? 'Building'} under construction 🏗️`);
  },
  'pick-plot': (el) => {
    state.pickedPlot = el.dataset.slot === '' ? null : Number(el.dataset.slot);
    if (state.panel) showParcel(state.panel);
  },
  demolish: (el) => {
    if (!confirm('Demolish this building? You get nothing back.')) return;
    act('tycoon_demolish', { improvement_id: Number(el.dataset.imp) }, () => 'Demolished.');
  },
  release: (el) => {
    if (!confirm(`Give ${state.panel?.name} back to the bank? You won't be paid for it, and any buildings go with it.`)) return;
    act('tycoon_release', { parcel_id: Number(el.dataset.id) }, () => 'Street returned to the bank.');
  },
  'force-tick': async () => {
    if (!backend.forceTick || !state.world) return;
    await backend.forceTick(state.world.id);
    await refreshMe();
    refreshView();
    if (state.panel) openParcel(state.panel.id);
  },
  'goto-parcel': (el) => { showModal(null); openParcel(Number(el.dataset.id), true); },
  'open-mine': async () => { showModal('My streets', ui.myStreets(await api('tycoon_my_parcels'))); },
  'open-leaderboard': async () => { showModal('Leaderboard', ui.leaderboard(await api('tycoon_leaderboard'), state.me!.player.id)); },
  'open-ledger': async () => { showModal('Ledger', ui.ledger(await api('tycoon_ledger', { limit: 200 }))); },
  'open-help': () => showModal('How to play', ui.HELP),
  'open-rules': () => {
    showModal('Rules of this world', ui.rules(state.ruleset, state.me!, state.types));
    document.getElementById('repay-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const major = Number(new FormData(ev.target as HTMLFormElement).get('amount'));
      const minor = Math.round(major * (state.me!.currency.minor_units ?? 100));
      try {
        await api('tycoon_repay', { amount: minor });
        toast(`Repaid ${money(minor)} of your loan.`, 'good');
        await refreshMe();
        actions['open-rules'](ev.target as HTMLElement, ev);
      } catch (e) {
        toast(errorText(e), 'bad');
      }
    });
  },
  'search-game': (el) => {
    const g = state.searchGame[Number(el.dataset.i)];
    hideSearch();
    openParcel(g.id, true);
  },
  'search-place': async (el) => {
    const pl = state.searchPlaces[Number(el.dataset.i)];
    hideSearch();
    if (pl.isStreet && pl.wayId) {
      gm.flyTo([pl.lon, pl.lat], 16.5);
      const seq = ++state.lookup;
      openPanelHtml(ui.panelLoading('Looking up this street in OpenStreetMap…'));
      try {
        const cand = await osm.findStreetByWay(pl.wayId);
        if (seq !== state.lookup) return;
        if (!cand) { closePanel(); toast("That road can't be bought (it's unnamed, or a motorway, service road or path)."); return; }
        await claimCandidate(cand, seq);
      } catch (e) {
        if (seq === state.lookup) { closePanel(); toast(errorText(e), 'bad'); }
      }
    } else {
      gm.flyTo([pl.lon, pl.lat], 15, pl.bbox);
    }
  },
};

document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!el) {
    if (!(ev.target as HTMLElement).closest('#search')) hideSearch();
    if ((ev.target as HTMLElement).id === 'modal') showModal(null);
    return;
  }
  const fn = actions[el.dataset.action!];
  if (fn) {
    ev.preventDefault();
    fn(el, ev);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!$('#modal').hidden) showModal(null);
    else if (state.panel || !$('#panel').hidden) closePanel();
    hideSearch();
  }
});

// ----------------------------------------------------------------- search

const searchInput = $('#search input') as HTMLInputElement;
const searchBox = $('#search-results');
let searchSeq = 0;
let searchTimer = 0;
function hideSearch() { searchBox.hidden = true; }

async function runSearch(q: string) {
  const seq = ++searchSeq;
  if (q.trim().length < 2) return hideSearch();
  state.searchPlaces = [];
  try { state.searchGame = await api<any[]>('tycoon_search', { q }); } catch { state.searchGame = []; }
  if (seq !== searchSeq) return;
  searchBox.hidden = false;
  searchBox.innerHTML = ui.searchResults(state.searchGame, [], true);
  try { state.searchPlaces = await osm.searchPlaces(q); } catch { state.searchPlaces = []; }
  if (seq !== searchSeq) return;
  searchBox.innerHTML = ui.searchResults(state.searchGame, state.searchPlaces, false);
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => runSearch(searchInput.value), 700);   // Nominatim: max 1 req/s
});
($('#search form') as HTMLFormElement).addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearTimeout(searchTimer);
  runSearch(searchInput.value);
});
searchInput.addEventListener('focus', () => { if (searchBox.innerHTML.trim()) searchBox.hidden = false; });

// ------------------------------------------------------------------- boot

(async function boot() {
  const saved = store.get<Session>('tycoon-session');
  if (saved) {
    try {
      state.session = await backend.call<Session>('tycoon_session', { token: saved.token });
      return await showWorlds(true);
    } catch {
      store.set('tycoon-session', null);
      state.session = null;
    }
  }
  showLogin();
})();

// Debug/test hook.
(window as any).tycoon = { state, gm, backend, reasonLabel };
