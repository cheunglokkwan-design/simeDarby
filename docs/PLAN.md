# Phase plan: Solar Opportunity Mapper (Section 1)

Defaults: City of Elmina · Python pipeline · React + deck.gl + MapLibre · AI car-park detection is a stretch goal only.
Deadline: **11:59 PM, Fri 23 Oct 2026**. Target submission time: 6 PM.

| Phase | When | Track | Output | Status |
|---|---|---|---|---|
| 0. Setup | Sun 18 | All | Repo skeleton, config, boundary | Done |
| 1. Data foundation | Sun 18 – Mon 19 AM | Pipeline | Every building with a height and a confidence flag | Done (spot-check pending) |
| 2. Solar potential | Mon 19 | Pipeline | kWp and kWh per roof | Done (yield and emission factor still placeholders) |
| 3. App skeleton | Mon 19 (parallel) | Web | Live URL with 3D buildings | Done: `solar-demo` merged and fed by the pipeline for 3 townships; Vercel deploy pending |
| 4. Shading | Tue 20 | Pipeline + Web | Shading loss %, sun slider | |
| 5. Demand and scoring | Tue 20 | Pipeline + Web | Ranked shortlist, CSV export | |
| 6. Car parks and ESG | Wed 21 | Pipeline + Web | Car-park canopies, CO₂ tracker | |
| 7. Validation | Wed 21 | Research | Accuracy numbers for the deck | |
| 8. Freeze, pitch, video | Thu 22 | All | 10-slide deck, 5-min video | |
| 9. Submit | Fri 23 | All | Submitted by 6 PM | |

## Existing work on the `solar-demo` branch

A teammate's JavaScript demo (Vite + deck.gl + MapLibre, all computed in the browser from
OpenStreetMap via Overpass) already covers much of Phases 3–6, for **Ara Damansara** and
**Bandar Bukit Raja**:
- 3D extrusion with OSM-tag height estimates
- a shading Web Worker (4 days × hourly sun positions, 3 sample points per roof)
- sun and shadow sliders
- a demand proxy and self-consumption ratio
- car-park canopies
- ROI and payback, with editable assumptions overridable from Supabase
- CO₂ per site and per township
- engineering flags and community micro-grid arcs
- a CSV shortlist
- a Gaussian-splat viewer

The pipeline's Phase 2 deliberately reuses its constants (`DEFAULT_ASSUMPTIONS`,
`USABLE_FRACTION`), so the numbers agree.

| | `solar-demo` (JS, in browser) | `pipeline/` (Python, offline) |
|---|---|---|
| Townships | Ara Damansara, Bandar Bukit Raja | City of Elmina |
| Footprints | OSM only | OSM + Google + Microsoft (Overture), so ML footprints fill OSM gaps |
| Building type | OSM tags, then footprint size | Tags, names (Malay and English), POIs, land use, shape, size, each with its source |
| Heights | tag, then levels, then type default | Same cascade, plus a confidence score per building |
| Data-quality flags | Engineering flags | Data provenance flags (ML footprint, type inferred, construction zone, ...) |

**Decided (18 Oct):**
- `solar-demo` is the front end; it was merged and the `web/` scaffold dropped.
- The pipeline exports `public/data/<township>.json` for **City of Elmina, Ara Damansara and Bandar Bukit Raja**.
- The app uses the pipeline's types, heights and provenance, and adds *Data confidence* and *Footprint source* colour modes.
- The browser shading worker covers most of Phase 4. What remains there: show a shading-confidence caveat, and validate the shading against a known case.

## 0. Setup
- Monorepo: `pipeline/`, `web/`, `docs/`.
- All constants, with sources, in `pipeline/config/assumptions.yaml`.
- **Research track:**
  - typical energy use per m² for each building type (Malaysian benchmarks)
  - Suruhanjaya Tenaga grid emission factor
  - PVGIS specific yield for Shah Alam
- **Done when:** the boundary exists and the decisions are locked.

## 1. Data foundation
- Overture buildings, places and land use; clip to the boundary and drop footprints under 15 m².
- Height cascade (measured, then floors, then type rule) with `height_source` and `height_confidence`.
- Analyse in detail only non-residential roofs, apartments and unknowns of at least 100 m²; total the landed homes as a residential programme.
- **Done when:**
  - every building has a height and a source;
  - 20 sampled heights are within ±1 storey on Street View.
- **If it goes wrong:** use type rules only, marked low confidence.

## 2. Solar potential
- Usable area = footprint × usable fraction (flat or pitched roof, setbacks, rooftop equipment).
- kWp = usable area × panel density.
- kWh/yr = kWp × specific yield.
- **Needs:** the PVGIS specific yield. `re.jrc.ec.europa.eu` is blocked from the cloud environment, so either fetch it once by hand or allow the domain.
- **Done when:** unit tests pass, the totals look plausible, and the top 5 roofs are checked by hand.

## 3. App skeleton
- deck.gl extruded buildings on MapLibre, coloured by kWh, with a click-for-details panel.
- Deploy to Vercel on day one.
- **Done when:** the live URL loads in under 3 seconds on a phone.

## 4. Shading
- Sample roof points on a 2 m grid.
- Compute sun positions hourly from 7 AM to 7 PM on 12 representative days.
- Trace a ray from each point towards the sun and test it against neighbouring building prisms.
- Output `shading_loss_pct`.
- In the app: a deck.gl sun-light time slider with shadows.
- **Done when:**
  - test cases pass (a roof next to a tower shows a loss; an isolated shed shows about 0%);
  - the whole township runs in under 10 minutes.
- **If it goes wrong:** shade only the top 500 buildings by area and add a "shading not assessed" flag.

## 5. Demand and scoring
- **Type inference:** places, land use and shape.
- **Demand:** floor area × energy use per m².
- **Self-use %:** the share of the building's solar output it would consume itself.
- **Score:** a weighted mix of potential kWh, self-use %, shading quality and data confidence.
- **In the app:** flags, weight sliders, a shortlist table and a CSV export.
- **Done when:** changing a weight re-ranks the shortlist live and the CSV opens in Excel.

## 6. Car parks and ESG
- Car-park polygons get a canopy kWp estimate.
- CO₂ = MWh × the grid emission factor. Frame it against SDP's current 603 kWp and its 40% Scope 1 & 2 target.
- **Built (18 Oct):** pretrained aerial vehicle detector (YOLO11-OBB, DOTA) → vehicle clusters → unmapped car parks (`solar-mapper detect-carparks`).
  - Logic is tested with stand-in tiles and detections.
  - A real run needs the imagery, weights and PyTorch hosts allowed (see `pipeline/README.md`).
- **Grid factor now official:** 0.740 kg CO₂/kWh (Suruhanjaya Tenaga 2024, provisional). Specific yield is still a placeholder (Global Solar Atlas / PVGIS).

## 7. Validation
- Hand-label 30–50 sites; if possible, a mentor ranks 10–20.
- Measure how many of our top 10 and top 20 they agree with.
- Sensitivity: change each assumption by ±20% and check whether the top 10 stays stable.

## 8. Freeze, pitch and video
- Stop adding features at noon Thursday.
- 10 slides covering the 8 required areas, with Sections 2–4 of the report as the roadmap.
- 5-minute video following one site the whole way through.

## 9. Submit
- README, a tagged release, a working live link.
- Submit by 6 PM Friday.
