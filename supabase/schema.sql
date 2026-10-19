-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).

-- Editable model assumptions (tariffs, CAPEX, grid factor). Keys match
-- DEFAULT_ASSUMPTIONS in src/solar.js; any row here overrides the default.
create table if not exists public.assumptions (
  key text primary key,
  value numeric not null,
  unit text,
  source text,
  updated_at timestamptz not null default now()
);

insert into public.assumptions (key, value, unit, source) values
  ('specificYield', 1350, 'kWh/kWp/yr', 'Typical Klang Valley yield - verify'),
  ('panelDensity', 0.18, 'kWp/m2', 'Modern mono PERC incl. spacing'),
  ('emissionFactor', 0.758, 'kg CO2/kWh', 'Peninsular grid factor - verify latest Suruhanjaya Tenaga value'),
  ('tariffResidential', 0.45, 'RM/kWh', 'Placeholder - verify current TNB tariff'),
  ('tariffCommercial', 0.50, 'RM/kWh', 'Placeholder - verify current TNB tariff'),
  ('tariffIndustrial', 0.42, 'RM/kWh', 'Placeholder - verify current TNB tariff'),
  ('exportSMP', 0.30, 'RM/kWh', 'ATAP System Marginal Price (vendors quote 25-35 sen) - verify monthly SMP'),
  ('atapCapKw', 1000, 'kW', 'ATAP cap for non-domestic systems (1 MW)'),
  ('homeCapKw', 15, 'kW', 'ATAP cap for domestic systems'),
  ('loadFactor', 0.4, 'ratio', 'Converts annual demand to peak kW'),
  ('capexSmall', 4000, 'RM/kWp', 'Placeholder market rate < 50 kWp'),
  ('capexLarge', 2800, 'RM/kWp', 'Placeholder market rate >= 50 kWp'),
  ('minKwp', 3, 'kWp', 'Smallest system worth flagging')
on conflict (key) do nothing;

-- Shortlists saved from the app ("Save to Supabase" button).
create table if not exists public.shortlist_sites (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  township text not null,
  rank int not null,
  osm_id text not null,
  name text,
  category text,
  longitude double precision,
  latitude double precision,
  system_kwp numeric,
  annual_kwh numeric,
  payback_years numeric,
  co2_tonnes numeric,
  score int,
  flags text[]
);

alter table public.assumptions enable row level security;
alter table public.shortlist_sites enable row level security;

-- Demo policies: anyone with the publishable key can read assumptions and
-- read/add shortlist rows. Tighten (e.g. require auth) before real use.
drop policy if exists "public read assumptions" on public.assumptions;
create policy "public read assumptions" on public.assumptions for select using (true);

drop policy if exists "public read shortlist" on public.shortlist_sites;
create policy "public read shortlist" on public.shortlist_sites for select using (true);

drop policy if exists "public insert shortlist" on public.shortlist_sites;
create policy "public insert shortlist" on public.shortlist_sites for insert with check (true);
