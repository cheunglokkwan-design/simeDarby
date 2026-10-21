// Drone scan viewer: a site's Gaussian splat with our predictions drawn over it.
//
// Opened from a site card (the parent page posts the site's footprint and
// estimates), or standalone: splat.html?site=<osm id> or splat.html?sample=1.
// The overlay uses its own transparent Three.js canvas that shares the splat
// viewer's camera, so it always draws on top of the splat.
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const siteId = params.get('site');
const isSample = params.has('sample');
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
const DEG = Math.PI / 180;

const DEFAULT_OVERLAY = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
// Stand-in footprint for the sample scene, so the overlay and Align tool can be tried out.
const DEMO_SITE = { id: null, name: 'Sample footprint', category: 'demo', footprint: [[-12, -6], [12, -6], [12, 6], [-12, 6], [-12, -6]], height: 6, area: 288, usable: 190, kwp: 34, panels: 62, flags: [] };

let site = null;
let scan = null;
let overlay = { ...DEFAULT_OVERLAY };
let viewer = null;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch { prompt(`Copy the ${what.toLowerCase()}:`, text); }
}

// ---------- overlay scene ----------
const overlayCanvas = $('overlay');
const renderer = new THREE.WebGLRenderer({ canvas: overlayCanvas, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
const group = new THREE.Group();
scene.add(group);
const outlineGroup = new THREE.Group();
const panelGroup = new THREE.Group();
group.add(outlineGroup, panelGroup);

function buildOverlay(s) {
  outlineGroup.clear();
  panelGroup.clear();
  if (!s?.footprint?.length) return;
  const ring = s.footprint; // metres from the centroid; x east, y north
  const yellow = new THREE.LineBasicMaterial({ color: 0xffc94a, transparent: true, depthTest: false });
  const faint = new THREE.LineBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.45, depthTest: false });
  const at = (h) => ring.map(([x, y]) => new THREE.Vector3(x, h, -y)); // three.js: y up, z south
  outlineGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(at(s.height)), yellow));
  outlineGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(at(0)), faint));
  const posts = [];
  for (const [x, y] of ring.slice(0, -1)) posts.push(new THREE.Vector3(x, 0, -y), new THREE.Vector3(x, s.height, -y));
  outlineGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(posts), faint));

  // Usable panel area: the footprint shrunk about its centroid to the usable share.
  const k = Math.sqrt(Math.max(0.01, Math.min(1, s.usable / s.area)));
  const shape = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x * k, y * k)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // lay flat: shape (x, y) -> world (x, 0, -y)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2b9fdc, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false }));
  mesh.position.y = s.height + 0.05;
  panelGroup.add(mesh);
  const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring.map(([x, y]) => new THREE.Vector3(x * k, s.height + 0.06, -y * k))),
    new THREE.LineBasicMaterial({ color: 0x7fd0ff, transparent: true, depthTest: false }));
  panelGroup.add(edge);
}

function applyOverlay() {
  const [px, py, pz] = overlay.position, [rx, ry, rz] = overlay.rotation;
  group.position.set(px, py, pz);
  group.rotation.set(rx * DEG, ry * DEG, rz * DEG, 'XYZ');
  group.scale.setScalar(overlay.scale);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  overlayCanvas.style.width = '100%';
  overlayCanvas.style.height = '100%';
}
window.addEventListener('resize', resize);
resize();

function renderLoop() {
  if (viewer?.camera) {
    viewer.camera.updateMatrixWorld();
    renderer.render(scene, viewer.camera);
  }
  requestAnimationFrame(renderLoop);
}

// ---------- side panel ----------
function renderSide() {
  const s = site;
  $('title').textContent = scan ? (s?.name || scan.title || 'Drone scan') : s?.name || 'Drone scan';
  $('subtitle').textContent = [s?.category, scan?.captured, scan?.source].filter(Boolean).join(' · ');
  const badge = $('badge');
  if (isSample) { badge.textContent = 'Sample scene: not an SDP roof'; badge.className = 'badge none'; }
  else if (scan) { badge.textContent = 'Drone-verified'; badge.className = 'badge'; }
  else { badge.textContent = 'No scan registered yet'; badge.className = 'badge none'; }
  const rows = s ? [
    ['Roof footprint', `${fmt(s.area)} m²`],
    ['Usable for panels', `${fmt(s.usable)} m² (${fmt((100 * s.usable) / s.area)}%)`],
    ['Height', `${fmt(s.height, 1)} m${s.heightSource ? ` (${s.heightSource.toLowerCase()})` : ''}`],
    ['System size', `${fmt(s.kwp, 0)} kWp · ${fmt(s.panels)} panels`],
    ['Flags', s.flags?.length ? s.flags.join(', ') : 'none']
  ] : [];
  $('predictions').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  if (scan?.findings) for (const [k, v] of Object.entries(scan.findings)) { const el = $(`f-${k}`); if (el) el.value = v; }
  if (scan?.captured || scan?.source) $('f-captured').value = [scan.captured, scan.source].filter(Boolean).join(' · ');
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (!tab) return;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
});
$('showOutline').onchange = (e) => (outlineGroup.visible = e.target.checked);
$('showPanels').onchange = (e) => (panelGroup.visible = e.target.checked);

// Align tool: position (m), rotation (deg), scale (log slider).
const SLIDERS = [
  ['East / west', 'position', 0, -60, 60, 0.1, 'm'], ['Up / down', 'position', 1, -60, 60, 0.1, 'm'], ['North / south', 'position', 2, -60, 60, 0.1, 'm'],
  ['Tilt X', 'rotation', 0, -180, 180, 0.5, '°'], ['Turn', 'rotation', 1, -180, 180, 0.5, '°'], ['Tilt Z', 'rotation', 2, -180, 180, 0.5, '°'],
  ['Scale', 'scale', null, -2, 1, 0.01, '×']
];
function renderSliders() {
  $('sliders').innerHTML = SLIDERS.map(([name, key, i, min, max, step], n) => {
    const v = key === 'scale' ? Math.log10(overlay.scale) : overlay[key][i];
    return `<label class="row">${name}<input type="range" data-n="${n}" min="${min}" max="${max}" step="${step}" value="${v}"><output id="o${n}"></output></label>`;
  }).join('');
  SLIDERS.forEach((_, n) => showValue(n));
}
function showValue(n) {
  const [, key, i, , , , unit] = SLIDERS[n];
  $(`o${n}`).textContent = key === 'scale' ? `${fmt(overlay.scale, 3)}${unit}` : `${fmt(overlay[key][i], 1)}${unit}`;
}
$('sliders').addEventListener('input', (e) => {
  const n = +e.target.dataset.n;
  if (!Number.isInteger(n)) return;
  const [, key, i] = SLIDERS[n];
  const v = +e.target.value;
  if (key === 'scale') overlay.scale = +(10 ** v).toFixed(4);
  else overlay[key] = overlay[key].map((x, j) => (j === i ? v : x));
  applyOverlay();
  showValue(n);
});
const overlayJSON = () => ({ position: overlay.position.map((v) => +v.toFixed(2)), rotation: overlay.rotation.map((v) => +v.toFixed(1)), scale: overlay.scale });
$('copyAlign').onclick = () => copy(JSON.stringify({ overlay: overlayJSON() }), 'Alignment');
$('resetAlign').onclick = () => { overlay = structuredClone(scan?.overlay || DEFAULT_OVERLAY); applyOverlay(); renderSliders(); };

$('copyEntry').onclick = () => {
  const findings = {};
  for (const k of ['roofType', 'obstructions', 'existingPanels', 'condition', 'heightCheck', 'areaCheck', 'notes']) {
    const v = $(`f-${k}`).value.trim();
    if (v) findings[k] = v;
  }
  const [captured, ...source] = $('f-captured').value.split('·').map((x) => x.trim());
  const entry = {
    url: scan?.url || `/splats/${(site?.id || 'site').replace('/', '-')}.ksplat`,
    title: site?.name || scan?.title || '',
    captured: captured || undefined,
    source: source.join(' · ') || scan?.source,
    cameraUp: scan?.cameraUp,
    camera: scan?.camera,
    overlay: overlayJSON(),
    findings
  };
  copy(JSON.stringify({ [site?.id || 'way/<osm id>']: entry }, null, 2), 'Scan entry');
};

// ---------- splat ----------
async function loadSplat() {
  const reg = await fetch('/splats/scans.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  scan = isSample ? reg.sample : reg.scans?.[siteId] || site?.scan || null;
  if (isSample && !site) site = DEMO_SITE;
  overlay = structuredClone(scan?.overlay || DEFAULT_OVERLAY);
  buildOverlay(site);
  applyOverlay();
  renderSliders();
  renderSide();

  if (!scan?.url) {
    const e = $('empty');
    e.hidden = false;
    e.innerHTML = `<div><b>No drone scan for this roof yet</b>Fly the roof, process it into a splat and add it to <code>public/splats/scans.json</code> (see docs/drone-scans.md).</div>`;
    return;
  }
  viewer = new GaussianSplats3D.Viewer({
    rootElement: $('viewer'),
    cameraUp: scan.cameraUp || [0, 1, 0],
    initialCameraPosition: scan.camera?.position || [0, 40, 60],
    initialCameraLookAt: scan.camera?.lookAt || [0, 0, 0],
    sharedMemoryForWorkers: false // no COOP/COEP headers needed
  });
  const progress = $('progress');
  progress.hidden = false;
  try {
    await viewer.addSplatScene(scan.url, {
      showLoadingUI: false,
      progressiveLoad: true,
      onProgress: (pct) => (progress.textContent = `Loading scan… ${Math.round(pct)}%`)
    });
    viewer.start();
    progress.hidden = true;
    requestAnimationFrame(renderLoop);
  } catch (err) {
    progress.textContent = `Could not load the scan: ${err.message}`;
  }
}

// The parent app posts the site's footprint and estimates after the frame loads.
let started = false;
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'site' || started) return;
  started = true;
  site = e.data.site;
  loadSplat();
});
// Standalone use (no parent message within a moment): load from the URL alone.
setTimeout(() => { if (!started) { started = true; loadSplat(); } }, 400);
