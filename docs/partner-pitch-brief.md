# Partner pitch brief — Solar Opportunity Mapper

## One sentence

**We help Sime Darby Property decide which rooftops and car parks deserve a solar feasibility study first, with the reasons, missing evidence and installer handover in one place.**

## The problem and the user

An SDP development or sustainability planner has many mapped sites but limited time and budget for detailed surveys. Roof size alone does not explain shading, electricity demand, existing installations or the checks needed to proceed. The decision we support is: **where should the next site study go, and what must it verify?**

This directly matches the supplied PLANET challenge: “Choosing the right sites for solar” / “Solar opportunity mapper.” Its suggested test is shortlist quality against expert assessments. Keep this problem consistent across the deck, video and application.

## Answer for Raya: what is the technology, and how does it assess solar?

The app starts with a township map and screens roofs before any drone flight. Drone footage adds a closer 3D inspection of a selected roof. The decision engine uses geometry, solar-energy modelling and financial scenarios to identify sites worth a professional feasibility study.

| Factor | How the prototype handles it | What needs confirmation |
|---|---|---|
| Usable roof area | OpenStreetMap footprint multiplied by an assumed usable fraction; source-referenced area corrections are supported. | Surveyed dimensions, roof pitch, equipment and access. |
| Existing panels / unavailable roofs | Curated imagery checks, building solar tags, separately mapped rooftop generators on refreshed OSM data, and source-referenced user inspection findings. Known installations/unavailable roofs are excluded. | Detection coverage is incomplete; unknown means not checked. |
| Sun and shade | Raycasting from roof/canopy points toward sun positions on four representative dates using neighbouring building heights. | Heights, trees and rooftop obstacles; this is a sampled building-shadow proxy, not measured annual irradiance. |
| Electricity generation | Proposed kWp × weather-derived specific yield × the shadow factor. Cached yield comes from pvlib using PVGIS-ERA5 hourly weather for 2005–2023 and assumed tilt/orientation. | Actual roof planes, equipment specification and independent energy simulation. |
| Electricity demand | Household/category proxies or source-referenced annual consumption; an assumed daytime fraction estimates onsite use. | Actual bills and interval load data. Canopies need a linked host scenario before financial benefits are displayed. |
| Draft panel placement | Fits real-size module rectangles inside mapped boundaries with setbacks, spacing, optional walkways, marked exclusions and sampled sun scores. | Accurate scale, roof planes, obstacles, electrical string design, mounting and structure. |
| Financial scenario | Assumed installation cost, energy tariff, export value and maintenance produce illustrative savings and simple payback. | Installer quote, current applicable scheme/tariff and verified demand. |
| Permissions and deliverability | Mapped flags, reported property control, evidence references and next actions are carried into the study brief. | Structural approval, ownership/access, utility connection and other required permissions. |

**Ranking today:** 40% generation, 25% estimated onsite-use share, 20% modelled payback and 15% sampled sun exposure, with mapped review penalties. These are heuristic weights, not learned or expert-calibrated accuracy. Unknown evidence is shown separately; close scores do not establish a meaningful difference.

**Drone / Gaussian-splat role:** overlapping footage can reconstruct a viewable 3D scene. A Gaussian splat is useful for visual inspection. In the current app, panel placement uses the mapped footprint; the splat does not automatically supply surveyed roof planes, structural strength or installation approval. Finished scans can be imported. The prepared remote GPU processing path still requires hosting and a demonstrated end-to-end run.

**Software stack:** JavaScript/Vite web app; MapLibre and deck.gl for the township map and overlays; a browser Web Worker for shadow calculations; pvlib/PVGIS-derived yield data; Three.js and GaussianSplats3D for scan viewing. Shortlists, study notes and local scans remain on the current device unless an explicit external export/integration is used.

**Forwardable short answer:** “We screen township roofs using usable area, sun/shade, expected energy output, electricity demand and financial assumptions. We flag existing panels and missing checks, then rank which sites deserve a study. Drone footage supplies a 3D inspection view to help check the mapped roof and draft layout. The output is a shortlist and feasibility-study brief; engineers still confirm structure, surveyed geometry, electrical connection and permissions.”

## Ten-slide story

| Slide | Message | What to show |
|---|---|---|
| 1. The decision | Which sites should SDP study first for solar? | One roof selected within the township map; project name. |
| 2. The problem | A large roof is only the start. Survey teams need a reasoned shortlist. | Area, shading, demand, existing panels and missing permissions as the screening questions. No invented survey-cost or time-saving statistic. |
| 3. The user | SDP planners screen candidates; engineers and installers verify feasibility. | Planner → study shortlist → professional site assessment. Residents benefit downstream from suitable projects. |
| 4. The solution | Compare sites, inspect the evidence, export a study brief. | Three screenshots from the final app: candidates, evidence, handover. |
| 5. How it works | Open building geometry + estimated heights + sampled building shadows + weather-derived yield + demand assumptions. | A plain pipeline with source labels. Category demand and geometry are estimates unless replaced by site evidence. |
| 6. What is different | A recommendation includes its reasoning and the work needed to check it. | Compare two candidates; show one specific evidence gap and a flagged/excluded existing installation. Avoid claiming the mapper concept itself is novel: it is in the brief. |
| 7. Working demonstration | From township to a reviewable shortlist. | Select a site, explain its generation and demand basis, inspect its main unknown, add it and open the printable study brief. Optional drone scan supports inspection; it does not automatically extract a certified roof design. |
| 8. Impact and value | Spend study effort on better-supported candidates; make decisions traceable. | Measurement plan: accepted candidates per ten recommendations, missed disqualifiers, analyst time and changes after bills/surveys. Environmental figures are modelled scenarios, not realised reductions. |
| 9. Feasible pilot | Test ten authorised sites against an independent expert and a largest-roof baseline. | Roof measurements, existing-PV check, bills, property access, installer feedback. Freeze original recommendations before reviewing them. Pilot and commercial terms are proposed, not agreed. |
| 10. The ask | Help us validate a ten-site pilot and measure shortlist quality. | Team, working application, named pilot needs, verified link/QR once available. |

## What we can honestly claim

- A working prototype screens mapped roofs and car parks in Ara Damansara and Bandar Bukit Raja.
- It combines building geometry, estimated heights, sampled shadow modelling, weather-derived solar yield and category-based electricity-demand assumptions.
- Users can inspect priority factors, replace selected assumptions with source-referenced evidence, assemble a study shortlist and export a brief.
- Known existing-solar and unusable-roof cases can be excluded. Unknown sites are not confirmed panel-free; review coverage is incomplete.
- Optional Gaussian-splat inspection and draft panel placement support review. Draft placement uses mapped geometry; it is not a surveyed, structurally approved installation design.

## What needs proof — do not present as completed

- No completed independent expert-vs-model accuracy study or demonstrated improvement over a simple baseline.
- No demonstrated staff-time or study-cost saving; no agreed SDP customer, paid pilot or commercial price.
- No verified electricity bills, installer quotations or survey for the lead recommendation unless the team actually supplies them.
- No real hosted GPU processing run has been established in this session. A scan of a teammate's house does not validate an SDP property.
- No Elmina coverage in the current application. No township-wide installation approval, structural assessment or confirmed utility connection.
- Do not pitch a mortgage product, CREAM lease or battery system as the main solution. They are supporting illustrative scenarios.

## Numbers and screenshots

Do not freeze township MWp or site savings into slides until the final model build is ready. Record the site ID, township, assumptions, snapshot date and whether a draft layout is applied. Label capacity “modelled mapped capacity” and financial outputs “illustrative assumptions.” Distinguish generation in MWh/year from capacity in kWp/MWp. Show the same site and configuration in deck and video.

The five AI judge perspectives rated the pre-improvement prototype 6.0–7.5/10; these are internal critique, not customer validation or competition predictions. The comparison workspace, evidence-aware handover and model corrections are implemented and locally checked. Describe only verified behavior in the recording; no post-change 10/10 rating is claimed.

Navigation is now **Site screening** (default), **Community solar** and **Battery storage**, all visible. Community solar opens on the proposed roof groups; home finance is a supporting disclosure. Follow [the three-minute demo run sheet](hackathon-demo-run-sheet.md) for the main recording.

## Suggested opening voiceover

“Which rooftops should Sime Darby Property study first for solar? A large roof can still have shading, an unsuitable electricity profile or panels already installed. Solar Opportunity Mapper brings those screening questions together. We compare mapped sites, explain each recommendation and turn the selected candidates into a brief for professional feasibility review. Our prototype works across two townships. Our next step is to test its shortlist against independent experts and measured site evidence.”

## Demo sequence, about 90 seconds

1. Choose the township and let analysis finish.
2. Compare two candidates and explain why their apparent priority is similar or different.
3. Select one; identify the usable-area assumption and main evidence gap.
4. Show a known existing-solar case and its exclusion/status, without implying complete detection coverage.
5. Add the chosen candidate to the study shortlist and open the printable brief.
6. End on the proposed ten-site expert validation pilot. Use the drone scan only if the working scene and its limitations strengthen this story.

## Pilot success measures

Use a fixed, mixed sample with permission to inspect. Compare the same sites with a blinded installer/engineer and an area-only ranking. Measure the share of recommended sites the expert accepts for study, missed existing-PV/geometry/load disqualifiers, change after real evidence, and analyst minutes per accepted candidate including manual review. Agree success thresholds before collecting results; do not invent favourable outcomes for the deck.
