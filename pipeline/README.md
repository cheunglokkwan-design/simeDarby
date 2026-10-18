# Pipeline

Offline Python pipeline that turns open map data into the layers the web app shows.
All constants live in [`config/assumptions.yaml`](config/assumptions.yaml); change them
there, not in code.

```bash
.venv/bin/solar-mapper phase1 --township elmina            # build everything for Phase 1
.venv/bin/solar-mapper phase1 --refresh                    # re-download Overture data
.venv/bin/solar-mapper spotcheck-score                     # score the filled-in height check
.venv/bin/pytest
```

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
   - `excluded`: minor structures and small roofs.

## Phase 1 results: City of Elmina

| | |
|---|---|
| Footprints analysed | 2,587 (133 under 15 m² dropped) |
| Footprint sources | OSM 1,247 · Google 1,068 · Microsoft 272 |
| Mapped height | **0**. Floor count for 50 (2%); the rest use type rules |
| Candidates | **184 roofs, 260,680 m²** (industrial 109 / 147k m², retail 19 / 49k m², unknown 31 / 27k m²) |
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
| `buildings.parquet` / `buildings.geojson` | one row per footprint, EPSG:4326 |
| `phase1_summary.json` | counts by source, kind, height source, role, flag |
| `spotcheck_heights.csv` | 20 buildings to verify on Street View |

Key columns:

| Column | Meaning |
|---|---|
| `kind`, `kind_source` | building type and the evidence used to decide it |
| `height_m`, `storeys`, `height_source`, `height_confidence` | estimated height and how much to trust it |
| `role`, `role_reason` | candidate, residential programme or excluded, and why |
| `data_flags` | semicolon-separated data-quality flags |
| `land_use_name`, `place_names` | context for the detail panel |

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
