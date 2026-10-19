import type { LonLat } from './osm';

export interface Currency { code: string; symbol?: string; minor_units: number }

export interface Improvement { id: number; type_id: string; slot_index: number; slots_used: number; cost: number; built_at?: string }

export interface TaxLine { id: string; base_expr: string; base: number; rate_bp: number; amount: number }

export interface Parcel {
  id: number; name: string; suburb: string | null; highway_class: string; length_m: number;
  slots_total: number; slots_used: number; land_value: number; improvement_value: number; price: number;
  owner_id: string | null; owner_handle: string | null; acquired_at: string | null; lease_expires_at: string | null;
  c_lon: number; c_lat: number; geom: LonLat[][]; improvements: Improvement[];
  per_tick?: { income_land: number; income_improvements: number; taxes: TaxLine[]; net: number };
  purchase?: { price: number; taxes: TaxLine[]; total: number };
}

export interface Me {
  player: { id: string; handle: string; world_id: string };
  world: { id: string; name: string; ruleset_id: string; tick_count: number; next_tick_at: string; tick_interval: string };
  currency: Currency;
  balance: number; loan_outstanding: number; parcel_count: number;
  land_value: number; improvement_value: number; net_worth: number;
  last_tick: null | {
    tick_number: number; ran_at: string;
    income: { reason: string; amount: number }[];
    taxes: { reason: string; amount: number; base_expr: string | null }[];
  };
}

export interface World {
  id: string; slug: string; name: string; status: string; ruleset_id: string; ruleset_name: string;
  ruleset_description: string; tick_interval: string; next_tick_at: string; tick_count: number;
  player_count: number; owned_count: number;
}

export interface BuildingType { id: string; name: string; description: string; cost: number; slots_used: number; yield_bp: number }

let currency: Currency = { code: 'GBP', symbol: '£', minor_units: 100 };
export const setCurrency = (c: Currency | undefined) => { if (c) currency = c; };

/** Money is always integer minor units from the server; this only formats. */
export function money(minor: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const major = minor / currency.minor_units;
  const abs = Math.abs(major);
  const sym = currency.symbol ?? '';
  let body: string;
  if (opts.compact && abs >= 1e6) body = (abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  else if (opts.compact && abs >= 1e4) body = (abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
  else body = abs.toLocaleString('en-GB', { minimumFractionDigits: abs < 100 && abs % 1 ? 2 : 0, maximumFractionDigits: abs < 100 ? 2 : 0 });
  const sign = major < 0 ? '−' : opts.sign && major > 0 ? '+' : '';
  return `${sign}${sym}${body}`;
}

export const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0).replace(/\.?0+$/, '')}%`;

export function metres(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function countdown(iso: string) {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const CLASS_LABEL: Record<string, string> = {
  trunk: 'Trunk road', primary: 'Main road', secondary: 'Secondary road', tertiary: 'Local road',
  residential: 'Residential street', unclassified: 'Minor road', living_street: 'Living street', pedestrian: 'Pedestrian street',
};

export const BUILDING_ICON: Record<string, string> = {
  cottage: '🏡', house: '🏠', terrace: '🏘️', shops: '🏪', apartments: '🏢', office: '🏬', tower: '🏙️', skyscraper: '🌆',
};

export function reasonLabel(r: string) {
  const map: Record<string, string> = {
    loan: 'Starting loan', loan_repayment: 'Loan repayment', purchase: 'Bought street', build: 'Construction',
    'income:land': 'Land income', 'income:improvements': 'Building income',
    'tax:property': 'Property tax', 'tax:transfer': 'Transfer tax', 'tax:lvt': 'Land value tax', 'tax:vacancy': 'Vacant land penalty',
  };
  return map[r] ?? r.replace(/^tax:/, 'Tax: ').replace(/^income:/, 'Income: ').replace(/_/g, ' ');
}

const ERRORS: Record<string, string> = {
  insufficient_funds: "You can't afford that.",
  parcel_already_owned: 'Someone already owns this street.',
  plot_taken: "That plot is taken, or there isn't room there for that building. Pick another plot.",
  no_free_slots: "There isn't enough free frontage on this street for that building.",
  not_owner: "You don't own this street.",
  wrong_world: 'That street belongs to a different world.',
  invalid_login: 'Wrong username or password.',
  username_taken: 'That username is taken.',
  invalid_username: 'Usernames are 3–20 characters: letters, numbers, dot, dash or underscore.',
  invalid_password: 'Passwords need at least 4 characters.',
  too_many_accounts: 'Too many accounts created from your connection recently. Try again later.',
  not_logged_in: 'Your session expired. Please log in again.',
  not_joined: "You haven't joined this world yet.",
  street_not_claimable: "That road can't be bought (motorways, service roads and paths are off-limits).",
  street_too_long: 'That road is too long to buy as one street.',
  invalid_geometry: "That street's map data looks broken, so it can't be bought.",
  amount_exceeds_loan: "That's more than you owe.",
  invalid_amount: 'Enter an amount greater than zero.',
  network_error: "Couldn't reach the game server.",
  parcel_not_found: 'That street no longer exists.',
};

export function errorText(e: unknown): string {
  const code = (e as any)?.code ?? String((e as any)?.message ?? e).match(/^[a-z_]+/)?.[0];
  return ERRORS[code] ?? String((e as any)?.message ?? e);
}
