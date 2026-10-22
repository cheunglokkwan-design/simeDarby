# Drone footage to 3D scan and draft solar layout

## Current status

The app includes the upload flow, resumable job tracking, the GPU worker source,
and draft panel packing. The worker has not been hosted or run on real drone
footage. API and pipeline-contract tests use mocked reconstruction commands;
they do not establish GPU training quality or container compatibility.

The user supplies GPU hosting later. No cloud account, spend, remote upload or
deployment has been performed.

## User workflow

1. Select the building shown in the capture.
2. Choose **Create solar layout from drone footage**.
3. Select an MP4, MOV, M4V or WebM video, then **Create 3D scan & layout**.
4. Follow real stages: upload, camera reconstruction, GPU training, export.
5. When complete, the app saves the scan locally, generates a draft panel layout,
   and opens the viewer. Align the mapped roof with the scene and review findings.

Uploads require a configured, ready worker. Without one, the app explains what
is missing and offers **Preview draft panel layout** and finished-splat imports.
Job IDs survive reloads in localStorage on the same origin. Files, alignment and
findings are stored in IndexedDB; they are not automatically shared with others.

## Deploy the worker on a Linux NVIDIA GPU host

The Dockerfile extends Nerfstudio's documented 1.1.3 image. The base image, CUDA
driver and GPU compatibility must be checked on the chosen host. A GPU with at
least 12 GB VRAM is a practical starting allocation for these captures, not a
guarantee for every scene. The process needs disk space for source video, extracted
frames, checkpoints and the exported splat.

Build from the repository root:

```sh
docker build -f worker/Dockerfile -t solar-drone-worker .
```

Copy `worker/worker.env.example` to `.env.worker.local` on the GPU host. Set a
strong random `DRONE_WORKER_TOKEN`. This local file is ignored by Git. Then run:

```sh
docker run --gpus all --shm-size=12gb --restart unless-stopped \
  -p 8080:8080 -v solar-drone-data:/workspace/drone-jobs \
  --env-file .env.worker.local solar-drone-worker
```

Put the worker behind the hosting provider's HTTPS endpoint. Set its request-body
limit to match the configured upload limit. The worker processes one job at a
time, accepts at most four active/queued uploads, and must run with one Uvicorn
process. Use persistent storage. A restart marks interrupted jobs as failed so
the user can retry. Uploaded footage and training artifacts remain on that volume;
the host operator manages retention and cleanup.

## Connect localhost

Add these server-only values to the project's ignored `.env.local`:

```dotenv
DRONE_WORKER_URL=https://your-worker-host
DRONE_WORKER_TOKEN=your-worker-token
```

Restart `npm run dev`. Vite proxies `/api/drone` to the worker and adds the bearer
token server-side. The token must never be prefixed `VITE_` or sent to the browser.
The same proxy works with `npm run preview`.

For a deployed frontend, configure an equivalent authenticated server-side proxy
on its host. A static-only deployment does not provide this proxy. This package
is a single-operator prototype; multi-user deployment needs application login,
per-user job access, quotas and storage ownership before exposing it broadly.

## Worker contract

All routes require `Authorization: Bearer <worker-token>`:

| Route | Behaviour |
| --- | --- |
| `GET /api/drone/health` | Dependency/GPU readiness and upload limits |
| `POST /api/drone/jobs` | Multipart `site_id` and `video`; returns HTTP 202 and a job ID |
| `GET /api/drone/jobs/{id}` | Current stage and a user-readable message |
| `GET /api/drone/jobs/{id}/scan` | Gaussian PLY after completion; HTTP 409 while unavailable |

The pipeline validates video duration with FFprobe, extracts approximately 200
frames and estimates cameras with `ns-process-data video`, trains Splatfacto,
then runs `ns-export gaussian-splat`. Logs remain in each job directory. Short,
sharp, overlapping footage improves the chance of reconstructing camera poses.
Training output may require cropping or different settings for very large scenes.

## What the automatic layout means

The layout is a preliminary packing against the selected OpenStreetMap roof
footprint in local metres. It tries two orientations along the longest roof edge,
uses assumed 1.134 × 2.278 m / 550 W modules, leaves 0.12 m module gaps and a 0.6 m
edge setback, and respects the site's modelled panel-count cap. Concave boundaries
are checked to avoid panels bridging missing sections.

User-marked blocked rectangles are also excluded, and source-backed site inputs
can replace demand and usable-area assumptions. When the packed panel capacity is
lower than the initial model, the site's solar economics and ranking are reduced
to that capacity. These corrections are stored on the same browser origin; they
do not independently establish survey accuracy or permission to install.

The video reconstruction supplies the visual inspection scene. It does **not**
currently supply a calibrated roof segmentation, obstacle map or structural model.
The draft assumes a flat plane at the estimated height and is not an installation
design. Measurements, roof pitch, fire/access pathways, obstructions, loading and
electrical design still need review. An unreferenced splat has arbitrary scale and
orientation; saved alignment supports visual comparison, not survey accuracy.

## Validation

```sh
npm test
npm run test:worker
npm run build
```

Worker API tests require the packages in `worker/requirements.txt` and `httpx`.

References: [Nerfstudio Docker setup](https://docs.nerf.studio/quickstart/installation.html#use-docker-image),
[video processing](https://docs.nerf.studio/quickstart/custom_dataset.html),
[Splatfacto and export](https://docs.nerf.studio/nerfology/methods/splat.html).
