// Talks to the game database. Two interchangeable implementations:
//  - OnlineBackend: a Supabase project (free tier), via its REST RPC endpoint.
//    This is real multiplayer: everyone using the site shares one world.
//  - OfflineBackend: the exact same SQL running in your browser via PGlite,
//    saved in IndexedDB. Used when no server is configured.
import setupSql from '../../supabase/setup.sql?raw';

export interface Backend {
  readonly mode: 'online' | 'offline';
  /** Stable id for this server, used to keep sessions apart. */
  readonly id: string;
  call<T = any>(fn: string, p?: Record<string, unknown>): Promise<T>;
  /** Offline sandbox only: force a tick right now. */
  forceTick?(worldId: string): Promise<void>;
}

export class GameError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

const FN = /^tycoon_[a-z_]+$/;

function toGameError(raw: unknown): GameError {
  const msg = String((raw as any)?.message ?? raw ?? 'unknown_error');
  const code = msg.match(/^[a-z_]+/)?.[0] ?? 'unknown_error';
  return new GameError(code, msg);
}

export class OnlineBackend implements Backend {
  readonly mode = 'online' as const;
  readonly id: string;
  constructor(private url: string, private key: string) {
    this.url = url.replace(/\/+$/, '');
    this.id = this.url;
  }

  async call<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
    if (!FN.test(fn)) throw new GameError('bad_function');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: this.key };
    // Legacy "anon" keys are JWTs and go in Authorization too; new
    // "sb_publishable_" keys only go in the apikey header.
    if (this.key.startsWith('eyJ')) headers.Authorization = `Bearer ${this.key}`;
    let res: Response;
    try {
      res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify({ p }) });
    } catch (e) {
      throw new GameError('network_error', String(e));
    }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw toGameError(body ?? res.statusText);
    return body as T;
  }
}

async function hash(s: string): Promise<string> {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

export class OfflineBackend implements Backend {
  readonly mode = 'offline' as const;
  readonly id = 'offline';
  private db: Promise<any> | null = null;

  private open() {
    this.db ??= (async () => {
      const [{ PGlite }, { pgcrypto }] = await Promise.all([
        import('@electric-sql/pglite'),
        import('@electric-sql/pglite/contrib/pgcrypto'),
      ]);
      let db: any;
      try {
        db = await PGlite.create('idb://tycoon-offline', { extensions: { pgcrypto } });
      } catch {
        db = await PGlite.create({ extensions: { pgcrypto } });   // private browsing: memory only
      }
      const version = await hash(setupSql);
      let installed: string | null = null;
      try {
        installed = localStorage.getItem('tycoon-offline-schema');
      } catch { /* storage blocked */ }
      const exists = (await db.query(`SELECT to_regclass('tycoon.worlds') AS t`)).rows[0].t;
      if (!exists || installed !== version) {
        await db.exec(setupSql);
        try { localStorage.setItem('tycoon-offline-schema', version); } catch { /* ignore */ }
      }
      return db;
    })();
    return this.db;
  }

  async call<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
    if (!FN.test(fn)) throw new GameError('bad_function');
    const db = await this.open();
    try {
      const r = await db.query(`SELECT public.${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
      return r.rows[0].r as T;
    } catch (e) {
      throw toGameError(e);
    }
  }

  async forceTick(worldId: string) {
    const db = await this.open();
    await db.query(`SELECT tycoon.run_tick($1)`, [worldId]);
  }
}

export interface ServerConfig { supabaseUrl: string; supabaseKey: string }

/** Server settings: the site's config.js, overridable per browser. */
export function serverConfig(): ServerConfig {
  const site = (window as any).TYCOON_CONFIG ?? {};
  let local: Partial<ServerConfig> = {};
  try {
    local = JSON.parse(localStorage.getItem('tycoon-server') ?? '{}');
  } catch { /* ignore */ }
  return {
    supabaseUrl: (local.supabaseUrl ?? site.supabaseUrl ?? '').trim(),
    supabaseKey: (local.supabaseKey ?? site.supabaseKey ?? '').trim(),
  };
}

export function saveServerOverride(cfg: Partial<ServerConfig> | null) {
  try {
    if (cfg) localStorage.setItem('tycoon-server', JSON.stringify(cfg));
    else localStorage.removeItem('tycoon-server');
  } catch { /* ignore */ }
}

export function makeBackend(): Backend {
  const c = serverConfig();
  if (c.supabaseUrl && c.supabaseKey) return new OnlineBackend(c.supabaseUrl, c.supabaseKey);
  return new OfflineBackend();
}
