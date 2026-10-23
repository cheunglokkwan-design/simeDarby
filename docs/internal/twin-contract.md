# Digital twin: shared contract

The digital twin shows a drone-scanned building with a simulated solar array on
it. Three pieces meet here; each owns its own files.

| Piece | Owner | Files |
|---|---|---|
| Research: panel specs, mounting rules, physics, plausibility | research agent | `docs/twin-research.md`, `src/twin/catalogue.js` |
| Scan preparation + placement algorithm | algorithm worker | `scripts/prepare_twin.py`, `src/twin/{sun,shade,placement,irradiance}.js`, `tests/twin-*.test.js`, `public/twins/friend-house/*` |
| Viewer (twin.html) | viewer worker | `twin.html`, `src/twin-viewer.js`, `src/twin.css`, the link from the app (`vite.config.js` input, `src/main.js` / `src/splat.js` button) |

Nobody commits. Nobody edits another piece's files; ask the manager instead.

## Source scan

`C:/Users/User/splatwork/friend/export_30000.ply`: binary little-endian PLY,
1,126,007 vertices, **x y z float32 only** (ImageToStl stripped colour,
opacity, scale and rotation). Frame is the trainer's (COLMAP) frame: not
gravity-aligned, arbitrary scale, arbitrary heading. ~2% of points are
floaters far outside the building.

## Twin frame (everything after preparation uses this)

- Metres. **x = east, y = up, z = south** (right-handed, same as Three.js
  default with north at -z). Origin = ground level under the building centre.
- `twin.json` records what was assumed: `scale` (metres per scan unit) and how
  it was estimated, `northBearing` (degrees, rotation applied so -z is north;
  user-adjustable in the viewer because a drone scan has no compass),
  `location` {lat, lon, name, timezone: 8}. Default location: Ara Damansara,
  3.11 N, 101.58 E (no GPS in the scan; viewer lets the user change it).

## Files in `public/twins/friend-house/`

- `points.bin`: decimated, cleaned points, Float32 x,y,z interleaved in the
  twin frame (keep under ~6 MB). Optional `normals.bin` Int8 x3 (×127).
- `twin.json`:
  ```json
  {
    "id": "friend-house", "title": "...", "source": "...",
    "pointCount": 0, "bounds": {"min": [x,y,z], "max": [x,y,z]},
    "scale": {"metresPerUnit": 0, "method": "...", "confidence": "low|medium|high"},
    "northBearing": 0, "location": {"lat": 3.11, "lon": 101.58, "name": "Ara Damansara (assumed)"},
    "ground": {"y": 0},
    "roofs": [{
      "id": "R1", "normal": [x,y,z], "point": [x,y,z],
      "tilt": 0, "azimuth": 0,
      "outline": [[x,y,z], ...],
      "eaveDir": [x,y,z],
      "area": 0, "obstacles": [{"outline": [[x,y,z],...], "height": 0, "kind": "..."}]
    }],
    "occupancy": {"origin": [x,y,z], "voxel": 0.25, "dims": [nx,ny,nz], "file": "occupancy.bin"}
  }
  ```
  `occupancy.bin`: Uint8 per voxel (1 = solid), x fastest then y then z; used
  for shadow raycasts in the browser.

## Algorithm API (`src/twin/placement.js`, pure JS, runs in node and browser)

```js
planArray(twin, occupancy, options) -> Plan
// options: { panel: catalogue entry, mounting: 'flush'|'tilted', tiltDeg, rowGap (auto),
//            setback (m), targetKwp|null, maxPanels|null, date range, lossFactors }
// Plan:
{
  panels: [{ id, roofId, arrayId, row, col,
             corners: [[x,y,z] x4],      // panel top surface, twin frame, CCW seen from above
             centre: [x,y,z], normal: [x,y,z], tiltDeg, azimuthDeg,
             annualKwh, poaKwhM2, shadeLoss /*0-1*/, sunHoursYear,
             reason: { headline, bullets: [..] } }],
  arrays: [{ id, roofId, rows, cols, orientation: 'portrait'|'landscape',
             widthM, lengthM, origin: [x,y,z], axisU: [x,y,z], axisV: [x,y,z],
             rowPitchM, gapM, setbackM, tiltDeg, azimuthDeg,
             weightKg, loadKgM2, kWp, annualKwh, reason }],
  rejected: [{ roofId, outline, why }],
  summary: { panels, kWp, annualKwh, specificYield, avgShadeLoss, assumptions: [..] }
}
sunPosition(date, lat, lon) -> { azimuth, elevation }      // src/twin/sun.js, degrees
shadowMask(occupancy, sunDir) / sunlitFraction(point, sunDir) // src/twin/shade.js
```

The viewer imports these directly, so changing panel model, tilt, setback or
target size re-plans live in the browser (aim < 1.5 s).

## Colour language (viewer)

- Scan points: neutral warm greys shaded by height/normal (never blue).
- Panels: saturated deep blue cells with a white/silver frame and a cyan
  outline glow; selected panel amber. Rejected or shaded areas: translucent red
  hatch. Sun heatmap on roofs: yellow→purple, toggleable.
