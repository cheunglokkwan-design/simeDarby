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

## One lead story: choose which sites to study first

For SDP development and sustainability teams, the app ranks mapped rooftops and
car parks for detailed solar feasibility studies. The opening screen and tour
follow the same journey: **rank sites → explain the recommendation → review
missing evidence → export a study shortlist**. This follows the supplied PLANET
brief's "Choosing the right sites for solar" problem.

Priority scores are heuristic, not validated engineering suitability or measured
accuracy. Users can select candidates, persist a separate shortlist per township,
and export CSV, geographic outlines, a JSON evidence/assumptions bundle and an
expert review template. Expert assessment fields start blank; no comparison
results, field accuracy or successful hosted GPU run are claimed.

**Community solar** and **Battery storage** are visible secondary workspaces.
Home finance remains a supporting disclosure. Drone scans and panel layouts are
optional aids within the evidence review. The [demo run sheet](docs/hackathon-demo-run-sheet.md)
keeps the recording focused on one site and its study handover.

## Supporting analysis

| Tab | Question it answers |
|---|---|
| **Site screening** (default) | Which rooftops and car parks should receive detailed feasibility studies first? |
| **Community solar** | Which proposed home-roof groups could supply nearby businesses? Home finance is a supporting disclosure. |
| **Battery storage** | Where could storage be worth further assessment? |

The expandable capacity summary separates modelled MWp on all viable mapped roofs →
MWp with no mapped heritage or strata flags → MWp that pays back within 7 years, with the energy, CO₂ and savings
of that last set. Select a site to keep its candidate list visible alongside **Priority → Evidence → Handover** on desktop. On phones, the study workspace opens full-screen with a **View map** switch. **Demo tour** walks through the screening story.

## What it does

| Feature | How it works in the demo |
|---|---|
| **Procedural 3D township** | OpenStreetMap footprints from the Overpass API, extruded with deck.gl on a MapLibre basemap |
| **Height estimation** | OSM `height` → `building:levels` × 3.2 m → default by building type → footprint-size inference (`src/heights.js`) |
| **Line-of-sight shading** | Web Worker raycasts from interior roof/canopy samples toward sun positions on four representative dates. This is sampled building-shadow exposure used as a yield proxy, not measured annual irradiation (`src/shading.worker.js`) |
| **Live sun & shadows** | Month and time sliders (on the Find roofs tab) drive deck.gl's sun light with real-time shadows |
| **Demand proxy scoring** | Building type → energy intensity × floors (OSM-tagged floors only; untagged sheds count as one floor) and daytime share → self-consumption ratio (`src/solar.js`) |
| **Car park canopies** | OSM surface car parks shown as proposed 4.5 m solar canopies; they receive building-shadow calculations and need a linked host load, daytime share and tariff before savings/payback are shown |
| **ROI calculator** | kWp, kWh/yr, CAPEX, savings, O&M, payback. Business solar is credited at the energy charge only (per-kW capacity and network charges are left to batteries). Assumptions are editable and can be overridden from Supabase |
| **Financial scenario assumptions** | Editable export values and system caps are screening assumptions; verify the applicable scheme, tariff and connection before relying on them |
| **pvlib yield model** | Hourly PVGIS-ERA5 2005–2023 per township: Perez transposition, SAPM temperature, DC/AC 1.2 clipping, 0.5 %/yr degradation, P50/P90 across weather years, roof tilt and orientation from the footprint (`scripts/pvlib_yield.py`) |
| **Grid checks** | Distance to the nearest OSM-mapped substation, flagged beyond 1 km (shown, not scored, because coverage is incomplete) |
| **Solar homes & CREAM** | Per-home options (buy, add to the mortgage, lease the roof); CREAM zones match leased roofs to buyers within 5 km at each buyer's tariff less a discount, with the 9 sen/kWh access charge, O&M, lease income and the install price needed for a 10-year payback (`src/cream.js`) |
| **Battery storage** | Behind-the-meter candidates sized and valued with NREL PySAM peak-shaving dispatch on load archetypes, with grid, flood, fire and space siting checks (`scripts/pysam_storage.py`, `src/storage.js`) |
| **Carbon offset tracker** | kWh × grid emission factor gives tonnes CO₂ per site and per township |
| **Engineering flags** | Too small, heavy shading, heritage/religious zoning review, strata approval |
| **Study shortlist** | Selected portfolio totals, source-referenced panel checks, reported property control, study actions and an initial selection snapshot. Excluded/on-hold selections remain visible but are omitted from active portfolio totals |
| **Study export** | Printable site and portfolio briefs, CSV expert-review templates, evidence/assumptions JSON, GeoJSON and KML. Warnings and study metadata follow the selected sites; PDF uses the browser print dialog |
| **Affordable housing** | Affordable-scheme blocks flagged as CREAM lease-income candidates (`src/affordable.js`) |
| **Open roof registry** | Every roof per township as open GeoJSON under ODbL (`registry/`, `npm run registry`) |
| **Google Solar comparison script** | A configurable capacity-comparison script for sampled homes (`npm run google-check`, needs your own API key); the presence of the script does not establish completed validation |
| **Drone scans** | Per-roof Gaussian splats registered in `public/splats/scans.json`, viewed in-app with our predicted outline and panel area overlaid, an Align tool and a findings checklist (see `docs/drone-scans.md`) |

Townships included: **Ara Damansara** (~4.6k buildings) and **Bandar Bukit Raja** (~7.3k buildings).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173.

Select a site to open **Priority → Evidence → Handover**. Review the missing
checks, add it to the study shortlist and export for expert assessment. Optional
roof review supports a mapped draft, blocked areas and 3D scans. Draft
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
