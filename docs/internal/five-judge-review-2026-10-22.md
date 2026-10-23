Method: five independent agents; isolated design assessment A: /root/panel_ux; isolated detector/browser assessment B: /root/panel_hackathon.

# Solar Opportunity Mapper: five-judge review

Reviewed 22 October 2026, main f4c3f5e5ebd62957d1879c0e65721af5b9fa63db, index.html and http://127.0.0.1:5173/. Application source was unchanged during review. These are simulated professional perspectives from AI agents, not external expert validation.

The idea directly fits the supplied PLANET brief: prioritise roofs and car parks for detailed solar feasibility work. Keep that story. The central UX problem is that a comparison task is forced through a narrow, sequential site card. The product also needs stronger propagation of evidence status and corrections to two reproducible numerical defects.

| Independent perspective | Score /10 | Main criticism |
|---|---:|---|
| UX/product design | 6.0 | Comparing candidates loses list context; narrow scrolling panel hides the outcome. |
| SDP township development | 7.0 | Geographic candidates need property control, evidence status and an actionable study handover. |
| Solar engineering/GIS | 7.2 | Shading, existing-PV coverage and narrow-roof layout defects can affect recommendations. |
| Commercial/procurement | 6.7 | Better shortlists and staff time savings remain unproven. |
| Hackathon judging | 7.5 | Strong brief alignment and working journey; evidence of recommendation quality is the scoring ceiling. |

Scores are subjective assessments through different lenses, not a predicted competition result. The hackathon judge rated impact 20/25, innovation 15/20, feasibility 15/20, fit 14/15, commercial 6/10 and evidence/pitch 5/10.

## Design health

| Nielsen heuristic | Score /4 | Finding |
|---|---:|---|
| System status | 2 | Provisional rankings appear actionable before analysis finishes. |
| Match to real-world task | 3 | Screening and evidence fit the brief; handover language needs clarity. |
| User control | 3 | Back navigation works; comparison context disappears on selection. |
| Consistency | 3 | Three stages are understandable; export choices fragment the finish. |
| Error prevention | 2 | Unknown PV status and precise-looking assumptions need prominent treatment. |
| Recognition rather than recall | 2 | Users must remember previous candidates while inspecting another. |
| Efficiency | 2 | Repeated panel navigation and scrolling slow comparison. |
| Minimalist design | 2 | Map dominates; detailed sidebar and six export formats increase decision load. |
| Error recovery | 2 | Review gaps are stated more clearly than their resolution workflow. |
| Help/documentation | 3 | Assumptions and missing checks are explained. |
| Total | 24/40 | Acceptable foundation; significant UX improvements needed. |

Design specificity: the township map and evidence-to-handover process are appropriate to this product. The generic narrow sidebar underserves the actual decision. Improving panel allocation and comparison will matter more than changing visual styling.

## What works

- Priority → Evidence → Handover provides a coherent route through a site. The hackathon judge completed it in a fresh browser tab.
- Scores, assumptions, geometry sources and missing engineering checks are disclosed. Known existing-solar and no-longer-building exclusions show concrete data review.
- A shortlist and installer-facing brief are useful outputs for the stated problem. Drone inspection can support that output when used as optional evidence.

## Five priorities

### 1. [P1] Make comparison the main workspace

At 1280×720, a roughly 380px panel carries the decision while the map takes most of the viewport. Selecting a site replaces the candidate list, making comparisons depend on memory. Only about two full ranked rows appear initially.

Fix: retain a compact candidate list beside site detail. Show generation, shading, demand basis and the leading unresolved check. Give the work area roughly 45% of desktop width, make the map flatter for inspection, and offer 3D as an optional view. Label near-tied rankings as similar priority rather than implying a meaningful 87-versus-86 difference. Suggested command: $impeccable layout.

Evidence: src/main.js:456, 567, 833; src/workspace.css:30.

### 2. [P1] Attach evidence strength to every recommendation

During analysis, Evolve/Paradigm appeared with provisional scores and 100% sun before the completed ranking changed to Persada. After completion, 100% sun and onsite use still look more certain than category demand and sampled shadow estimates warrant. Evolve's unclear imagery status is not carried consistently into shortlist/export checks. An already-shortlisted Citta Mall still appears as a normal shortlist row despite its existing-solar warning inside the detail.

Fix: mark unfinished results as provisional and enable the top recommendation only after analysis. Place checked/unclear/unknown evidence states beside each metric and candidate, and preserve status, note, source and date through shortlist and export. Retain excluded saved sites for audit with explicit warning rather than silently treating them as active proposals. Unknown PV status must not read as confirmed panel-free. Suggested command: $impeccable harden.

Evidence: src/main.js:563, 569, 839, 889; src/roof-checks.js:17, 25; src/shortlist.js:28; src/solar.js:204, 221.

### 3. [P1] Fix model defects before polishing their output

Two reproducible defects affect user-visible decisions:

- Car parks use a fixed 0.95 shading factor instead of the roof raycaster (src/main.js:1563). For BBR way1384934125, the existing raycaster returned about 0.642; substituting it materially changed modelled yield and priority. This comparison exposes inconsistent modelling, not measured ground truth. Calculate shading at proposed canopy height; explicitly label any fallback assumption.
- A 30×3m rectangle fits 12 modules with default settings, but adding a constant full-sun scoring function produces zero modules. The neighbor-count pruning removes valid single-row strings (src/panels.js:129). Preserve valid connected strings and add a regression test. Aesthetic filtering must not imply physical infeasibility.

Additional requirements: separate rooftop generators are not queried and spatially joined to buildings; curated checks cover only a small subset. Car parks have no linked host demand, yet export-only economics can still appear actionable. Require host/load/tariff evidence before decision-grade payback. Generated-array exposure is not currently used to update energy estimates separately from whole-roof exposure. Suggested command: $impeccable harden, plus solar model corrections and targeted tests.

### 4. [P1] Give the journey one visible finish

Handover foregrounds adding a shortlist item while the brief/download actions sit lower down; the top Export menu offers six formats. Users must infer whether they are finishing one site or a batch.

Fix: keep one sticky primary action per state: Review site → Add to study shortlist → Export study brief. Keep View shortlist/count visible. Put technical formats under Other formats. Give the selected portfolio totals and site-specific next checks, with optional SDP asset ID/control status, responsible person, evidence reference and next action. Keep finance, batteries and drone processing subordinate to the screening task. Suggested command: $impeccable distill.

Evidence: src/main.js:766, 775; index.html:28; src/shortlist.js:12.

### 5. [P1] Demonstrate shortlist quality

The supplied brief explicitly suggests testing shortlist quality against expert assessment. The validation document is a plan; this review found no completed independent comparison. Twenty-three passing JavaScript tests establish software behavior, not field accuracy.

Fix: freeze a small mixed-site sample and initial rankings; compare against an independent installer/engineer and a simple largest-roof baseline. Record accepted candidates, missed disqualifiers, changes after real bills/surveyed geometry, and analyst time. Present actual results, including failures. Add a concise evidence summary to the handover. Suggested command: $impeccable document for presenting real results; external validation itself requires real participants.

Evidence: docs/validation-plan.md; src/shortlist.js:35; src/main.js:839.

## Recommended flow

1. Choose township and see analysed candidate list with data readiness.
2. Select a site while the list remains visible; read three recommendation reasons and its main unknown.
3. Review site-specific area, shading and demand evidence. Optional drone inspection belongs here.
4. Add selected sites to a persistent study shortlist.
5. Export one brief containing assumptions, warnings, next checks and references.

The goal for a first-time user is to identify a candidate, explain why it is worth studying and produce a reviewable handover without opening secondary scenarios.

## Persona and interaction findings

- Impatient planner: repeated one-site navigation and close scores make comparative decisions slow.
- First-time user: Handover does not clearly communicate that the useful task is complete.
- Keyboard-dependent user: Escape closes Export without restoring focus to its trigger. Screen-reader, mobile and contrast compliance remain unverified.
- Cognitive load: six equal export choices exceed a manageable immediate decision; generic evidence warnings compete with the site's specific unknown.
- Emotional journey: the map creates a strong first impression; repetitive scrolling is the valley; the export should be a visible, reassuring finish.

## Hardest panel question

For SDP's next ten site studies, how many of these recommendations survive independent review, why are they better than choosing the largest roofs, and how much staff time is saved?

## Run notes

- Five fresh independent agents, self-contained prompts, no other judges' findings supplied. UX assessment completed before detector output entered synthesis.
- Target slug index-html; ignore file absent. No application source edits.
- UX, SDP and hackathon judges walked fresh browser tabs. Commercial inspection was partial because of stale browser references. Solar judge used source inspection and numerical probes. Root repeated the narrow-roof probe and checked shortlist warning propagation.
- Detector ran exactly once on index.html, exit 0, [] / zero findings. Degraded regex fallback lacked htmlparser2, css-select, css-tree and domutils. Dynamic application markup, computed styles, contrast and selector matching were not comprehensively scanned. No extra findings or false positives were available; zero is not accessibility clearance.
- Browser evidence used screenshots and accessibility DOM. Read-only evaluation prevented mutable detector injection, so no overlay or detector server was started. No viewport/visibility changes were made. Judges reported closing their temporary tabs; the user app and existing development server were retained.
- Review artifacts only were written. No deployment, Git commit or push was performed as part of this audit.

Follow-up preferences: choose comparison workspace versus guided full-page review; choose the first three priorities versus all five for the implementation scope. Comparison workspace with all five priorities is the panel synthesis recommendation, with model correctness and evidence states addressed before visual polish.
