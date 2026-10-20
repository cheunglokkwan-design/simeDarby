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
| **Solar ATAP economics** | Exports paid at the System Marginal Price; systems capped at 1 MW or peak demand (15 kW for homes) |
| **pvlib yield model** | Hourly PVGIS-ERA5 2005–2023 per township: Perez transposition, SAPM temperature, DC/AC 1.2 clipping, 0.5 %/yr degradation, P50/P90 across weather years, roof tilt and orientation from the footprint (`scripts/pvlib_yield.py`) |
| **Grid checks** | Distance to the nearest OSM-mapped substation, flagged beyond 1 km (shown, not scored, because coverage is incomplete) |
| **CREAM planner** | Clusters landed-home roofs and matches them to buyers within 5 km, with the 9 sen/kWh access charge and homeowner lease income (`src/cream.js`) |
| **Battery storage** | Behind-the-meter candidates sized and valued with NREL PySAM peak-shaving dispatch on load archetypes, with grid, flood, fire and space siting checks (`scripts/pysam_storage.py`, `src/storage.js`) |
| **Carbon offset tracker** | kWh × grid emission factor gives tonnes CO₂ per site and per township |
| **Engineering flags** | Too small, heavy shading, heritage/religious zoning review, strata approval |
| **Community micro-grids** | Arcs from high-surplus commercial roofs to nearby schools and clinics |
| **Exportable shortlist** | Ranked CSV, GeoJSON and KML (extruded for Google Earth; loads into QGIS, HelioScope or PVsyst), optionally saved to Supabase |
| **Site brief** | One-page pre-feasibility brief per site (panels, P50/P90 output, savings, CO₂, battery option, footprint plan), saved as PDF from the browser |
| **Affordable housing** | Affordable-scheme blocks flagged as CREAM lease-income candidates (`src/affordable.js`) |
| **Open roof registry** | Every roof per township as open GeoJSON under ODbL (`registry/`, `npm run registry`) |
| **Google Solar API check** | Compares our roof capacity with Google's for 30 sampled homes (`npm run google-check`, needs your own API key) |
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

### Regenerating the yield and battery data (Python)

The results are already in `public/data/` (`yield-*.json`, `storage-*.json`), so this is only
needed after changing townships or model settings:

```bash
pip install pvlib nrel-pysam
python scripts/pvlib_yield.py      # fetches PVGIS-ERA5 hourly data, ~1 min per township
python scripts/pysam_storage.py    # runs PySAM battery dispatch on the typical-year profile
```

See `docs/competitors.md` for the deck's competitor table.

### Registry and Google check

```bash
npm run registry                    # rebuild registry/<township>.geojson
npm run google-check -- --dry-run   # list the 30 sampled homes without calling Google
npm run google-check                # needs GOOGLE_SOLAR_API_KEY in .env.local; writes docs/google-solar-check.md
```

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
