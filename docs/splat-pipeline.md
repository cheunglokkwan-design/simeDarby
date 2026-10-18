# Micro-verification: making your own Gaussian splat

The demo's `splat.html` loads an open-source sample scene. To show a rooftop or
township scene instead, make a splat from open drone imagery and load it with
`splat.html?url=<your file>`.

## 1. Get open drone images

- **OpenDroneMap sample datasets**: https://github.com/OpenDroneMap/ODMdata
  (e.g. `odm_data_aukerman`, `brighton-beach`: about 50–200 JPGs each).
- **DroneSplat (CVPR '25)** / **UrbanScene3D**: bigger and better for urban scenes,
  but heavy downloads.
- **OpenAerialMap** gives orthophotos (2D), not multi-view images, so it can't be used for splats.

## 2a. Pathway A: zero VRAM (fastest)

1. Upload the images (or a fly-over video) to **Polycam** (Gaussian Splat
   capture) or **Luma AI**.
2. Wait for processing (~15–60 min), then export `.ply` or `.splat`.
3. Put the file in `public/splats/` and open `/splat.html?url=/splats/your-file.ply`.

## 2b. Pathway B: free/rented GPU (nerfstudio)

On Google Colab (free T4) or RunPod:

```bash
pip install nerfstudio
ns-process-data images --data ./images --output-dir ./processed   # runs COLMAP
ns-train splatfacto --data ./processed --max-num-iterations 15000
ns-export gaussian-splat --load-config outputs/*/splatfacto/*/config.yml --output-dir ./export
```

Download `export/splat.ply` into `public/splats/`.

## 3. Load it in the app

`splat.html?url=/splats/splat.ply&site=Raya%20Complex`. The **Micro-verify in 3D** button
on a site card already passes `site=`. To make your scene the default, change
`DEFAULT_SPLAT` in `src/splat.js`.

Large `.ply` files (>100 MB) load slowly. Convert to `.ksplat` with the
`@mkkellogg/gaussian-splats-3d` CLI or trim the scene first.
