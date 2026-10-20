# Open roof registry

Every building roof and surface car park in each Sime Darby Property township
covered by the Solar Opportunity Mapper, with its estimated solar potential.
It's published as open data so SDP, councils and researchers can reuse it.

| File | Township |
|---|---|
| `ara-damansara.geojson` | Ara Damansara |
| `bandar-bukit-raja.geojson` | Bandar Bukit Raja |

Regenerate with `npm run registry` after `npm run fetch-osm` or a model change.

## Licence

This registry is a derivative database of OpenStreetMap, so it is released
under the same licence: the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

- **Attribution:** "© OpenStreetMap contributors" plus a credit to this project.
- **Share-alike:** if you publish an adapted version of the database, release it under ODbL too.
- **Keep it open:** you may not distribute it under technical restrictions that prevent reuse.

## Fields

| Field | Meaning |
|---|---|
| `osm_id` | OpenStreetMap element (e.g. `way/123`): view at openstreetmap.org/way/123 |
| `name`, `category` | OSM name; building type used as the demand proxy |
| `footprint_m2`, `height_m`, `height_source` | Footprint area; height and where it came from (OSM tag or estimate) |
| `usable_roof_m2` | Footprint × usable share for the building type |
| `unshaded_fraction` | Annual share of sun reaching the roof (line-of-sight raycast against neighbours) |
| `system_kwp`, `panels`, `atap_capped` | System size, panel count at 550 W, whether the Solar ATAP cap applied |
| `yield_p50_kwh_per_kwp`, `yield_p90_kwh_per_kwp` | pvlib + PVGIS-ERA5 2005–2023, for the roof's tilt and orientation |
| `annual_kwh_p50`, `annual_kwh_p90`, `lifetime_kwh_25yr` | Generation in year 1 and over 25 years (0.5 %/yr degradation) |
| `self_consumption` | Share of generation used on site (demand proxy) |
| `capex_rm`, `annual_savings_rm`, `payback_years` | Demo economics under ATAP; tariffs and CAPEX are placeholders |
| `co2_tonnes_per_year` | Generation × grid emission factor |
| `substation_distance_m` | Straight-line distance to the nearest OSM-mapped substation |
| `affordable_housing` | Affordable-housing block (CREAM lease-income candidate) |
| `score`, `flags` | Opportunity score (0–100) and engineering flags |

## Limits

These are pre-feasibility estimates from open data, not survey results. Heights
are mostly estimated, roof pitch and rooftop equipment are not mapped, and OSM
substation coverage is incomplete. Economic fields use editable placeholder
tariffs: check them against TNB, SEDA and Suruhanjaya Tenaga before relying on them.
