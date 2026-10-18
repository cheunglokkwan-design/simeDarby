# Pipeline

Offline Python pipeline that turns open map data into the layers the web app shows.
All constants live in [`config/assumptions.yaml`](config/assumptions.yaml); change them
there, not in code.

```bash
.venv/bin/solar-mapper phase1 --township elmina            # build everything for Phase 1
.venv/bin/solar-mapper phase1 --refresh                    # re-download Overture data
.venv/bin/solar-mapper phase2                              # solar potential (needs phase1 output)
.venv/bin/solar-mapper export-app                          # public/data/<township>.json for the web app
.venv/bin/solar-mapper run --township ara-damansara        # all three steps
.venv/bin/solar-mapper spotcheck-score                     # score the filled-in height check
.venv/bin/pytest
```

Townships: `elmina`, `ara-damansara`, `bandar-bukit-raja` (`config/townships/*.yaml`).
- **Elmina:** boundary from Elmina-named land-use polygons.
- **Bandar Bukit Raja:** the mapped "Bandar Bukit Raja" outline.
- **Ara Damansara:** no outline exists in open data, so it uses the rectangle the web demo already used.

## Web app export

`solar_mapper/app_export.py` writes `public/data/<township>.json` with the same
`{buildings, parking, community}` shape as the app's OSM snapshots.
- **Buildings** also carry the pipeline's `category`, `height`, `heightSource`,
  `heightConfidence`, `footprintSource`, `dataFlags` and `role`. The app uses these
  instead of re-deriving them from OSM tags.
- **Car parks** are Overture `infrastructure` parking polygons: surface only, at least 200 m².
  Open data is thin here (Elmina has only 5 qualifying car parks), which is the case for detecting them from imagery later.
- **Community sites** are schools, clinics, hospitals and libraries from places, plus school and
  hospital buildings that no place marks yet.

`tests/test_app_export.py` checks that the usable fractions, yield, panel density and
emission factor in `assumptions.yaml` match `src/solar.js`, so both always give the same kWp.

## Phase 1: data foundation

1. **Download** Overture buildings, places and land use for the township's bbox
   (`solar_mapper/overture.py`, pinned release, anonymous S3, no account needed).
2. **Boundary.** No open township boundary exists, so we take the union of Overture
   land-use polygons whose name contains "Elmina" (township outline, Elmina Crescent
   industrial area, Taman Perdagangan Elmina / Elmina Business Park, neighbourhoods), with
   holes filled: 21.1 km². Approximate; replace with SDP's masterplan boundary when we have it.
3. **Clean.** Keep footprints whose representative point is inside the boundary; drop
   those under 15 m² (sheds and ML noise).
4. **Kind** (what the building is used for). Evidence, strongest first:

   | Source | Example |
   |---|---|
   | `overture_class` / `overture_subtype` | OSM `building=industrial` |
   | `building_name` | "Elmina Lakeside Mall" → retail |
   | `place` | mall / place of worship / school POI in the footprint, or ≥ 2 businesses → shop-office |
   | `land_use` / `land_use_name` | smallest containing land-use polygon; its name when its class is uninformative ("Kanopi Residences" construction plot → apartment) |
   | `land_use_shape` | long, thin footprint in a residential area → terrace row |
   | `overture_class_weak` | generic `building=residential` with nothing better |
   | `size` | < 300 m² → house, otherwise `unknown` |

   A generic residential tag loses to a specific land use: 20 identical
   "residential" blocks inside the industrial park become industrial (`tag_overridden` flag).
5. **Height**: the cascade is measured height, then floor count × floor-to-floor height
   for the kind, then a typical height for the kind. `height_source` and
   `height_confidence` record which step was used.
6. **Role**:
   - `candidate`: non-residential, apartment or unknown roofs of at least 100 m². These get the full analysis.
   - `residential_programme`: landed homes, reported only as one aggregate figure.
   - `excluded`: minor structures, utility assets (tanks, reservoirs, substations) and small roofs.

## Phase 1 results: City of Elmina

| | |
|---|---|
| Footprints analysed | 2,587 (133 under 15 m² dropped) |
| Footprint sources | OSM 1,247 · Google 1,068 · Microsoft 272 |
| Mapped height | **0**. Floor count for 50 (2%); the rest use type rules |
| Candidates | **183 roofs, 256,113 m²** (industrial 108 / 142k m², retail 19 / 49k m², unknown 31 / 27k m²) |
| Residential programme | 2,164 landed buildings, 783,050 m² of footprint (terrace rows count as one building) |
| Mean height confidence | 0.41 overall, 0.38 for candidates |

Largest candidates include:
- a 28.6k m² building in the Google data centre plot (Elmina Business Park 1A, flagged `construction_zone`)
- Elmina Lakeside Mall (24.8k m²)
- the Elmina Crescent factories
- Kanopi Residences
- a multi-storey car park at Pangsapuri Harmoni Elmina

Full numbers: [`data/processed/elmina/phase1_summary.json`](../data/processed/elmina/phase1_summary.json).

### Outputs (`data/processed/<township>/`)

| File | What |
|---|---|
| `buildings.parquet` | Phase 1: one row per footprint, EPSG:4326 |
| `phase1_summary.json` | counts by source, kind, height source, role, flag |
| `spotcheck_heights.csv` | 20 buildings to verify on Street View |
| `sites.parquet` / `sites.geojson` | Phase 2: every Phase 1 column plus the solar columns (load this one in the app) |
| `phase2_summary.json` | kWp, MWh and tCO₂ totals by role and kind, plus the top 10 candidates |

Key columns:

| Column | Meaning |
|---|---|
| `kind`, `kind_source` | building type and the evidence used to decide it |
| `height_m`, `storeys`, `height_source`, `height_confidence` | estimated height and how much to trust it |
| `role`, `role_reason` | candidate, residential programme or excluded, and why |
| `data_flags` | semicolon-separated data-quality flags |
| `land_use_name`, `place_names` | context for the detail panel |
| `display_name` | building name, else first place, else "<kind> in <land use>" (Phase 2) |
| `usable_roof_m2`, `system_kwp`, `kwh_yr_unshaded`, `co2_t_yr_unshaded` | solar potential before shading (Phase 2) |

### Data flags

These are shown next to each site in the app:

| Flag | Meaning |
|---|---|
| `height_estimated` | no mapped height; value comes from floors or a type rule |
| `type_inferred` | kind not tagged on the building itself |
| `type_unknown` | kind could not be inferred |
| `tag_overridden` | a generic tag lost to stronger evidence |
| `ml_footprint` | outline traced by Google's or Microsoft's ML models, not a mapper |
| `construction_zone` | inside a construction plot, so the building may have changed |
| `below_min_system` | fits less than 3 kWp, not worth a feasibility study (Phase 2) |

### Exit check: Street View spot-check (needs a teammate)

1. Open `spotcheck_heights.csv`. It lists 12 candidates and 8 homes, with fixed seed 42.
2. For each row, open the Street View link and enter `observed_storeys`.
3. Run `solar-mapper spotcheck-score`.

Target: at least 16 of 20 within ±1 storey. Rerunning `phase1` keeps the filled sheet
unless you pass `--new-spotcheck`.

### Known limitations

- **No measured heights in open data.** Every height is modelled. Phase 4 shading inherits
  this, which is why each result carries `height_confidence`.
- **Data vintage.** ML footprints come from imagery that is a few years old, so the newest
  phases may be missing or still outlined as construction.
- **Footprint granularity varies.** OSM often maps a terrace row as one polygon, while ML
  datasets split it into units.
- **31 candidates are still `unknown`.** These are large, compact buildings in residential
  areas (clubhouses, apartment blocks?). Phase 5 refines types using places and demand.

## Phase 2: solar potential

`solar_mapper/solar.py`, constants in the `solar` block of `assumptions.yaml`:

```
usable roof = footprint × usable fraction for the kind (industrial 0.75, retail 0.65, commercial 0.60,
              public buildings 0.55, unknown 0.50, landed homes 0.45, apartments 0.40)
system kWp  = usable roof × 0.18 kWp/m²
kWh/yr      = kWp × 1,350 kWh/kWp        (no shading yet: Phase 4 multiplies in the unshaded fraction)
tCO₂/yr     = kWh × 0.758 kg/kWh ÷ 1000
```

These are the same formula and the same values as the `solar-demo` app (`src/solar.js`), so
both give identical numbers for the same roof. They are all placeholders. Before the pitch:
- replace the 1,350 kWh/kWp yield with the PVGIS figure for Elmina;
- replace the 0.758 kg/kWh factor with the latest Suruhanjaya Tenaga grid factor.

### Results: City of Elmina, before shading

| | Roofs | kWp | MWh/yr | tCO₂/yr |
|---|---|---|---|---|
| **Candidates** | 183 | **30,902** | **41,717** | **31,622** |
| of which industrial | 108 | 19,234 | 25,965 | 19,681 |
| of which retail | 19 | 5,697 | 7,691 | 5,830 |
| Residential programme (technical potential, all landed homes) | 2,164 | 63,437 | 85,627 | 64,904 |

The candidates alone are **51× SDP's current 603 kWp** of rooftop PV.

### Hand check of the top 5 (Phase 2 exit check)

| Site | Roof m² | × usable | × 0.18 = kWp | × 1,350 = MWh/yr | Sense check |
|---|---|---|---|---|---|
| Google data centre plot, Elmina Business Park 1A | 28,552 | 0.75 | 3,854 | 5,204 | Under construction (`construction_zone`); cooling plant will cut usable roof, but data-centre demand would absorb all of it |
| Elmina Lakeside Mall | 24,775 | 0.65 | 2,899 | 3,913 | Same order as large Malaysian mall rooftop systems (1–3 MWp); roof car parks/plant may lower 0.65 |
| Chye Keong Hardware warehouse, Elmina Crescent | 13,405 | 0.75 | 1,810 | 2,443 | Single-volume warehouse: ideal flat/low-pitch roof |
| Factory, Elmina Crescent | 7,407 | 0.75 | 1,000 | 1,350 | Typical 1 MWp industrial rooftop |
| Factory, Elmina Crescent | 6,894 | 0.75 | 931 | 1,256 | As above |

Overall density works out at 7.4 m² of footprint per kWp on industrial roofs, within the usual
6–10 m²/kWp rule of thumb for flat roofs. The hand check also caught a "Water Balancing Tank"
ranked 9th. Utility structures (tanks, reservoirs, substations) are now their own `utility`
kind and are excluded.
