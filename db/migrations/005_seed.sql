-- =====================================================================
-- Tycoon: seed data. Rulesets, worlds and building types.
-- Existing rows are left alone, so your own edits survive a re-run.
-- To try a new economic model, INSERT a new ruleset and a world using it.
-- =====================================================================

INSERT INTO tycoon.rulesets (id, name, description, config) VALUES
('uk-baseline', 'UK baseline',
 'Approximates the current English system: tax falls mostly on the built structure, purchases pay a transfer tax, and land appreciation is untaxed.',
 $json$
 {
   "currency": { "code": "GBP", "symbol": "£", "minor_units": 100 },
   "starting_loan": 5000000,
   "tick": { "interval": "1 hour", "max_catch_up": 24 },

   "valuation": {
     "land_base": "length_m * class_weight * density_weight * 1000",
     "class_weights": {
       "trunk": 4.0, "primary": 4.0, "secondary": 2.5, "tertiary": 1.6,
       "residential": 1.0, "unclassified": 0.8,
       "living_street": 0.9, "pedestrian": 1.4
     },
     "density_source": "parcel_count_within_500m",
     "density": { "radius_m": 500, "base": 1.0, "per_neighbour": 0.05, "max": 3.0 },
     "reassess_every_ticks": 7
   },

   "slots": { "metres_per_slot": 40, "min": 1, "max": 16 },

   "income": {
     "from_land_bp": 200,
     "from_improvements_bp": 800
   },

   "taxes": [
     { "id": "property", "base": "land_value + improvement_value", "rate_bp": 100 },
     { "id": "transfer", "base": "sale_price", "rate_bp": 300, "on": "purchase" }
   ],

   "tenure": { "type": "freehold" },
   "lease_term_ticks": null,
   "vacancy_penalty_bp": 0,

   "transfers": {
     "player_to_player": false,
     "max_multiple_of_assessed": 1.5
   }
 }
 $json$::jsonb),
('lvt', 'Land value tax',
 'No transfer tax and no tax on buildings, but a heavy tax on land value every tick, and holding empty land costs extra.',
 $json$
 {
   "currency": { "code": "GBP", "symbol": "£", "minor_units": 100 },
   "starting_loan": 5000000,
   "tick": { "interval": "1 hour", "max_catch_up": 24 },

   "valuation": {
     "land_base": "length_m * class_weight * density_weight * 1000",
     "class_weights": {
       "trunk": 4.0, "primary": 4.0, "secondary": 2.5, "tertiary": 1.6,
       "residential": 1.0, "unclassified": 0.8,
       "living_street": 0.9, "pedestrian": 1.4
     },
     "density_source": "parcel_count_within_500m",
     "density": { "radius_m": 500, "base": 1.0, "per_neighbour": 0.05, "max": 3.0 },
     "reassess_every_ticks": 7
   },

   "slots": { "metres_per_slot": 40, "min": 1, "max": 16 },

   "income": {
     "from_land_bp": 200,
     "from_improvements_bp": 800
   },

   "taxes": [
     { "id": "lvt", "base": "land_value", "rate_bp": 500 }
   ],

   "tenure": { "type": "freehold" },
   "lease_term_ticks": null,
   "vacancy_penalty_bp": 500,

   "transfers": {
     "player_to_player": false,
     "max_multiple_of_assessed": 1.5
   }
 }
 $json$::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tycoon.worlds (slug, name, ruleset_id) VALUES
  ('classic',  'Classic',  'uk-baseline'),
  ('landtax',  'Land Tax', 'lvt')
ON CONFLICT (slug) DO NOTHING;

-- Costs in minor units (pence). yield_bp multiplies the ruleset's
-- improvement yield: 10000 = 1x, 12000 = 1.2x.
INSERT INTO tycoon.building_types (id, name, description, cost, slots_used, yield_bp, sort_order) VALUES
  ('cottage',    'Cottage',          'A modest little home.',                    200000,  1, 10000, 1),
  ('house',      'House',            'A solid two-storey family house.',         500000,  1, 10000, 2),
  ('terrace',    'Terrace',          'A row of three townhouses.',              1200000,  2, 10500, 3),
  ('shops',      'Shopping Parade',  'Shops at street level.',                  2000000,  2, 11000, 4),
  ('apartments', 'Apartment Block',  'Six storeys of flats.',                   3000000,  3, 11000, 5),
  ('office',     'Office Block',     'Glass and steel for the nine-to-five.',   7500000,  4, 11500, 6),
  ('tower',      'Tower',            'A landmark high-rise.',                  20000000,  6, 12000, 7),
  ('skyscraper', 'Skyscraper',       'Owns the skyline.',                      60000000, 10, 12500, 8)
ON CONFLICT (id) DO NOTHING;
