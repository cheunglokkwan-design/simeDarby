# Implementation and verification — 22 October 2026

## Delivered

- Partner pitch brief with ten-slide outline, voiceover, demo sequence, technology/factors explanation and boundaries on claims.
- Desktop candidate list retained alongside the selected site; labelled model outputs, demand basis and existing-panel status.
- Full-screen mobile study workspace with map/results switching, persistent workflow actions and restored export-menu focus on Escape.
- Source-referenced user panel checks, known-solar exclusions, and spatial joining of separate rooftop-generator records in refreshed OSM data.
- Real building-shadow calculation for proposed car parks. Proposed canopies do not act as existing shadow-casting buildings.
- Concave-roof sample points constrained to the roof interior. Narrow sunny panel strings survive layout filtering. Fully shaded/invalid scores return finite empty results.
- Draft-array exposure used once in energy estimates; financial/drawn module capacities stay aligned for generated home layouts.
- Car-park financial benefits withheld until host reference, annual load, daytime share and tariff are supplied.
- Local study actions, reported property control, asset references, selection rationale and original selection snapshot.
- Printable site/portfolio briefs; CSV/JSON exports carry warnings and study metadata. Active portfolio totals omit excluded/on-hold selections while retaining their records.
- Township/shadow-run guards prevent stale worker results from overwriting a newly selected township. Retry states cover data and shadow failures.

## Verification completed

- `npm test`: **33 passed, 0 failed**, including regression cases for narrow strings, separate solar records, canopy economics, sampled shading, exports and portfolio exclusions.
- `node --check src/main.js`: passed.
- `git diff --check`: no whitespace errors; Git reported normal LF/CRLF conversion notices.
- `npm run build`: passed. Vite retains a large-chunk warning for the mapping/3D dependencies; startup performance remains a limitation.
- Desktop live walkthrough: candidate selection → evidence → add to shortlist → handover → printable site brief → printable portfolio brief. Portfolio export retained the existing-solar warning on a previously saved Citta Mall entry and omitted it from active totals. The test-added Persada selection was removed afterwards; the original saved selection was retained.
- Mobile 390×844: full study view, header and candidate list inspected without horizontal document overflow. Mobile map/results switch and export-menu Escape focus recovery checked. Temporary viewport override restored afterwards.
- Layout detector: zero findings, with degraded regex fallback. Missing parser modules prevented computed contrast/selector coverage, and the dynamic application is not comprehensively scanned; this is not accessibility certification.
- Localhost server had stopped after interruptions. Restarted as a hidden Node/Vite process on 127.0.0.1:5173 and confirmed the application returned to “Analysis ready.”

## Limits that software changes do not resolve

Independent installer/expert comparison, surveyed SDP roofs, actual electricity bills, installation quotes, permission/connection confirmation and a real hosted GPU reconstruction run remain outstanding. No customer-validation, measured accuracy, demonstrated time saving or 10/10 competition outcome is claimed. Changes remain local in the working tree; this implementation pass did not push to GitHub.
