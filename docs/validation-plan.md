# From screening prototype to a defensible pilot

## Implemented after the panel review

- Building height no longer creates invented occupied floors. Missing floor
  counts use an explicit one-storey assumption; recorded OSM floor counts remain
  separate from physical height.
- User-provided annual consumption, peak demand, floor counts and usable roof
  area can replace assumptions. A source description is required for numeric
  corrections. These values are not independently verified.
- Property name, mapped address and ID search cover all loaded sites. Accessible
  result buttons and progressive browsing include roofs, zones and batteries.
- Mobile map/results and selected-detail controls preserve property identity.
  Modal focus uses the browser's native dialog behaviour.
- Blocked regions marked on the mapped footprint are persisted and excluded from
  packing. Resulting panel capacity constrains the solar estimate, so savings and
  rankings change with the proposal. Undo and site reset are available.
- Missing video processing is shown before submission; a finished-scan import
  and a mapped-layout preview remain usable.
- Completed-job download/storage failures stop after three failed attempts.
- Approval/engineering-pass claims have been removed. Battery figures are gross
  scenario benefits, not complete net bill savings. P90 is weather variability,
  not a confidence bound covering every input error.

## Evidence still required

Use one owner-authorized building as the first complete pilot. Record the site ID
and keep all inputs linked to it:

| Evidence | What it establishes |
| --- | --- |
| Actual drone footage and a successful hosted worker run | Reconstruction works on a real capture, with known runtime, cost and failures |
| Surveyed dimensions/control points and roof planes | Scale, orientation and usable geometry can be checked independently |
| Roof obstructions and access constraints | Proposed panels avoid more than a mapped boundary |
| Bills and interval load data | Demand, self-consumption and peak estimates can be compared with observed use |
| Installer/engineer review and estimate | Layout feasibility, connection requirements and pricing have an accountable reference |
| Measured PV output where available | The yield and shading estimates can be checked against production |

Compare predicted versus reference roof area, usable area, panel count, annual
generation, self-consumption, peak demand and full annual bill savings. Agree
acceptance thresholds with the engineer before evaluating the case. Show the
original screening estimate and the evidence-corrected result side by side;
record uncertainty and which recommendation changed.

One roof validates one case, not an entire township. Follow it with representative
warehouses, malls, homes and roof shapes before claiming broad accuracy.

## Remaining software work for a full drone-to-design service

1. Host and validate the existing GPU reconstruction worker; packaging and mocked
   tests are not evidence of successful reconstruction.
2. Extract and calibrate roof planes and obstacles from the reconstruction, with
   user review. Today the layout still uses the mapped footprint on an estimated
   flat plane, even when a splat is available.
3. Match synchronized PV and load time series, and compare complete before/after
   electricity bills. Cached battery values do not fully cost grid-charge losses.
4. Validate maintenance assumptions, add replacement costs and sensitivity
   analysis for investment comparisons. Current solar payback is simple CAPEX
   divided by estimated annual benefit after assumed annual maintenance.
5. Before multi-user rollout, add identity, ownership/access controls, shared
   evidence storage, audit history and per-user compute budgets.

No surveyed roof, customer bill, real scan or hosting account was supplied for
this change. No field accuracy or completed drone-processing result is claimed.
