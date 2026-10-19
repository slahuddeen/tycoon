// Test database harness. Uses a real Postgres when TYCOON_PG_URL (or the
// default local URL) is reachable, otherwise falls back to PGlite so the
// suite still runs anywhere. Concurrency tests need real Postgres.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export const SETUP_SQL = readFileSync(join(__dirname, '..', 'supabase', 'setup.sql'), 'utf8');
const PG_URL = process.env.TYCOON_PG_URL ?? (process.env.TYCOON_FORCE_PGLITE ? 'postgres://x@127.0.0.1:1/x' : 'postgres://postgres:postgres@localhost:5432/tycoon_test');

export interface Db {
  kind: 'postgres' | 'pglite';
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** A second, independent connection (real Postgres only). */
  connect(): Promise<{ q<T = any>(sql: string, params?: unknown[]): Promise<T[]>; close(): Promise<void> }>;
  close(): Promise<void>;
}

async function pgClient() {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  c.on('notice', () => {});
  return {
    q: async (sql: string, params?: unknown[]) => (await c.query(sql, params as any[])).rows,
    close: () => c.end(),
  };
}

export async function openDb(): Promise<Db> {
  try {
    const main = await pgClient();
    await main.q(`DROP SCHEMA IF EXISTS tycoon CASCADE`);
    await main.q(`DO $$BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END$$`);
    await main.q(SETUP_SQL);
    return { kind: 'postgres', q: main.q, connect: pgClient, close: main.close };
  } catch (e: any) {
    if (process.env.TYCOON_PG_URL) throw e;
    const db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(SETUP_SQL);
    return {
      kind: 'pglite',
      q: async (sql, params) => (await db.query(sql, params as any[])).rows as any[],
      connect: async () => { throw new Error('PGlite has a single connection'); },
      close: () => db.close(),
    };
  }
}

export async function api<T = any>(db: { q: Db['q'] }, fn: string, p: Record<string, unknown>): Promise<T> {
  const rows = await db.q(`SELECT public.${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
  return rows[0].r as T;
}

export async function apiError(db: { q: Db['q'] }, fn: string, p: Record<string, unknown>): Promise<string> {
  try {
    await api(db, fn, p);
  } catch (e: any) {
    return String(e.message);
  }
  return 'NO_ERROR';
}

export async function worldId(db: Db, slug: string): Promise<string> {
  return (await db.q(`SELECT id FROM tycoon.worlds WHERE slug = $1`, [slug]))[0].id;
}

let wayCounter = 1000;
/** A fake straight street of roughly `metres` length starting at lon/lat. */
export function fakeStreet(lon: number, lat: number, metres: number, highway = 'residential') {
  const id = ++wayCounter;
  const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    anchor_way: id,
    ways: [{ id, highway, coords: [[lon, lat], [lon + dLon / 2, lat], [lon + dLon, lat]] }],
  };
}

export async function newPlayer(db: Db, world: string, username: string) {
  const s = await api(db, 'tycoon_register', { username, password: 'secret' });
  await api(db, 'tycoon_join', { token: s.token, world_id: world });
  return { token: s.token as string, world_id: world };
}

export async function claim(db: Db, who: { token: string; world_id: string }, name: string,
                            street: ReturnType<typeof fakeStreet>) {
  return api(db, 'tycoon_claim', { ...who, name, ...street });
}
