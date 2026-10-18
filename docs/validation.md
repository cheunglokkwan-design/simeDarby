# Validation (Phase 7)

The hackathon brief's test for the solar mapper is *"shortlist quality against expert assessments"*.
Three checks, all scripted and reproducible:

| Check | Command | Status |
|---|---|---|
| Ranking stability: does the top 10 survive ±20 % on each assumption? | `npm run sensitivity` | **Done**, see [sensitivity.md](sensitivity.md) |
| Shortlist quality: do people agree with our top picks? | `npm run validation-sheet`, label, then `npm run validate` | Sheets ready; **needs labels** |
| Heights: are modelled heights right to ±1 storey? | `solar-mapper spotcheck-score --township <id>` | Sheets ready; **needs labels** |

All Node scripts reuse the app's own code (`src/solar.js`, `src/shading.js`), so their rankings
match what judges see in the browser. `npm run rank` writes each township's shortlist to
`data/processed/<id>/app_ranking.csv`.

## Ranking stability

A ±20 % change to any single assumption keeps:

| Township | Top-10 sites kept (worst case) |
|---|---|
| City of Elmina | ≥ 7 of 10 |
| Ara Damansara | 10 of 10 |
| Bandar Bukit Raja | ≥ 8 of 10 |

In Elmina, panel density and specific yield move sites 8–11, whose scores sit within one point of
each other. The headline sites never move: Elmina Lakeside Mall, the data-centre plot and the
Elmina Crescent factories.

## Shortlist quality (blind labelling)

`data/processed/<id>/validation_sheet.csv` lists 40 sites per township: our top 20 mixed with 20
random other viable sites, shuffled, with no scores shown. Which site came from which group is
kept separately in `validation_key.csv`.

For each row, open `satellite_url` (and `street_view_url` if useful) and set `label` to:

| Label | Meaning |
|---|---|
| `good` | I would put this roof or car park on a shortlist for a solar feasibility study |
| `maybe` | Possible, but something is unclear: roof shape, plant, ownership, condition |
| `poor` | Not worth a study: small, cluttered, shaded, pitched and fragmented, or not a real building |

Fill in `labeller` (your name, or "SDP mentor") and any `notes`. Then run `npm run validate`. It
reports, per township:
- how many of our top 10 and top 20 were rated good (maybe counts as half);
- the same rate for the random sites;
- how many times better than random our ranking is.

**The single strongest piece of evidence for the judges is an SDP mentor labelling one township.**

## Model assumptions behind the demand estimate

The demand intensities in `src/solar.js` (kWh per m² of floor area per year) drive self-consumption
and payback:

| Building type | Value | Basis |
|---|---|---|
| Commercial / office | 220 | Pusat Tenaga Malaysia audit: most Malaysian offices use 200–250 (MS 1525 efficient benchmark: 135) |
| Landed home | 30 | ~350 kWh/month per household (TNB worked example; ~80 % of households use under 600 kWh/month), over ~150 m² of floor |
| Apartment | 40 | Same household use over ~100 m² |
| Retail / mall | 280 | **Assumption**: above the 262 average of a 41-mall Nordic study, since cooling dominates in the tropics. No Malaysian mall figure found |
| Industrial | 250 | **Assumption**: varies widely by process |
| Institutional | 100 | **Assumption**: a Malaysian university campus reported under 135 |

The grid emission factor is official: 0.740 kg CO₂/kWh, from Suruhanjaya Tenaga, Peninsular
Malaysia, 2024, provisional. SDP's baseline is 41,107 tCO₂e (FY2021 Scope 1 + 2, externally
assured, Sustainability Report FY2021), so its 40 % cut by 2030 is 16,443 tCO₂e a year.
