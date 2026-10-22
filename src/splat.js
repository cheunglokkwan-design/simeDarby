// Drone scan viewer: a site's Gaussian splat with our predictions drawn over it.
//
// Opened from a site card (the parent page posts the site's footprint and
// estimates), or standalone: splat.html?site=<osm id> or splat.html?sample=1.
// The overlay uses its own transparent Three.js canvas that shares the splat
// viewer's camera, so it always draws on top of the splat.
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { getLocalScan, saveLocalScan } from './scans.js';
import { panelLayoutForSite } from './panels.js';

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
let objectUrl = null;
let scanLoaded = false;
let panelLayout = null;

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

  panelLayout = s.layout || scan?.layout || panelLayoutForSite(s);
  const material = new THREE.MeshBasicMaterial({ color: 0x244f80, transparent: true, opacity: .8, side: THREE.DoubleSide, depthTest: false });
  const edges = new THREE.LineBasicMaterial({ color: 0xb0dbff, depthTest: false });
  const faces = [], lines = [];
  for (const panel of panelLayout.panels) {
    for (const i of [0, 1, 2, 0, 2, 3]) faces.push(panel[i][0], s.height + .1, -panel[i][1]);
    for (const i of [0, 1, 1, 2, 2, 3, 3, 0]) lines.push(panel[i][0], s.height + .11, -panel[i][1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  panelGroup.add(new THREE.Mesh(geometry, material), new THREE.LineSegments(edgeGeometry, edges));
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
  else if (scan) { badge.textContent = scan.reviewed ? 'Scan reviewed' : 'Scan available · awaiting review'; badge.className = 'badge'; }
  else { badge.textContent = 'No scan registered yet'; badge.className = 'badge none'; }
  const rows = s ? [
    ['Draft panel layout', `${fmt(panelLayout?.count || 0)} panels · ${fmt(panelLayout?.kwp || 0, 1)} kWp`],
    ['Roof footprint', `${fmt(s.area)} m²`],
    ['Usable for panels', `${fmt(s.usable)} m² (${fmt((100 * s.usable) / s.area)}%)`],
    ['Height', `${fmt(s.height, 1)} m${s.heightSource ? ` (${s.heightSource.toLowerCase()})` : ''}`],
    ['System size', `${fmt(s.kwp, 0)} kWp · ${fmt(s.panels)} panels`],
    ['Flags', s.flags?.length ? s.flags.join(', ') : 'none']
  ] : [];
  $('predictions').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  if (scan?.findings) for (const [k, v] of Object.entries(scan.findings)) { const el = $(`f-${k}`); if (el) el.value = v; }
  $('f-captured').value = scan?.captured || '';
  $('f-source').value = scan?.source || '';
  $('reviewed').checked = !!scan?.reviewed;
  $('saveAlign').hidden = $('saveReview').hidden = isSample || !siteId;
  $('saveAlign').disabled = $('saveReview').disabled = !scanLoaded;
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

function scanEntry() {
  const findings = {};
  for (const k of ['roofType', 'obstructions', 'existingPanels', 'condition', 'heightCheck', 'areaCheck', 'notes']) {
    const v = $(`f-${k}`).value.trim();
    if (v) findings[k] = v;
  }
  const captured = $('f-captured').value;
  const source = $('f-source').value.trim();
  const entry = {
    url: scan?.url || `/splats/${(site?.id || siteId || 'site').replace('/', '-')}.${scan?.format || 'ksplat'}`,
    title: site?.name || scan?.title || '',
    captured: captured || undefined,
    source: source || undefined,
    cameraUp: scan?.cameraUp,
    camera: viewer?.camera ? { position: viewer.camera.position.toArray(), lookAt: viewer.controls.target.toArray() } : scan?.camera,
    overlay: overlayJSON(),
    findings,
    layout: panelLayout
  };
  return entry;
}
$('copyEntry').onclick = () => {
  copy(JSON.stringify({ [site?.id || siteId || 'way/<osm id>']: { ...scanEntry(), reviewed: $('reviewed').checked } }, null, 2), 'Scan entry');
};

async function saveReview(alignmentOnly = false) {
  if (!scanLoaded || !scan || !siteId || isSample) return;
  const status = $('saveStatus');
  const buttons = [$('saveAlign'), $('saveReview')];
  buttons.forEach((button) => (button.disabled = true));
  status.textContent = 'Saving…';
  status.classList.remove('error');
  try {
    const entry = scanEntry();
    if (!alignmentOnly && $('reviewed').checked && !Object.keys(entry.findings).length) {
      throw new Error('Record at least one finding before marking this scan reviewed.');
    }
    const existing = await getLocalScan(siteId);
    const record = { ...(existing || scan), ...entry, id: siteId,
      findings: alignmentOnly ? scan.findings || {} : entry.findings,
      reviewed: alignmentOnly ? false : $('reviewed').checked };
    // An imported file is resolved through IndexedDB, not through a synthetic published URL.
    if (record.file) delete record.url;
    await saveLocalScan(record);
    scan = record;
    renderSide();
    status.textContent = alignmentOnly ? 'Alignment saved on this device. Review the roof under Findings.' : 'Findings saved on this device.';
    window.parent.postMessage({ type: 'scan-saved', id: siteId }, location.origin);
    toast(alignmentOnly ? 'Alignment saved' : 'Findings saved');
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
  } finally { buttons.forEach((button) => (button.disabled = false)); }
}
$('saveAlign').onclick = () => saveReview(true);
$('saveReview').onclick = () => saveReview();

function fitScan() {
  const mesh = viewer.splatMesh;
  const count = mesh.getSplatCount();
  const center = new THREE.Vector3();
  const bounds = new THREE.Box3();
  for (let i = 0; i < count; i += Math.max(1, Math.ceil(count / 2000))) {
    mesh.getSplatCenter(i, center, true);
    if (center.toArray().every(Number.isFinite)) bounds.expandByPoint(center);
  }
  if (bounds.isEmpty()) return;
  bounds.getCenter(center);
  const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2);
  viewer.controls.target.copy(center);
  viewer.camera.position.copy(center).add(new THREE.Vector3(0, radius, radius * 1.6));
  viewer.camera.lookAt(center);
  viewer.controls.update();
}
$('fitScan').onclick = () => { if (scanLoaded) fitScan(); };

// ---------- splat ----------
async function loadSplat() {
  const reg = await fetch('/splats/scans.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  let local = null;
  if (!isSample && siteId) {
    try { local = await getLocalScan(siteId); }
    catch (err) { $('saveStatus').textContent = err.message; }
  }
  scan = isSample ? reg.sample : local || site?.scan || reg.scans?.[siteId] || null;
  if (!site && scan?.siteMetrics) site = scan.siteMetrics;
  if (isSample && !site) site = DEMO_SITE;
  overlay = structuredClone(scan?.overlay || DEFAULT_OVERLAY);
  buildOverlay(site);
  applyOverlay();
  renderSliders();
  renderSide();

  if (!scan?.url && !scan?.file) {
    const e = $('empty');
    e.hidden = false;
    e.innerHTML = `<div><b>No drone scan for this roof yet</b>Close this viewer and choose Add drone scan on the building's card to import a finished Gaussian splat.</div>`;
    return;
  }
  const progress = $('progress');
  progress.hidden = false;
  progress.textContent = 'Opening 3D scan…';
  try {
    viewer = new GaussianSplats3D.Viewer({
    rootElement: $('viewer'),
    cameraUp: scan.cameraUp || [0, 1, 0],
    initialCameraPosition: scan.camera?.position || [0, 40, 60],
    initialCameraLookAt: scan.camera?.lookAt || [0, 0, 0],
    sharedMemoryForWorkers: false // no COOP/COEP headers needed
    });
    const path = scan.file ? (objectUrl = URL.createObjectURL(scan.file)) : scan.url;
    const formats = { ply: GaussianSplats3D.SceneFormat.Ply, splat: GaussianSplats3D.SceneFormat.Splat, ksplat: GaussianSplats3D.SceneFormat.KSplat };
    await viewer.addSplatScene(path, {
      ...(scan.format ? { format: formats[scan.format] } : {}),
      showLoadingUI: false,
      progressiveLoad: true,
      onProgress: (pct) => (progress.textContent = `Loading scan… ${Math.round(pct)}%`)
    });
    viewer.start();
    scanLoaded = true;
    if (scan.file && !scan.camera) fitScan();
    $('fitScan').disabled = false;
    renderSide();
    progress.hidden = true;
    requestAnimationFrame(renderLoop);
  } catch (err) {
    progress.textContent = 'Could not open this scan. Close the viewer and import a valid Gaussian splat export, or try a smaller file.';
    console.error('Scan load failed:', err);
  }
}

// The parent app posts the site's footprint and estimates after the frame loads.
let started = false;
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== 'site' || started) return;
  started = true;
  site = e.data.site;
  loadSplat().catch(showLoadError);
});
function showLoadError(err) {
  $('progress').hidden = false;
  $('progress').textContent = `The scan could not be opened. ${err.message}`;
}
if (window.parent === window || isSample) { started = true; loadSplat().catch(showLoadError); }
else window.parent.postMessage({ type: 'scan-ready' }, location.origin);
window.addEventListener('pagehide', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  viewer?.dispose();
  renderer.dispose();
});
