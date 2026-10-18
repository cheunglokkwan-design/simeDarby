# simeDarby: Solar Opportunity Mapper

Sime Darby Property *Township of Tomorrow* University Hackathon 2026 · **PLANET: choosing the right sites for solar**

A 3D web app, built entirely from open data, that ranks every rooftop and car park in
three SDP townships by solar opportunity. It also shows how much each number can be
trusted. Submission deadline: **11:59 PM, 23 October 2026** ([phase plan](docs/PLAN.md)).

```
Overture Maps (OSM + Google + Microsoft footprints, places, land use, car parks)
        │  pipeline/  (Python, offline, deterministic)
        ▼  boundary → building type → height + confidence → kWp / kWh / tCO₂ → export
public/data/<township>.json
        │  web app (Vite + deck.gl + MapLibre, all in the browser)
        ▼  3D extrusion → live sun & shadows → shading raycast → demand, ROI, score → shortlist
```

## Townships

Before shading, for candidate roofs only (non-residential, apartments, unknown; at least 100 m²):

| Township | Buildings | AI-traced outlines | Candidate roofs | kWp | MWh/yr | Top site |
|---|---|---|---|---|---|---|
| City of Elmina | 2,587 | 52% | 183 | 30,902 | 41,717 | Google data centre plot, Elmina Business Park |
| Ara Damansara | 6,743 | 34% | 1,561 | 124,050 | 167,464 | Paradigm Mall |
| Bandar Bukit Raja | 3,496 | 54% | 585 | 62,579 | 84,481 | Industrial sheds, ~30k m² each |

"AI-traced" means the outline comes from Google Open Buildings or Microsoft ML Buildings
rather than OpenStreetMap. Without them, a third to a half of each township would be
missing. The app's headline totals also include landed homes and car-park canopies.

## What the app does

| Feature | How |
|---|---|
| **Procedural 3D township** | Footprints extruded with deck.gl on a MapLibre basemap |
| **Building type and height** | From the pipeline. Evidence used, strongest first: building tags, names (Malay and English), POIs, land use, footprint shape, size. Every building records which source it used and a confidence score (`pipeline/README.md`) |
| **Data confidence view** | Colour by *Data confidence* (height and type mapped vs guessed) or *Footprint source* (people vs AI). The detail panel lists data-quality flags |
| **Line-of-sight shading** | A Web Worker casts rays from each roof towards 40+ sun positions across the year, against neighbouring buildings (`src/shading.worker.js`) |
| **Live sun and shadows** | Month and time sliders drive deck.gl's sun light |
| **Demand proxy and self-consumption** | Building type → base-load intensity and daytime share (`src/solar.js`) |
| **Car-park canopies** | Surface car parks shown as proposed 4.5 m solar canopies |
| **ROI calculator** | kWp, kWh/yr, CAPEX, savings, payback. Assumptions are editable and can be overridden from Supabase |
| **Carbon tracker** | kWh × grid emission factor, per site and per township |
| **Engineering flags** | Too small, heavy shading, heritage/religious zoning review, strata approval, utility asset |
| **Community micro-grids** | Arcs from high-surplus commercial roofs to nearby schools and clinics |
| **Exportable shortlist** | Ranked CSV including data-quality columns; optionally saved to Supabase |
| **3D micro-verification** | `splat.html`, a Gaussian splat viewer ([how to make your own](docs/splat-pipeline.md)) |

## Run the app

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (deploy to Vercel / Netlify)
```

The **Re-fetch live OSM data** button swaps in raw OpenStreetMap data from Overpass, using
the app's own tag-based typing. `npm run fetch-osm` saves the same raw snapshots to
`public/data/osm/` for comparison.

## Refresh the data (pipeline)

Python 3.11+. On the first run it downloads about 6–15 MB per township from Overture.

```bash
cd pipeline
uv venv && uv pip install -e ".[dev]"      # or: python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/solar-mapper run --township elmina          # also: ara-damansara, bandar-bukit-raja
.venv/bin/pytest
```

`run` does three things:
- `phase1`: buildings, type, height and candidates;
- `phase2`: solar potential;
- `export-app`: writes `public/data/<township>.json`.

Outputs are deterministic and committed under `data/processed/<township>/`. To add a
township, add `pipeline/config/townships/<id>.yaml` and an entry in `src/townships.js`.
Method, results and limitations: [`pipeline/README.md`](pipeline/README.md).

## Supabase (optional)

1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. `cp .env.example .env.local` and fill in `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Restart `npm run dev`. The footer then shows "Assumptions from Supabase", and a
   **Save to Supabase** button appears next to the shortlist.

Only the publishable key goes in `VITE_*` variables. The secret and service-role keys must
never be exposed to the browser.

## Model assumptions

All numbers are demo placeholders, shared by `DEFAULT_ASSUMPTIONS` (`src/solar.js`) and
`pipeline/config/assumptions.yaml`. A test (`pipeline/tests/test_app_export.py`) keeps the two
in sync. Before quoting results in the pitch, check them against:
- PVGIS specific yield
- current TNB tariffs
- SEDA NEM 3.0 rules
- the Suruhanjaya Tenaga grid emission factor

## Data and credits

- Buildings, land use, car parks, places: [Overture Maps](https://overturemaps.org) `2026-09-23.1`
  - buildings and land use: ODbL, © OpenStreetMap contributors, Google Open Buildings, Microsoft ML Buildings
  - places: CDLA Permissive 2.0
- Basemap: © CARTO. Satellite imagery: © Esri.
- Sample splat: Tanks & Temples "train" scene via antimatter15/splat.
