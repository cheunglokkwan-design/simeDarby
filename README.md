# simeDarby: Solar Opportunity Mapper

Sime Darby Property *Township of Tomorrow* hackathon (PLANET track: choosing the right sites for solar).

Solar Opportunity Mapper is a 3D web map that shows which rooftops and car parks in a township are
worth putting solar on. It uses free, open data: building outlines and grid substations from
OpenStreetMap, plus 19 years of hourly weather data. It covers every building in Ara Damansara and
Bandar Bukit Raja, about 12,000 in total. It estimates each roof's height, checks how much the
neighbouring buildings shade it across the year, and models its yearly output with pvlib, the
open-source engine industry tools are built on. From that it works out each site's system size,
cost, bill savings, payback time and CO₂ avoided, using Malaysia's Solar ATAP rules; battery savings
are modelled with NREL's PySAM. Shortlisted roofs can be checked with a drone scan, which shows the
model's predicted roof outline over a 3D capture of the real roof. Each site has a printable one-page
brief, the ranked shortlist exports to CSV, GeoJSON or KML, and every roof's estimates are published
as an open dataset. All figures are early estimates for screening sites, not survey-grade results,
and the tariffs and costs are editable placeholders.

## One lead story: solar-ready homes

The app and demo tour open on the homeowner's monthly outcome: modelled bill
reduction minus an illustrative fully financed solar payment and assumed upkeep.
The example is a median-size mapped single home, not a verified SDP property or
customer offer. Business roofs, CREAM leasing and batteries support the main story.
No field accuracy, validated customer saving or successful hosted GPU run is claimed.

## Supporting analysis

| Tab | Question it answers |
|---|---|
| **1. Find roofs** | Which roofs and car parks should get solar, and what do they save? |
| **2. Community solar** | Which proposed groups of home roofs could share power with nearby buyers, and what does each household get? |
| **3. Store energy** | Where does a battery make the most sense, and how long does it take to pay back? |

The expandable capacity summary separates modelled MWp on all viable mapped roofs →
MWp with no mapped heritage or strata flags → MWp that pays back within 7 years, with the energy, CO₂ and savings
of that last set. Click any site for a card with four headline numbers and expandable detail; **▶ Tour**
walks through the story for the demo video.

## What it does

| Feature | How it works in the demo |
|---|---|
| **Procedural 3D township** | OpenStreetMap footprints from the Overpass API, extruded with deck.gl on a MapLibre basemap |
| **Height estimation** | OSM `height` → `building:levels` × 3.2 m → default by building type → footprint-size inference (`src/heights.js`) |
| **Line-of-sight shading** | Web Worker raycasts from each roof toward 40+ sun positions across the year, against neighbouring buildings, giving an annual unshaded fraction (`src/shading.worker.js`) |
| **Live sun & shadows** | Month and time sliders (on the Find roofs tab) drive deck.gl's sun light with real-time shadows |
| **Demand proxy scoring** | Building type → energy intensity × floors (OSM-tagged floors only; untagged sheds count as one floor) and daytime share → self-consumption ratio (`src/solar.js`) |
| **Car park canopies** | OSM surface car parks shown as proposed 4.5 m solar canopies |
| **ROI calculator** | kWp, kWh/yr, CAPEX, savings, O&M, payback. Business solar is credited at the energy charge only (per-kW capacity and network charges are left to batteries). Assumptions are editable and can be overridden from Supabase |
| **Solar ATAP economics** | Exports paid at the System Marginal Price; systems capped at 1 MW or peak demand (15 kW for homes) |
| **pvlib yield model** | Hourly PVGIS-ERA5 2005–2023 per township: Perez transposition, SAPM temperature, DC/AC 1.2 clipping, 0.5 %/yr degradation, P50/P90 across weather years, roof tilt and orientation from the footprint (`scripts/pvlib_yield.py`) |
| **Grid checks** | Distance to the nearest OSM-mapped substation, flagged beyond 1 km (shown, not scored, because coverage is incomplete) |
| **Solar homes & CREAM** | Per-home options (buy, add to the mortgage, lease the roof); CREAM zones match leased roofs to buyers within 5 km at each buyer's tariff less a discount, with the 9 sen/kWh access charge, O&M, lease income and the install price needed for a 10-year payback (`src/cream.js`) |
| **Battery storage** | Behind-the-meter candidates sized and valued with NREL PySAM peak-shaving dispatch on load archetypes, with grid, flood, fire and space siting checks (`scripts/pysam_storage.py`, `src/storage.js`) |
| **Carbon offset tracker** | kWh × grid emission factor gives tonnes CO₂ per site and per township |
| **Engineering flags** | Too small, heavy shading, heritage/religious zoning review, strata approval |
| **Exportable shortlist** | Ranked CSV, GeoJSON and KML (extruded for Google Earth; loads into QGIS, HelioScope or PVsyst), optionally saved to Supabase |
| **Site brief** | One-page pre-feasibility brief per site (panels, P50/P90 output, savings, CO₂, battery option, footprint plan), saved as PDF from the browser |
| **Affordable housing** | Affordable-scheme blocks flagged as CREAM lease-income candidates (`src/affordable.js`) |
| **Open roof registry** | Every roof per township as open GeoJSON under ODbL (`registry/`, `npm run registry`) |
| **Google Solar API check** | Compares our roof capacity with Google's for 30 sampled homes (`npm run google-check`, needs your own API key) |
| **Drone scans** | Per-roof Gaussian splats registered in `public/splats/scans.json`, viewed in-app with our predicted outline and panel area overlaid, an Align tool and a findings checklist (see `docs/drone-scans.md`) |

Townships included: **Ara Damansara** (~4.6k buildings) and **Bandar Bukit Raja** (~7.3k buildings).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173.

Select a building to open its three-step workspace: **Potential → Roof & panels
→ Brief**. Generate a mapped-roof draft, mark blocked areas, or add a 3D scan;
then open the printable site brief. Draft
panel layouts and finished-splat imports work locally. Video reconstruction uses
the included [remote GPU worker](docs/drone-worker.md), which needs hosting and
server-side connection settings before footage can be processed. Draft layouts
use the mapped footprint; roof planes and obstacles still require review.

Community-solar boundaries are proposed geographic groups, with ownership and
feeder checks pending. See the [zoning audit](docs/zoning-audit.md).

Search mapped properties by building name, mapped address or OSM ID. Every result
can be selected by keyboard, and more results are available below the list.
**Improve estimate with site evidence** accepts occupied-storey counts, annual
electricity use, metered peak demand and surveyed usable area. Corrections are
saved in the browser and recalculate capacity, savings, rankings and draft layouts.
The layout preview also supports manually marked blocked regions; these remove
panels and reduce the proposal where needed. This is reviewed mapped geometry,
not automatic extraction of roof planes from video. See the
[validation plan](docs/validation-plan.md) for the remaining evidence needed.

- `npm run fetch-osm`: refresh the cached OSM snapshots in `public/data/`
  (the app works offline from these; the "Re-fetch live OSM data" button pulls fresh data in the browser).
- `npm run build`: production build into `dist/`. Deploy as a static site (Vercel, Netlify, or any web server).
  For a sub-path such as GitHub Pages, build with `BASE=/simeDarby/ npm run build`.
- The app needs internet access for the basemap (CARTO), satellite imagery (Esri) and the sample 3D scene; the building data itself is bundled.

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
3. Restart `npm run dev`. ⚙ Settings → Data says "Assumptions loaded from Supabase", and
   **Save shortlist to Supabase** appears in the Export menu.

The demo policies in `schema.sql` let anyone with the publishable key read assumptions and add
shortlist rows. Require sign-in before real use.

Only the publishable key goes in `VITE_*` variables. The secret and service-role keys must never be exposed to the browser.

## Model assumptions

All numbers in `DEFAULT_ASSUMPTIONS` (`src/solar.js`) are demo placeholders.
Check them against current TNB tariffs, SEDA's Solar ATAP rules and the Suruhanjaya Tenaga
grid emission factor before quoting results in the pitch. Known limits: ERA5 weather data tends to
overstate sunshine in the humid tropics, so treat yields as ±8%; P90 reflects year-to-year weather only.

## Data & credits

- Buildings, car parks, community facilities: © OpenStreetMap contributors (ODbL)
- Basemap: © CARTO; satellite imagery: © Esri
- Sample splat (viewer test only): Tanks & Temples "train" scene via antimatter15/splat
- Code: MIT (see `LICENSE`); data: ODbL
