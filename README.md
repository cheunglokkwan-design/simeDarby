# Solar Opportunity Mapper

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
