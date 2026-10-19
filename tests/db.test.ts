import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, apiError, claim, Db, fakeStreet, newPlayer, openDb, worldId } from './helpers';

let db: Db;
let classic: string;
let landtax: string;

beforeAll(async () => {
  db = await openDb();
  classic = await worldId(db, 'classic');
  landtax = await worldId(db, 'landtax');
  // Keep the lazy dispatcher out of the way; tests run ticks explicitly.
  await db.q(`UPDATE tycoon.worlds SET next_tick_at = now() + interval '100 years'`);
});
afterAll(async () => db?.close());

const sumAll = async () =>
  Number((await db.q(`SELECT COALESCE(SUM(balance),0)::bigint AS s FROM tycoon.balances`))[0].s);

describe('accounts', () => {
  it('registers, logs in, rejects bad passwords and duplicate names', async () => {
    const s = await api(db, 'tycoon_register', { username: 'Dora', password: 'hunter2' });
    expect(s.token).toMatch(/^[0-9a-f]{48}$/);
    expect(await apiError(db, 'tycoon_register', { username: 'dora', password: 'xxxxxx' })).toContain('username_taken');
    expect(await apiError(db, 'tycoon_login', { username: 'dora', password: 'nope' })).toContain('invalid_login');
    const l = await api(db, 'tycoon_login', { username: 'DORA', password: 'hunter2' });
    expect(l.account.username).toBe('Dora');
    expect(await apiError(db, 'tycoon_register', { username: 'x', password: 'xxxxxx' })).toContain('invalid_username');
    const hash = (await db.q(`SELECT password_hash FROM tycoon.accounts WHERE username='Dora'`))[0].password_hash;
    expect(hash).not.toContain('hunter2');
  });

  it('records the caller IP from request headers', async () => {
    await db.q(`SELECT set_config('request.headers', '{"x-forwarded-for":"203.0.113.7, 10.0.0.1"}', false)`);
    await api(db, 'tycoon_register', { username: 'ipcheck', password: 'secret' });
    await db.q(`SELECT set_config('request.headers', '', false)`);
    const row = (await db.q(`SELECT created_ip, last_ip FROM tycoon.accounts WHERE username='ipcheck'`))[0];
    expect(row.created_ip).toBe('203.0.113.7');
    expect(row.last_ip).toBe('203.0.113.7');
  });

  it('requires a valid session for player actions', async () => {
    expect(await apiError(db, 'tycoon_me', { token: 'bogus', world_id: classic })).toContain('not_logged_in');
    const s = await api(db, 'tycoon_register', { username: 'notjoined', password: 'secret' });
    expect(await apiError(db, 'tycoon_me', { token: s.token, world_id: classic })).toContain('not_joined');
  });
});

describe('starting capital', () => {
  it('is a repayable loan in the ledger, never a grant', async () => {
    const p = await newPlayer(db, classic, 'loanie');
    const me = await api(db, 'tycoon_me', p);
    expect(me.balance).toBe(5000000);
    expect(me.loan_outstanding).toBe(5000000);
    expect(me.net_worth).toBe(0);
    // Joining twice doesn't issue a second loan.
    await api(db, 'tycoon_join', p);
    expect((await api(db, 'tycoon_me', p)).balance).toBe(5000000);

    expect(await apiError(db, 'tycoon_repay', { ...p, amount: 6000000 })).toContain('amount_exceeds_loan');
    const r = await api(db, 'tycoon_repay', { ...p, amount: 1000000 });
    expect(r.balance).toBe(4000000);
    expect((await api(db, 'tycoon_me', p)).loan_outstanding).toBe(4000000);
  });
});

describe('claiming streets', () => {
  it('computes length, slots and land value server-side', async () => {
    const p = await newPlayer(db, classic, 'claimer');
    const parcel = await claim(db, p, 'Long Road', fakeStreet(-0.1, 51.5, 410, 'primary'));
    expect(parcel.length_m).toBeGreaterThan(400);
    expect(parcel.length_m).toBeLessThan(420);
    expect(parcel.slots_total).toBe(10);           // 410m / 40m per slot
    expect(parcel.highway_class).toBe('primary');
    expect(parcel.land_value).toBeGreaterThan(0);
  });

  it('resolves the same street to the same parcel wherever it is clicked', async () => {
    const p = await newPlayer(db, classic, 'clicker');
    const a = await claim(db, p, 'Twin St', fakeStreet(-0.2, 51.4, 200));
    // A different piece of the same street, a little further along.
    const b = await claim(db, p, 'twin st', fakeStreet(-0.1975, 51.4, 150));
    expect(b.id).toBe(a.id);
    // Same name in another town is a different street.
    const far = await claim(db, p, 'Twin St', fakeStreet(-0.1, 51.4, 150));
    expect(far.id).not.toBe(a.id);
    // The same street in another world is a separate parcel.
    const p2 = await newPlayer(db, landtax, 'clicker2');
    const c = await claim(db, p2, 'Twin St', fakeStreet(-0.2, 51.4, 200));
    expect(c.id).not.toBe(a.id);
  });

  it('rejects junk geometry and unknown road classes', async () => {
    const p = await newPlayer(db, classic, 'junk');
    const bad = { highway: 'residential', lines: [[[500, 500], [501, 501]]] };
    expect(await apiError(db, 'tycoon_claim', { ...p, name: 'Bad', ...bad })).toContain('invalid_geometry');
    const empty = { highway: 'residential', lines: [[[1, 1]]] };
    expect(await apiError(db, 'tycoon_claim', { ...p, name: 'Dot', ...empty })).toContain('invalid_geometry');
    const motorway = fakeStreet(1, 1, 100, 'motorway');
    expect(await apiError(db, 'tycoon_claim', { ...p, name: 'M1', ...motorway })).toContain('street_not_claimable');
    const st = fakeStreet(2, 2, 100);
    expect(await apiError(db, 'tycoon_claim', { token: 'nope', world_id: classic, name: 'X', ...st })).toContain('not_logged_in');
  });

  it('never stores a parcel with no slots or no length', async () => {
    const rows = await db.q(`SELECT count(*)::int AS n FROM tycoon.parcels WHERE slots_total < 1 OR length_m <= 0`);
    expect(rows[0].n).toBe(0);
  });
});

describe('authorisation', () => {
  it('stops players acting on parcels they do not own or in other worlds', async () => {
    const a = await newPlayer(db, classic, 'owner_a');
    const b = await newPlayer(db, classic, 'other_b');
    const parcel = await claim(db, a, 'Owned St', fakeStreet(0.5, 51, 80));
    await api(db, 'tycoon_buy', { ...a, parcel_id: parcel.id });
    const built = await api(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'cottage' });
    const impId = built.parcel.improvements[0].id;

    expect(await apiError(db, 'tycoon_build', { ...b, parcel_id: parcel.id, type_id: 'cottage' })).toContain('not_owner');
    expect(await apiError(db, 'tycoon_demolish', { ...b, improvement_id: impId })).toContain('not_owner');
    expect(await apiError(db, 'tycoon_release', { ...b, parcel_id: parcel.id })).toContain('not_owner');
    expect(await apiError(db, 'tycoon_buy', { ...b, parcel_id: parcel.id })).toContain('parcel_already_owned');

    // Same account, other world: the parcel belongs to `classic`.
    const s = await api(db, 'tycoon_login', { username: 'other_b', password: 'secret' });
    await api(db, 'tycoon_join', { token: s.token, world_id: landtax });
    expect(await apiError(db, 'tycoon_buy', { token: s.token, world_id: landtax, parcel_id: parcel.id })).toContain('wrong_world');
  });

  it('enforces slots and funds', async () => {
    const a = await newPlayer(db, classic, 'slotter');
    const parcel = await claim(db, a, 'Short St', fakeStreet(0.6, 51, 50));   // 1 slot
    await api(db, 'tycoon_buy', { ...a, parcel_id: parcel.id });
    expect(await apiError(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'terrace' })).toContain('no_free_slots');
    expect(await apiError(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'nope' })).toContain('unknown_building_type');
    const big = await claim(db, a, 'Big St', fakeStreet(0.7, 51, 800));
    expect(await apiError(db, 'tycoon_build', { ...a, parcel_id: big.id, type_id: 'house' })).toContain('not_owner');
  });

  it('builds from the middle of the street out, or on a chosen plot', async () => {
    const a = await newPlayer(db, classic, 'planner');
    const parcel = await claim(db, a, 'Plan St', fakeStreet(0.9, 51, 410));   // 10 plots
    await api(db, 'tycoon_buy', { ...a, parcel_id: parcel.id });
    const r1 = await api(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'cottage' });
    expect(r1.parcel.improvements[0].slot_index).toBe(4);
    const r2 = await api(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'cottage', slot: 9 });
    expect(r2.parcel.improvements.map((i: any) => i.slot_index)).toEqual([4, 9]);
    expect(await apiError(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'cottage', slot: 4 })).toContain('plot_taken');
    // A 2-plot terrace asked for plot 9 can't fit (plot 9 is taken) but plot 3 works: it spans 2-3 or 3-4.
    const r3 = await api(db, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'terrace', slot: 3 });
    expect(r3.parcel.improvements.find((i: any) => i.type_id === 'terrace').slot_index).toBe(2);
  });

  it('releasing a street pays nothing', async () => {
    const a = await newPlayer(db, classic, 'releaser');
    const parcel = await claim(db, a, 'Let Go Lane', fakeStreet(0.8, 51, 100));
    const bought = await api(db, 'tycoon_buy', { ...a, parcel_id: parcel.id });
    const rel = await api(db, 'tycoon_release', { ...a, parcel_id: parcel.id });
    expect(rel.balance).toBe(bought.balance);
    expect(rel.parcel.owner_id).toBeNull();
  });
});

describe('database privileges', () => {
  it('ledger is append-only even for the owner', async () => {
    await expect(db.q(`UPDATE tycoon.ledger SET amount = amount + 1`)).rejects.toThrow(/append_only/);
    await expect(db.q(`DELETE FROM tycoon.ledger`)).rejects.toThrow(/append_only/);
  });

  it('client roles can only call the API functions', async (ctx) => {
    if (db.kind !== 'postgres') return ctx.skip();
    const c = await db.connect();
    try {
      await c.q(`SET ROLE anon`);
      for (const sql of [
        `INSERT INTO tycoon.ledger (world_id, from_account, to_account, amount, reason) VALUES ('${classic}', 'bank', 'player:x', 1, 'x')`,
        `UPDATE tycoon.parcels SET owner_id = NULL`,
        `INSERT INTO tycoon.improvements (parcel_id, type_id, cost, slots_used, slot_index) VALUES (1, 'house', 1, 1, 0)`,
        `SELECT * FROM tycoon.accounts`,
        `SELECT tycoon.run_tick('${classic}')`,
        `SELECT tycoon.purchase_parcel(gen_random_uuid(), 1)`,
      ]) {
        await expect(c.q(sql)).rejects.toThrow(/permission denied/);
      }
      const worlds = await c.q(`SELECT public.tycoon_worlds('{}') AS r`);
      expect(worlds[0].r.length).toBeGreaterThanOrEqual(2);
    } finally {
      await c.close();
    }
  });
});

describe('concurrency', () => {
  it('two simultaneous purchases of one parcel: exactly one wins', async (ctx) => {
    if (db.kind !== 'postgres') return ctx.skip();
    const a = await newPlayer(db, classic, 'racer_a');
    const b = await newPlayer(db, classic, 'racer_b');
    const parcel = await claim(db, a, 'Race Rd', fakeStreet(1.0, 51, 100));
    const ca = await db.connect();
    const cb = await db.connect();
    try {
      // A holds the parcel lock inside an open transaction while B tries.
      await ca.q('BEGIN');
      await api(ca, 'tycoon_buy', { ...a, parcel_id: parcel.id });
      const bTry = apiError(cb, 'tycoon_buy', { ...b, parcel_id: parcel.id });
      await new Promise((r) => setTimeout(r, 200));
      await ca.q('COMMIT');
      expect(await bTry).toContain('parcel_already_owned');

      // And a true free-for-all.
      const p2 = await claim(db, a, 'Race Rd Two', fakeStreet(1.1, 51, 100));
      const results = await Promise.all([
        apiError(ca, 'tycoon_buy', { ...a, parcel_id: p2.id }),
        apiError(cb, 'tycoon_buy', { ...b, parcel_id: p2.id }),
      ]);
      expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
      expect(results.filter((r) => r.includes('parcel_already_owned'))).toHaveLength(1);
    } finally {
      await ca.close();
      await cb.close();
    }
  });

  it('two simultaneous builds that would overfill a street: exactly one succeeds', async (ctx) => {
    if (db.kind !== 'postgres') return ctx.skip();
    const a = await newPlayer(db, classic, 'builder_race');
    const parcel = await claim(db, a, 'Narrow Way', fakeStreet(1.2, 51, 125));   // 3 slots
    expect(parcel.slots_total).toBe(3);
    await api(db, 'tycoon_buy', { ...a, parcel_id: parcel.id });
    const ca = await db.connect();
    const cb = await db.connect();
    try {
      const results = await Promise.all([
        apiError(ca, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'terrace' }),
        apiError(cb, 'tycoon_build', { ...a, parcel_id: parcel.id, type_id: 'terrace' }),
      ]);
      expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
      expect(results.filter((r) => r.includes('no_free_slots'))).toHaveLength(1);
    } finally {
      await ca.close();
      await cb.close();
    }
  });
});

describe('expression evaluator', () => {
  const allowed = `ARRAY['land_value','improvement_value']`;
  it('compiles allowed formulas', async () => {
    const r = await db.q(`SELECT tycoon.compile_expr('land_value + (improvement_value * 2) - -1', ${allowed}) AS e`);
    expect(r[0].e).toBe('( v.land_value + ( v.improvement_value * 2::numeric ) - - 1::numeric )');
  });
  it('emits tokens space-separated so "--" can never become a SQL comment', async () => {
    const e = (await db.q(`SELECT tycoon.compile_expr('1 -- 1', ${allowed}) AS e`))[0].e;
    expect(e).toBe('( 1::numeric - - 1::numeric )');
    expect(Number((await db.q(`SELECT ${e} AS v FROM (SELECT 1) v`))[0].v)).toBe(2);
  });
  it.each([
    ['land_value; DROP TABLE tycoon.ledger', 'invalid_character'],
    ['pg_sleep(10)', 'not_allowed'],
    ['land_value -- comment', 'not_allowed'],
    ['(land_value', 'incomplete'],
    ['land_value)', 'unexpected'],
    ['land_value land_value', 'unexpected'],
    ['* land_value', 'unexpected'],
    ['sale_price', 'not_allowed'],
    ["land_value || 'x'", 'invalid_character'],
    ['1e9', 'unexpected'],
    ['', 'incomplete'],
  ])('rejects %j', async (expr, msg) => {
    await expect(db.q(`SELECT tycoon.compile_expr($1, ${allowed})`, [expr])).rejects.toThrow(new RegExp(msg));
  });
});

describe('ticks', () => {
  it('the dispatcher runs due worlds on their own cadence', async () => {
    await db.q(`UPDATE tycoon.worlds SET next_tick_at = now() - interval '90 minutes' WHERE id = $1`, [classic]);
    const before = (await db.q(`SELECT tick_count FROM tycoon.worlds WHERE id = $1`, [classic]))[0].tick_count;
    const n = (await db.q(`SELECT tycoon.run_due_ticks() AS n`))[0].n;
    expect(n).toBe(2);   // 90 minutes behind on a 1 hour cadence
    const w = (await db.q(`SELECT tick_count, next_tick_at > now() AS future FROM tycoon.worlds WHERE id = $1`, [classic]))[0];
    expect(w.tick_count).toBe(before + 2);
    expect(w.future).toBe(true);
    expect((await db.q(`SELECT tycoon.run_due_ticks() AS n`))[0].n).toBe(0);
    await db.q(`UPDATE tycoon.worlds SET next_tick_at = now() + interval '100 years'`);
  });

  it('shows last tick income and tax separately', async () => {
    const p = await newPlayer(db, classic, 'ticker');
    const parcel = await claim(db, p, 'Tick Tock Rd', fakeStreet(1.5, 51, 300));
    await api(db, 'tycoon_buy', { ...p, parcel_id: parcel.id });
    await db.q(`SELECT tycoon.run_tick($1)`, [classic]);
    const me = await api(db, 'tycoon_me', p);
    const income = me.last_tick.income.find((x: any) => x.reason === 'income:land');
    const tax = me.last_tick.taxes.find((x: any) => x.reason === 'tax:property');
    expect(income.amount).toBe(Math.floor((parcel.land_value * 200) / 10000));
    expect(tax.amount).toBe(Math.floor((parcel.land_value * 100) / 10000));
    expect(tax.base_expr).toBe('land_value + improvement_value');
  });

  it('a new economic model is just an INSERT (leasehold expiry)', async () => {
    await db.q(`INSERT INTO tycoon.rulesets (id, name, description, config)
                SELECT 'lease-test', 'Lease test', 'test',
                       config || '{"tenure":{"type":"leasehold"},"lease_term_ticks":2}'::jsonb
                  FROM tycoon.rulesets WHERE id = 'uk-baseline'`);
    await db.q(`INSERT INTO tycoon.worlds (slug, name, ruleset_id, next_tick_at)
                VALUES ('lease', 'Lease', 'lease-test', now() + interval '100 years')`);
    const w = await worldId(db, 'lease');
    const p = await newPlayer(db, w, 'leaser');
    const parcel = await claim(db, p, 'Lease Lane', fakeStreet(1.6, 51, 100));
    const bought = await api(db, 'tycoon_buy', { ...p, parcel_id: parcel.id });
    expect(bought.parcel.lease_expires_at).not.toBeNull();
    await db.q(`UPDATE tycoon.parcels SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [parcel.id]);
    await db.q(`SELECT tycoon.run_tick($1)`, [w]);
    const after = await api(db, 'tycoon_parcel', { world_id: w, parcel_id: parcel.id });
    expect(after.owner_id).toBeNull();
  });

  it('run_tick contains no hardcoded rates', async () => {
    const src: string = (await db.q(`SELECT prosrc FROM pg_proc WHERE proname = 'run_tick'`))[0].prosrc;
    const code = src.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
    const literals = (code.match(/(?<![\w.])\d+(\.\d+)?(?![\w.])/g) ?? []).filter((n) => n !== '0' && n !== '1');
    expect(literals).toEqual([]);
  });
});

describe('ruleset isolation', () => {
  it('identical play under uk-baseline and lvt gives different wealth outcomes', async () => {
    async function play(world: string, tag: string) {
      const builder = await newPlayer(db, world, `builder_${tag}`);
      const holder = await newPlayer(db, world, `holder_${tag}`);
      const saver = await newPlayer(db, world, `saver_${tag}`);
      const base = tag === 'uk' ? 10 : 20;   // separate locations, same shapes
      const s1 = await claim(db, builder, 'Builder Rd', fakeStreet(base, 10, 600, 'secondary'));
      const s2 = await claim(db, holder, 'Holder Rd', fakeStreet(base + 0.5, 10, 600, 'secondary'));
      await api(db, 'tycoon_buy', { ...builder, parcel_id: s1.id });
      await api(db, 'tycoon_buy', { ...holder, parcel_id: s2.id });
      for (let i = 0; i < 4; i++) await api(db, 'tycoon_build', { ...builder, parcel_id: s1.id, type_id: 'house' });
      for (let t = 0; t < 30; t++) await db.q(`SELECT tycoon.run_tick($1)`, [world]);
      const out: Record<string, number> = {};
      for (const [k, who] of Object.entries({ builder, holder, saver })) out[k] = (await api(db, 'tycoon_me', who)).net_worth;
      return out;
    }
    const uk = await play(classic, 'uk');
    const lvt = await play(landtax, 'lvt');
    expect(uk).not.toEqual(lvt);
    // Holding empty land is worse under LVT than under the UK baseline.
    expect(lvt.holder - lvt.saver).toBeLessThan(uk.holder - uk.saver);
    // Builder minus holder gap is wider under LVT (it rewards building).
    expect(lvt.builder - lvt.holder).toBeGreaterThan(uk.builder - uk.holder);
  });
});

describe('money invariants', () => {
  it('every world balances to zero: money only ever moves', async () => {
    expect(await sumAll()).toBe(0);
    const perWorld = await db.q(`SELECT world_id, SUM(balance)::bigint AS s FROM tycoon.balances GROUP BY world_id`);
    for (const r of perWorld) expect(Number(r.s)).toBe(0);
  });

  it('players are only ever paid by the starting loan or tick income', async () => {
    const rows = await db.q(`SELECT DISTINCT reason FROM tycoon.ledger WHERE to_account LIKE 'player:%'`);
    for (const r of rows) expect(r.reason === 'loan' || r.reason.startsWith('income:')).toBe(true);
    const fromBank = await db.q(`SELECT count(*)::int AS n FROM tycoon.ledger
                                  WHERE to_account LIKE 'player:%' AND reason LIKE 'income:%' AND tick_id IS NULL`);
    expect(fromBank[0].n).toBe(0);
  });
});
