# Land — prototype build spec

Implementation spec for a browser game played on real UK street geometry.
Players buy streets, build on them, and earn income under a swappable economic
ruleset. This document targets a working local prototype, scoped to Greater
London.

Written to be implemented directly. Where a decision is already made, it is
stated as a requirement, not a suggestion.

---

## 0. Hard constraints

Violating any of these means the prototype has failed its purpose.

1. **No hardcoded economics.** Rates, tax bases, valuation formulas, and
   cadence live in `rulesets.config` (JSONB). Adding a new economic model must
   be an `INSERT`, not a code change.
2. **`land_value` and `improvement_value` are always separate.** Never merge
   into a single `value` column. The distinction between a property tax and a
   land value tax lives entirely in that split.
3. **Money is `BIGINT` in minor units.** Never float, never numeric, never a
   client-supplied amount.
4. **Balances are derived from the ledger, never stored mutably.**
   `balance = SUM(credits) - SUM(debits)`.
5. **The client never writes to economic tables.** All mutations go through
   `SECURITY DEFINER` Postgres functions called by the API. RLS denies direct
   write on `parcels`, `improvements`, `ledger`.
6. **No signup cash grant and no daily login grant.** These two faucets plus
   free peer-to-peer transfer were the sockpuppet exploit that destroyed the
   2009 original. Starting capital is a fixed loan recorded in the ledger and
   repayable, not free money.

---

## 1. Stack

| Layer | Requirement |
|---|---|
| DB | PostgreSQL 16 + PostGIS 3.4 + `pg_cron` |
| API | Node 20, TypeScript, Fastify 4, `postgres` (porsager) or `pg` |
| Frontend | Vite, TypeScript, MapLibre GL JS 4, `pmtiles` protocol, deck.gl 9 |
| Ingest | `osmium-tool`, `osm2pgsql` (flex output) |
| Tiles | Protomaps `.pmtiles` extract, served statically |
| Container | Docker Compose |

No managed services. No Google APIs. No cloud dependency of any kind in the
prototype. Everything runs on `docker compose up`.

---

## 2. Repo layout

```
land/
  docker-compose.yml
  .env.example
  db/
    migrations/
      001_extensions.sql
      002_schema.sql
      003_functions.sql
      004_rls.sql
      005_seed_rulesets.sql
    lua/
      parcels.lua            # osm2pgsql flex profile
  ingest/
    fetch.sh                 # download pbf + pmtiles
    ingest.sh                # filter, import, derive
  api/
    src/
      index.ts
      routes/{auth,parcels,actions,tiles,world}.ts
      db.ts
    package.json
  web/
    src/{main.ts,map.ts,ui.ts,style.json}
    index.html
    package.json
  data/                      # gitignored: .pbf, .pmtiles
```

---

## 3. Data acquisition

`ingest/fetch.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p data

# Greater London OSM extract (~122 MB)
curl -L -o data/greater-london.osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf

# Protomaps basemap, London bbox only
# Get a current build date from https://maps.protomaps.com/builds
pmtiles extract "https://build.protomaps.com/${PMTILES_BUILD}.pmtiles" \
  data/london.pmtiles \
  --bbox=-0.5103,51.2868,0.3340,51.6919
```

`ingest/ingest.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Keep only named highway ways. Named is required: the search-by-street-name
# hook is the core discovery mechanic.
osmium tags-filter data/greater-london.osm.pbf \
  w/highway=residential,unclassified,tertiary,secondary,primary,living_street,pedestrian \
  -o data/roads.osm.pbf --overwrite

osm2pgsql --output=flex --style=db/lua/parcels.lua \
  -d "$PGDATABASE" -U "$PGUSER" -H "$PGHOST" \
  data/roads.osm.pbf

psql -f db/migrations/006_derive_parcels.sql
```

**Way merging.** OSM splits a single real street into many `way` rows at every
junction and tag change. Do not treat one way as one parcel — Oxford Street
would become forty parcels. `006_derive_parcels.sql` must group by
`(name, suburb)` and merge with `ST_LineMerge(ST_Collect(geom))`, then explode
multi-part results with `ST_Dump` so disjoint streets sharing a name stay
separate parcels. Assign `suburb` by spatial join against
`boundary=administrative admin_level=10` (London wards) or `place=suburb`
nodes, whichever gives better coverage — check both and pick.

Expect a significant reduction in row count at this step. If the merged parcel
count is not roughly an order of magnitude below the raw way count, the merge
is wrong.

---

## 4. Schema

`db/migrations/002_schema.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE rulesets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  config       JSONB NOT NULL
);

CREATE TABLE worlds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  ruleset_id   TEXT NOT NULL REFERENCES rulesets(id),
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','running','ended')),
  started_at   TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ
);

CREATE TABLE players (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id     UUID NOT NULL REFERENCES worlds(id),
  handle       TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (world_id, handle)
);

CREATE TABLE parcels (
  id                 BIGSERIAL PRIMARY KEY,
  world_id           UUID NOT NULL REFERENCES worlds(id),
  name               TEXT NOT NULL,
  suburb             TEXT,
  geom               geometry(LineString, 4326) NOT NULL,
  length_m           DOUBLE PRECISION NOT NULL,
  highway_class      TEXT NOT NULL,
  slots_total        INT NOT NULL,
  land_value         BIGINT NOT NULL,          -- assessed, mutable by tick
  improvement_value  BIGINT NOT NULL DEFAULT 0, -- derived from improvements
  owner_id           UUID REFERENCES players(id),
  acquired_at        TIMESTAMPTZ,
  lease_expires_at   TIMESTAMPTZ               -- NULL under freehold rulesets
);
CREATE INDEX parcels_geom_idx   ON parcels USING GIST (geom);
CREATE INDEX parcels_owner_idx  ON parcels (world_id, owner_id);
CREATE INDEX parcels_name_idx   ON parcels
  USING GIN (to_tsvector('english', name || ' ' || COALESCE(suburb,'')));

CREATE TABLE building_types (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cost         BIGINT NOT NULL,
  slots_used   INT NOT NULL,
  yield_bp     INT NOT NULL   -- basis points of cost paid per tick
);

CREATE TABLE improvements (
  id           BIGSERIAL PRIMARY KEY,
  parcel_id    BIGINT NOT NULL REFERENCES parcels(id),
  type_id      TEXT NOT NULL REFERENCES building_types(id),
  cost         BIGINT NOT NULL,   -- snapshot at build time
  slots_used   INT NOT NULL,      -- snapshot at build time
  built_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX improvements_parcel_idx ON improvements (parcel_id);

CREATE TABLE ticks (
  id               BIGSERIAL PRIMARY KEY,
  world_id         UUID NOT NULL REFERENCES worlds(id),
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ruleset_snapshot JSONB NOT NULL
);

-- Append only. No UPDATE, no DELETE, ever.
CREATE TABLE ledger (
  id            BIGSERIAL PRIMARY KEY,
  world_id      UUID NOT NULL REFERENCES worlds(id),
  tick_id       BIGINT REFERENCES ticks(id),
  from_account  TEXT NOT NULL,   -- 'bank' | 'treasury' | 'player:<uuid>'
  to_account    TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL,   -- 'purchase'|'build'|'income'|'tax'|'loan'|...
  parcel_id     BIGINT REFERENCES parcels(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account <> to_account)
);
CREATE INDEX ledger_from_idx ON ledger (world_id, from_account);
CREATE INDEX ledger_to_idx   ON ledger (world_id, to_account);

CREATE VIEW balances AS
SELECT world_id, account, SUM(delta)::BIGINT AS balance FROM (
  SELECT world_id, to_account   AS account,  amount AS delta FROM ledger
  UNION ALL
  SELECT world_id, from_account AS account, -amount AS delta FROM ledger
) t GROUP BY world_id, account;
```

`balance_of(world_id, account)` will be called on every action. If the ledger
grows past a few million rows and this becomes slow, add a materialised
`balance_cache` table maintained by trigger — but only then, and the ledger
stays the source of truth.

---

## 5. Ruleset config

Schema of `rulesets.config`:

```jsonc
{
  "currency": { "code": "GBP", "minor_units": 100 },
  "starting_loan": 5000000,          // minor units, recorded as a ledger debt
  "tick": { "interval": "24 hours" },

  "valuation": {
    "land_base": "length_m * class_weight * density_weight * 1000",
    "class_weights": {
      "primary": 4.0, "secondary": 2.5, "tertiary": 1.6,
      "residential": 1.0, "unclassified": 0.8,
      "living_street": 0.9, "pedestrian": 1.4
    },
    "density_source": "parcel_count_within_500m",
    "reassess_every_ticks": 7
  },

  "income": {
    "from_land_bp": 200,             // 2% of land_value per tick
    "from_improvements_bp": 800      // 8% of improvement_value per tick
  },

  "taxes": [
    { "id": "property", "base": "land_value + improvement_value", "rate_bp": 100 },
    { "id": "transfer",  "base": "sale_price", "rate_bp": 300, "on": "purchase" }
  ],

  "tenure": { "type": "freehold" },  // or "leasehold"
  "lease_term_ticks": null,
  "vacancy_penalty_bp": 0,           // charged on land_value if slots_used == 0

  "transfers": {
    "player_to_player": false,       // OFF in the prototype
    "max_multiple_of_assessed": 1.5
  }
}
```

`base` is evaluated by a small whitelisted expression evaluator server-side —
**not** `eval`, and not string-interpolated into SQL. Allowed identifiers:
`land_value`, `improvement_value`, `length_m`, `class_weight`,
`density_weight`, `sale_price`, `slots_used`, `slots_total`. Allowed
operators: `+ - * /` and parentheses. Reject anything else.

### Seed two rulesets

`uk-baseline` — as above. Approximates the current English system: tax falls
mostly on the built structure, transactions are taxed, land appreciation is
untaxed.

`lvt` — same file with:

```jsonc
{
  "taxes": [
    { "id": "lvt", "base": "land_value", "rate_bp": 500 }
  ],
  "vacancy_penalty_bp": 500,
  "income": { "from_land_bp": 200, "from_improvements_bp": 800 }
}
```

No transfer tax, no tax on improvements, heavy tax on land, and holding empty
land costs money. The observable difference between the two worlds is the
entire point of the project — do not tune either one to "win".

---

## 6. Server-side functions

All in `003_functions.sql`, all `SECURITY DEFINER`, all single-transaction.

```sql
-- Returns new balance, or raises.
purchase_parcel(p_player UUID, p_parcel BIGINT) RETURNS BIGINT
build_improvement(p_player UUID, p_parcel BIGINT, p_type TEXT) RETURNS BIGINT
demolish_improvement(p_player UUID, p_improvement BIGINT) RETURNS BIGINT
run_tick(p_world UUID) RETURNS BIGINT      -- returns tick_id
reassess_values(p_world UUID) RETURNS VOID
```

### `purchase_parcel` requirements

```sql
SELECT * FROM parcels WHERE id = p_parcel FOR UPDATE;   -- lock first
-- raise if owner_id IS NOT NULL
-- raise if parcel.world_id <> player.world_id
-- price := land_value + improvement_value
-- raise if balance_of(player) < price + transfer_tax
-- INSERT ledger: player -> bank, price, 'purchase'
-- INSERT ledger: player -> treasury, transfer_tax, 'tax:transfer'  (if any)
-- UPDATE parcels SET owner_id, acquired_at, lease_expires_at
```

The `FOR UPDATE` before the ownership check is what makes concurrent purchase
of the same parcel impossible. Two simultaneous requests must produce exactly
one success and one `parcel_already_owned` error.

### `run_tick` requirements

Set-based SQL only. **No loop over players or parcels in application code.**
Sequence:

1. `INSERT INTO ticks` with a snapshot of the world's ruleset config.
2. Recompute `improvement_value` per parcel as `SUM(improvements.cost)`.
3. If `tick_number % reassess_every_ticks == 0`, call `reassess_values`.
4. Insert income ledger rows: `bank -> player:<uuid>`, aggregated per player
   in one `INSERT ... SELECT`.
5. Insert tax ledger rows: `player:<uuid> -> treasury`, one `INSERT ... SELECT`
   per configured tax.
6. Under `tenure.type = 'leasehold'`, null out `owner_id` on parcels where
   `lease_expires_at < now()`.

Scheduled with `pg_cron`. Cadence comes from the ruleset, so the cron entry
calls a dispatcher that checks which worlds are due — it does not hardcode
`0 0 * * *`.

---

## 7. API

Fastify. Session cookie (`httpOnly`, `sameSite=lax`). Argon2id password
hashing. No JWT, no third-party auth in the prototype.

```
POST   /api/auth/register        {handle, password, world_id}
POST   /api/auth/login           {handle, password, world_id}
POST   /api/auth/logout
GET    /api/me                   -> {player, balance, parcel_count, net_worth}

GET    /api/worlds               -> [{id, name, ruleset_id, status}]
GET    /api/worlds/:id/ruleset   -> full config (read-only, for the UI)

GET    /api/parcels/search?q=    -> fuzzy name+suburb match, max 20
GET    /api/parcels/:id          -> parcel + improvements + owner handle
POST   /api/parcels/:id/buy      -> calls purchase_parcel
POST   /api/parcels/:id/build    {type_id} -> calls build_improvement

GET    /api/ledger?limit=50      -> the player's own rows, newest first
GET    /api/leaderboard          -> top 20 by net worth

GET    /tiles/parcels/:z/:x/:y.mvt
```

**Tiles.** Serve parcels as Mapbox Vector Tiles straight from PostGIS with
`ST_AsMVT`. Do not send GeoJSON of the whole city to the browser.

```sql
SELECT ST_AsMVT(q, 'parcels', 4096, 'geom') FROM (
  SELECT p.id, p.name, p.owner_id, p.land_value,
         ST_AsMVTGeom(ST_Transform(p.geom, 3857),
                      ST_TileEnvelope($1,$2,$3), 4096, 64, true) AS geom
  FROM parcels p
  WHERE p.world_id = $4
    AND p.geom && ST_Transform(ST_TileEnvelope($1,$2,$3), 4326)
) q;
```

Cache with `Cache-Control: max-age=10`. Ownership changes need to show up
quickly but not instantly.

Every mutating endpoint returns the new balance so the client never computes
money locally.

---

## 8. Frontend

Phase 1 target: flat map, ownership colouring, buy and build. 3D is Phase 3
and should not block a playable prototype.

- MapLibre GL JS with `pmtiles://` protocol pointed at `data/london.pmtiles`.
- Basemap style: Protomaps light or grey theme, heavily desaturated. The
  basemap must recede — game state is the only saturated thing on screen.
- **Suppress OSM building footprints entirely** in the style, or render them
  as flat untextured grey. If real buildings and player buildings look alike,
  the map is unreadable.
- Parcels layer from `/tiles/parcels/{z}/{x}/{y}.mvt`, `line-width` 4–8,
  coloured by ownership: unowned neutral, yours one colour, others another.
  Do not give every player a unique colour; it becomes noise fast.
- Search box hitting `/api/parcels/search`, flying to the result.
- Click a parcel → side panel with name, land value, improvement value,
  slots used/total, owner, and buy/build actions.
- A persistent HUD strip: balance, parcels owned, next tick countdown, and
  last tick's income and tax **shown separately**. Players must always be able
  to see what they earned and what was taken, and under which base.

### Phase 3 (3D, not required for prototype)

deck.gl `ScenegraphLayer`, low-poly glTF models placed at intervals along
parcel geometry with heading from segment bearing. Lock camera pitch to
40–60°, disable free orbit, overscale buildings 2–3x, cull models entirely
below zoom 15 and fall back to line colouring.

---

## 9. Invariants and tests

These must exist as automated tests. They are the difference between a
prototype and a toy.

**Money**
- Sum of all `balances.balance` across every account in a world equals zero at
  all times. Money is only ever moved, never created outside a ledger row.
- No code path anywhere issues money to a player except `starting_loan` and
  `income`.
- No test fixture, seed script, or admin endpoint mints money.

**Concurrency**
- Two concurrent `POST /parcels/:id/buy` for the same parcel: exactly one 200,
  one 409.
- Two concurrent builds that would jointly exceed `slots_total`: exactly one
  succeeds.

**Authorisation**
- A player cannot build on, demolish on, or sell a parcel they do not own.
- A player cannot act on a parcel in a different world.
- Direct `INSERT`/`UPDATE` on `parcels`, `improvements`, `ledger` as the API's
  DB role is rejected by RLS. The API role only has `EXECUTE` on the functions.

**Ruleset isolation**
- Running the same seeded world under `uk-baseline` and `lvt` for 30 ticks
  with identical scripted player actions produces different wealth
  distributions, and the only difference in the codebase is the ruleset row.
- Zero occurrences of a hardcoded tax rate or yield outside `rulesets.config`.
  Grep for numeric literals in the tick function as a review step.

**Data**
- Merged parcel count is roughly an order of magnitude below raw way count.
- No parcel has `slots_total < 1` or `length_m <= 0`.
- Spot-check ten known London streets by name and confirm each is a single
  parcel with plausible length.

---

## 10. Out of scope for the prototype

Do not build these yet. Each one obscures the economic signal or adds attack
surface before the core is proven.

- Player-to-player trading. `transfers.player_to_player` stays `false`.
- Chance cards, hazards, bulldozers, sabotage of any kind.
- 3D rendering.
- Land Registry price-paid calibration (Phase 4 — it replaces the synthetic
  `land_base` formula with real transaction data).
- Additional rulesets beyond `uk-baseline` and `lvt`.
- Any region outside Greater London.
- Email, password reset, social login.

---

## 11. Local run

```bash
cp .env.example .env
docker compose up -d db
psql -f db/migrations/001_extensions.sql   # ... through 005
./ingest/fetch.sh
./ingest/ingest.sh
docker compose up -d api web
# http://localhost:5173
```

Success condition for the prototype: two browser sessions can register, search
for a real London street by name, buy it, build on it, watch a tick pay income
and levy tax, and see every penny of that explained in their own ledger view.

---

## 12. Licensing and naming

- OSM data is ODbL 1.0. Display `© OpenStreetMap contributors` on the map.
  The `parcels` table is a Derivative Database; publicly redistributing that
  table triggers share-alike. Rendering it in a game is a Produced Work and
  needs attribution only.
- Protomaps basemap is an ODbL Produced Work requiring OSM attribution; its
  styles are CC0.
- Monopoly, Mr. Monopoly, and the board's visual language are Hasbro
  trademarks. Mechanics are not protectable, branding is. Do not reference
  Monopoly in any user-facing string, asset, or domain name.
