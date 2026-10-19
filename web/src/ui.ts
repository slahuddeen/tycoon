// HTML renderers. Pure functions from game data to markup; main.ts wires
// up behaviour through data-action attributes.
import {
  ago, BUILDING_ICON, BuildingType, CLASS_LABEL, countdown, esc, Me, metres, money, Parcel, pct,
  reasonLabel, World,
} from './format';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const LOGO = `<svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true">
  <rect x="6" y="30" width="12" height="28" rx="2" fill="#10b981"/>
  <rect x="22" y="14" width="14" height="44" rx="2" fill="#f59e0b"/>
  <rect x="40" y="24" width="12" height="34" rx="2" fill="#ef4444"/>
  <rect x="26" y="6" width="6" height="8" rx="1" fill="#f59e0b"/>
  <rect x="2" y="56" width="60" height="4" rx="2" fill="#0f172a"/></svg>`;

export function loginScreen(mode: 'online' | 'offline', host: string, tab: 'login' | 'register', error = '') {
  return `
  <div class="card login">
    <div class="brand">${LOGO}<div><h1>Tycoon</h1><p>Buy the real streets of the world. Build an empire.</p></div></div>
    <div class="mode ${mode}">
      ${mode === 'online'
        ? `<b>● Online</b> Playing with everyone on <code>${esc(host)}</code>`
        : `<b>● Offline sandbox</b> No server is set up, so progress is saved in this browser only.`}
      <button class="link" data-action="server-settings">Server settings</button>
    </div>
    <div class="tabs">
      <button class="${tab === 'login' ? 'on' : ''}" data-action="tab-login">Log in</button>
      <button class="${tab === 'register' ? 'on' : ''}" data-action="tab-register">Create account</button>
    </div>
    <form id="auth-form" autocomplete="on">
      <label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="20"
        pattern="[A-Za-z0-9_.\\-]{3,20}" placeholder="e.g. mayfair_mogul"></label>
      <label>Password<input name="password" type="password" required minlength="4"
        autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}"></label>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <button class="primary big" type="submit">${tab === 'login' ? 'Log in' : 'Create account & play'}</button>
    </form>
    <p class="fine">Just for fun: no email needed. Your IP address is recorded when you sign up or log in.
    Map data © OpenStreetMap contributors.</p>
  </div>`;
}

export function serverSettings(url: string, key: string) {
  return `
  <div class="card login">
    <h2>Game server</h2>
    <p>Multiplayer uses a free <a href="https://supabase.com" target="_blank" rel="noopener">Supabase</a> project.
    The site owner normally sets this in <code>config.js</code>, so players don't need to touch it.
    Anything here overrides that, for this browser only.</p>
    <form id="server-form">
      <label>Supabase project URL<input name="url" value="${esc(url)}" placeholder="https://abcd1234.supabase.co"></label>
      <label>Publishable (anon) key<input name="key" value="${esc(key)}" placeholder="sb_publishable_… or eyJ…"></label>
      <div class="row">
        <button class="primary" type="submit">Save & reload</button>
        <button type="button" data-action="server-offline">Use offline sandbox</button>
        <button type="button" data-action="server-reset">Use site default</button>
      </div>
    </form>
    <button class="link" data-action="back-login">← Back</button>
  </div>`;
}

export function worldPicker(worlds: World[], username: string) {
  return `
  <div class="card worlds">
    <div class="brand small">${LOGO}<div><h1>Pick a world</h1><p>Logged in as <b>${esc(username)}</b>
      · <button class="link" data-action="logout">Log out</button></p></div></div>
    <p>Each world runs the same map under a different economic rulebook. Your account can play in all of them.</p>
    <div class="world-grid">
      ${worlds.map((w) => `
        <button class="world" data-action="pick-world" data-id="${w.id}">
          <span class="world-name">${esc(w.name)}</span>
          <span class="tag">${esc(w.ruleset_name)}</span>
          <span class="desc">${esc(w.ruleset_description)}</span>
          <span class="stats">${w.player_count} players · ${w.owned_count} streets owned · ticks every ${esc(w.tick_interval)}</span>
          <span class="go">Play →</span>
        </button>`).join('')}
    </div>
  </div>`;
}

export function hud(me: Me, offline: boolean) {
  const inc = me.last_tick?.income.reduce((s, x) => s + x.amount, 0) ?? 0;
  const tax = me.last_tick?.taxes.reduce((s, x) => s + x.amount, 0) ?? 0;
  const tip = me.last_tick
    ? [...me.last_tick.income.map((x) => `${reasonLabel(x.reason)}: ${money(x.amount, { sign: true })}`),
       ...me.last_tick.taxes.map((x) => `${reasonLabel(x.reason)}: ${money(-x.amount)}${x.base_expr ? ` (on ${x.base_expr})` : ''}`)].join('\n')
    : 'No tick yet';
  return `
    <div class="hud-brand">${LOGO}<span>Tycoon</span>
      <button class="world-chip" data-action="switch-world" title="Switch world">${esc(me.world.name)} ▾</button></div>
    <div class="hud-stats">
      <div class="stat"><small>Cash</small><b class="${me.balance < 0 ? 'neg' : ''}">${money(me.balance, { compact: true })}</b></div>
      <div class="stat"><small>Loan</small><b>${money(me.loan_outstanding, { compact: true })}</b></div>
      <div class="stat"><small>Net worth</small><b>${money(me.net_worth, { compact: true })}</b></div>
      <div class="stat"><small>Streets</small><b>${me.parcel_count}</b></div>
      <div class="stat tick" title="${esc(tip)}"><small>Last tick ${me.last_tick ? '#' + me.last_tick.tick_number : ''}</small>
        <b><span class="pos">${money(inc, { compact: true, sign: true })}</span> <span class="neg">${money(-tax, { compact: true })}</span></b></div>
      <div class="stat"><small>Next tick</small><b id="countdown">${countdown(me.world.next_tick_at)}</b></div>
      ${offline ? `<button class="tick-now" data-action="force-tick" title="Offline sandbox only">⏩ Tick now</button>` : ''}
    </div>
    <nav class="hud-nav">
      <button data-action="open-mine" title="My streets">🏘️<span>Mine</span></button>
      <button data-action="open-leaderboard" title="Leaderboard">🏆<span>Top</span></button>
      <button data-action="open-ledger" title="Ledger">📒<span>Ledger</span></button>
      <button data-action="open-rules" title="Rules & loan">📜<span>Rules</span></button>
      <button data-action="open-help" title="How to play">❔<span>Help</span></button>
    </nav>`;
}

export function panelLoading(text: string) {
  return `<button class="close" data-action="close-panel" aria-label="Close">×</button>
    <div class="loading"><div class="spinner"></div><p>${esc(text)}</p></div>`;
}

function plotStrip(p: Parcel, mine: boolean, picked: number | null) {
  const cells: string[] = [];
  const occ = new Map<number, { type: string; len: number }>();
  for (const i of p.improvements) occ.set(i.slot_index, { type: i.type_id, len: i.slots_used });
  for (let s = 0; s < p.slots_total;) {
    const o = occ.get(s);
    if (o) {
      cells.push(`<span class="plot used" style="flex:${o.len}" title="${esc(o.type)}">${BUILDING_ICON[o.type] ?? '🏗️'}</span>`);
      s += o.len;
    } else {
      cells.push(mine
        ? `<button class="plot free ${picked === s ? 'picked' : ''}" style="flex:1" data-action="pick-plot" data-slot="${s}" title="Plot ${s + 1}: click to build here"></button>`
        : `<span class="plot" style="flex:1"></span>`);
      s += 1;
    }
  }
  return `<div class="plots">${cells.join('')}</div>
    ${mine ? `<p class="plot-hint">${picked != null ? `Building on plot ${picked + 1}. <button class="link" data-action="pick-plot" data-slot="">Let the game choose</button>` : 'Tip: click an empty plot to choose where your next building goes.'}</p>` : ''}`;
}

export function parcelPanel(p: Parcel, me: Me, types: BuildingType[], ruleset: any, picked: number | null = null) {
  const mine = p.owner_id === me.player.id;
  const owned = p.owner_id != null;
  const cfg = ruleset?.config ?? {};
  const free = p.slots_total - p.slots_used;
  const impBp = Number(cfg.income?.from_improvements_bp ?? 0);
  const pt = p.per_tick;
  const interval = me.world.tick_interval;
  const ownerLine = !owned
    ? `<div class="owner none">For sale by the bank</div>`
    : `<div class="owner ${mine ? 'mine' : 'other'}"><span class="dot"></span>${mine ? 'You own this street' : `Owned by <b>${esc(p.owner_handle)}</b>`}
       ${p.acquired_at ? `<small>since ${ago(p.acquired_at)}</small>` : ''}
       ${p.lease_expires_at ? `<small>lease ends ${new Date(p.lease_expires_at).toLocaleString()}</small>` : ''}</div>`;

  const perTick = pt ? `
    <section>
      <h3>Per tick <small>(every ${esc(interval)})${owned ? '' : ' if you owned it'}</small></h3>
      <div class="lines">
        <div><span>Land income <small>${pct(Number(cfg.income?.from_land_bp ?? 0))} of land value</small></span><b class="pos">${money(pt.income_land, { sign: true })}</b></div>
        <div><span>Building income</span><b class="pos">${money(pt.income_improvements, { sign: true })}</b></div>
        ${pt.taxes.map((t) => `<div><span>${esc(reasonLabel('tax:' + t.id))} <small>${pct(t.rate_bp)} of ${esc(t.base_expr)}</small></span><b class="neg">${money(-t.amount)}</b></div>`).join('')}
        <div class="total"><span>Net per tick</span><b class="${pt.net >= 0 ? 'pos' : 'neg'}">${money(pt.net, { sign: true })}</b></div>
      </div>
    </section>` : '';

  const buy = !owned && p.purchase ? `
    <section class="buy">
      <div class="lines">
        <div><span>Price</span><b>${money(p.purchase.price)}</b></div>
        ${p.purchase.taxes.map((t) => `<div><span>${esc(reasonLabel('tax:' + t.id))} <small>${pct(t.rate_bp)}</small></span><b>${money(t.amount)}</b></div>`).join('')}
      </div>
      <button class="primary big" data-action="buy" data-id="${p.id}" ${me.balance < p.purchase.total ? 'data-short="1"' : ''}>
        Buy for ${money(p.purchase.total)}</button>
      ${me.balance < p.purchase.total ? `<p class="hint">You have ${money(me.balance)}: not enough yet.</p>` : ''}
    </section>` : '';

  const build = mine ? `
    <section>
      <h3>Build <small>${free} of ${p.slots_total} plots free</small></h3>
      <div class="build-grid">
        ${types.map((t) => {
          const fits = t.slots_used <= free;
          const afford = me.balance >= t.cost;
          const est = Math.floor((Math.floor((t.cost * t.yield_bp) / 10000) * impBp) / 10000);
          return `<button class="bcard ${fits ? '' : 'nofit'} ${afford ? '' : 'poor'}" data-action="build" data-type="${t.id}" data-id="${p.id}"
                    ${fits ? '' : 'disabled'} title="${esc(t.description)}">
            <span class="bicon">${BUILDING_ICON[t.id] ?? '🏗️'}</span>
            <span class="bname">${esc(t.name)}</span>
            <span class="bcost">${money(t.cost, { compact: true })}</span>
            <span class="bmeta">${t.slots_used} plot${t.slots_used > 1 ? 's' : ''} · ${money(est, { compact: true, sign: true })}/tick</span>
          </button>`;
        }).join('')}
      </div>
    </section>` : '';

  const buildings = p.improvements.length ? `
    <section>
      <h3>Buildings <small>${p.improvements.length}</small></h3>
      <ul class="blist">
        ${p.improvements.map((i) => `<li><span>${BUILDING_ICON[i.type_id] ?? '🏗️'} ${esc(types.find((t) => t.id === i.type_id)?.name ?? i.type_id)}
          <small>plot ${i.slot_index + 1}${i.slots_used > 1 ? `–${i.slot_index + i.slots_used}` : ''}</small></span>
          <span>${money(i.cost, { compact: true })}${mine ? ` <button class="mini danger" data-action="demolish" data-imp="${i.id}" title="Demolish (no refund)">✕</button>` : ''}</span></li>`).join('')}
      </ul>
    </section>` : '';

  return `
    <button class="close" data-action="close-panel" aria-label="Close">×</button>
    <header>
      <h2>${esc(p.name)}</h2>
      ${p.suburb ? `<p class="sub">${esc(p.suburb)}</p>` : ''}
      <div class="chips"><span>${esc(CLASS_LABEL[p.highway_class] ?? p.highway_class)}</span><span>${metres(p.length_m)}</span><span>${p.slots_total} plots</span></div>
    </header>
    ${ownerLine}
    <section>
      <div class="values">
        <div><small>Land value</small><b>${money(p.land_value)}</b></div>
        <div><small>Buildings</small><b>${money(p.improvement_value)}</b></div>
      </div>
      ${plotStrip(p, mine, picked)}
    </section>
    ${buy}
    ${build}
    ${buildings}
    ${perTick}
    ${mine ? `<section class="danger-zone"><button class="link danger" data-action="release" data-id="${p.id}">Give this street back to the bank (no refund)</button></section>` : ''}
  `;
}

export function modal(title: string, body: string) {
  return `<div class="modal-card"><header><h2>${esc(title)}</h2><button class="close" data-action="close-modal" aria-label="Close">×</button></header>
    <div class="modal-body">${body}</div></div>`;
}

export function leaderboard(rows: any[], meId: string) {
  if (!rows.length) return '<p>No players yet.</p>';
  return `<table class="table"><thead><tr><th>#</th><th>Player</th><th>Net worth</th><th>Streets</th><th>Buildings</th><th>Cash</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="${r.player_id === meId ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.handle)}</td>
      <td><b>${money(r.net_worth)}</b></td><td>${r.parcel_count}</td><td>${money(r.improvement_value, { compact: true })}</td>
      <td>${money(r.balance, { compact: true })}</td></tr>`).join('')}
  </tbody></table>
  <p class="fine">Net worth = cash + land value + building value − outstanding loan.</p>`;
}

export function ledger(rows: any[]) {
  if (!rows.length) return '<p>No transactions yet.</p>';
  return `<p class="fine">Every penny you have ever received or paid. Balances are always calculated from this list.</p>
  <table class="table ledger"><thead><tr><th>When</th><th>What</th><th>Street</th><th class="r">Amount</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${ago(r.created_at)}${r.tick_number ? `<br><small>tick #${r.tick_number}</small>` : ''}</td>
      <td>${esc(reasonLabel(r.reason))}<br><small>${r.amount > 0 ? 'from' : 'to'} ${esc(r.counterparty.startsWith('player:') ? 'player' : r.counterparty)}</small></td>
      <td>${r.parcel_name ? `<button class="link" data-action="goto-parcel" data-id="${r.parcel_id}">${esc(r.parcel_name)}</button>` : '—'}</td>
      <td class="r ${r.amount >= 0 ? 'pos' : 'neg'}">${money(r.amount, { sign: true })}</td></tr>`).join('')}
  </tbody></table>`;
}

export function myStreets(rows: any[]) {
  if (!rows.length) return `<p>You don't own any streets yet. Search for a place or zoom in and click a street to buy one.</p>`;
  return `<ul class="streets">${rows.map((r) => `<li><button data-action="goto-parcel" data-id="${r.id}">
    <b>${esc(r.name)}</b><small>${esc(r.suburb ?? '')}</small>
    <span>${money(r.land_value + r.improvement_value, { compact: true })} · ${r.slots_used}/${r.slots_total} plots</span></button></li>`).join('')}</ul>`;
}

export function rules(rs: any, me: Me, types: BuildingType[]) {
  const c = rs.config;
  return `
    <p><b>${esc(rs.name)}</b>: ${esc(rs.description)}</p>
    <div class="rules-grid">
      <div><small>Tick</small><b>every ${esc(c.tick.interval)}</b></div>
      <div><small>Starting loan</small><b>${money(c.starting_loan)}</b></div>
      <div><small>Land income</small><b>${pct(c.income.from_land_bp)} of land value / tick</b></div>
      <div><small>Building income</small><b>${pct(c.income.from_improvements_bp)} of cost / tick</b></div>
      ${c.taxes.map((t: any) => `<div><small>${esc(reasonLabel('tax:' + t.id))}${t.on === 'purchase' ? ' (on purchase)' : ' / tick'}</small><b>${pct(t.rate_bp)} of ${esc(t.base)}</b></div>`).join('')}
      <div><small>Vacant land penalty</small><b>${c.vacancy_penalty_bp ? pct(c.vacancy_penalty_bp) + ' of land value / tick' : 'none'}</b></div>
      <div><small>Land value</small><b><code>${esc(c.valuation.land_base)}</code></b></div>
      <div><small>Reassessed</small><b>every ${c.valuation.reassess_every_ticks} ticks</b></div>
    </div>
    <h3>Road class weights</h3>
    <p class="fine">${Object.entries(c.valuation.class_weights).map(([k, v]) => `${esc(CLASS_LABEL[k] ?? k)} ×${v}`).join(' · ')}</p>
    <p class="fine">Density weight grows by ${c.valuation.density.per_neighbour} for every other street within ${c.valuation.density.radius_m} m that someone has looked at (max ×${c.valuation.density.max}), so busy neighbourhoods become more valuable over time.</p>
    <h3>Buildings</h3>
    <table class="table"><thead><tr><th></th><th>Type</th><th>Cost</th><th>Plots</th><th>Yield</th></tr></thead><tbody>
      ${types.map((t) => `<tr><td>${BUILDING_ICON[t.id] ?? ''}</td><td>${esc(t.name)}</td><td>${money(t.cost)}</td><td>${t.slots_used}</td>
        <td>${pct(Math.round((c.income.from_improvements_bp * t.yield_bp) / 10000))}</td></tr>`).join('')}
    </tbody></table>
    <h3>Your loan</h3>
    <p>You owe <b>${money(me.loan_outstanding)}</b>. It counts against your net worth until repaid. There's no interest.</p>
    ${me.loan_outstanding > 0 ? `<form id="repay-form" class="row">
      <input name="amount" type="number" min="1" step="1" placeholder="Amount in ${esc(me.currency.symbol ?? '')}" required>
      <button class="primary" type="submit">Repay</button></form>` : ''}`;
}

export const HELP = `
  <ol class="help">
    <li><b>Find a street.</b> Search for any place on Earth, or zoom in on the map and click a named road.</li>
    <li><b>Buy it.</b> Price depends on length, road type and how busy the neighbourhood is.</li>
    <li><b>Build.</b> Each street has plots along its length. Put houses, shops and towers on them; they appear in 3D.</li>
    <li><b>Collect.</b> Every tick you earn income from your land and buildings and pay tax, all shown separately in the bar at the top and in your ledger.</li>
    <li><b>Climb the leaderboard</b> by net worth. You started with a loan, so you begin at zero.</li>
  </ol>
  <p class="fine">Each world has its own economic rules: try the same strategy in <i>Classic</i> and <i>Land Tax</i> and compare.
  Streets are real OpenStreetMap roads. Motorways, service roads and footpaths can't be bought.</p>
  <p class="fine">Map © OpenStreetMap contributors · tiles by OpenFreeMap · geocoding by Nominatim · street data via Overpass API.</p>`;

export function feed(events: any[]) {
  const verb: Record<string, string> = { purchase: 'bought', build: 'built on', demolish: 'demolished on', release: 'gave up', joined: 'joined the game', lease_expired: 'lost the lease on' };
  return events.slice(0, 8).map((e) => `<li ${e.parcel_id ? `data-action="goto-parcel" data-id="${e.parcel_id}"` : ''}>
    <b>${esc(e.handle ?? 'someone')}</b> ${verb[e.kind] ?? e.kind}
    ${e.parcel_name ? `<span class="st">${e.kind === 'build' && e.data?.type_id ? `${BUILDING_ICON[e.data.type_id] ?? ''} ` : ''}${esc(e.parcel_name)}</span>` : ''}
    <small>${ago(e.created_at)}</small></li>`).join('');
}

export function searchResults(game: any[], places: { label: string; isStreet: boolean }[], loadingPlaces: boolean) {
  return `
    ${game.length ? `<div class="group">In this world</div>${game.map((g, i) => `<button data-action="search-game" data-i="${i}">
      <span>🏁 <b>${esc(g.name)}</b> <small>${esc(g.suburb ?? '')}</small></span>
      <small>${g.owner_handle ? `owned by ${esc(g.owner_handle)}` : `for sale · ${money(g.price, { compact: true })}`}</small></button>`).join('')}` : ''}
    <div class="group">Places</div>
    ${loadingPlaces ? '<div class="empty">Searching OpenStreetMap…</div>' : places.length
      ? places.map((p, i) => `<button data-action="search-place" data-i="${i}"><span>${p.isStreet ? '🛣️' : '📍'} ${esc(p.label)}</span></button>`).join('')
      : '<div class="empty">No places found.</div>'}`;
}
