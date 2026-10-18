// Gaussian splat viewer for the micro-verification step.
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

// Open-source sample scene (Tanks & Temples "train", via antimatter15/splat).
// Replace with your own splat exported from Polycam / Luma / gsplat.
const DEFAULT_SPLAT = 'https://huggingface.co/cakewalk/splat-data/resolve/main/train.splat';

const params = new URLSearchParams(location.search);
const url = params.get('url') || DEFAULT_SPLAT;
document.getElementById('site').textContent = params.get('site') ? `Selected site: ${params.get('site')}` : '';
document.getElementById('url').value = params.get('url') || '';
document.getElementById('form').onsubmit = (e) => {
  e.preventDefault();
  const u = document.getElementById('url').value.trim();
  if (u) { params.set('url', u); location.search = params.toString(); }
};

const viewer = new GaussianSplats3D.Viewer({
  rootElement: document.getElementById('viewer'),
  cameraUp: [0, -1, 0],
  initialCameraPosition: [-1, -4, 6],
  initialCameraLookAt: [0, 4, 0],
  sharedMemoryForWorkers: false // no COOP/COEP headers needed
});

const progress = document.getElementById('progress');
viewer
  .addSplatScene(url, {
    showLoadingUI: false,
    progressiveLoad: true,
    onProgress: (pct) => (progress.textContent = `Loading splat… ${Math.round(pct)}%`)
  })
  .then(() => {
    progress.textContent = 'Splat loaded.';
    viewer.start();
  })
  .catch((err) => (progress.textContent = `Failed to load splat: ${err.message}`));
