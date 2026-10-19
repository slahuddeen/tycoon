# Tycoon

A multiplayer property game played on the **real streets of the world**.
Pick any street on the map, buy it, fill it with 3D buildings, and earn rent
every tick, under economic rules you can swap out.

Formerly *Land*. The original build spec is in [`docs/original-spec.md`](docs/original-spec.md).

- 🌍 **Any street on Earth.** Streets come live from OpenStreetMap, so there's nothing to download or import.
- 🏙️ **3D buildings.** Cottages up to 270 m skyscrapers grow out of the street when you build. Your roofs are green, everyone else's are red.
- 💷 **Honest economics.** Every penny is a row in an append-only ledger. You can see exactly what you earned, what was taxed, and on what base.
- ⚖️ **Swappable rulesets.** Two worlds run side by side: *Classic* (UK-style property tax) and *Land Tax* (land value tax). Same map, different rules.
- 🔑 **Simple accounts.** Just a username and password. No email. Players' IP addresses are recorded.
- 💸 **Free to run.** No paid map APIs and no API keys for maps. Hosting is GitHub Pages; the multiplayer database is Supabase's free tier.

## Play

Once GitHub Pages is switched on (below), the game lives at
**https://slahuddeen.github.io/tycoon/**

1. Create an account, then pick a world.
2. Search for a place, or zoom in and **click any named street**.
3. **Buy** it. The price depends on length, road type, and how busy the area is.
4. **Build** on its plots. Click an empty plot first to choose the spot.
5. Every tick (hourly by default) you earn income and pay tax. The top bar shows both separately; 📒 Ledger shows every transaction.
6. Climb 🏆 Top by net worth. You start with a £50,000 **loan**, not free money, so everyone starts at £0 net worth.

Motorways, service roads and footpaths can't be bought.

## Single-player, anywhere in the world

With no server configured, the live site is a single-player sandbox:

- Every street on Earth is playable (London, Tokyo, a village lane), as long as it's a named road in OpenStreetMap.
- The whole game database runs inside your browser and saves there. Clearing site data, or using another browser or device, starts you fresh.
- The ⏩ **Tick now** button skips ahead, so you don't have to wait an hour for income.
- Both worlds (*Classic* and *Land Tax*) and every feature work the same as online. You just won't see other players.

Once a Supabase server is added (below), the site switches to shared multiplayer for everyone.
Any player can still choose the sandbox from **Server settings** on the login screen.

## Setting it up

### 1. Turn on GitHub Pages (one click)

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

Every push to the default branch runs the tests, then builds and publishes the site.
Until you do step 2, the site runs as an **offline sandbox**: the whole game
database runs inside each visitor's browser (PGlite) and saves there.
It's fully playable, but players can't see each other.

### 2. Multiplayer: a free Supabase database (about 5 minutes)

1. Sign up at [supabase.com](https://supabase.com) and create a **new project** (Free plan).
2. Open **SQL Editor → New query**, paste the whole of [`supabase/setup.sql`](supabase/setup.sql), and press **Run**.
3. Optional but recommended: **Database → Extensions → enable `pg_cron`**, then run `setup.sql` again.
   This makes ticks happen on schedule even when nobody is online.
   Without it, ticks still run, but only when a player loads the game.
4. Go to **Project Settings → API** (or **Connect**). Copy the **Project URL** and the **publishable key**
   (on older projects, the `anon` `public` key).
5. Give those to the site, either way works:
   - edit [`web/public/config.js`](web/public/config.js) and commit, **or**
   - add two repository variables (**Settings → Secrets and variables → Actions → Variables**):
     `TYCOON_SUPABASE_URL` and `TYCOON_SUPABASE_KEY`, then re-run the workflow.

Both values are safe to make public. That key can only call the game's own
functions. The tables themselves are hidden from the API, and row-level
security is on everywhere.

> Free Supabase projects pause after a week with no activity. Un-pause from the dashboard.

To update the database after pulling new code, run `supabase/setup.sql` again.
It keeps all data and replaces the functions.

### Handy SQL (Supabase SQL editor)

```sql
-- Accounts and their IP addresses
select username, created_ip, last_ip, created_at, last_login_at from tycoon.accounts order by created_at desc;

-- Change how often ticks happen in a world (rulesets are just data)
update tycoon.rulesets set config = jsonb_set(config, '{tick,interval}', '"30 minutes"') where id = 'uk-baseline';

-- Add a new economic model: copy a ruleset, tweak it, open a world on it
insert into tycoon.rulesets (id, name, description, config)
select 'no-tax', 'No tax', 'A pure free-for-all.', config || '{"taxes": []}'::jsonb from tycoon.rulesets where id = 'uk-baseline';
insert into tycoon.worlds (slug, name, ruleset_id) values ('wild-west', 'Wild West', 'no-tax');
```

## Developing

```bash
npm install
npm run dev        # http://localhost:5173 (offline sandbox unless config.js points at Supabase)
npm test           # database + unit tests; uses local Postgres if reachable, else PGlite
npm run e2e        # builds, then plays a full round in headless Chromium with fake map data
```

`npm test` looks for Postgres at `postgres://postgres:postgres@localhost:5432/tycoon_test`
(override with `TYCOON_PG_URL`). Without one it falls back to PGlite and skips
the three tests that need multiple connections. CI always uses real Postgres.

### Layout

```
db/migrations/      the whole game: schema, rules engine, API, permissions, seed data
db/bundle.mjs       concatenates migrations -> supabase/setup.sql
supabase/setup.sql  generated; paste into Supabase (also what offline mode runs)
web/src/
  main.ts           app controller: screens, game loop, actions
  map.ts            MapLibre map, ownership-coloured streets, click handling
  buildings3d.ts    procedural low-poly 3D buildings (Three.js custom layer)
  osm.ts            OpenStreetMap lookups + merging a street's ways
  backend.ts        Supabase (online) or PGlite (offline) – same SQL either way
  ui.ts, style.css  panels, HUD, modals
tests/              invariants from the spec, plus street-merging tests
scripts/e2e-smoke.mjs  browser smoke test
```

## How it maps to the spec

The spec asked for Docker, Fastify, PostGIS and a London-only data import.
You asked for something that runs on GitHub Pages, covers the whole world, is 3D, and costs nothing.
So the architecture changed, but the spec's hard constraints all still hold:

| Spec | Here |
|---|---|
| No hardcoded economics; new model = an `INSERT` | All rates, bases, formulas and cadence live in `rulesets.config`. The tests add a leasehold ruleset with a single `INSERT`, and grep `run_tick` for numeric literals. |
| `land_value` and `improvement_value` always separate | Separate columns; taxes and income use them independently. |
| Money is `BIGINT` minor units, never client-supplied | Yes. The browser only ever sends *what* to buy or build, never an amount (except how much loan to repay, which is checked). |
| Balances derived from the ledger | `balance_of()` and the `balances` view sum the ledger. A trigger blocks `UPDATE`/`DELETE`/`TRUNCATE` on it. |
| Client never writes economic tables | Tables live in a schema the API can't see; clients can only `EXECUTE` the `public.tycoon_*` functions (`SECURITY DEFINER`). RLS is on for every table. Tested with the `anon` role. |
| No signup grant, no login grant | Starting capital is a repayable loan in the ledger. Player-to-player transfer doesn't exist. |
| Fastify API + sessions | Replaced by SQL functions called over Supabase's REST endpoint. Sessions are random tokens. Passwords are bcrypt (pgcrypto), since Argon2id isn't available in Postgres. |
| PostGIS + osm2pgsql London import | Replaced by on-demand lookups against the free Overpass API, for any street worldwide. Same merge rule: connected, same-named ways become one parcel. A way can only ever belong to one parcel per world. Geometry is JSON, so no PostGIS is needed (that's also what lets the identical SQL run in the browser). |
| `parcel_count_within_500m` density | Counts streets anyone has looked at within the radius, so neighbourhoods appreciate as they get busier. |
| pg_cron, cadence from the ruleset | A per-minute dispatcher runs only the worlds that are due. Without pg_cron, the same dispatcher runs lazily on player activity. |
| Basemap must recede; flat buildings | OpenFreeMap "Positron" (grey, no API key) with OSM buildings flattened; player streets and buildings are the only saturated things. |
| Phase 3 3D | Done with Three.js instead of deck.gl: low-poly procedural buildings, placed along the street by plot, roofs in owner colour, hidden below zoom 14. |
| Tests (money, concurrency, authorisation, ruleset isolation, data) | `tests/db.test.ts`: money sums to zero; only loan and income ever pay players; concurrent buy gives exactly one winner; concurrent builds can't overfill; ownership and cross-world checks; `anon` can't touch tables; uk-baseline and lvt give different wealth outcomes under identical play. |

Additions beyond the spec: choose-your-plot building, a live activity feed,
handing a street back to the bank (no payment, so the no-minting rule holds),
loan repayment, and an offline sandbox with a ⏩ *Tick now* button for trying the rules quickly.

Deliberately not built (out of scope in the spec): player-to-player trading,
chance cards/hazards, real price-paid calibration. One known gap: under the
*Land Tax* rules, a player who leaves keeps their streets and slides into debt.
A foreclosure rule would be the natural next step.

## Credits & licences

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Street geometry via the Overpass API; search via Nominatim.
- Map tiles by [OpenFreeMap](https://openfreemap.org); rendering by [MapLibre GL JS](https://maplibre.org); 3D by [Three.js](https://threejs.org).
- In-browser Postgres by [PGlite](https://pglite.dev).
