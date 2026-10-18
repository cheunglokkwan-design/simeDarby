# simeDarby: Solar Opportunity Mapper

Sime Darby Property *Township of Tomorrow* hackathon (PLANET track: choosing the right sites for solar).

A 3D web demo, built from open data, that ranks every rooftop and car park in a
township by solar opportunity.

## What it does

| Feature | How it works in the demo |
|---|---|
| **Procedural 3D township** | OpenStreetMap footprints from the Overpass API, extruded with deck.gl on a MapLibre basemap |
| **Height estimation** | OSM `height` → `building:levels` × 3.2 m → default by building type → footprint-size inference (`src/heights.js`) |
| **Line-of-sight shading** | Web Worker raycasts from each roof toward 40+ sun positions across the year, against neighbouring buildings, giving an annual unshaded fraction (`src/shading.worker.js`) |
| **Live sun & shadows** | Month and time sliders drive deck.gl's sun light with real-time shadows |
| **Demand proxy scoring** | Building type → base-load intensity and daytime share → self-consumption ratio (`src/solar.js`) |
| **Car park canopies** | OSM surface car parks shown as proposed 4.5 m solar canopies |
| **ROI calculator** | kWp, kWh/yr, CAPEX, savings, payback. Assumptions are editable and can be overridden from Supabase |
| **Carbon offset tracker** | kWh × grid emission factor gives tonnes CO₂ per site and per township |
| **Engineering flags** | Too small, heavy shading, heritage/religious zoning review, strata approval |
| **Community micro-grids** | Arcs from high-surplus commercial roofs to nearby schools and clinics |
| **Exportable shortlist** | Ranked CSV, and optionally saved to the Supabase `shortlist_sites` table |
| **3D micro-verification** | `splat.html`, a Gaussian splat viewer (open-source sample now, drone splat later: see `docs/splat-pipeline.md`) |

Townships included: **Ara Damansara** (~4.6k buildings) and **Bandar Bukit Raja** (~7.3k buildings).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173.

- `npm run fetch-osm`: refresh the cached OSM snapshots in `public/data/`
  (the app works offline from these; the "Re-fetch live OSM data" button pulls fresh data in the browser).
- `npm run build`: production build into `dist/` (deploy to Vercel/Netlify as a static site).

## Supabase (optional)

1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. `cp .env.example .env.local` and fill in `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Restart `npm run dev`. The footer shows "Assumptions from Supabase" and a
   **Save to Supabase** button appears next to the shortlist.

Only the publishable key goes in `VITE_*` variables. The secret and service-role keys must never be exposed to the browser.

## Model assumptions

All numbers in `DEFAULT_ASSUMPTIONS` (`src/solar.js`) are demo placeholders.
Check them against current TNB tariffs, SEDA NEM 3.0 rules and the Suruhanjaya Tenaga
grid emission factor before quoting results in the pitch.

## Data & credits

- Buildings, car parks, community facilities: © OpenStreetMap contributors (ODbL)
- Basemap: © CARTO; satellite imagery: © Esri
- Sample splat: Tanks & Temples "train" scene via antimatter15/splat

---

# Data pipeline (City of Elmina)

Sime Darby Property University Hackathon 2026 · **PLANET: choosing the right sites for solar**

Ranks rooftops and car parks in an SDP township by usable area, shading and electricity
demand, flags missing data, and translates the shortlist into tonnes of CO₂ avoided.
Pilot township: **City of Elmina**, Shah Alam.

Submission deadline: **11:59 PM, 23 October 2026**. See [`docs/PLAN.md`](docs/PLAN.md) for the phase plan.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Repo, config, township boundary | Done |
| 1 | Data foundation: buildings, kind, height, candidates | Done (Street View spot-check pending) |
| 2 | Solar potential (kWp, kWh, tCO₂) | Done: 183 candidate roofs, 30.9 MWp, 41.7 GWh/yr before shading |
| 3 | 3D map app skeleton + deploy | Next (in parallel) |
| 4–9 | Shading, demand & scoring, car parks & ESG, validation, pitch, submit | Planned |

## Repository layout

```
pipeline/                  Python data pipeline (offline)
  config/assumptions.yaml  every modelling constant, with its rationale
  config/townships/        per-township settings (bbox, Overture release)
  config/boundaries/       derived township boundary (GeoJSON)
  solar_mapper/            the package
  tests/                   pytest suite
data/
  raw/                     Overture downloads (git-ignored, re-creatable)
  processed/<township>/    pipeline outputs the web app reads (committed)
web/                       React + Vite + TypeScript app (map arrives in Phase 3)
docs/                      plan and method notes
```

## Quick start

Pipeline (Python 3.11+):

```bash
cd pipeline
uv venv && uv pip install -e ".[dev]"     # or: python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/solar-mapper phase1 --township elmina   # downloads ~6 MB from Overture on first run
.venv/bin/solar-mapper phase2 --township elmina   # solar potential -> data/processed/elmina/sites.*
.venv/bin/pytest
```

Web app:

```bash
cd web
npm install
npm run dev
```

## Data and licences

Building footprints, land use and places come from [Overture Maps](https://overturemaps.org)
release `2026-09-23.1`, which combines OpenStreetMap, Google Open Buildings and Microsoft
ML Buildings. Buildings and land use are ODbL (contains © OpenStreetMap contributors); places
are CDLA Permissive 2.0. Each record keeps its source in the `source_dataset` column.
