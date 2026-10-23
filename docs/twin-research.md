# Digital twin: research basis for a realistic rooftop array

Owner: research agent. Constants live in `src/twin/catalogue.js`; this file says
where they come from and how the algorithm should use them. Site: Ara Damansara,
Klang Valley, 3.11 N 101.58 E. Researched 23 Oct 2026. "Approx" means a
reseller listing or family datasheet, not the maker's current PDF.

## 1. Modules

Every mainstream module now uses a **1134 mm wide** frame (182 mm cells), apart
from the 210 mm utility format (1303 mm). Frames are 30 mm deep (33-35 mm for
utility sizes). The glass is 3.2 mm tempered over a backsheet, or 2+2 mm in
glass-glass bifacials, which are heavier. STC efficiency is 21.5-23%. The Pmax
temperature coefficient is -0.28 to -0.30 %/°C for n-type TOPCon/BC and about
-0.34 to -0.35 for older PERC. NOCT/NMOT is 43-45 °C.

| Class | Example | L x W x D mm | W | kg | eff | Pmax %/°C | Voc V | Isc A |
|---|---|---|---|---|---|---|---|---|
| 108 half-cut (resi) | LONGi Hi-MO 6 LR5-54HTH-430M | 1722x1134x30 | 430 | 20.8 | 22.0% | -0.29 | 39.1 | 14.0 |
| 108 glass-glass | JA DeepBlue 4.0 Pro JAM54D40-440/GB | 1762x1134x30 | 440 | ~24 | 22.0% | -0.29 | ~39.4 | ~14.1 |
| 144 x 210R (resi) | Trina Vertex S+ TSM-445NEG9R.28 | 1762x1134x30 | 445 | 21.0 | 22.3% | -0.30 | ~52.6 | ~10.7 |
| Google default | generic (Solar API) | 1879x1045 | 400 | (22) | 20.4% | (-0.35) | - | - |
| 144 x 182 | Jinko Tiger Neo JKM580N-72HL4-V | 2278x1134x30 | 580 | 28 | 22.5% | -0.29 | ~51.3 | ~14.3 |
| 144 x 182R/210R | LONGi Hi-MO 7 LR7-72HGD-620M | 2382x1134x30 | 620 | 33.5 | 23.0% | -0.28 | 52.7 | 14.8 |
| 132 x 210 (utility) | Trina Vertex N TSM-700NEG21C.20 | 2384x1303x33 | 700 | 38.3 | 22.5% | -0.29 | 48.6 | 18.3 |

Areal mass of the module alone is **10.5-12.5 kg/m²** for every class (checked
in the catalogue). Most mechanical ratings are 5400 Pa down and 2400 Pa up.
Sources: [LONGi 430 (sun.store)](https://configurator.sun.store/en/product/longi-lr5-54hth-430m-black-frame-1500v-hi-mo-6-explorer-lr5-54hth-420-440m-2116),
[Trina 445](https://www.solartraders.com/de/products/module/trina-solar-tsm-445neg9r-28-bfr-evo2),
[Jinko 72HL4](https://fvcomponentes.com/en/product/solar-panel-jinko-585w-tiger-neo-72hl4-v),
[Jinko 72HL4 datasheet](https://solarproof.com.au/datasheets/panel_datasheet_JKM560-585N-72HL4R-V-F2C1-EN-AU-CEC.pdf),
[LONGi Hi-MO 7](https://solarproof.com.au/products/LR7-72HGD-620MHi-MO7.php),
[Trina 700](https://sun.store/el/product/trina-tsm-neg21c.20-700-675-700-1500v-silver-frame-ts4-3907),
[Google panel update 2024-04-29](https://developers.google.com/maps/documentation/solar/release-notes).

## 2. Mounting

### Pitched roofs (Malaysian terrace/semi-D/bungalow: concrete or clay tile, metal deck)
- **Flush rail mount.** On tile roofs, stainless tile hooks are screwed to the
  rafters or battens under a lifted tile. On metal deck, L-feet or clamps sit
  on the ribs. Two aluminium rails run across the slope, and modules clamp on
  top. The module top ends up **80-150 mm above the roof surface** (tile
  0.10-0.15 m, deck 0.08-0.10 m). The module is **parallel to the roof plane**,
  so its tilt and azimuth equal the roof's.
- **Clamp zone.** Clamps go on the long frame edge at **L/4 ± 50 mm** from each
  end (LONGi manual: `L/4-50 ≤ D ≤ L/4+50`; some tables allow 350-450 mm). The
  rails therefore sit about **L/2 apart**, and each row of modules needs its own
  rail pair. Portrait (long edge up-slope) is the default on tile.
  [LONGi IM](https://ressupply.com/documents/longi/Installation_Manual.pdf).
- **Gaps.** Mid clamps leave **18-25 mm** between modules (use 20 mm). Rows on
  separate rails also sit about 20 mm apart. Rails overhang the end clamp by
  20-50 mm. Every module in an array has the same gap, so the array is a
  rectangle (or an L or T built from rectangles), aligned to the eave line.
- **Racking mass** is 2-4 kg/m², so a flush system totals **12-16 kg/m²**
  (0.12-0.16 kPa).

### Flat RC slabs (common on link-house extensions, shophouses, condos)
- **Tilt.** At 3°N the yield-optimal tilt is about 3-5° facing roughly south
  or north, and yield is flat out to about 15°. Malaysian installers use
  **10°** (5° minimum) so rain washes the glass and water does not pond on the
  frame lip. Above about 15° yield falls and wind load rises. East-west
  "dual-tilt" at 10° is common too: GCR about 0.9, roughly 3-5% less yield per
  kWp, much more kWp per m².
- **Inter-row spacing (no shading 09:00-15:00 solar time on the worst solstice).**
  - Row height: `H = L_slope · sin(tilt)`.
  - Clear gap: `d = H / tan(α_p)`, where the profile angle is
    `tan α_p = tan(elev) / cos(az_sun − az_row)`.
  - The worst day is the solstice that puts the sun **behind** the rows: 21 Dec
    for south-facing rows, 21 Jun for north-facing rows.
  - Worked example at 3.1°N, 21 Dec, 09:00: elevation 38.8°, sun 56° east of
    south, so α_p = 55° for south-facing rows. A 10° portrait LR5 row has
    H = 0.30 m, d = 0.21 m, pitch 1.90 m, GCR 0.90.
  - Low latitude makes these gaps tiny. Cap **GCR ≤ 0.8** and add a 0.6 m
    walkway between blocks so the array can be cleaned and maintained.
- **Attachment** is ballasted (**30-60 kg/m²** total) or fixed into the slab
  (6-10 kg/m²). Ballast only works on RC slabs; never on tile or deck.

## 3. Setbacks and edge zones

**Malaysian rules.**
- No Malaysian document gives a numeric residential fire setback.
- PV installation follows **MS 1837:2018** (grid-connected PV, up to 1500 V DC),
  **MS 2440** (code of practice for PV mounting systems on all roof types),
  **MS IEC 62446** (test, commissioning, documentation) and the Energy
  Commission (ST) installation guidelines. Installers must be SEDA-registered
  (RPVSP). [MS 2440 (JSM)](https://mysol.jsm.gov.my/preview-file/eyJpdiI6Im92SnhEYW5tcVpuZ3F3S2ZkYkpaK3c9PSIsInZhbHVlIjoibnFiVy90Vk9WblB1UUI2OGlSNWtFdz09IiwibWFjIjoiMGU1MjQ4ZmMxNzg4ODE2ZWZjZGJiZTEyNWExYmMxOGQ0Y2NmNjdlMDM2NzQwMDliNzViMGExZjI0NWYwYTJkZCJ9),
  [ST NEM guideline 2021](https://www.st.gov.my/ms/contents/files/highlights/2021-01-30/1612021974.pdf).

**Wind (MS 1553:2002 + Amd 1:2013).**
- The basic wind speed is 32.5-33.5 m/s (50-year) in Peninsular Malaysia.
- MS 1553 follows AS/NZS 1170.2. Roof local pressure factors are K_l = 1.5
  within `a` of an edge or ridge and 2.0 within `a/2`, with
  `a = min(0.2·b, 0.2·d, h)`. For a 10 m x 8 m terrace roof 7 m high, a = 1.6 m.
- Uplift is highest in corners and along verges and eaves. Arrays avoid the
  outer `a/2` band where practical, or use extra fixings there.
  [MS 1553 Amd 1](https://mysol.jsm.gov.my/getPdfFile/eyJpdiI6ImpzZUdWOEJjNTQ0VzRWVDNCcjZ0Snc9PSIsInZhbHVlIjoidDI0UlF6dFVzWEp0d1lXdWgvVjdkQT09IiwibWFjIjoiZjNiNzBlYzA5ZDc4ZDA0ZGZhMGJlZWJkNDhiYWQ4YTI4ZGE5NGJiZjE3NTc1MjYzNjczZWI2MjQzNmEwZGNlMCJ9).

**Fire code reference (US IFC/IRC R324, not law in Malaysia).**
- Ridge setback: 18 in (0.46 m) if the array covers ≤ 33% of plan roof area;
  36 in (0.9 m) if it covers more.
- Two 36 in eave-to-ridge pathways.
- Roofs ≤ 2:12 (9.5°) are exempt.
  [Richland summary](https://ci.richland.wa.us/home/showpublisheddocument/13666/637913199228500000).

**Practical defaults (Malaysian practice + wind + access), in `MOUNTING`.**

| Zone | Flush (pitched) | Flat slab |
|---|---|---|
| Ridge | 0.5 m (0.9 m "fireStrict") | - |
| Eave / gutter | 0.4 m | - |
| Verge / rake / hip | 0.4 m | 1.0 m from parapet/edge |
| Valley | 0.3 m each side | - |
| Obstacles (vents, skylights, AC, water tank) | 0.3 m + shade test | 0.5 m |

Panels never overhang the roof outline. The user's `setback` option overrides
the edge value. The ridge and eave values should stay at least those above.

## 4. Physics

**Loads.**
- Flush dead load is 12-16 kg/m², which is 0.12-0.16 kPa. The LR5 module alone
  is 20.8 kg over 1.95 m², or 10.7 kg/m².
- Malaysian practice (UBBL, BS 6399-3 heritage) designs pitched roofs without
  access for an imposed load of about 0.25 kPa (about 25 kg/m²). Concrete tile
  itself is about 45-55 kg/m². A flush array is a modest permanent addition,
  usually acceptable for timber or steel trusses after an installer check.
- Ballasted flat systems (30-60 kg/m²) need an RC slab (1.5 kPa access
  imposed load) and an engineer's check.
- Plausibility limits: flush **< 20 kg/m²**, ballasted < 60 kg/m².

**Wind.** Uplift q = 0.6·V² Pa. At V = 33.5 m/s, q ≈ 0.67 kPa before
coefficients. Edge and corner Cp·K_l can push that to about 1.5-2 kPa, which is
within the module's 2400 Pa up-rating but sets the hook spacing. This is why
arrays keep off the edges.

**Geometry and drainage.**
- Modules lie on rails on the roof plane: same normal as the roof, offset by
  the standoff, never floating or sinking.
- Rails run across the slope, so water flows under and between modules
  downslope to the gutter.
- On flat slabs, tilt the rows so the low edge drains toward the slab outlets,
  and never block the slab falls.

**Irradiance and climate** (NASA POWER climatology at 3.11 N 101.58 E, in
`CLIMATE_KL`).
- GHI is **4.80 kWh/m²/day, or 1,753 kWh/m²/yr**. Monthly values range from
  4.2 (Dec) to 5.3 (Mar).
- The diffuse fraction is **0.55** annually (0.51-0.59 by month). About half
  the energy comes from the sky dome, not the beam. Shading must therefore
  model **sky view factor** (diffuse obstruction), not just beam shadows. A
  dormer or a neighbour's wall cuts diffuse light even at noon.
- Air temperature means 25.5 °C; mean daily maximum 32-34 °C and minimum
  17-21 °C. Wind at 2 m is about 0.8 m/s.
- POWER is a coarse satellite/reanalysis product. Ground pyranometers in the
  Klang Valley typically give about 1,550-1,700 kWh/m²/yr.
  [NASA POWER API](https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DIFF,T2M&community=RE&longitude=101.58&latitude=3.11&format=JSON).

**Transposition (POA).**
- The isotropic sky (Liu-Jordan) model is acceptable:
  `POA = B·cosθ·sunlit + D·SVF + GHI·ρ·(1−cosβ)/2`, with albedo ρ = 0.2.
- Hay-Davies is better when beam is significant (circumsolar weighted by the
  anisotropy index). Perez is the industry default in PVsyst and SAM.
- At 3°N with tilts of 0-25°, annual POA is within about ±3% of GHI for any
  azimuth at ≤ 10° tilt. A 25° west-facing roof loses about 5-8%. Expect
  roof-facing differences to be small.

**Cell temperature.**
- Faiman model: `Tc = Ta + G_poa / (U0 + U1·ws)`. Use U0 = 25, U1 = 6.84 for an
  open rack ([pvlib](https://pvlib-python.readthedocs.io/en/latest/reference/generated/pvlib.temperature.faiman.html)).
  For flush on roof, use about U0 = 20, U1 = 5. That is an assumption: lower
  convection under a module only 100-150 mm off the roof, similar to PVsyst
  "semi-integrated".
- NOCT alternative: `Tc = Ta + (NOCT−20)/800·G`, plus 5-10 K for a close roof.
- At midday in Kuala Lumpur, Tc reaches 55-65 °C. The annual thermal loss is
  **6-10%**, the biggest loss after shading.

**Performance.**
- PR (AC yield / (POA·kWp)) is **0.75-0.82** for a good new system.
- One measured 4 kWp Shah Alam house gave 1,144-1,196 kWh/kWp/yr at PR
  0.73-0.76 ([UiTM study](https://journal.uitm.edu.my/index.php/JOA/article/view/5324)).
- Expected specific yield in the Klang Valley is **1,150-1,400 kWh/kWp/yr**
  (unshaded, any reasonable roof).
- The Google Solar API applies a 0.85 DC→AC derate and 0.5%/yr degradation
  ([Google](https://developers.google.com/maps/documentation/solar/calculate-costs-us)).
- Chain in `LOSSES`: soiling 2%, mismatch 2%, DC wiring 1.5%, AC wiring 0.5%,
  LID 1%, low-light 1%, inverter 97%, availability 99%. Their product is 0.886
  before temperature and shading. Adding the thermal loss gives PR ≈ 0.80-0.83
  unshaded.

## 5. How the best tools place panels

**Google Solar API, `buildingInsights:findClosest`.**
- Inputs: a DSM (0.1 m/px at HIGH imagery quality), roof segmentation, and
  annual, monthly and hourly flux and shade layers. Flux is in kWh/kW/yr, with
  1 "sunshine hour" = 1 kWh per kW.
- Output: `roofSegmentStats` (pitch, azimuth, plane height, bounding box,
  sunshine quantiles) and `solarPanels`, a list of panel centres, orientation
  (LANDSCAPE/PORTRAIT), segment index and `yearlyEnergyDcKwh`.
- Order: the list is "in the order that the panel layout algorithm placed"
  them, "usually, though not always, in decreasing order of annual energy".
- `solarPanelConfigs[N]` is simply the **first N panels**. Configs are only
  given when at least 4 panels fit.
- Default panel: 400 W, 1.879 x 1.045 m (since April 2024; previously 250 W,
  1.65 x 0.992 m).
- What it amounts to: a **flux-ranked greedy** on a regular per-segment grid
  aligned to the segment azimuth.
  [Reference](https://developers.google.com/maps/documentation/solar/reference/rest/v1/buildingInsights/findClosest),
  [release notes](https://developers.google.com/maps/documentation/solar/release-notes).

**Project Sunroof (Google, 2015-).** It uses the same pipeline: ray-traced
annual sun on a DSM, shade from trees and neighbours, and roof planes. Its
published methodology reportedly excludes roof area with low sunshine relative
to the local maximum. Treat a threshold of about 75% of the local maximum as
the conventional cut-off. This is unverified in this session. The Sunroof page
did not load.

**Aurora Solar.**
- Panels are placed only where Solar Access % ≥ a user "SAP min" (commonly
  80-90%). This applies to AutoDesigner, fill-roof-face and manual placement.
- Fire pathways follow the local code and can be steered into the shaded
  areas. Setbacks are a separate optional buffer.
  [Aurora settings](https://help.aurorasolar.com/hc/en-us/articles/21240604594963-Design-with-Aurora-A-to-Z-guide),
  [fire pathways](https://help.aurorasolar.com/hc/en-us/articles/21324795831443-How-to-plan-for-fire-pathways-and-setbacks).

**OpenSolar and Solargraf.** Same pattern: fill each roof face with a grid
aligned to the eave inside setbacks, drop modules below a shade or irradiance
threshold, then auto-string. Solargraf applies jurisdiction fire setbacks by
default ([Solargraf](https://www.solargraf.com/help-center/article/fire-pathways)).

**PVsyst / SAM.**
- Near shading uses 3D scene ray-casting. Beam shading uses a sun-path table.
  Diffuse shading is an isotropic integral over the sky dome, which gives a
  constant diffuse factor.
- Electrical losses for partial shading come from "modules by string" (the
  string loses its current share).
- SAM supports 3D shade import and a self-shading model for rows based on GCR.

**Recommended algorithm for the twin (distillation).**
1. Per roof plane: offset the outline inward by the zone setbacks (ridge, eave,
   verge, valley) and buffer the obstacles.
2. Build a grid aligned to the eave direction (`eaveDir`): module plus 20 mm
   gaps. Try portrait and landscape. Try a few grid offsets (0, ¼, ½, ¾ pitch
   along u and v) and keep the one that fits the most cells.
3. Score each cell by POA kWh/m² from beam sunlit fraction plus diffuse SVF.
   Reject cells below about 80% of the best unshaded cell on that roof (the
   Aurora/Sunroof style threshold), and any cell whose footprint partly leaves
   the usable polygon.
4. Rank cells by energy and take them greedily, but keep the result
   rectangular. Grow contiguous row blocks, never isolated modules, and keep
   at least 4 modules per array.
5. Stop at `targetKwp` or the grid cap (Section 6). Round to string-friendly
   counts.
6. Recompute shading with the final layout. On flat slabs, include the
   self-shading between rows.

## 6. Stringing and grid limits (Malaysia)

**String limits.**
- Maximum modules per string:
  `N_max = floor(V_dc,max / (Voc·(1+β_Voc·(T_min−25))))`, with T_min = 15 °C
  (Klang Valley lows are 17-18 °C; margin added).
- Minimum modules per string:
  `N_min = ceil(V_mppt,min / (Vmp·(1+γ·(T_max−25))))`, with T_cell,max = 75 °C.

**Worked example.** Huawei SUN2000-5KTL-L1 single-phase: 600 V max DC, 100 V
start, 90-560 V MPPT, 2 MPPTs at 12.5 A each
([Huawei specs](https://solar.huawei.com/en/products/sun2000-3-4-5-6ktl-l1/specs/)).
With LR5-54HTH-430:
- Voc at 15 °C = 40.0 V, so N_max = 14.
- Vmp at 75 °C ≈ 28.2 V, so N_min = 4 (6+ in practice for MPPT headroom).
- So one string of 6-14 modules per MPPT. The 13.06 A Imp slightly exceeds
  12.5 A, giving minor clipping, which is accepted practice.
- Typical 5 kW house: 12 x 430 W = 5.16 kWp (2 x 6 or 1 x 12). Arrays come in
  multiples that fill 1-2 strings. Odd single panels are a red flag.

**Solar ATAP** (from 1 Jan 2026; replaces NEM 3.0, which closed June 2025):
- Domestic caps: **5 kW single-phase, 15 kW three-phase**. Bigger systems
  need a RM1,000 Connection Confirmation Check.
- Overall cap of 100% of maximum demand.
- 10-year export offset tenure, then self-consumption only.
- The cap is generally read against inverter AC rating. DC/AC ratios of
  1.0-1.3 are typical. Confirm the DC rule with the RPVSP.
- Default `targetKwp` ≈ 6 kWp (Solar ATAP single-phase 5 kWac × DC/AC 1.2) for an unknown single-phase terrace house.
- Sources: [SEDA ATAP](https://www.seda.gov.my/reportal/atap/),
  [The Star 2025-12-20](https://www.thestar.com.my/news/nation/2025/12/20/embracing-rooftop-power).

## 7. User-adjustable panel size

| Choice | Good for | Trade-off |
|---|---|---|
| ~1.72-1.76 m x 1.134 m, 430-445 W (default) | Terrace/semi-D tile roofs, hip roofs, small planes | Most installers stock it; one-person handling, fits between hips and dormers |
| 1.879 x 1.045, 400 W (Google default) | Comparing with Google Solar API | Older efficiency; ~8% less kWp per m² |
| 2.28-2.38 m x 1.134 m, 580-620 W | Long simple gable planes, flat slabs | ~8-12% fewer clamps/kWp, but tile-course clash, harder roof access, higher wind sail, fewer fit on cut-up roofs (often *less* total kWp) |
| 2.38 x 1.30 m, 700 W | Utility/C&I only | Isc 18 A exceeds residential MPPT inputs; 38 kg; not for homes |
| Glass-glass bifacial | Flat slab with high racks | +2-3 kg/m²; bifacial gain near zero flush on a roof |

The real lever is **fill factor on cut-up roofs**. Smaller modules usually win
on hip roofs with dormers. Larger ones win on big rectangles. The twin should
show kWp, panel count and kWh/yr side by side when the user switches.

## Plausibility checklist

Run these against the `planArray` output. Tolerances in brackets.

1. **kWp arithmetic.** `summary.kWp = panels.length × panel.watt / 1000` (exact),
   and each `array.kWp` adds up to the total.
2. **Specific yield.** `summary.specificYield` is between 1,100 and 1,450
   kWh/kWp/yr for unshaded arrays at Ara Damansara. Below 950 needs heavy shade
   to explain it. Above 1,500 is a bug (POA or loss chain).
3. **PR.** `annualKwh / (Σ poaKwhM2 × panel area × efficiency)` lies in
   0.72-0.84. That is AC kWh over DC STC-equivalent, with shading excluded from
   the POA used here.
4. **POA vs GHI.** Unshaded `poaKwhM2` lies in 0.90-1.03 × 1,753 kWh/m²/yr for
   tilt ≤ 30°. No panel exceeds 1,820.
5. **Diffuse matters.** A panel next to a tall obstacle shows `shadeLoss` > 0
   even if never beam-shaded at noon. Annual shade loss never exceeds 1.0, and
   an open roof averages < 0.05.
6. **Coplanar flush mount.** For `mounting: 'flush'`, every panel corner's
   distance to its roof plane (along the normal) is within 0.08-0.15 m. Panel
   `normal` · roof `normal` ≥ cos(1°). `tiltDeg` equals roof tilt (±1°) and
   `azimuthDeg` equals roof azimuth (±2°).
7. **Inside the usable area.** All 4 corners are inside the roof outline offset
   inward by the setbacks:
   - ≥ 0.5 m from the ridge (0.9 m if fireStrict)
   - ≥ 0.4 m from the eave and verges
   - ≥ 0.3 m from valleys and obstacles
   - flat slab ≥ 1.0 m from the edge
   - nothing overhangs.
8. **No overlaps.** Panel footprints are pairwise disjoint. No panel
   intersects an obstacle footprint or an occupancy voxel above the roof.
9. **Rectangular grid.** Within an array, all panels share orientation and
   axes. Centres sit on a lattice with u-pitch = width + gapM and v-pitch =
   `rowPitchM` (±5 mm). `gapM` is in 0.018-0.025 m for flush. The array
   outline is a rectangle or a union of full rows.
10. **Panel dimensions.** Each panel's edge lengths equal the catalogue
    width/length (±5 mm), and its corners are CCW from above.
11. **Load.** `loadKgM2 = (n × weightKg + racking × area) / area`. It is
    10-20 kg/m² flush, 30-60 ballasted, and `weightKg ≈ n × panel.weightKg × 1.15-1.35`.
12. **Flat-slab tilt.** If the roof tilt is < 5° and the mounting is tilted:
    `tiltDeg` is in 5-15° (default 10). Row pitch ≥ L·cosβ + L·sinβ/tan(α_p).
    Recomputed inter-row shade between 09:00 and 15:00 on both solstices is 0.
    GCR ≤ 0.8.
13. **No floating or tilt-up on pitched roofs.** No panel on a roof steeper than
    5° has a tilt different from the roof's, and no panel's lowest corner is
    below the roof plane.
14. **Ranking sanity.** Removing the lowest-ranked panel never removes more
    energy than removing a higher-ranked one. `reason.headline` mentions shade
    for panels with `shadeLoss` > 0.10.
15. **Minimum flux.** Every placed panel has `poaKwhM2` ≥ 0.8 × the best
    panel on the same roof (or a documented threshold). Excluded areas appear
    in `rejected` with a `why`.
16. **String-sensible count.** For the default panel and a 5 kW single-phase
    inverter, the panel count per array is 6-14 per string, and the total
    is ≤ 2 strings. kWp ≤ 6.5 when `targetKwp` is null on a single-phase
    house, or a warning is given.
17. **Grid cap.** The default plan respects Solar ATAP: ≤ 5 kWac single-phase,
    ≤ 15 kWac three-phase. Otherwise `assumptions` lists the cap breach.
18. **Thermal.** The mean irradiance-weighted cell temperature is 45-60 °C. The
    annual temperature loss is 5-11%. Flush runs hotter than tilted at the
    same irradiance.
19. **Monthly shape.** Monthly kWh follows `CLIMATE_KL.ghiKwhM2Day`: peak
    Feb-Apr, trough Nov-Dec, with a max/min month ratio of 1.15-1.35.
20. **Orientation effect is small.** At 3°N, an unshaded north-facing 20° roof
    plane yields within ±8% of a south-facing 20° plane. A much bigger gap means
    a sun-position or azimuth sign bug (x = east, z = south, north = −z).
21. **Determinism and speed.** The same inputs give an identical plan, and
    replanning in the browser takes < 1.5 s.
