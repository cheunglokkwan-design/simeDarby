# Drone scans: from flight to the app

## Import and review on localhost

Select a building in **Find roofs**, then choose **Add drone scan**. Import a
finished Gaussian `.ply`, `.splat` or `.ksplat` file (up to 200 MB). Files,
alignment and findings are saved in IndexedDB in this browser on this device;
they are not uploaded or shared. Keep the original files. Browser data is scoped
to the exact origin, so `localhost` and `127.0.0.1` have separate scan libraries.

In the viewer, use **Align → Save alignment**, then **Findings → Save findings**.
The status becomes **Scan reviewed** only after recording findings and checking
the review checkbox. Saving a new alignment resets that status. This is a visual
review, not measurement or structural certification. Removing a local scan
restores the published entry, if one exists.

Raw drone-video reconstruction and automatic panel-layout generation are not
implemented in this version. A deployable remote GPU worker is planned; no worker
hosting or credentials have been configured.

The manual publishing workflow below remains available for shared scan assets.
Its older "Drone-verified" wording now corresponds to "Scan available" until a
review is explicitly saved.

A drone scan turns a shortlisted roof from "our estimate" into "checked". In the
app, a scanned roof's card gets a **Drone-verified** badge and a **View drone
scan (3D)** button. The viewer draws our predicted roof outline (yellow) and
usable panel area (blue) over the Gaussian splat, so anyone can see where the
model was right or wrong.

Scan the top 10–20 commercial roofs, not the whole township: open data already
covers every roof, and malls and factories have one owner who can give permission.

## 1. Before flying

- **Permission:** the building owner, in writing. Avoid flying over homes (privacy).
- **CAAM:** Ara Damansara is next to Subang Airport, so a flight there likely needs
  Civil Aviation Authority of Malaysia approval and may not be allowed at all.
  Bandar Bukit Raja is a better first site. Check CAAM's current drone rules for any site.
- **Weather:** overcast is ideal (soft shadows, no glare off metal roofs).

## 2. Capture (about 10 minutes per roof)

One flight gives two outputs: photogrammetry for measurements and a splat for the visual.

- **Orbit 1:** circle the building at roughly 1.5× its height, camera tilted 45° down, a photo every ~10° (≈36 photos).
- **Orbit 2:** higher and tighter, camera 60–70° down (≈36 photos).
- **Grid:** a straight-down lawnmower pass over the roof with 70–80% overlap.
- Or record a slow 2–3 minute 4K video along the same orbits.
- Keep GPS tagging on: it lets the scan be placed on the map with little manual alignment.

## 3. Process

| Output | Tool | Notes |
|---|---|---|
| **Splat (for the app)**, Pathway A, no GPU | Polycam or Luma AI | Upload photos or video, export `.ply` |
| **Splat**, Pathway B, GPU | nerfstudio `splatfacto` on Colab, RunPod or a local NVIDIA GPU | `ns-process-data` → `ns-train splatfacto` → `ns-export gaussian-splat` |
| **Measurements** | OpenDroneMap (free) | Orthophoto and a measurable 3D mesh: use it for roof area, pitch and height |

The splat is for seeing; the photogrammetry model is for measuring. Use both.

## 4. Clean up and compress

1. Open the `.ply` in [SuperSplat](https://superspl.at/editor) (free, in the browser). Crop to the building and its surroundings, delete floaters, and level it so the roof is horizontal.
2. Export `.ply` (or `.splat`). Aim for under ~50 MB so it loads quickly.
3. Optional: convert to `.ksplat` (faster loading) with the converter in the
   [GaussianSplats3D repo](https://github.com/mkkellogg/GaussianSplats3D): `node util/create-ksplat.js in.ply out.ksplat`.

## 5. Publish

- **Small files (< 50 MB):** put them in `public/splats/`, e.g. `public/splats/way-780152646.ksplat`.
- **Larger files:** upload them to a public Supabase Storage bucket (GitHub rejects files over 100 MB) and use that URL.

Add an entry to `public/splats/scans.json`, keyed by the site's OSM id (shown on its card and site brief):

```json
"scans": {
  "way/780152646": {
    "url": "/splats/way-780152646.ksplat",
    "title": "Citta Mall",
    "captured": "2026-10-21",
    "source": "DJI Mini 4 Pro · Polycam",
    "cameraUp": [0, 1, 0],
    "camera": { "position": [0, 60, 80], "lookAt": [0, 0, 0] },
    "overlay": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1 }
  }
}
```

## 6. Align and record findings (in the app)

1. Open the site's card and click **View drone scan (3D)**.
2. **Align** tab: move, turn and scale the yellow outline until it sits on the scanned roof. Click **Copy alignment** and paste it into the entry's `overlay`.
3. **Findings** tab: record roof type, rooftop equipment, existing panels, condition, and whether our height and usable area match. Click **Copy scan entry** and replace the entry in `scans.json`.
4. Reload the app. The card now shows **Drone-verified** with the findings.

`cameraUp`: Polycam and SuperSplat exports are usually Y-up (`[0, 1, 0]`);
raw nerfstudio or COLMAP output is often Y-down (`[0, -1, 0]`).

The **Open 3D viewer with sample scene** button in Settings loads a public test
scene with a stand-in footprint, for trying the viewer and Align tool before a real scan exists.
