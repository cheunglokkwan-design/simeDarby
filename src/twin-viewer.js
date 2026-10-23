// Digital twin viewer: a drone-scanned house as a point cloud, with a
// simulated rooftop solar array, a sun / time-of-day simulation, CAD-style
// dimensions and per-panel "why here" explanations.
//
// Data and algorithms follow docs/twin-contract.md. The real modules in
// src/twin/*.js and the prepared scan in public/twins/<id>/ are optional at
// build time: import.meta.glob only picks up files that exist, and anything
// missing (or failing) falls back to src/twin-mock.js so the page always works.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import * as mock from './twin-mock.js';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);
const TWIN_ID = (params.get('twin') || 'friend-house').replace(/[^\w-]/g, '');
const FORCE_MOCK = params.has('mock');
const DEG = Math.PI / 180;
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const compass = mock.compassName;
const primaryRoofs = () => mock.primaryRoofs(state.twin);
const wrap360 = (a) => ((a % 360) + 360) % 360;
// Let the browser paint (e.g. the re-planning pill) before heavy work; the timeout keeps going in background tabs.
const nextFrame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(go); setTimeout(go, 60); });
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ modules
const realModules = import.meta.glob('./twin/*.js');
const warned = new Set();
function warnOnce(key, ...msg) { if (!warned.has(key)) { warned.add(key); console.warn(...msg); } }

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const num = (...v) => v.find((x) => typeof x === 'number' && Number.isFinite(x));
function normalizePanel(p) {
  const m = (x) => (typeof x === 'number' && x > 0 && x < 10 ? x * 1000 : x); // metres → mm
  const lengthMm = num(p.lengthMm, p.length_mm, m(p.lengthM), m(p.length), p.dims?.lengthMm, m(p.dimensions?.length));
  const widthMm = num(p.widthMm, p.width_mm, m(p.widthM), m(p.width), p.dims?.widthMm, m(p.dimensions?.width));
  const wattPeak = num(p.wattPeak, p.wp, p.watt, p.watts, p.pmaxW, p.pmax, p.powerW, p.stcW, p.ratedW, p.kwp && p.kwp * 1000);
  const thicknessMm = num(p.thicknessMm, p.depthMm, p.thickness_mm, m(p.thicknessM), m(p.depthM), 30);
  const weightKg = num(p.weightKg, p.weight_kg, p.massKg, p.weight, 21);
  const maker = p.maker ?? p.manufacturer ?? p.brand ?? '';
  const model = p.model ?? p.name ?? p.id;
  const label = p.name ? String(p.name) : maker && maker !== 'generic' ? `${maker} ${model}` : String(model);
  return { ...p, id: p.id ?? model, label, wattPeak, lengthMm, widthMm, thicknessMm, weightKg, efficiency: num(p.efficiency, p.eff, wattPeak && lengthMm && widthMm ? wattPeak / (lengthMm * widthMm / 1e6) / 1000 : undefined) };
}

async function loadApi() {
  const load = async (name) => {
    const f = realModules[`./twin/${name}.js`];
    if (!f || FORCE_MOCK) return null;
    try { return await f(); } catch (e) { warnOnce(name, `twin: src/twin/${name}.js failed to load; using the built-in fallback.`, e); return null; }
  };
  const [placement, sun, shade, catalogue] = await Promise.all(['placement', 'sun', 'shade', 'catalogue'].map(load));
  const api = { placement, sun, shade, catalogue, real: {} };
  api.real.placement = typeof placement?.planArray === 'function';
  api.real.sun = typeof sun?.sunPosition === 'function';
  const cataloguePanels = Array.isArray(catalogue?.PANELS) ? catalogue.PANELS : catalogue?.PANELS && typeof catalogue.PANELS === 'object' ? Object.values(catalogue.PANELS) : null;
  api.real.catalogue = !!cataloguePanels?.length;
  api.panels = (api.real.catalogue ? cataloguePanels : mock.MOCK_PANELS).map(normalizePanel).filter((p) => p.wattPeak && p.lengthMm && p.widthMm);
  if (!api.panels.length) { api.real.catalogue = false; api.panels = mock.MOCK_PANELS.map(normalizePanel); }

  api.sunPosition = (date, lat, lon) => {
    if (api.real.sun) {
      try { const r = sun.sunPosition(date, lat, lon); if (Number.isFinite(r?.azimuth) && Number.isFinite(r?.elevation)) return r; } catch (e) { warnOnce('sunpos', 'twin: sunPosition failed; using fallback', e); }
    }
    return mock.mockSunPosition(date, lat, lon);
  };
  const heatFn = placement?.roofHeatmap || placement?.roofFluxHeatmap || placement?.fluxHeatmap || placement?.heatmap || shade?.roofHeatmap;
  api.real.heatmap = typeof heatFn === 'function';
  api.heatmap = async (twin, occ, o) => {
    if (api.real.heatmap) {
      try { const h = normalizeHeat(await heatFn(twin, occ, o), twin); if (h) return h; } catch (e) { warnOnce('heat', 'twin: roof heatmap failed; using fallback', e); }
    }
    return mock.mockRoofHeatmap(twin, occ, o);
  };
  api.planArray = async (twin, occ, o) => {
    if (api.real.placement) {
      try { return await placement.planArray(twin, occ, o); } catch (e) { warnOnce('plan', 'twin: planArray failed; using the fallback planner', e); }
    }
    return mock.mockPlanArray(twin, occ, o);
  };
  const instFn = placement?.instantShading || shade?.instantShading;
  api.real.instant = typeof instFn === 'function';
  api.instantShading = (twin, occ, plan, sunObj, date) => {
    const s = sunObj.s;
    if (api.real.instant) {
      try {
        const r = instFn(plan, occ, sunObj, { twin, date });
        const arr = Array.isArray(r) ? r : r?.panels || r?.sunlit;
        if (arr && arr.length === plan.panels.length) return { lit: arr.map((x) => (typeof x === 'number' ? x : num(x?.sunlit, x?.sunlitFraction, x?.fraction, 0))), totalW: num(r?.totalW), source: 'planner' };
      } catch (e) { warnOnce('inst', 'twin: instantShading failed; using fallback', e); }
    }
    if (typeof shade?.sunlitFraction === 'function' && typeof shade?.makeGrid === 'function') {
      try {
        const grid = shade.makeGrid(occ);
        return { lit: plan.panels.map((p) => (s[1] > 0 && dot3(p.normal || [0, 1, 0], s) > 0 ? shade.sunlitFraction(grid, p.centre, s, { normal: p.normal || [0, 1, 0] }) : 0)), source: 'shade' };
      } catch (e) { warnOnce('sunlit', 'twin: shade.sunlitFraction failed; using fallback', e); }
    }
    return null;
  };
  return api;
}

// Accepts a few plausible heatmap shapes and returns {roofs:[{roofId, cells:[{corners, poa}]}], min, max}.
function normalizeHeat(h, twin) {
  if (!h) return null;
  const roofs = Array.isArray(h) ? h : h.roofs;
  if (!Array.isArray(roofs)) return null;
  let min = Infinity, max = -Infinity;
  const out = roofs.map((r) => {
    const cells = (r.cells || []).map((c) => {
      const poa = num(c.poa, c.flux, c.kwhM2, c.value, 0);
      min = Math.min(min, poa); max = Math.max(max, poa);
      let corners = c.corners;
      if (!corners && c.centre) {
        const roof = twin.roofs.find((x) => x.id === (r.roofId ?? r.id));
        const f = roof && mock.roofFrame(roof), s = (r.cell ?? h.cell ?? 0.5) / 2;
        if (f) { const [a, b] = mock.toPlane(f, c.centre); corners = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([x, y]) => mock.fromPlane(f, a + x, b + y, 0.03)); }
      }
      return { ...c, poa, corners };
    }).filter((c) => c.corners);
    return { roofId: r.roofId ?? r.id, cell: r.cell ?? h.cell, cells };
  });
  return { roofs: out, min: num(h.min, min), max: num(h.max, max) };
}

// ------------------------------------------------------------------ data
async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok || /html/.test(r.headers.get('content-type') || '')) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}
// Full-colour Gaussian splat of the scan (scene.splat, already in the twin
// frame). The point cloud stays as the fallback if it is missing or fails.
let splatViewer = null;
async function loadSplat() {
  if (FORCE_MOCK || params.has('points')) return false;
  const url = `${BASE}twins/${TWIN_ID}/scene.splat`;
  const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  if (!head?.ok || /html/.test(head.headers.get('content-type') || '')) return false;
  splatViewer = new GaussianSplats3D.DropInViewer({ sharedMemoryForWorkers: false });
  await splatViewer.addSplatScene(url, { format: GaussianSplats3D.SceneFormat.Splat, showLoadingUI: false, progressiveLoad: false, splatAlphaRemovalThreshold: 8 });
  groups.scan.add(splatViewer);
  return true;
}
function setScanMode(mode) {
  const photo = mode === 'photo' && splatViewer;
  if (splatViewer) splatViewer.visible = !!photo;
  if (pointsObj) pointsObj.visible = !photo;
  $('scanMode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === (photo ? 'photo' : 'points'))));
  // Over the photo the roof itself shows the context; the planner's outlines and
  // excluded areas would hide it, so they start off there (the layer box brings them back).
  groups.roofs.visible = !photo;
  const rej = $('lyrRejected');
  if (rej.checked === !!photo) { rej.checked = !photo; rej.dispatchEvent(new Event('change')); }
}
async function loadTwin() {
  if (FORCE_MOCK) return { ...mock.makeMockTwin(), real: false, why: 'Mock forced with ?mock' };
  const dir = `${BASE}twins/${TWIN_ID}/`;
  try {
    const r = await fetch(`${dir}twin.json`);
    if (!r.ok || /html/.test(r.headers.get('content-type') || '')) throw new Error('twin.json not found');
    const twin = await r.json();
    if (!Array.isArray(twin.roofs)) throw new Error('twin.json has no roofs');
    const points = new Float32Array(await fetchBin(`${dir}points.bin`));
    let normals = null, occupancy = null;
    try { normals = new Int8Array(await fetchBin(`${dir}normals.bin`)); if (normals.length !== points.length) normals = null; } catch { /* optional */ }
    if (twin.occupancy) {
      try {
        const data = new Uint8Array(await fetchBin(`${dir}${twin.occupancy.file || 'occupancy.bin'}`));
        const [nx, ny, nz] = twin.occupancy.dims;
        if (data.length >= nx * ny * nz) occupancy = mock.makeOccupancy(twin.occupancy, data);
      } catch { /* shading falls back to unshaded */ }
    }
    return { twin, points, normals, occupancy, real: true };
  } catch (e) {
    return { ...mock.makeMockTwin(), real: false, why: e.message };
  }
}

// ------------------------------------------------------------------ state
const state = {
  api: null, data: null, twin: null, occ: null,
  plan: null, heat: null, panelIdx: new Map(),
  selected: null, hover: null, selectedArray: null,
  opts: { panelId: null, mounting: 'flush', tiltDeg: 10, orientation: 'auto', setback: 0.4, sizeMode: 'atap', targetKwp: 6, fluxThreshold: 0 },
  lat: 3.11, lon: 101.58, tz: 8, north: 0,
  date: null, minutes: 600, playing: false,
  sun: { azimuth: 0, elevation: 0, s: [0, 1, 0] },
  sunlit: [], nowKw: 0, sky: 'typical',
  centre: new THREE.Vector3(), radius: 15, groundY: 0
};

// ------------------------------------------------------------------ three
const canvas = $('gl');
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151a22);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 800);
camera.position.set(14, 12, 18);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI * 0.53;
controls.minDistance = 1.5;
controls.maxDistance = 250;
const labelRenderer = new CSS2DRenderer({ element: $('labels') });

const hemi = new THREE.HemisphereLight(0xe6ecf5, 0x4a4540, 0.9);
const sunLight = new THREE.DirectionalLight(0xfff1d6, 2.0);
scene.add(hemi, sunLight, sunLight.target);

const groups = {};
for (const k of ['scan', 'grid', 'roofs', 'heat', 'rejected', 'panels', 'dims', 'sun']) { groups[k] = new THREE.Group(); groups[k].name = k; scene.add(groups[k]); }

function clearGroup(g) {
  const labels = [];
  g.traverse((o) => { if (o.isCSS2DObject) labels.push(o); });
  for (const l of labels) l.parent?.remove(l); // fires 'removed' → element leaves the DOM
  for (const o of [...g.children]) {
    o.traverse((x) => { x.geometry?.dispose?.(); if (x.material && !x.material.userData?.shared) (Array.isArray(x.material) ? x.material : [x.material]).forEach((m) => m.dispose()); });
    g.remove(o);
  }
}
function setVisible(g, v) { g.visible = v; g.traverse((o) => { if (o.isCSS2DObject) o.element.style.visibility = v ? '' : 'hidden'; }); }
function label(text, cls, pos) {
  const el = document.createElement('div');
  el.className = cls; el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  return o;
}

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (pointsMat) pointsMat.uniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * DEG) / 2));
}
new ResizeObserver(resize).observe(viewport);

// ------------------------------------------------------------------ scan points
let pointsMat = null, pointsObj = null, litAttr = null, hideAttr = null;
const scanShadow = { s: null, k: 0, voxels: null, voxOfPoint: null, voxLit: null, stride: 1 };

function voxelIndex(occ, x, y, z) {
  const { origin, voxel, dims } = occ;
  const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((y - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
  if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return -1;
  return i + dims[0] * (j + dims[1] * k);
}
function smallestEigvec(c00, c01, c02, c11, c12, c22) {
  const p1 = c01 * c01 + c02 * c02 + c12 * c12;
  const q = (c00 + c11 + c22) / 3;
  const p = Math.sqrt(((c00 - q) ** 2 + (c11 - q) ** 2 + (c22 - q) ** 2 + 2 * p1) / 6);
  if (p < 1e-12) return [0, 1, 0];
  const b00 = (c00 - q) / p, b11 = (c11 - q) / p, b22 = (c22 - q) / p, b01 = c01 / p, b02 = c02 / p, b12 = c12 / p;
  const det = b00 * (b11 * b22 - b12 * b12) - b01 * (b01 * b22 - b12 * b02) + b02 * (b01 * b12 - b11 * b02);
  const phi = Math.acos(clamp(det / 2, -1, 1)) / 3;
  const l = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const r0 = [c00 - l, c01, c02], r1 = [c01, c11 - l, c12], r2 = [c02, c12, c22 - l];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let best = [0, 1, 0], bn = 0;
  for (const v of [cr(r0, r1), cr(r0, r2), cr(r1, r2)]) { const n = Math.hypot(...v); if (n > bn) { bn = n; best = v; } }
  return bn > 0 ? best.map((x) => x / bn) : [0, 1, 0];
}
// Normals and a cheap ambient-occlusion term from the occupancy grid, for scans without normals.bin.
function analyseScan(points, normals, occ) {
  const n = points.length / 3;
  const outN = normals || new Int8Array(points.length);
  const ao = new Uint8Array(n).fill(255);
  if (!occ) { if (!normals) for (let i = 0; i < n; i++) outN[i * 3 + 1] = 127; return { normals: outN, ao, voxOfPoint: null, voxels: null }; }
  const { dims, data } = occ, [nx, ny] = dims;
  const cx = state.centre.x, cz = state.centre.z;
  const voxMap = new Map(), counts = new Uint8Array(n), voxOfPoint = new Int32Array(n);
  const voxels = []; // {idx, n:[x,y,z], c:[x,y,z]}
  const solid = (i, j, k) => (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < dims[2] ? data[i + nx * (j + ny * k)] : 0);
  for (let p = 0; p < n; p++) {
    const x = points[p * 3], y = points[p * 3 + 1], z = points[p * 3 + 2];
    const vi = voxelIndex(occ, x, y, z);
    if (vi < 0) { voxOfPoint[p] = -1; if (!normals) outN[p * 3 + 1] = 127; continue; }
    let v = voxMap.get(vi);
    if (v === undefined) {
      const i = vi % nx, j = Math.floor(vi / nx) % ny, k = Math.floor(vi / (nx * ny));
      let cnt = 0, sx = 0, sy = 0, sz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0, near = 0;
      const R = normals ? 1 : 2; // with scan normals only the 3×3×3 crease count is needed
      for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (!solid(i + dx, j + dy, k + dz)) continue;
        cnt++; sx += dx; sy += dy; sz += dz; xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1) near++;
      }
      const mx = sx / cnt, my = sy / cnt, mz = sz / cnt;
      let nv;
      if (Math.hypot(mx, my, mz) > 0.6) nv = [-mx, -my, -mz].map((c) => c / Math.hypot(mx, my, mz)); // solid side known: point away from it
      else nv = smallestEigvec(xx / cnt - mx * mx, xy / cnt - mx * my, xz / cnt - mx * mz, yy / cnt - my * my, yz / cnt - my * mz, zz / cnt - mz * mz);
      const c = [occ.origin[0] + (i + 0.5) * occ.voxel, occ.origin[1] + (j + 0.5) * occ.voxel, occ.origin[2] + (k + 0.5) * occ.voxel];
      // orient: up for near-horizontal surfaces, otherwise away from the building centre
      if (Math.abs(nv[1]) > 0.6) { if (nv[1] < 0) nv = nv.map((q) => -q); }
      else if (nv[0] * (c[0] - cx) + nv[2] * (c[2] - cz) < 0) nv = nv.map((q) => -q);
      v = voxels.length;
      voxels.push({ idx: vi, n: nv, c, near: near - 1 });
      voxMap.set(vi, v);
    }
    voxOfPoint[p] = v;
    const vx = voxels[v];
    counts[p] = vx.near;
    if (!normals) { outN[p * 3] = Math.round(vx.n[0] * 127); outN[p * 3 + 1] = Math.round(vx.n[1] * 127); outN[p * 3 + 2] = Math.round(vx.n[2] * 127); }
  }
  // median-relative crease darkening: more solid neighbours than typical = inside corner
  const hist = new Uint32Array(27); for (let p = 0; p < n; p++) hist[counts[p]]++;
  let acc = 0, med = 8; for (let c = 0; c < 27; c++) { acc += hist[c]; if (acc >= n / 2) { med = c; break; } }
  for (let p = 0; p < n; p++) ao[p] = Math.round(255 * clamp(1 - (counts[p] - med) * 0.04, 0.55, 1));
  // voxel normals from the point normals when the scan provides them
  if (normals) {
    const acc3 = new Float32Array(voxels.length * 3);
    for (let p = 0; p < n; p++) { const v = voxOfPoint[p]; if (v < 0) continue; acc3[v * 3] += normals[p * 3]; acc3[v * 3 + 1] += normals[p * 3 + 1]; acc3[v * 3 + 2] += normals[p * 3 + 2]; }
    voxels.forEach((v, i) => { const l = Math.hypot(acc3[i * 3], acc3[i * 3 + 1], acc3[i * 3 + 2]); if (l > 0) v.n = [acc3[i * 3] / l, acc3[i * 3 + 1] / l, acc3[i * 3 + 2] / l]; });
  }
  return { normals: outN, ao, voxOfPoint, voxels };
}

function buildPoints() {
  const { points } = state.data;
  const occ = state.occ;
  const t0 = performance.now();
  const a = analyseScan(points, state.data.normals, occ);
  scanShadow.voxels = a.voxels; scanShadow.voxOfPoint = a.voxOfPoint;
  scanShadow.voxLit = a.voxels ? new Uint8Array(a.voxels.length) : null;
  const n = points.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(points, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3, true));
  g.setAttribute('ao', new THREE.BufferAttribute(a.ao, 1, true));
  hideAttr = new THREE.BufferAttribute(new Uint8Array(n), 1, true);
  hideAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('hide', hideAttr);
  litAttr = new THREE.BufferAttribute(new Uint8Array(n).fill(255), 1, true);
  litAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('lit', litAttr);
  g.computeBoundingSphere();
  // point spacing estimate: surface area ≈ occupied voxels × voxel²
  // point spacing on the main roofs: roof area / points above the roof bounding box
  let spacing = 0.04;
  const roofs = primaryRoofs(), rb = new THREE.Box3();
  for (const r of roofs) for (const q of r.outline) rb.expandByPoint(V3(q));
  const roofArea = roofs.reduce((t, r) => t + (r.area || 0), 0);
  let onRoof = 0;
  if (!rb.isEmpty() && roofArea > 0) for (let i = 0; i < points.length; i += 3) {
    if (points[i] > rb.min.x && points[i] < rb.max.x && points[i + 2] > rb.min.z && points[i + 2] < rb.max.z && points[i + 1] > rb.min.y - 0.3) onRoof++;
  }
  if (onRoof > 200) spacing = clamp(Math.sqrt(roofArea / onRoof), 0.01, 0.2);
  else if (a.voxels) spacing = clamp(Math.sqrt((a.voxels.length * occ.voxel * occ.voxel) / n), 0.015, 0.2);
  const bmin = state.twin.bounds?.min?.[1] ?? 0, bmax = state.twin.bounds?.max?.[1] ?? 8;
  pointsMat = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: spacing * 1.2 }, uBase: { value: spacing }, uScale: { value: 600 },
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunK: { value: 1 }, uDay: { value: 1 },
      uMinY: { value: Math.min(bmin, state.groundY) }, uMaxY: { value: Math.max(bmax, state.groundY + 1) },
      uTwoSided: { value: state.data.normals && state.data.real ? 1 : 0 }
    },
    vertexShader: /* glsl */ `
      attribute float ao; attribute float lit; attribute float hide;
      uniform float uSize, uScale, uSunK, uDay, uMinY, uMaxY, uTwoSided; uniform vec3 uSun;
      varying vec3 vCol;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = hide > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
        gl_PointSize = clamp(uSize * uScale / -mv.z, 1.0, 9.0);
        vec3 n = normalize(normal);
        float key = abs(dot(n, normalize(vec3(0.35, 0.85, 0.40))));
        float sd = dot(n, uSun);
        sd = uTwoSided > 0.5 ? abs(sd) : max(sd, 0.0);
        float h = clamp((position.y - uMinY) / max(uMaxY - uMinY, 0.1), 0.0, 1.0);
        vec3 base = mix(vec3(0.50, 0.475, 0.44), vec3(0.83, 0.80, 0.75), 0.25 + 0.6 * h);
        float light = (0.30 + 0.30 * key) * uDay + 0.18 + 0.62 * sd * lit * uSunK;
        vCol = base * light * (0.35 + 0.65 * ao);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r = dot(c, c);
        if (r > 1.0) discard;
        gl_FragColor = vec4(vCol * (1.0 - 0.22 * r), 1.0);
        #include <colorspace_fragment>
      }`
  });
  pointsObj = new THREE.Points(g, pointsMat);
  pointsObj.frustumCulled = false;
  groups.scan.add(pointsObj);
  resize();
  return performance.now() - t0;
}

// Progressive per-voxel cast shadows on the scan, a few ms per frame.
function requestScanShadow() {
  if (!scanShadow.voxels || !$('lyrScanShadow').checked) { if (litAttr) { litAttr.array.fill(255); litAttr.needsUpdate = true; } return; }
  scanShadow.s = state.sun.s.slice(); scanShadow.k = 0;
  const N = scanShadow.voxels.length;
  scanShadow.stride = [7919, 7907, 7901, 104729].find((p) => N % p !== 0) || 1;
}
function stepScanShadow(budget = 5) {
  const S = scanShadow;
  if (!S.s) return;
  const t0 = performance.now(), N = S.voxels.length, s = S.s, occ = state.occ;
  let k = S.k;
  while (k < N && performance.now() - t0 < budget) {
    for (let m = 0; m < 600 && k < N; m++, k++) {
      const vi = (k * S.stride) % N, v = S.voxels[vi];
      let lit = 0;
      if (s[1] > 0) {
        const d = v.n[0] * s[0] + v.n[1] * s[1] + v.n[2] * s[2];
        if (d > 0.02) {
          const lift = occ.voxel * 1.3, off = occ.voxel * 1.5;
          lit = mock.raycastOcc(occ, v.c[0] + v.n[0] * lift + s[0] * off, v.c[1] + v.n[1] * lift + s[1] * off, v.c[2] + v.n[2] * lift + s[2] * off, s[0], s[1], s[2]) < 0 ? 255 : 0;
        }
      }
      S.voxLit[vi] = lit;
    }
  }
  S.k = k;
  const arr = litAttr.array, vop = S.voxOfPoint, vl = S.voxLit;
  for (let p = 0; p < arr.length; p++) { const v = vop[p]; arr[p] = v < 0 ? 255 : vl[v]; }
  litAttr.needsUpdate = true;
  if (k >= N) S.s = null;
}

// ------------------------------------------------------------------ grid + compass
let northArrow = null;
function buildGrid() {
  clearGroup(groups.grid);
  const c = state.centre, gy = state.groundY + 0.015;
  const E = Math.ceil((state.radius + 6) / 5) * 5;
  const minor = [], major = [];
  for (let i = -E; i <= E; i++) {
    const arr = i % 5 === 0 ? major : minor;
    const x = Math.round(c.x) + i, z = Math.round(c.z) + i;
    arr.push(x, gy, Math.round(c.z) - E, x, gy, Math.round(c.z) + E);
    arr.push(Math.round(c.x) - E, gy, z, Math.round(c.x) + E, gy, z);
  }
  const mk = (arr, color, opacity) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    l.renderOrder = 1; return l;
  };
  groups.grid.add(mk(minor, 0x8a93a6, 0.18), mk(major, 0xb6bfd0, 0.42));
  // north arrow on the ground at the grid edge
  northArrow = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.4); shape.lineTo(0.55, -0.4); shape.lineTo(0, -0.05); shape.lineTo(-0.55, -0.4); shape.closePath();
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2); // +y of the shape → -z (north)
  const arrow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xe0483c, side: THREE.DoubleSide }));
  arrow.position.set(0, 0.03, -(E - 2.2));
  northArrow.add(arrow);
  northArrow.add(label('N', 'north-label', new THREE.Vector3(0, 0.1, -(E - 0.2))));
  northArrow.position.set(Math.round(c.x), gy, Math.round(c.z));
  groups.grid.add(northArrow);
  updateNorth();
}
// True north in the twin frame is (sin θ, 0, -cos θ), θ = twin.northBearing + the viewer's correction (src/twin/sun.js convention).
function bearing() { return (state.twin?.northBearing || 0) + state.north; }
function northVec() { const d = bearing() * DEG; return new THREE.Vector3(Math.sin(d), 0, -Math.cos(d)); }
function eastVec() { const d = bearing() * DEG; return new THREE.Vector3(Math.cos(d), 0, Math.sin(d)); }
function updateNorth() { if (northArrow) northArrow.rotation.y = -bearing() * DEG; }
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function updateCompassWidget() {
  _a.copy(controls.target).project(camera);
  _b.copy(controls.target).add(northVec()).project(camera);
  const dx = (_b.x - _a.x) * camera.aspect, dy = _b.y - _a.y;
  if (Math.hypot(dx, dy) < 1e-6) return;
  $('compass').querySelector('i').style.transform = `rotate(${Math.atan2(dx, dy)}rad)`;
}

// ------------------------------------------------------------------ roofs (outline context)
function buildRoofOutlines() {
  clearGroup(groups.roofs);
  const mat = new THREE.LineDashedMaterial({ color: 0xffe2a0, dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.55 });
  for (const r of primaryRoofs()) {
    const pts = r.outline.map((p) => V3(p));
    const n = V3(r.normal).normalize().multiplyScalar(0.03);
    pts.forEach((p) => p.add(n));
    const g = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
    const l = new THREE.Line(g, mat); l.computeLineDistances();
    groups.roofs.add(l);
    for (const o of r.obstacles || []) {
      const op = o.outline.map((p) => V3(p).add(n));
      const og = new THREE.BufferGeometry().setFromPoints([...op, op[0]]);
      groups.roofs.add(new THREE.Line(og, new THREE.LineBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.8 })));
    }
  }
}

// ------------------------------------------------------------------ textures
function canvasTex(w, h, draw, { repeat = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
// 6 × 18 half-cut cells (108), deep blue with fine busbars, split across the middle.
const cellTex = canvasTex(384, 640, (g, w, h) => {
  g.fillStyle = '#c9d2e0'; g.fillRect(0, 0, w, h); // backsheet gaps
  const cols = 6, rows = 18, gap = 3, mid = 8;
  const cw = (w - gap * (cols + 1)) / cols, ch = (h - gap * (rows + 1) - mid) / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = gap + c * (cw + gap), y = gap + r * (ch + gap) + (r >= rows / 2 ? mid : 0);
    const gr = g.createLinearGradient(x, y, x + cw, y + ch);
    gr.addColorStop(0, '#173f9a'); gr.addColorStop(0.55, '#0f2f7c'); gr.addColorStop(1, '#0b2565');
    g.fillStyle = gr; g.fillRect(x, y, cw, ch);
    g.strokeStyle = 'rgba(190,205,235,0.35)'; g.lineWidth = 1;
    for (let b = 1; b <= 9; b++) { const bx = x + (cw * b) / 10; g.beginPath(); g.moveTo(bx, y); g.lineTo(bx, y + ch); g.stroke(); }
    g.strokeStyle = 'rgba(120,150,210,0.18)'; g.beginPath(); g.moveTo(x, y + ch / 2); g.lineTo(x + cw, y + ch / 2); g.stroke();
  }
});
const hatchTex = canvasTex(64, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(214,48,39,0.22)'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(235,60,45,0.85)'; g.lineWidth = 7;
  for (let i = -w; i < w * 2; i += 21) { g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
}, { repeat: true });
const softShadowTex = canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w * 0.5);
  gr.addColorStop(0, 'rgba(0,0,0,0.95)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const sunTex = canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,240,1)'); gr.addColorStop(0.22, 'rgba(255,226,120,1)'); gr.addColorStop(0.5, 'rgba(255,190,60,0.35)'); gr.addColorStop(1, 'rgba(255,170,40,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});

// ------------------------------------------------------------------ panels
const unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitLoop = new THREE.BufferGeometry().setFromPoints([[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 0, -0.5]].map((p) => new THREE.Vector3(...p)));
const shared = (m) => { m.userData.shared = true; return m; };
const frameMat = shared(new THREE.MeshStandardMaterial({ color: 0xd3d8df, metalness: 0.75, roughness: 0.32 }));
const footMat = shared(new THREE.MeshBasicMaterial({ map: softShadowTex, transparent: true, opacity: 0.6, depthWrite: false, color: 0x000000 }));
const COL = { cyan: new THREE.Color(0x22e3ff), hover: new THREE.Color(0xffffff), sel: new THREE.Color(0xffb020) };
const MASK_U = 4, MASK_V = 6;
let panelMeshes = [];

function panelFrame(p) {
  const c = p.corners.map(V3);
  const n = V3(p.normal || [0, 1, 0]).normalize();
  if (n.y < 0) n.negate();
  let e1 = c[1].clone().sub(c[0]), e3 = c[3].clone().sub(c[0]);
  let w = e1.length(), l = e3.length();
  if (w > l) { [e1, e3] = [e3, e1]; [w, l] = [l, w]; }
  const X = e1.clone().sub(n.clone().multiplyScalar(e1.dot(n))).normalize();
  const Z = new THREE.Vector3().crossVectors(X, n).normalize();
  const centre = p.centre ? V3(p.centre) : c.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(0.25);
  return { X, Y: n, Z, w, l, centre };
}

function buildPanels() {
  clearGroup(groups.panels);
  panelMeshes = [];
  state.panelIdx.clear();
  const plan = state.plan;
  if (!plan) return;
  const panelSpec = currentPanel();
  const thick = (panelSpec.thicknessMm || 30) / 1000;
  const standoff = mountStandoff();
  plan.panels.forEach((p, i) => {
    state.panelIdx.set(p.id, i);
    const f = panelFrame(p);
    const grp = new THREE.Group();
    grp.position.copy(f.centre);
    grp.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.X, f.Y, f.Z));
    // standoff shadow on the roof
    const foot = new THREE.Mesh(unitPlane, footMat);
    foot.scale.set(f.w + 0.16, 1, f.l + 0.16); foot.position.y = -Math.max(standoff, thick + 0.02) + 0.015; foot.renderOrder = 2;
    // glow halo
    const glowMat = new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const glow = new THREE.Mesh(unitPlane, glowMat);
    glow.scale.set(f.w + 0.12, 1, f.l + 0.12); glow.position.y = -thick * 0.6; glow.renderOrder = 3;
    // frame
    const frame = new THREE.Mesh(unitBox, frameMat);
    frame.scale.set(f.w, thick, f.l); frame.position.y = -thick / 2 - 0.001;
    // cell surface
    const cellMat = new THREE.MeshStandardMaterial({ map: cellTex, roughness: 0.28, metalness: 0.25, emissive: 0x000000 });
    const cell = new THREE.Mesh(unitPlane, cellMat);
    cell.scale.set(f.w - 0.03, 1, f.l - 0.03); cell.position.y = 0.002;
    cell.userData.panel = i;
    // shade mask overlay
    const maskData = new Uint8Array(MASK_U * MASK_V * 4).fill(0);
    const maskTex = new THREE.DataTexture(maskData, MASK_U, MASK_V, THREE.RGBAFormat);
    maskTex.magFilter = THREE.LinearFilter; maskTex.minFilter = THREE.LinearFilter; maskTex.needsUpdate = true;
    const maskMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.72, alphaMap: maskTex, depthWrite: false });
    const mask = new THREE.Mesh(unitPlane, maskMat);
    mask.scale.copy(cell.scale); mask.position.y = 0.004; mask.renderOrder = 4;
    // outline
    const lineMat = new THREE.LineBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.95 });
    const outline = new THREE.Line(unitLoop, lineMat);
    outline.scale.set(f.w, 1, f.l); outline.position.y = 0.006; outline.renderOrder = 5;
    grp.add(foot, glow, frame, cell, mask, outline);
    grp.userData = { i, f, cellMat, glowMat, lineMat, maskTex, maskData };
    groups.panels.add(grp);
    panelMeshes.push(cell);
  });
  refreshPanelStyles();
  hidePointsUnderPanels();
}
// Roof points within a module's footprint (from the roof surface up to just above the glass) are hidden,
// so the simulated modules read cleanly instead of being speckled by the scan.
function hidePointsUnderPanels() {
  if (!hideAttr) return;
  const arr = hideAttr.array; arr.fill(0);
  const P = state.data.points;
  const boxes = groups.panels.children.map((grp) => {
    const { f } = grp.userData;
    const bb = new THREE.Box3();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [-0.45, 0.25]) bb.expandByPoint(f.centre.clone().addScaledVector(f.X, sx * f.w / 2).addScaledVector(f.Z, sz * f.l / 2).addScaledVector(f.Y, sy));
    return { f, bb };
  });
  if (!boxes.length) { hideAttr.needsUpdate = true; return; }
  const all = new THREE.Box3(); for (const b of boxes) all.union(b.bb);
  const q = new THREE.Vector3();
  for (let i = 0, k = 0; i < P.length; i += 3, k++) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < all.min.x || x > all.max.x || y < all.min.y || y > all.max.y || z < all.min.z || z > all.max.z) continue;
    for (const { f, bb } of boxes) {
      if (x < bb.min.x || x > bb.max.x || y < bb.min.y || y > bb.max.y || z < bb.min.z || z > bb.max.z) continue;
      q.set(x - f.centre.x, y - f.centre.y, z - f.centre.z);
      if (Math.abs(q.dot(f.X)) < f.w / 2 + 0.02 && Math.abs(q.dot(f.Z)) < f.l / 2 + 0.02) { const h = q.dot(f.Y); if (h > -0.45 && h < 0.25) { arr[k] = 255; break; } }
    }
  }
  hideAttr.needsUpdate = true;
}
function refreshPanelStyles() {
  groups.panels.children.forEach((grp) => {
    const { i, cellMat, glowMat, lineMat } = grp.userData;
    const p = state.plan.panels[i];
    const sel = state.selected === p.id, hov = state.hover === p.id;
    const col = sel ? COL.sel : hov ? COL.hover : COL.cyan;
    lineMat.color.copy(col); glowMat.color.copy(sel ? COL.sel : COL.cyan);
    glowMat.opacity = sel ? 0.55 : hov ? 0.5 : 0.28;
    const lit = state.sunlit[i] ?? 1;
    const day = clamp(state.sun.elevation / 12, 0, 1);
    const k = 0.42 + 0.58 * (0.25 + 0.75 * lit * day);
    cellMat.color.setScalar(k);
    cellMat.emissive.set(sel ? 0x5a3a00 : hov ? 0x0d3640 : 0x000000);
  });
}

// ------------------------------------------------------------------ rejected regions + heatmap
let rejectedMeshes = [];
function polyMesh(pts3, material, lift = 0.03) {
  const pts = pts3.map(V3);
  // plane basis from Newell normal
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y); }
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize(); if (n.y < 0) n.negate();
  const u = new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x));
  if (u.lengthSq() < 1e-6) u.set(0, 0, 1).sub(n.clone().multiplyScalar(n.z));
  u.normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const o = pts[0];
  const p2 = pts.map((p) => new THREE.Vector2(p.clone().sub(o).dot(u), p.clone().sub(o).dot(v)));
  const tris = THREE.ShapeUtils.triangulateShape(p2, []);
  const pos = [], uv = [];
  for (const p of pts) { const q = p.clone().addScaledVector(n, lift); pos.push(q.x, q.y, q.z); }
  for (const q of p2) uv.push(q.x / 0.6, q.y / 0.6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(tris.flat());
  const mesh = new THREE.Mesh(g, material);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...pts, pts[0]].map((p) => p.clone().addScaledVector(n, lift + 0.003))), null);
  return { mesh, line };
}
// Exclusion classes: red hatch only for real constraints; "not needed" spots are usable roof.
const NOT_NEEDED = new Set(['not-needed', 'size-cap', 'target', 'unneeded']);
const STRONG = new Set(['shade', 'obstacle', 'clutter', 'flux']);
function rejCause(r) {
  const sub = [r.cause, r.constraint, r.subKind, r.reasonKind, r.type].find((x) => typeof x === 'string');
  if (r.kind === 'constraint') return sub || 'constraint';
  if (r.kind === 'not-needed') return 'not-needed';
  return r.kind || sub || 'constraint';
}
function rejClass(r) {
  const c = rejCause(r);
  if (NOT_NEEDED.has(c) || NOT_NEEDED.has(r.kind)) return 'unneeded';
  if (c === 'setback') return 'band';
  if (STRONG.has(c)) return 'strong';
  return 'medium'; // no-fit, small, steep, orientation, generic constraint
}
const hatchMat = (opacity) => shared(new THREE.MeshBasicMaterial({ map: hatchTex, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
const rejMats = {
  strong: hatchMat(0.9), medium: hatchMat(0.32), band: hatchMat(0.14),
  unneeded: shared(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }))
};
const KIND_LABEL = { setback: 'edge setback', 'no-fit': 'no room for a block', small: 'roof too small', orientation: 'poor orientation', steep: 'too steep', obstacle: 'obstacle keep-out', clutter: 'unlisted object in scan', flux: 'low sun', shade: 'shaded', constraint: 'constraint' };
const rejLineMats = {
  strong: shared(new THREE.LineBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.9 })),
  medium: shared(new THREE.LineBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.35 })),
  band: shared(new THREE.LineBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.14 })),
  unneeded: shared(new THREE.LineDashedMaterial({ color: 0xf2f4f8, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.8 }))
};
function buildRejected() {
  clearGroup(groups.rejected);
  rejectedMeshes = [];
  for (const [i, r] of (state.plan?.rejected || []).entries()) {
    if (!r.outline || r.outline.length < 3) continue;
    const cls = rejClass(r);
    const { mesh, line } = polyMesh(r.outline, rejMats[cls], cls === 'unneeded' ? 0.035 : 0.02);
    line.material = rejLineMats[cls];
    if (cls === 'unneeded') line.computeLineDistances();
    mesh.userData.rejected = i; mesh.renderOrder = cls === 'strong' ? 3 : 2;
    groups.rejected.add(mesh, line);
    rejectedMeshes.push(mesh);
  }
}

const RAMP = ['#2c0b57', '#7a1e6c', '#c43c4e', '#f0763a', '#fbc33a', '#fcf3a0'].map((c) => new THREE.Color(c));
function rampColor(t, out = new THREE.Color()) {
  t = clamp(t, 0, 1) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t));
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], t - i);
}
let heatMesh = null, heatCells = [];
function buildHeat() {
  clearGroup(groups.heat);
  heatMesh = null; heatCells = [];
  const h = state.heat;
  if (!h) return;
  const pos = [], col = [], c = new THREE.Color();
  const thr = state.opts.fluxThreshold;
  for (const r of h.roofs) for (const cell of r.cells) {
    const k = cell.corners;
    const t = (cell.poa - h.min) / Math.max(1, h.max - h.min);
    rampColor(t, c);
    if (thr > 0 && cell.poa < thr) c.multiplyScalar(0.3);
    for (const idx of [0, 1, 2, 0, 2, 3]) { pos.push(k[idx][0], k[idx][1] + 0.012, k[idx][2]); col.push(c.r, c.g, c.b); }
    heatCells.push(cell);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  heatMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  heatMesh.renderOrder = 1;
  groups.heat.add(heatMesh);
  $('legendMin').textContent = fmt(h.min); $('legendMax').textContent = fmt(h.max);
  const m = $('legendMark');
  m.hidden = !(thr > 0);
  m.style.left = `${clamp((thr - h.min) / Math.max(1, h.max - h.min), 0, 1) * 100}%`;
}

// ------------------------------------------------------------------ dimensions
const dimMat = shared(new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
const dimMatSet = shared(new THREE.LineBasicMaterial({ color: 0xff9f7a, depthTest: false, transparent: true }));
const coneGeo = new THREE.ConeGeometry(0.045, 0.16, 10).translate(0, -0.08, 0); // tip at origin, pointing +y
const coneMat = shared(new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
const coneMatSet = shared(new THREE.MeshBasicMaterial({ color: 0xff9f7a, depthTest: false }));
function dimension(a, b, off, text, setback = false) {
  const g = new THREE.Group();
  const lm = setback ? dimMatSet : dimMat, cm = setback ? coneMatSet : coneMat;
  const a2 = a.clone().add(off), b2 = b.clone().add(off);
  const seg = [];
  if (off.lengthSq() > 1e-6) {
    const ext = off.clone().multiplyScalar(1.15);
    seg.push(a, a.clone().add(ext), b, b.clone().add(ext));
  }
  seg.push(a2, b2);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), lm);
  lines.renderOrder = 20; g.add(lines);
  const dir = b2.clone().sub(a2), len = dir.length();
  if (len > 1e-4) {
    dir.normalize();
    for (const [p, d] of [[a2, dir.clone().negate()], [b2, dir]]) {
      const cone = new THREE.Mesh(coneGeo, cm);
      cone.position.copy(p);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      const s = clamp(len / 0.5, 0.35, 1); cone.scale.setScalar(s);
      cone.renderOrder = 21; g.add(cone);
    }
  }
  addDimLabel(a2.clone().lerp(b2, 0.5), text, setback);
  return g;
}
// Dimension labels live in a screen-space layer: each frame they are placed
// outside the array's screen box, pushed apart, joined to their dimension line
// by a leader, and hidden when they still collide.
const SVGNS = 'http://www.w3.org/2000/svg';
const dimLayer = document.createElement('div'); dimLayer.id = 'dimLayer'; dimLayer.setAttribute('aria-hidden', 'true');
const dimSvg = document.createElementNS(SVGNS, 'svg'); dimLayer.appendChild(dimSvg);
viewport.insertBefore(dimLayer, $('compass'));
let dimLabels = [], dimArrayCorners = [];
function clearDimLabels() { for (const d of dimLabels) { d.el.remove(); d.line.remove(); } dimLabels = []; }
function addDimLabel(anchor, text, setback) {
  const el = document.createElement('div');
  el.className = `dim-label${setback ? ' setback' : ''}`; el.textContent = text;
  dimLayer.appendChild(el);
  const line = document.createElementNS(SVGNS, 'line'); line.setAttribute('class', setback ? 'leader setback' : 'leader');
  dimSvg.appendChild(line);
  dimLabels.push({ anchor: anchor.clone(), el, line, prio: setback ? 1 : 0, w: 0, h: 0 });
}
function layoutDimLabels() {
  if (!dimLabels.length) return;
  const W = viewport.clientWidth, H = viewport.clientHeight;
  const proj = (v) => { const p = v.clone().project(camera); return { x: (p.x + 1) / 2 * W, y: (1 - p.y) / 2 * H, z: p.z }; };
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const c of dimArrayCorners) { const q = proj(c); bx0 = Math.min(bx0, q.x); by0 = Math.min(by0, q.y); bx1 = Math.max(bx1, q.x); by1 = Math.max(by1, q.y); }
  const box = { x0: bx0 - 4, y0: by0 - 4, x1: bx1 + 4, y1: by1 + 4 }, cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  const hit = (a, b, pad = 3) => a.x - a.w / 2 < b.x + b.w / 2 + pad && a.x + a.w / 2 + pad > b.x - b.w / 2 && a.y - a.h / 2 < b.y + b.h / 2 + pad && a.y + a.h / 2 + pad > b.y - b.h / 2;
  const inBox = (a) => a.x + a.w / 2 > box.x0 && a.x - a.w / 2 < box.x1 && a.y + a.h / 2 > box.y0 && a.y - a.h / 2 < box.y1;
  const items = [];
  for (const d of dimLabels) {
    const a = proj(d.anchor);
    if (a.z > 1 || a.z < -1) { d.el.style.visibility = 'hidden'; d.line.style.visibility = 'hidden'; continue; }
    if (!d.w) { d.w = d.el.offsetWidth; d.h = d.el.offsetHeight; }
    let dx = a.x - cx, dy = a.y - cy; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const it = { d, ax: a.x, ay: a.y, dx, dy, w: d.w, h: d.h, x: a.x + dx * (18 + d.w / 2), y: a.y + dy * (14 + d.h / 2) };
    for (let k = 0; k < 40 && inBox(it); k++) { it.x += dx * 6; it.y += dy * 6; }
    items.push(it);
  }
  items.sort((a, b) => a.d.prio - b.d.prio);
  for (let iter = 0; iter < 30; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (!hit(A, B)) continue;
      const ox = (A.w + B.w) / 2 + 3 - Math.abs(A.x - B.x), oy = (A.h + B.h) / 2 + 3 - Math.abs(A.y - B.y);
      // push the lower-priority label along the axis of least overlap, then back out of the array
      if (oy < ox) B.y += (B.y >= A.y ? 1 : -1) * oy; else B.x += (B.x >= A.x ? 1 : -1) * ox;
      for (let k = 0; k < 20 && inBox(B); k++) { B.x += B.dx * 6; B.y += B.dy * 6; }
      moved = true;
    }
    if (!moved) break;
  }
  const shown = [];
  for (const it of items) {
    it.x = clamp(it.x, it.w / 2 + 2, W - it.w / 2 - 2); it.y = clamp(it.y, it.h / 2 + 2, H - it.h / 2 - 2);
    const ok = !inBox(it) && !shown.some((o) => hit(o, it, 1));
    it.d.el.style.visibility = ok ? '' : 'hidden';
    it.d.line.style.visibility = ok ? '' : 'hidden';
    if (!ok) continue;
    shown.push(it);
    it.d.el.style.transform = `translate(${(it.x - it.w / 2).toFixed(1)}px, ${(it.y - it.h / 2).toFixed(1)}px)`;
    const ex = clamp(it.ax, it.x - it.w / 2, it.x + it.w / 2), ey = clamp(it.ay, it.y - it.h / 2, it.y + it.h / 2);
    it.d.line.setAttribute('x1', it.ax.toFixed(1)); it.d.line.setAttribute('y1', it.ay.toFixed(1));
    it.d.line.setAttribute('x2', ex.toFixed(1)); it.d.line.setAttribute('y2', ey.toFixed(1));
  }
}
// Ray from p (2D, in the array's u/v frame) along d: distance to the polygon edge.
function rayPoly(px, py, dx, dy, poly, withIndex = false) {
  let best = Infinity, bi = -1;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - px) * ey - (ay - py) * ex) / den, s = ((ax - px) * dy - (ay - py) * dx) / den;
    if (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6 && t < best) { best = t; bi = i; }
  }
  return withIndex ? { t: best, i: bi } : best;
}
function arrayGeometry(arr) {
  const panels = state.plan.panels.filter((p) => p.arrayId === arr.id);
  let U = arr.axisU ? V3(arr.axisU).normalize() : null, Vv = arr.axisV ? V3(arr.axisV).normalize() : null;
  if (!U || !Vv) { const f = panelFrame(panels[0]); U = f.X; Vv = f.Z; }
  const n = new THREE.Vector3().crossVectors(U, Vv).normalize(); if (n.y < 0) n.negate();
  // extent from the panel corners (robust to any origin convention)
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  const ref = arr.origin ? V3(arr.origin) : V3(panels[0].corners[0]);
  for (const p of panels) for (const c of p.corners) { const d = V3(c).sub(ref); const a = d.dot(U), b = d.dot(Vv); a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
  const P = (a, b) => ref.clone().addScaledVector(U, a).addScaledVector(Vv, b);
  const roof = state.twin.roofs.find((r) => r.id === arr.roofId);
  const poly = roof ? roof.outline.map((q) => { const d = V3(q).sub(ref); return [d.dot(U), d.dot(Vv)]; }) : null;
  const tilt = Math.acos(clamp(n.y, -1, 1)) / DEG;
  const kindFor = (dx, dy) => {
    const world = U.clone().multiplyScalar(dx).addScaledVector(Vv, dy);
    if (tilt < 5) { const az = wrap360(Math.atan2(world.dot(eastVec()), world.dot(northVec())) / DEG); return `${compass(az)} edge`; }
    if (world.y < -0.05) return 'eave';
    if (world.y > 0.05) return 'ridge';
    return world.dot(eastVec()) > 0 ? 'east verge' : 'west verge';
  };
  const sides = [
    { mid: [(a0 + a1) / 2, b0], d: [0, -1] }, { mid: [(a0 + a1) / 2, b1], d: [0, 1] },
    { mid: [a0, (b0 + b1) / 2], d: [-1, 0] }, { mid: [a1, (b0 + b1) / 2], d: [1, 0] }
  ].map((s) => {
    const hit = poly ? rayPoly(s.mid[0], s.mid[1], s.d[0], s.d[1], poly, true) : { t: Infinity, i: -1 };
    const edgeType = roof?.edges?.[hit.i]?.type;
    const world = U.clone().multiplyScalar(s.d[0]).addScaledVector(Vv, s.d[1]);
    const dirName = world.y > 0.05 ? 'Up-slope' : world.y < -0.05 ? 'Down-slope' : `${compass(wrap360(Math.atan2(world.dot(eastVec()), world.dot(northVec())) / DEG))}`;
    return { ...s, dist: hit.t, kind: edgeType || kindFor(s.d[0], s.d[1]), dirName };
  });
  return { U, V: Vv, n, a0, a1, b0, b1, P, sides, panels, tilt, widthM: a1 - a0, lengthM: b1 - b0 };
}
function buildDims() {
  clearGroup(groups.dims);
  clearDimLabels();
  const arr = currentArray();
  if (!arr || !$('lyrDims').checked) return;
  const G = arrayGeometry(arr);
  dimArrayCorners = [G.P(G.a0, G.b0), G.P(G.a1, G.b0), G.P(G.a1, G.b1), G.P(G.a0, G.b1)];
  const lift = G.n.clone().multiplyScalar(0.04);
  const off = 0.45;
  // mounting rails under the modules (from the planner's CAD output)
  if (arr.cad?.rails?.length) {
    const pts = arr.cad.rails.flatMap((r) => [V3(r.from), V3(r.to)]);
    const rails = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xc7cdd6, transparent: true, opacity: 0.9 }));
    groups.dims.add(rails);
  }
  const w = num(arr.widthM, G.widthM), l = num(arr.lengthM, G.lengthM);
  // overall width on the upslope side, overall length on the left side
  const upSide = G.sides[0], leftSide = G.sides[2];
  const offW = G.V.clone().multiplyScalar(-Math.min(off, upSide.dist * 0.6 || off));
  const offL = G.U.clone().multiplyScalar(-Math.min(off, leftSide.dist * 0.6 || off));
  groups.dims.add(dimension(G.P(G.a0, G.b0).add(lift), G.P(G.a1, G.b0).add(lift), offW, `${fmt(w, 2)} m`));
  groups.dims.add(dimension(G.P(G.a0, G.b0).add(lift), G.P(G.a0, G.b1).add(lift), offL, `${fmt(l, 2)} m`));
  for (const s of G.sides) {
    if (!Number.isFinite(s.dist) || s.dist < 0.02) continue;
    const a = G.P(s.mid[0], s.mid[1]).add(lift);
    // shift the setback dimension off the centre-line so it does not cross the overall dims
    const along = s.d[0] === 0 ? G.U.clone().multiplyScalar((G.a1 - G.a0) * 0.22) : G.V.clone().multiplyScalar((G.b1 - G.b0) * 0.22);
    a.add(along);
    const b = a.clone().addScaledVector(G.U, s.d[0] * s.dist).addScaledVector(G.V, s.d[1] * s.dist);
    groups.dims.add(dimension(a, b, new THREE.Vector3(), `${fmt(s.dist, 2)} m to ${s.kind}`, true));
  }
}

// ------------------------------------------------------------------ sun
let sunSprite = null;
function sunDate(minutes = state.minutes) {
  const [y, m, d] = state.date.split('-').map(Number);
  return mock.localDate(y, m - 1, d, minutes / 60, state.tz);
}
function sunFor(minutes) {
  const sp = state.api.sunPosition(sunDate(minutes), state.lat, state.lon);
  return { ...sp, s: mock.sunVector(sp.azimuth, sp.elevation, bearing()) };
}
function sunDistance() { return Math.max(22, state.radius * 1.6); }
function buildSunPath() {
  clearGroup(groups.sun);
  const R = sunDistance(), c = state.centre.clone(); c.y = state.groundY;
  const segs = [];
  let cur = [];
  for (let m = 300; m <= 1260; m += 5) {
    const s = sunFor(m);
    if (s.elevation > -1) cur.push(c.clone().addScaledVector(V3(s.s), R));
    else if (cur.length) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);
  const pathMat = new THREE.LineDashedMaterial({ color: 0xffc94a, dashSize: 0.6, gapSize: 0.35, transparent: true, opacity: 0.75 });
  for (const s of segs) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(s), pathMat); l.computeLineDistances(); groups.sun.add(l); }
  const dotGeo = new THREE.SphereGeometry(0.16, 10, 8), dotMat = new THREE.MeshBasicMaterial({ color: 0xffc94a });
  for (let h = 7; h <= 19; h++) {
    const s = sunFor(h * 60);
    if (s.elevation <= 0) continue;
    const p = c.clone().addScaledVector(V3(s.s), R);
    const d = new THREE.Mesh(dotGeo, dotMat); d.position.copy(p); groups.sun.add(d);
    groups.sun.add(label(`${h}:00`, 'hour-label', p.clone().add(new THREE.Vector3(0, 0.7, 0))));
  }
  sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, depthWrite: false, transparent: true }));
  sunSprite.scale.setScalar(4.2);
  groups.sun.add(sunSprite);
  setVisible(groups.sun, $('lyrSunPath').checked);
  sunSprite.visible = true;
}
function updateSun() {
  const sp = sunFor(state.minutes);
  state.sun = sp;
  const c = state.centre.clone(); c.y = state.groundY;
  const S = V3(sp.s);
  if (sunSprite) { sunSprite.position.copy(c).addScaledVector(S, sunDistance()); sunSprite.visible = sp.elevation > -2; }
  const day = clamp((sp.elevation + 4) / 16, 0, 1);
  sunLight.position.copy(c).addScaledVector(S, 40);
  sunLight.target.position.copy(c);
  sunLight.intensity = sp.elevation > 0 ? 0.6 + 2.2 * Math.sin(sp.elevation * DEG) : 0;
  hemi.intensity = 0.35 + 0.6 * day;
  scene.background.setRGB(0.055 + 0.05 * day, 0.07 + 0.06 * day, 0.095 + 0.075 * day);
  if (pointsMat) {
    pointsMat.uniforms.uSun.value.copy(S);
    pointsMat.uniforms.uSunK.value = sp.elevation > 0 ? clamp(sp.elevation / 15, 0, 1) : 0;
    pointsMat.uniforms.uDay.value = 0.45 + 0.55 * day;
  }
  $('timeOut').textContent = `${String(Math.floor(state.minutes / 60)).padStart(2, '0')}:${String(state.minutes % 60).padStart(2, '0')}`;
  $('sunPos').textContent = sp.elevation > 0 ? `Sun ${fmt(sp.elevation, 0)}° up, ${fmt(sp.azimuth, 0)}° ${compass(sp.azimuth)}` : 'Sun below the horizon';
  updatePanelSun();
  requestScanShadow();
}
// Per-panel sun: moving shadow masks, sunlit fraction and live power.
function updatePanelSun() {
  const plan = state.plan;
  if (!plan) return;
  const s = state.sun.s, el = state.sun.elevation;
  const fromApi = state.occ ? state.api.instantShading(planTwin(), state.occ, plan, state.sun, sunDate()) : null;
  const cs = mock.clearSky(el);
  const wp = currentPanel().wattPeak;
  let kw = 0;
  state.sunlit = plan.panels.map((p, i) => {
    const grp = groups.panels.children[i];
    let lit = 0;
    if (grp) {
      const { f, maskData, maskTex } = grp.userData;
      let sum = 0;
      for (let j = 0; j < MASK_V; j++) for (let k = 0; k < MASK_U; k++) {
        let v = 0;
        if (el > 0 && f.Y.dot(V3(s)) > 0) {
          const x = ((k + 0.5) / MASK_U - 0.5) * f.w, z = (0.5 - (j + 0.5) / MASK_V) * f.l;
          const q = f.centre.clone().addScaledVector(f.X, x).addScaledVector(f.Z, z);
          v = state.occ ? mock.sunlitAt(state.occ, [q.x, q.y, q.z], [f.Y.x, f.Y.y, f.Y.z], s) : 1;
        }
        sum += v;
        const o = (j * MASK_U + k) * 4, a = Math.round((1 - v) * 255);
        maskData[o] = maskData[o + 1] = maskData[o + 2] = maskData[o + 3] = el > 0 ? a : 0;
      }
      maskTex.needsUpdate = true;
      lit = sum / (MASK_U * MASK_V);
    }
    if (fromApi) lit = clamp(fromApi.lit[i], 0, 1);
    const n = p.normal || [0, 1, 0];
    const ci = Math.max(0, n[0] * s[0] + n[1] * s[1] + n[2] * s[2]);
    const poa = cs.dni * ci * lit + cs.dhi * (1 + n[1]) / 2;
    kw += (wp * poa / 1000) * 0.86 / 1000;
    return lit;
  });
  const typical = state.sky === 'typical' && Number.isFinite(fromApi?.totalW);
  state.nowKw = typical ? (el > 0 ? fromApi.totalW / 1000 : 0) : kw;
  $('nowKw').textContent = `${fmt(state.nowKw, 2)} kW now`;
  $('nowKw').title = typical
    ? 'Planner estimate for this moment on a typical-sky day of this month (climatology), with shading from the scan, cell temperature and system losses'
    : 'Clear-sky estimate for this moment, including shading from the scan and 14% system losses';
  refreshPanelStyles();
  if (state.selected) renderModuleDetail();
}
let dayTimer = 0;
function scheduleDayTotal() {
  clearTimeout(dayTimer);
  dayTimer = setTimeout(() => {
    const plan = state.plan;
    if (!plan) return;
    const wp = currentPanel().wattPeak;
    let kwh = 0, typical = state.sky === 'typical' && state.api.real.instant && !!state.occ;
    const twin = planTwin();
    for (let m = 390; m <= 1170; m += 15) {
      const sp = sunFor(m);
      if (sp.elevation <= 0) continue;
      if (typical) {
        const r = state.api.instantShading(twin, state.occ, plan, sp, sunDate(m));
        if (Number.isFinite(r?.totalW)) { kwh += (r.totalW / 1000) * 0.25; continue; }
        typical = false; kwh = 0; m = 375; continue; // planner failed: restart with the clear-sky fallback
      }
      const cs = mock.clearSky(sp.elevation);
      const lit = state.occ ? mock.mockInstantShading(state.twin, state.occ, plan, sp.s) : plan.panels.map(() => 1);
      plan.panels.forEach((p, i) => {
        const n = p.normal || [0, 1, 0];
        const ci = Math.max(0, n[0] * sp.s[0] + n[1] * sp.s[1] + n[2] * sp.s[2]);
        kwh += (wp * (cs.dni * ci * lit[i] + cs.dhi * (1 + n[1]) / 2) / 1e6) * 0.86 * 0.25;
      });
    }
    $('dayKwh').textContent = `${typical ? 'typical' : 'clear-sky'} day ≈ ${fmt(kwh, 0)} kWh`;
  }, 120);
}

// ------------------------------------------------------------------ planning
function currentPanel() { return state.api.panels.find((p) => p.id === state.opts.panelId) || state.api.panels[0]; }
function mountInfo() { return state.api.catalogue?.MOUNTING?.[state.opts.mounting] || null; }
function mountStandoff() {
  const m = mountInfo();
  // roof surface to module top (catalogue convention)
  return num(m?.standoffM, m?.standoffMm && m.standoffMm / 1000, state.opts.mounting === 'tilted' ? 0.3 : 0.12);
}
function currentArray() {
  const arrays = state.plan?.arrays || [];
  return arrays.find((a) => a.id === state.selectedArray) || arrays[0] || null;
}
function planTwin() {
  return { ...state.twin, location: { ...(state.twin.location || {}), lat: state.lat, lon: state.lon }, northBearing: (state.twin.northBearing || 0) + state.north, northOffsetDeg: bearing() };
}
function planOptions(orientation) {
  const o = state.opts;
  return {
    panel: currentPanel(), mounting: o.mounting, tiltDeg: o.mounting === 'tilted' ? o.tiltDeg : null,
    orientation: orientation === 'auto' ? undefined : orientation,
    setback: o.setback, setbackM: o.setback,
    // atap: leave targetKwp undefined so the planner applies the Solar ATAP cap (DC/AC 1.2 on 5 kWac)
    targetKwp: o.sizeMode === 'kwp' ? o.targetKwp : o.sizeMode === 'atap' ? (state.api.real.placement ? undefined : 6.5) : null, sizeMode: o.sizeMode, maxPanels: null,
    fluxThreshold: o.fluxThreshold || 0, minFluxKwhM2: o.fluxThreshold || 0,
    heatmap: state.heat, northOffsetDeg: bearing(), azimuthOffsetDeg: state.north, lat: state.lat, lon: state.lon,
    standoffM: mountStandoff(), gapM: mountInfo()?.gapM ?? 0.02,
    mountingKgPerPanel: (mountInfo()?.rackingKgM2 ?? 3) * currentPanel().lengthMm * currentPanel().widthMm / 1e6
  };
}
let planTimer = 0, planSeq = 0, heatDirty = true;
function schedulePlan(delay = 250, { heat = false } = {}) {
  if (heat) heatDirty = true;
  $('planState').hidden = false;
  showStatus('Re-planning…');
  clearTimeout(planTimer);
  planTimer = setTimeout(runPlan, delay);
}
async function runPlan() {
  const seq = ++planSeq;
  await nextFrame();
  const t0 = performance.now();
  try {
    const twin = planTwin();
    if (heatDirty || !state.heat) {
      state.heat = await state.api.heatmap(twin, state.occ, { cell: 0.5, northOffsetDeg: bearing(), northBearing: bearing(), lat: state.lat, lon: state.lon });
      heatDirty = false;
      const fmax = Math.ceil((state.heat?.max || 1600) / 50) * 50;
      $('flux').max = String(fmax);
    }
    let plan;
    if (state.opts.orientation === 'auto' && !state.api.real.placement) {
      const [p1, p2] = [await state.api.planArray(twin, state.occ, planOptions('portrait')), await state.api.planArray(twin, state.occ, planOptions('landscape'))];
      plan = p2.summary.annualKwh > p1.summary.annualKwh * 1.001 ? p2 : p1;
    } else plan = await state.api.planArray(twin, state.occ, planOptions(state.opts.orientation));
    if (seq !== planSeq) return;
    applyPlan(plan);
    showStatus(null);
    $('planState').title = `Planned in ${fmt(performance.now() - t0)} ms`;
  } catch (e) {
    console.warn('twin: planning failed', e);
    showStatus(`Planning failed: ${e.message}`, true);
  } finally {
    if (seq === planSeq) $('planState').hidden = true;
  }
}
function applyPlan(plan) {
  plan.panels ||= []; plan.arrays ||= []; plan.rejected ||= [];
  state.plan = plan;
  if (state.selected && !plan.panels.some((p) => p.id === state.selected)) closeSelection();
  if (state.selectedArray && !plan.arrays.some((a) => a.id === state.selectedArray)) state.selectedArray = null;
  buildPanels(); buildRejected(); buildHeat(); buildDims();
  setVisible(groups.heat, $('lyrHeat').checked);
  setVisible(groups.rejected, $('lyrRejected').checked);
  updatePanelSun();
  scheduleDayTotal();
  renderSummary(); renderCad(); renderPanelPick();
  if (state.selected) renderModuleDetail();
}

// ------------------------------------------------------------------ UI: summary + assumptions
function scaleSensitivityText(s, sc) {
  const ss = s.scaleSensitivity;
  if (typeof ss === 'string') return `<b>Scale sensitivity:</b> ${escapeHtml(ss)}`;
  if (ss && typeof ss === 'object') {
    const r = (k, u, d = 0) => (Array.isArray(ss[k]) ? `${k} ${fmt(ss[k][0], d)}–${fmt(ss[k][1], d)}${u}` : null);
    const parts = [r('metresPerUnit', ' m/u', 2), r('panels', ''), r('kWp', ' kWp', 1), r('annualKwh', ' kWh/yr')].filter(Boolean);
    const txt = ss.text || ss.note || ss.summary;
    return `<b>Scale sensitivity:</b> ${escapeHtml([txt, parts.join(', ')].filter(Boolean).join(' ') || JSON.stringify(ss))}`;
  }
  const m = sc.metresPerUnit, rg = sc.rangeMetresPerUnit;
  if (!m || !Array.isArray(rg)) return null;
  const lo = rg[0] / m, hi = rg[1] / m;
  const pc = (x) => `${x >= 1 ? '+' : '−'}${fmt(Math.abs(x - 1) * 100)}%`;
  return `<b>Scale sensitivity:</b> plausible scale ${fmt(rg[0], 2)}–${fmt(rg[1], 2)} m per scan unit (${pc(lo)} / ${pc(hi)}). Every length moves with it and roof areas by ${pc(lo * lo)} / ${pc(hi * hi)}, so the number of modules that fit could change by a similar share. Tilts, orientation and the shading pattern do not depend on scale.`;
}
function pitchText() {
  const ts = primaryRoofs().map((r) => r.tilt).filter(Number.isFinite);
  if (!ts.length) return null;
  return `<b>Roof pitches:</b> ${fmt(Math.min(...ts), 0)}–${fmt(Math.max(...ts), 0)}° across ${ts.length} planes fitted to the scan; independent of scale.`;
}
// "Roof potential" banner for Max mode (not a buildable single-phase system)
function renderBanner() {
  const s = state.plan?.summary || {};
  const g = s.grid || {};
  const over = g.withinLimits === false || g.withinLimit === false;
  const potential = s.mode === 'roof-potential' || (state.opts.sizeMode === 'max' && over);
  const b = $('banner');
  b.hidden = !potential;
  if (potential) b.innerHTML = `<b>Roof potential</b> — ${fmt(s.kWp, 1)} kWp needs a three-phase supply; not a system design.`;
}
function renderSummary() {
  const s = state.plan?.summary || {};
  const panels = state.plan?.panels || [];
  const kWp = num(s.kWp, panels.length * currentPanel().wattPeak / 1000);
  const kwh = num(s.annualKwh, panels.reduce((t, p) => t + (p.annualKwh || 0), 0));
  $('mPanels').textContent = fmt(num(s.panels, panels.length));
  $('mKwp').textContent = fmt(kWp, 2);
  // ground-calibrated headline when the planner provides it
  const y = s.yield;
  const yo = y && typeof y === 'object' ? y : {};
  const cal = typeof y === 'number' ? y : num(yo.calibratedKwh, yo.annualKwhCalibrated, yo.groundCalibratedKwh, yo.calibrated, yo.annualKwh, yo.kwh, yo.value);
  const modelled = num(yo.modelledKwh, yo.modelKwh, yo.modelled, kwh);
  const yNote = yo.note || yo.source || yo.basis || 'NASA POWER satellite climatology reads ~5–10% above Klang Valley ground stations; the headline is scaled to ground data.';
  const range = Array.isArray(yo.range) ? ` Range ${fmt(yo.range[0])}–${fmt(yo.range[1])} kWh/yr.` : '';
  if (Number.isFinite(cal)) {
    $('mKwh').textContent = `≈ ${fmt(cal)}`;
    $('mKwh').parentElement.title = `Ground-calibrated estimate. Modelled with NASA POWER climatology: ${fmt(modelled)} kWh/yr. ${yNote}${range}`;
  } else {
    $('mKwh').textContent = fmt(kwh);
    $('mKwh').parentElement.title = 'Modelled with the planner climate (see Assumptions); not ground-calibrated.';
  }
  const specModel = num(s.specificYield, kWp ? kwh / kWp : NaN);
  const specCal = num(s.specificYieldCalibrated, Number.isFinite(cal) && kWp ? cal / kWp : undefined);
  $('mYield').textContent = Number.isFinite(specCal) ? `≈ ${fmt(specCal)}` : fmt(specModel);
  $('mYield').parentElement.title = Number.isFinite(specCal) ? `Ground-calibrated. Modelled: ${fmt(specModel)} kWh/kWp.` : 'Modelled specific yield.';
  renderBanner();
  $('mShade').textContent = `${fmt(num(s.avgShadeLoss, 0) * 100, 1)}%`;
  const t = state.twin, sc = t.scale || {};
  const planAssump = (state.plan?.summary?.assumptions || []).map((a) => (typeof a === 'string' ? a : a.text || JSON.stringify(a)));
  const hasScale = planAssump.some((a) => /scale/i.test(a)), hasLoc = planAssump.some((a) => /^Location/i.test(a));
  const items = [
    hasScale ? null : `<b>Scale:</b> ${sc.metresPerUnit ? `${fmt(sc.metresPerUnit, 4)} m per scan unit` : 'unknown'}${sc.method ? `, ${escapeHtml(sc.method)}` : ''} (confidence: <b>${escapeHtml(sc.confidence || 'unknown')}</b>). Dimensions inherit this uncertainty.`,
    hasLoc ? null : `<b>Location assumed:</b> ${escapeHtml(t.location?.name || 'not given')} at ${fmt(state.lat, 4)}° N, ${fmt(state.lon, 4)}° E, UTC+${state.tz}. The scan has no GPS; change it under Site.`,
    scaleSensitivityText(s, sc),
    pitchText(),
    `<b>Heading assumed:</b> north from scan preparation (bearing ${fmt(t.northBearing || 0, 0)}°)${state.north ? `, corrected by ${state.north > 0 ? '+' : ''}${state.north}° here` : ''}. A drone scan has no compass.`,
    `<b>Scan:</b> ${state.data.real ? 'Gaussian-splat point cloud converted by ImageToStl, which stripped colour, opacity and splat shape. Points are drawn in neutral greys shaded by surface normal; ~2% floaters were cleaned.' : `Synthetic stand-in house (${escapeHtml(state.data.why || 'real scan not found')}). Same frame and data format as the real twin.`}`,
    ...planAssump.map((a) => `<b>Model:</b> ${escapeHtml(a)}`),
    `<b>Algorithms:</b> planner ${state.api.real.placement ? 'src/twin/placement.js' : 'built-in fallback'}, sun ${state.api.real.sun ? 'src/twin/sun.js' : 'built-in NOAA-style'}, catalogue ${state.api.real.catalogue ? 'src/twin/catalogue.js' : 'built-in indicative datasheets'}, live shading ${state.api.real.instant ? 'planner instantShading' : state.api.shade?.sunlitFraction ? 'src/twin/shade.js' : 'built-in voxel rays'}.`,
    '<b>Live kW:</b> “Typical day” is the planner’s typical sky for the month (climatology); “Clear day” is a cloudless Meinel model with 14% losses. Both include shading from the scan. Stormy afternoons produce much less.',
    '<b>Not an engineering certificate:</b> roof structure, waterproofing and wind loads need an installer survey (MS 1837, SEDA NEM rules).'
  ];
  $('assumptionList').innerHTML = items.filter(Boolean).map((i) => `<li>${i}</li>`).join('');
}

// ------------------------------------------------------------------ UI: module detail + popup
function panelRows(p, i) {
  const lit = state.sunlit[i];
  const wp = currentPanel().wattPeak;
  return [
    ['Annual energy', `${fmt(p.annualKwh)} kWh`],
    ['Irradiation on module (POA)', `${fmt(p.poaKwhM2)} kWh/m²/yr`],
    ['Shade loss (annual)', `${fmt((p.shadeLoss || 0) * 100, 1)}%`],
    ['Direct-sun hours', `${fmt(p.sunHoursYear)} h/yr`],
    ['Tilt', `${fmt(p.tiltDeg, 1)}°`],
    ['Azimuth', `${fmt(wrap360(p.azimuthDeg ?? 0), 0)}° (${compass(p.azimuthDeg ?? 0)})`],
    ['Array · row · col', `${escapeHtml(p.arrayId)} · ${p.row} · ${p.col}`],
    ['Roof plane', escapeHtml(p.roofId)],
    ['Module', `${escapeHtml(currentPanel().label)}, ${fmt(wp)} Wp`],
    ['Now (this time of day)', lit == null ? '–' : `${fmt(lit * 100)}% sunlit`],
    ['Centre x, y, z (m)', (p.centre || []).map((v) => fmt(v, 2)).join(', ')]
  ];
}
function renderModuleDetail() {
  const i = state.panelIdx.get(state.selected);
  const p = state.plan?.panels[i];
  const box = $('moduleDetail');
  if (!p) { box.innerHTML = '<p class="note">Click a panel in the 3D view to see why it was placed there.</p>'; return; }
  const r = p.reason || {};
  box.innerHTML = `<div class="detail-head"><small>Module ${escapeHtml(p.id)}</small><b>${escapeHtml(r.headline || 'Placed by the planner')}</b></div>
    <ul>${(r.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
    <table>${panelRows(p, i).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  $('panelPick').value = p.id;
}
function selectPanel(id, { focus = false, openTab = true } = {}) {
  state.selected = id;
  const i = state.panelIdx.get(id);
  const p = state.plan.panels[i];
  if (!p) return closeSelection();
  if (p.arrayId !== state.selectedArray) { state.selectedArray = p.arrayId; buildDims(); renderCad(); }
  const r = p.reason || {};
  $('popupKicker').textContent = `Module ${p.id} · row ${p.row}, col ${p.col}`;
  $('popupTitle').textContent = r.headline || 'Placed by the planner';
  $('popupBullets').innerHTML = (r.bullets || []).slice(0, 3).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  $('popupStats').innerHTML = `<span><b>${fmt(p.annualKwh)}</b> kWh/yr</span><span><b>${fmt(p.poaKwhM2)}</b> kWh/m² POA</span><span><b>${fmt((p.shadeLoss || 0) * 100, 1)}%</b> shade</span>`;
  $('popup').hidden = false;
  refreshPanelStyles();
  renderModuleDetail();
  if (openTab) setTab('module');
  if (focus) flyTo(V3(p.centre || p.corners[0]), Math.min(camera.position.distanceTo(controls.target), 9));
}
function closeSelection() {
  state.selected = null;
  $('popup').hidden = true;
  if (state.plan) refreshPanelStyles();
  renderModuleDetail();
}
function placePopup() {
  if ($('popup').hidden || !state.selected) return;
  const p = state.plan.panels[state.panelIdx.get(state.selected)];
  if (!p) return;
  const v = V3(p.centre || p.corners[0]).project(camera);
  const el = $('popup'), W = viewport.clientWidth, H = viewport.clientHeight;
  if (v.z > 1) { el.style.visibility = 'hidden'; return; }
  el.style.visibility = '';
  const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
  const h = el.offsetHeight, w = el.offsetWidth;
  let top = y - h - 18, below = false;
  if (top < 8) { top = y + 22; below = true; }
  el.classList.toggle('below', below);
  el.style.left = `${clamp(x - 30, 8, W - w - 8)}px`;
  el.style.top = `${clamp(top, 8, H - h - 8)}px`;
}
function renderPanelPick() {
  const ps = state.plan?.panels || [];
  $('panelPick').innerHTML = `<option value="">Choose a module…</option>` + ps.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)} · ${fmt(p.annualKwh)} kWh/yr${p.shadeLoss > 0.05 ? ' · shaded' : ''}</option>`).join('');
  if (state.selected) $('panelPick').value = state.selected;
  $('arrayPick').innerHTML = (state.plan?.arrays || []).map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.id)} on ${escapeHtml(a.roofId)} · ${num(a.panelCount, ps.filter((p) => p.arrayId === a.id).length)} modules</option>`).join('');
  const ca = currentArray(); if (ca) $('arrayPick').value = ca.id;
}

// ------------------------------------------------------------------ UI: CAD
function renderCad() {
  const arr = currentArray();
  const box = $('cadTable');
  if (!arr) { box.innerHTML = '<p class="note">No array placed. Lower the setback or the min. sun threshold.</p>'; return; }
  const G = arrayGeometry(arr);
  const pm = currentPanel();
  const count = G.panels.length;
  const w = num(arr.widthM, G.widthM), l = num(arr.lengthM, G.lengthM);
  const standoff = num(arr.standoffM, mountStandoff());
  const weight = num(arr.weightKg, count * (pm.weightKg + 2.5));
  const load = num(arr.loadKgM2, weight / (w * l));
  const kWp = num(arr.kWp, (count * pm.wattPeak) / 1000);
  const kwh = num(arr.annualKwh, G.panels.reduce((s, p) => s + (p.annualKwh || 0), 0));
  const tilt = num(arr.tiltDeg, G.tilt), az = num(arr.azimuthDeg, G.panels[0]?.azimuthDeg, 0);
  const rows = [
    ['Layout', null],
    ['Rows × columns', `${arr.rows ?? '–'} × ${arr.cols ?? '–'} (${count} modules)`],
    ['Orientation', escapeHtml(arr.orientation || '–')],
    ['Overall width × length (on slope)', `${fmt(w, 2)} × ${fmt(l, 2)} m`],
    ['Plan footprint (projected)', `${fmt(w, 2)} × ${fmt(l * Math.cos(tilt * DEG), 2)} m`],
    ['Module L × W × T', `${fmt(pm.lengthMm)} × ${fmt(pm.widthMm)} × ${fmt(pm.thicknessMm)} mm`],
    ['Gap between modules', `${fmt(num(arr.gapM, 0.02) * 1000)} mm`],
    ['Row pitch', arr.rowPitchM ? `${fmt(arr.rowPitchM, 3)} m` : '–'],
    ['Setbacks (module edge to roof edge)', null],
    ...(arr.setbacks && typeof arr.setbacks === 'object'
      ? Object.entries(arr.setbacks).map(([k, v]) => [`To ${escapeHtml(k)}${arr.setbackRules?.[k] != null ? ` (min ${fmt(arr.setbackRules[k], 2)})` : ''}`, `${fmt(v, 2)} m`])
      : G.sides.map((x) => [`${x.dirName} side → ${escapeHtml(x.kind)}`, Number.isFinite(x.dist) ? `${fmt(x.dist, 2)} m` : '–'])),
    ...(arr.obstacleClearM != null ? [['To nearest obstacle', `${fmt(arr.obstacleClearM, 2)} m`]] : []),
    ...(arr.setbackRules ? [] : [['Minimum rule', `${fmt(num(arr.setbackM, state.opts.setback), 2)} m`]]),
    ...(arr.cad?.rails?.length ? [['Rails', `${arr.cad.rails.length} (${arr.cad.railsPerRow ?? 2} per row)`]] : []),
    ['Mounting', null],
    ['Tilt', `${fmt(tilt, 1)}°`],
    ['Azimuth', `${fmt(wrap360(az), 0)}° (${compass(az)})`],
    ['Standoff above roof', `${fmt(standoff * 1000)} mm`],
    ['Weight (modules + rails)', `${fmt(weight)} kg`],
    ['Distributed load', `${fmt(load, 1)} kg/m²`],
    ['Output', null],
    ['Peak power', `${fmt(kWp, 2)} kWp`],
    ['Annual energy', `${fmt(kwh)} kWh`],
    ['Specific yield', `${fmt(kWp ? kwh / kWp : NaN)} kWh/kWp`],
    ...(state.plan.summary?.performanceRatio ? [['Performance ratio', `${fmt(state.plan.summary.performanceRatio * 100, 1)}%`]] : []),
    ...(state.plan.summary?.grid?.maxModulesPerString ? [['String length', `${state.plan.summary.grid.minModulesPerString}–${state.plan.summary.grid.maxModulesPerString} modules`]] : [])
  ];
  box.innerHTML = gridHtml() + `<table>${rows.map(([k, v]) => (v == null ? `<tr class="group"><td colspan="2">${k}</td></tr>` : `<tr><td>${k}</td><td>${v}</td></tr>`)).join('')}</table>` +
    (arr.reason?.headline ? `<p class="note"><b>${escapeHtml(arr.reason.headline)}</b>${(arr.reason.bullets || []).map((b) => `<br>· ${escapeHtml(b)}`).join('')}</p>` : '');
}

// Whole-system electrical summary (summary.grid; older planner shape: grid + stringing).
function gridHtml() {
  const s = state.plan?.summary || {};
  const g = s.grid;
  if (!g) return '';
  const inv = num(g.inverterKwac, g.suggestedInverterKwac), dcac = num(g.dcAc, g.dcAcRatio);
  const within = g.withinLimits ?? g.withinLimit;
  const lines = [];
  if (Array.isArray(g.mppts) && g.mppts.length) {
    g.mppts.forEach((m, i) => {
      const voc = num(m.vocColdV), vmp = num(m.vmpHotV);
      lines.push(`MPPT${i + 1}${m.arrayIds ? ` (${escapeHtml([].concat(m.arrayIds).join(', '))})` : ''}: ${m.strings ?? 1} × ${m.modulesPerString ?? m.modules ?? '?'} modules${Number.isFinite(voc) ? ` (Voc cold ${fmt(voc)} V ${voc <= 600 ? '≤' : '>'} 600 V${Number.isFinite(vmp) ? `, Vmp hot ${fmt(vmp)} V` : ''})` : ''}`);
    });
  } else if (s.stringing?.mppts?.length) {
    const st = s.stringing;
    st.mppts.forEach((m, i) => {
      const per = Math.ceil(m.modules / Math.max(1, m.strings));
      lines.push(`MPPT${i + 1} (${escapeHtml(m.orientation)}): ${m.modules} modules in ${m.strings} string${m.strings > 1 ? 's' : ''} (≤ ${per} each; Voc cold ≈ ${fmt(st.vocColdV * per)} V ≤ 600 V)`);
    });
  }
  const notes = [].concat(g.notes || [], s.stringing?.note && !g.mppts ? [s.stringing.note] : []);
  return `<div class="sysbox"><b>${Number.isFinite(inv) ? `${fmt(inv, 1)} kWac inverter` : 'Inverter'}${Number.isFinite(dcac) ? ` · DC/AC ${fmt(dcac, 2)}` : ''}${g.phase ? ` · ${escapeHtml(g.phase)}-phase` : ''}</b>
    ${lines.map((l) => `<div>${l}</div>`).join('')}
    <div class="${within === false ? 'bad' : 'ok'}">${within === false ? 'Over' : 'Within'} ${escapeHtml(g.programme || 'grid')} limits${Number.isFinite(g.limitKwac) ? ` (${fmt(g.limitKwac)} kWac)` : ''}</div>
    ${notes.map((n) => `<small>${escapeHtml(n)}</small>`).join('')}</div>`;
}
// ------------------------------------------------------------------ exports
function download(name, blobOrUrl, type = 'text/plain') {
  const url = typeof blobOrUrl === 'string' && blobOrUrl.startsWith('data:') ? blobOrUrl : URL.createObjectURL(new Blob([blobOrUrl], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  if (!url.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function csvText() {
  const ps = state.plan?.panels || [];
  const head = ['panel_id', 'array_id', 'roof_id', 'row', 'col', 'centre_x_east_m', 'centre_y_up_m', 'centre_z_south_m'];
  for (let k = 1; k <= 4; k++) head.push(`c${k}_x_east_m`, `c${k}_y_up_m`, `c${k}_z_south_m`);
  head.push('tilt_deg', 'azimuth_deg', 'annual_kwh', 'poa_kwh_m2', 'shade_loss_pct', 'sun_hours_year', 'module', 'wp');
  const pm = currentPanel();
  const rows = ps.map((p) => [p.id, p.arrayId, p.roofId, p.row, p.col, ...(p.centre || [NaN, NaN, NaN]).map((v) => v.toFixed(3)), ...p.corners.flat().map((v) => v.toFixed(3)),
    (p.tiltDeg ?? 0).toFixed(1), wrap360(p.azimuthDeg ?? 0).toFixed(1), (p.annualKwh ?? 0).toFixed(1), (p.poaKwhM2 ?? 0).toFixed(1), ((p.shadeLoss ?? 0) * 100).toFixed(2), Math.round(p.sunHoursYear ?? 0), `"${pm.label.replace(/"/g, '""')}"`, pm.wattPeak]);
  return [head, ...rows].map((r) => r.join(',')).join('\r\n');
}
function exportCsv() { download(`${state.twin.id || 'twin'}-panels.csv`, csvText(), 'text/csv');
}
function dxfText() {
  // Plan view: X = east, Y = north (= -z). Minimal ASCII DXF with LINE, LWPOLYLINE and TEXT.
  const out = [];
  const g = (code, v) => out.push(String(code), String(v));
  const X = (p) => (p[0]).toFixed(4), Y = (p) => (-p[2]).toFixed(4);
  const layers = [['ROOF', 7], ['OBSTACLES', 1], ['PANELS', 5], ['RAILS', 8], ['EXCLUDED', 1], ['DIMENSIONS', 2], ['TEXT', 7]];
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$INSUNITS'); g(70, 6); g(9, '$MEASUREMENT'); g(70, 1); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [n, c] of layers) { g(0, 'LAYER'); g(2, n); g(70, 0); g(62, c); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (pts, layer) => { g(0, 'LWPOLYLINE'); g(8, layer); g(90, pts.length); g(70, 1); for (const p of pts) { g(10, X(p)); g(20, Y(p)); } };
  const line = (a, b, layer) => { g(0, 'LINE'); g(8, layer); g(10, X(a)); g(20, Y(a)); g(30, 0); g(11, X(b)); g(21, Y(b)); g(31, 0); };
  const text = (p, h, s, layer = 'TEXT', rot = 0) => { g(0, 'TEXT'); g(8, layer); g(10, X(p)); g(20, Y(p)); g(30, 0); g(40, h); g(1, s); if (rot) g(50, rot.toFixed(2)); };
  for (const r of primaryRoofs()) {
    poly(r.outline, 'ROOF');
    const c = r.outline.reduce((s, p) => [s[0] + p[0] / r.outline.length, 0, s[2] + p[2] / r.outline.length], [0, 0, 0]);
    text(c, 0.25, `${r.id} tilt ${fmt(r.tilt, 0)} az ${fmt(r.azimuth, 0)}`, 'TEXT');
    for (const o of r.obstacles || []) poly(o.outline, 'OBSTACLES');
  }
  for (const rj of state.plan?.rejected || []) if (rj.outline?.length > 2) poly(rj.outline, 'EXCLUDED');
  for (const p of state.plan?.panels || []) { poly(p.corners, 'PANELS'); text(p.centre || p.corners[0], 0.12, p.id, 'TEXT'); }
  for (const arr of state.plan?.arrays || []) {
    for (const r of arr.cad?.rails || []) line(r.from, r.to, 'RAILS');
    const G = arrayGeometry(arr);
    const a = G.P(G.a0, G.b0), b = G.P(G.a1, G.b0), c = G.P(G.a0, G.b1);
    const offW = G.V.clone().multiplyScalar(-0.4), offL = G.U.clone().multiplyScalar(-0.4);
    const A = (v) => [v.x, v.y, v.z];
    line(A(a.clone().add(offW)), A(b.clone().add(offW)), 'DIMENSIONS');
    line(A(a), A(a.clone().add(offW)), 'DIMENSIONS'); line(A(b), A(b.clone().add(offW)), 'DIMENSIONS');
    line(A(a.clone().add(offL)), A(c.clone().add(offL)), 'DIMENSIONS');
    line(A(a), A(a.clone().add(offL)), 'DIMENSIONS'); line(A(c), A(c.clone().add(offL)), 'DIMENSIONS');
    const rotU = Math.atan2(-G.U.z, G.U.x) / DEG, rotV = Math.atan2(-G.V.z, G.V.x) / DEG;
    text(A(a.clone().lerp(b, 0.5).add(offW.clone().multiplyScalar(1.6))), 0.18, `${arr.id} W ${fmt(num(arr.widthM, G.widthM), 2)} m`, 'DIMENSIONS', rotU);
    text(A(a.clone().lerp(c, 0.5).add(offL.clone().multiplyScalar(1.6))), 0.18, `${arr.id} L ${fmt(num(arr.lengthM, G.lengthM), 2)} m (on slope)`, 'DIMENSIONS', rotV);
    for (const s of G.sides) {
      if (!Number.isFinite(s.dist)) continue;
      const p0 = G.P(s.mid[0], s.mid[1]), p1 = p0.clone().addScaledVector(G.U, s.d[0] * s.dist).addScaledVector(G.V, s.d[1] * s.dist);
      line(A(p0), A(p1), 'DIMENSIONS');
      text(A(p0.clone().lerp(p1, 0.5)), 0.12, `${fmt(s.dist, 2)} m to ${s.kind}`, 'DIMENSIONS');
    }
  }
  const outl = primaryRoofs().flatMap((r) => r.outline);
  const minX = Math.min(...outl.map((p) => p[0])), maxZ = Math.max(...outl.map((p) => p[2]));
  text([minX, 0, maxZ + 1.5], 0.3, `${state.twin.title || state.twin.id}: plan view, metres, X east, Y north. Simulated array; verify on site.`, 'TEXT');
  g(0, 'ENDSEC'); g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
function exportDxf() { download(`${state.twin.id || 'twin'}-plan.dxf`, dxfText(), 'application/dxf');
}
function snapshot() {
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const s = state.plan?.summary || {}, k = renderer.getPixelRatio();
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(0, c.height - 34 * k, c.width, 34 * k);
  g.fillStyle = '#1b1f27'; g.font = `${600} ${13 * k}px Inter, system-ui, sans-serif`;
  g.fillText(`${state.twin.title || 'Digital twin'} · ${fmt(s.panels ?? state.plan?.panels.length)} panels · ${fmt(s.kWp, 2)} kWp · ${fmt(s.annualKwh)} kWh/yr · ${state.date} ${$('timeOut').textContent} · simulated array, not a survey`, 12 * k, c.height - 12 * k);
  download(`${state.twin.id || 'twin'}-snapshot.png`, c.toDataURL('image/png'));
}

// ------------------------------------------------------------------ camera
let tween = null;
function flyTo(target, dist, dir) {
  const d = dir ? dir.clone().normalize() : camera.position.clone().sub(controls.target).normalize();
  tween = { t0: performance.now(), dur: 700, p0: camera.position.clone(), q0: controls.target.clone(), p1: target.clone().addScaledVector(d, dist), q1: target.clone() };
}
function fitDistance() { return (state.radius / Math.sin((camera.fov * DEG) / 2)) * 0.9; }
function view(name) {
  const c = state.centre.clone(), D = fitDistance();
  const N = northVec(), E = eastVec(), U = new THREE.Vector3(0, 1, 0);
  if (name === 'top') flyTo(c, D * 0.95, U.clone().addScaledVector(N, -0.002));
  else if (name === 'front') flyTo(c, D * 0.85, N.clone().negate().addScaledVector(U, 0.22));
  else if (name === 'oblique') flyTo(c, D * 0.85, N.clone().negate().add(E).multiplyScalar(0.7).addScaledVector(U, 0.75));
  else flyTo(c, D);
}
// Oblique view centred on the planned modules, from the side they face, with the house around them.
function frameArrays(zoomOut = 1) {
  const ps = state.plan?.panels || [];
  if (!ps.length) return view('oblique');
  const bb = new THREE.Box3(), nAvg = new THREE.Vector3();
  for (const p of ps) { for (const c of p.corners) bb.expandByPoint(V3(c)); nAvg.add(V3(p.normal || [0, 1, 0])); }
  const c = bb.getCenter(new THREE.Vector3()).lerp(state.centre, 0.2);
  const h = new THREE.Vector3(nAvg.x, 0, nAvg.z);
  if (h.lengthSq() < 1e-4) h.copy(northVec()).negate();
  h.normalize();
  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), h).multiplyScalar(0.35);
  const dir = h.clone().add(side).multiplyScalar(0.8).add(new THREE.Vector3(0, 0.85, 0));
  const r = bb.getSize(new THREE.Vector3()).length() / 2;
  flyTo(c, Math.max(20, Math.min(r * 5, fitDistance() * 0.85)) * zoomOut, dir);
}
function stepTween(now) {
  if (!tween) return;
  const t = clamp((now - tween.t0) / tween.dur, 0, 1), e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  camera.position.lerpVectors(tween.p0, tween.p1, e);
  controls.target.lerpVectors(tween.q0, tween.q1, e);
  if (t >= 1) tween = null;
}

// ------------------------------------------------------------------ picking
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let pointerDirty = false, lastPointer = null, downAt = null;
function setRay(ev) {
  const r = canvas.getBoundingClientRect();
  mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
}
function pick() {
  const hits = raycaster.intersectObjects(panelMeshes, false);
  if (hits.length) return { type: 'panel', i: hits[0].object.userData.panel, point: hits[0].point };
  if (groups.rejected.visible) {
    const h = raycaster.intersectObjects(rejectedMeshes, false);
    if (h.length) { const best = h.find((x) => rejClass(state.plan.rejected[x.object.userData.rejected]) !== 'band') || h[0]; return { type: 'rejected', i: best.object.userData.rejected }; }
  }
  if (groups.heat.visible && heatMesh) { const h = raycaster.intersectObject(heatMesh, false); if (h.length) return { type: 'heat', i: Math.floor(h[0].faceIndex / 2) }; }
  return null;
}
function processHover() {
  if (!pointerDirty || !lastPointer || !state.plan) return;
  pointerDirty = false;
  setRay(lastPointer);
  const hit = pick();
  const tip = $('tooltip');
  const hoverId = hit?.type === 'panel' ? state.plan.panels[hit.i].id : null;
  if (hoverId !== state.hover) { state.hover = hoverId; refreshPanelStyles(); }
  canvas.style.cursor = hit?.type === 'panel' ? 'pointer' : '';
  if (!hit) { tip.hidden = true; return; }
  let html = '';
  tip.className = '';
  if (hit.type === 'panel') { const p = state.plan.panels[hit.i]; html = `<b>${escapeHtml(p.id)}</b>${fmt(p.annualKwh)} kWh/yr · ${fmt((p.shadeLoss || 0) * 100, 1)}% shade · ${state.sunlit[hit.i] != null ? `${fmt(state.sunlit[hit.i] * 100)}% sunlit now` : ''}<br><span style="opacity:.7">Click for why it is here</span>`; }
  else if (hit.type === 'rejected') {
    const r = state.plan.rejected[hit.i];
    if (rejClass(r) === 'unneeded') html = `<b>Usable, not needed at this system size</b>${escapeHtml(r.why || '')}`;
    else { tip.className = 'rej'; const c = rejCause(r); html = `<b>Excluded: ${escapeHtml(KIND_LABEL[c] || c)}</b>${escapeHtml(r.why || 'Not suitable for modules')}`; }
  }
  else { const c = heatCells[hit.i]; html = `<b>${fmt(c.poa)} kWh/m²/yr</b>annual sun on this roof cell${state.opts.fluxThreshold && c.poa < state.opts.fluxThreshold ? ' · below your min. sun threshold' : ''}`; }
  tip.innerHTML = html;
  tip.hidden = false;
  const r = viewport.getBoundingClientRect();
  const x = lastPointer.clientX - r.left, y = lastPointer.clientY - r.top;
  tip.style.left = `${clamp(x + 14, 4, r.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${clamp(y + 16, 4, r.height - tip.offsetHeight - 4)}px`;
}
canvas.addEventListener('pointermove', (e) => { lastPointer = { clientX: e.clientX, clientY: e.clientY }; pointerDirty = true; });
canvas.addEventListener('pointerleave', () => { lastPointer = null; $('tooltip').hidden = true; if (state.hover) { state.hover = null; refreshPanelStyles(); } });
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || downAt.b !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || !state.plan) return;
  setRay(e);
  const hit = pick();
  if (hit?.type === 'panel') selectPanel(state.plan.panels[hit.i].id);
  else if (state.selected) closeSelection();
});
canvas.addEventListener('dblclick', (e) => {
  setRay(e);
  let point = null;
  const h = raycaster.intersectObjects(panelMeshes, false);
  if (h.length) point = h[0].point;
  else if (state.occ) {
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    const t = mock.raycastOcc(state.occ, o.x, o.y, o.z, d.x, d.y, d.z, 600);
    if (t > 0) point = o.clone().addScaledVector(d, t);
  }
  if (!point) { const t = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -state.groundY), new THREE.Vector3()); point = t; }
  if (point) flyTo(point, Math.max(3, camera.position.distanceTo(controls.target) * 0.6));
});
canvas.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSelection();
  const k = { t: 'top', f: 'front', o: 'oblique', h: 'fit' }[e.key.toLowerCase()];
  if (k) view(k);
});

// ------------------------------------------------------------------ UI wiring
function showStatus(text, error = false) {
  const s = $('status');
  s.hidden = !text; s.textContent = text || ''; s.classList.toggle('error', !!error);
}
function setTab(name) {
  if (name === 'cad' && !$('lyrDims').checked) { $('lyrDims').checked = true; buildDims(); }
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
function renderPanelSpec() {
  const p = currentPanel();
  $('panelSpec').textContent = `${fmt(p.wattPeak)} Wp · ${fmt(p.lengthMm)} × ${fmt(p.widthMm)} × ${fmt(p.thicknessMm)} mm · ${fmt(p.weightKg, 1)} kg${p.efficiency ? ` · ${fmt(p.efficiency * 100, 1)}% eff.` : ''}${p.cells ? ` · ${p.cells} cells` : ''}`;
  const m = state.api.catalogue?.MOUNTING?.[state.opts.mounting];
  const pitched = state.twin.roofs.some((r) => (r.tilt ?? 0) >= 5);
  $('mountingInfo').textContent = m?.description || m?.note || (state.opts.mounting === 'flush'
    ? `Aluminium rails on roof hooks, ~${fmt(mountStandoff() * 1000)} mm standoff for airflow; modules parallel to the roof, so no added wind sail area. About 2.5 kg of rails and clamps per module.`
    : `Tilted frames for flat roofs (under 5°): rows spaced to avoid shading each other, ballast or anchors sized for wind uplift.${pitched ? ' This house has pitched roofs, which stay flush-mounted.' : ''}`);
  $('tiltRow').hidden = state.opts.mounting !== 'tilted';
}
function bindRange(id, outId, fmtFn, onChange) {
  const el = $(id);
  const upd = () => { $(outId).textContent = fmtFn(Number(el.value)); };
  el.addEventListener('input', () => { upd(); onChange(Number(el.value)); });
  upd();
}
function wireUi() {
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => view(b.dataset.view)));
  $('panelModel').innerHTML = state.api.panels.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} · ${fmt(p.wattPeak)} W · ${fmt(p.lengthMm)}×${fmt(p.widthMm)} mm</option>`).join('');
  const defId = state.api.catalogue?.DEFAULT_PANEL_ID;
  state.opts.panelId = state.api.panels.some((p) => p.id === defId) ? defId : state.api.panels[0].id;
  $('panelModel').value = state.opts.panelId;
  const defSetback = state.api.catalogue?.MOUNTING?.flush?.edgeSetbackM;
  if (Number.isFinite(defSetback)) { state.opts.setback = defSetback; $('setback').value = String(defSetback); }
  $('panelModel').onchange = (e) => { state.opts.panelId = e.target.value; renderPanelSpec(); schedulePlan(); };
  $('mounting').onchange = (e) => { state.opts.mounting = e.target.value; renderPanelSpec(); schedulePlan(); };
  $('orientation').onchange = (e) => { state.opts.orientation = e.target.value; schedulePlan(); };
  bindRange('tilt', 'tiltOut', (v) => `${v}°`, (v) => { state.opts.tiltDeg = v; schedulePlan(); });
  bindRange('setback', 'setbackOut', (v) => `${v.toFixed(2)} m`, (v) => { state.opts.setback = v; schedulePlan(); });
  bindRange('kwp', 'kwpOut', (v) => `${v.toFixed(1)} kWp`, (v) => { state.opts.targetKwp = v; schedulePlan(); });
  bindRange('flux', 'fluxOut', (v) => (v > 0 ? `${v}` : 'off'), (v) => { state.opts.fluxThreshold = v; if (v > 0 && !$('lyrHeat').checked) { $('lyrHeat').checked = true; toggleHeat(); } schedulePlan(); });
  document.querySelectorAll('[data-size]').forEach((b) => (b.onclick = () => {
    state.opts.sizeMode = b.dataset.size;
    document.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('kwpRow').hidden = state.opts.sizeMode !== 'kwp';
    $('sizeNote').textContent = { atap: 'ATAP: sized for a 5 kWac single-phase inverter (the Solar ATAP limit, an AC rating) at DC/AC 1.2, about 6 kWp of panels, wired as equal strings under 600 V.', max: 'Max: every valid spot on the roof is used (may exceed what a single-phase home can export).', kwp: 'Target: best-yield modules first until the target is met.' }[state.opts.sizeMode];
    schedulePlan();
  }));
  const toggleHeat = () => { setVisible(groups.heat, $('lyrHeat').checked); $('legend').hidden = !$('lyrHeat').checked; };
  $('lyrHeat').onchange = toggleHeat;
  $('lyrRejected').onchange = () => setVisible(groups.rejected, $('lyrRejected').checked);
  $('lyrDims').onchange = () => { buildDims(); };
  $('lyrScanShadow').onchange = () => requestScanShadow();
  $('lyrSunPath').onchange = () => { setVisible(groups.sun, $('lyrSunPath').checked); if (sunSprite) sunSprite.visible = state.sun.elevation > -2; };
  bindRange('pointSize', 'pointSizeOut', (v) => `${v.toFixed(1)}×`, (v) => { if (pointsMat) pointsMat.uniforms.uSize.value = pointsMat.uniforms.uBase.value * v; });
  // sun
  $('date').value = state.date;
  $('date').onchange = (e) => { if (!e.target.value) return; state.date = e.target.value; buildSunPath(); updateSun(); scheduleDayTotal(); };
  $('time').value = String(state.minutes);
  $('time').oninput = (e) => { state.minutes = Number(e.target.value); updateSun(); };
  document.querySelectorAll('[data-sky]').forEach((b) => (b.onclick = () => {
    state.sky = b.dataset.sky;
    document.querySelectorAll('[data-sky]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    updatePanelSun(); scheduleDayTotal();
  }));
  if (!state.api.real.instant) {
    state.sky = 'clear';
    document.querySelectorAll('[data-sky]').forEach((x) => { x.setAttribute('aria-pressed', String(x.dataset.sky === 'clear')); if (x.dataset.sky === 'typical') { x.disabled = true; x.title = 'Needs the planner (src/twin/placement.js)'; } });
  }
  $('play').onclick = () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play the day'); };
  // site
  const siteChanged = () => {
    const lat = Number($('lat').value), lon = Number($('lon').value);
    if (Number.isFinite(lat) && Math.abs(lat) <= 66) state.lat = lat;
    if (Number.isFinite(lon) && Math.abs(lon) <= 180) state.lon = lon;
    updateNorth(); buildSunPath(); updateSun(); renderNorthNote(); schedulePlan(400, { heat: true });
  };
  $('lat').value = state.lat; $('lon').value = state.lon;
  $('lat').onchange = siteChanged; $('lon').onchange = siteChanged;
  bindRange('north', 'northOut', (v) => `${v > 0 ? '+' : ''}${v}°`, (v) => { state.north = v; updateNorth(); buildSunPath(); updateSun(); renderNorthNote(); schedulePlan(500, { heat: true }); });
  $('resetSite').onclick = () => {
    const loc = state.twin.location || {};
    $('lat').value = state.lat = loc.lat ?? 3.11; $('lon').value = state.lon = loc.lon ?? 101.58;
    $('north').value = state.north = 0; $('northOut').textContent = '0°';
    siteChanged();
  };
  $('panelPick').onchange = (e) => { if (e.target.value) selectPanel(e.target.value, { focus: true, openTab: false }); };
  $('arrayPick').onchange = (e) => { state.selectedArray = e.target.value; buildDims(); renderCad(); };
  $('popupClose').onclick = closeSelection;
  $('exportCsv').onclick = exportCsv;
  $('exportDxf').onclick = exportDxf;
  $('exportPng').onclick = snapshot;
  $('snapshot').onclick = snapshot;
  renderPanelSpec();
  renderNorthNote();
}
function renderNorthNote() {
  const nb = wrap360((state.twin.northBearing || 0) + state.north);
  $('northNote').textContent = `Scan heading: ${fmt(nb, 0)}° (preparation ${fmt(state.twin.northBearing || 0, 0)}°, offset ${state.north > 0 ? '+' : ''}${state.north}°). Positive offsets turn true north clockwise; the red ground arrow and compass follow.`;
}
function renderScanTable() {
  const t = state.twin, b = t.bounds;
  const size = b ? b.max.map((v, i) => v - b.min[i]) : null;
  const rows = [
    ['Twin', escapeHtml(t.title || t.id)],
    ['Source', escapeHtml(t.source || '–')],
    ['Points shown', fmt(state.data.points.length / 3)],
    ['Size E × H × S', size ? `${size.map((v) => fmt(v, 1)).join(' × ')} m` : '–'],
    ['Roof planes (main building)', primaryRoofs().map((r) => `${escapeHtml(r.id)} ${fmt(r.tilt, 0)}°/${fmt(r.azimuth, 0)}° ${fmt(r.area, 0)} m²`).join('<br>')],
    ['Occupancy grid', state.occ ? `${state.occ.dims.join(' × ')} @ ${fmt(state.occ.voxel * 100)} cm` : 'missing (no shading)'],
    ['Normals', state.data.normals ? 'from scan' : 'estimated from voxels']
  ];
  $('scanTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

// ------------------------------------------------------------------ loop
let lastT = performance.now(), compassT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (state.playing && state.date) {
    state.minutes += dt * 90;
    if (state.minutes > 1170) state.minutes = 390;
    const m = Math.round(state.minutes);
    if (Number($('time').value) !== m) { $('time').value = String(m); state.minutes = m + (state.minutes - m); const keep = state.minutes; state.minutes = m; updateSun(); state.minutes = keep; }
  }
  stepTween(now);
  controls.update();
  processHover();
  stepScanShadow();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  placePopup();
  layoutDimLabels();
  if (now - compassT > 60) { compassT = now; updateCompassWidget(); }
}

// ------------------------------------------------------------------ boot
async function boot() {
  showStatus('Loading digital twin…');
  const [api, data] = await Promise.all([loadApi(), loadTwin()]);
  state.api = api; state.data = data; state.twin = data.twin; state.occ = data.occupancy || null;
  const t = state.twin;
  const loc = t.location || {};
  state.lat = loc.lat ?? 3.11; state.lon = loc.lon ?? 101.58; state.tz = loc.timezone ?? 8;
  state.groundY = t.ground?.y ?? 0;
  // bounds + centre (prefer roofs for the focus point)
  const bb = new THREE.Box3();
  if (t.bounds?.min && t.bounds?.max) bb.set(V3(t.bounds.min), V3(t.bounds.max));
  else { const p = data.points; for (let i = 0; i < p.length; i += 3) bb.expandByPoint(_a.set(p[i], p[i + 1], p[i + 2])); t.bounds = { min: bb.min.toArray(), max: bb.max.toArray() }; }
  const roofBox = new THREE.Box3();
  for (const r of primaryRoofs()) for (const q of r.outline) roofBox.expandByPoint(V3(q));
  const focus = roofBox.isEmpty() ? bb : roofBox;
  focus.getCenter(state.centre);
  state.centre.y = (state.groundY + focus.max.y) / 2;
  const size = focus.getSize(new THREE.Vector3());
  state.radius = Math.max(6, size.length() * 0.5);
  const now = new Date();
  state.date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  $('twinTitle').textContent = t.title || 'Digital twin';
  $('twinSub').textContent = `${loc.name || 'Location assumed'} · ${fmt(data.points.length / 3)} points · simulated rooftop solar`;
  const realAlgo = api.real.placement;
  const badge = $('sourceBadge');
  badge.textContent = data.real ? (realAlgo ? 'Drone scan · live planner' : 'Drone scan · fallback planner') : (realAlgo ? 'Demo house · live planner' : 'Demo house · fallback data');
  badge.className = `badge ${data.real && realAlgo ? 'real' : 'mock'}`;
  badge.title = data.real ? 'Prepared drone scan from public/twins' : `Synthetic house: ${data.why || ''}`;

  buildPoints();
  buildGrid();
  buildRoofOutlines();
  wireUi();
  renderScanTable();
  buildSunPath();
  state.minutes = 600; $('time').value = '600';
  updateSun();
  camera.position.copy(state.centre).add(new THREE.Vector3(1, 0.9, 1.2).normalize().multiplyScalar(fitDistance()));
  controls.target.copy(state.centre);
  view('oblique');
  requestAnimationFrame(frame);
  await runPlan();
  frameArrays();
  $('scanMode').querySelectorAll('button').forEach((b) => { b.onclick = () => setScanMode(b.dataset.mode); });
  showStatus('Loading full-colour scan…');
  loadSplat().then((ok) => {
    $('scanMode').hidden = !ok;
    if (ok) {
      setScanMode('photo');
      $('sourceBadge').textContent = $('sourceBadge').textContent.replace('Drone scan', 'Gaussian splat');
      $('twinSub').textContent = $('twinSub').textContent.replace(/[\d,]+ points/, `${fmt(splatViewer.viewer.splatMesh.getSplatCount())} colour splats`);
      // Pull back so the whole house and plot are in frame, not just the array.
      frameArrays(2.2);
    }
    showStatus('');
  }).catch((e) => { console.warn('Colour splat unavailable, showing the point cloud:', e); showStatus(''); });
  if (import.meta.env.DEV) window.__twin = { state, scene, camera, controls, selectPanel, view, csvText, dxfText };
}
boot().catch((e) => { console.error(e); showStatus(`Could not start the viewer: ${e.message}`, true); });
