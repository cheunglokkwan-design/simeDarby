// Solar array placement on a scanned roof (digital twin).
// Pure ES module, no DOM; runs in node, the browser and Web Workers.
//
// planArray(twin, occupancy, options) -> Plan       (docs/internal/twin-contract.md)
// roofHeatmap(twin, occupancy, options) -> { roofs:[{roofId, cell, nu, nv, values:Float32Array, cells:[{corners, poa}]}], min, max }
// instantShading(twin, occupancy, plan, date)      -> { panels:[{id, sunlit, watts}], totalW, sun }
//   (also accepts the viewer's form instantShading(plan, occupancy, sun, { twin, date }))
//
// How a plan is made (each step is physical, and every number ends up in a
// panel's or array's `reason`):
//  1. Roof frame: u along the eave, v up-slope, n = roof normal. Edges are typed
//     (eave / ridge / hip-verge / valley-abutment) and get their own setback.
//  2. Flux map: a 0.25 m grid on every roof. For each cell and each sun sample of
//     a typical year (12 representative days × 30 min) a DDA ray through the
//     occupancy grid decides beam shading; a 48-direction cosine-weighted sky
//     view gives the diffuse share. Hay-Davies POA, Martin-Ruiz optics, Faiman
//     temperature, catalogue loss chain.
//  3. Lattice sweep: portrait and landscape, grid phases every 0.1 m in u and v,
//     20 mm module gaps. A slot is valid when the whole module footprint is inside
//     the roof, clear of each edge by its setback and of obstacles by 0.3 m, free
//     of unlisted clutter in the occupancy, and its mean flux is ≥ 80% of that
//     roof's best.
//  4. Rectangles: valid slots form a binary matrix; maximal all-ones rectangles
//     are peeled off (≥ 4 modules, no ragged rows). Layout score = energy −
//     2% per extra array. Each rectangle then slides (2 cm steps) to the centre
//     of its free span, so margins are symmetric unless that costs > 0.5% energy.
//  5. Size: default cap = Solar ATAP single-phase (5 kWac × DC/AC 1.2 ≈ 6 kWp);
//     an exact knapsack picks whole-row/column sub-rectangles of the candidate
//     blocks (max energy, 1.2 module-years per extra array, ≤ 2 roof orientations
//     with ≥ 6 modules each = 2 MPPT strings), trimmed blocks are re-centred.
//  6. Physics of mounting: flush modules lie on rails parallel to the roof, top
//     surface = plane + normal × standoff; flat slabs (< 5°) get tilted racks
//     facing the equator-side axis with row pitch from the 9:00-15:00 winter
//     solstice no-shade rule.

import { PANELS, DEFAULT_PANEL_ID, MOUNTING, LOSSES, CLIMATE_KL, GRID_RULES_MY } from './catalogue.js';
import { typicalYearSamples, sunVectorTwin, compassAzimuthOf, solarGeometry, localDate, dayOfYear, extraterrestrialNormal } from './sun.js';
import { climateSamples, poaComponents, iamBeam, iamDiffuse, faimanCellTemp, systemDerate, thermalParams, haurwitzGhi, erbsDiffuseFraction, ambientAt } from './irradiance.js';
import { makeGrid, castRay, skyView, cosineHemisphere, solidAlongNormal } from './shade.js';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const EPS = 1e-9;

// ----------------------------------------------------------------------------- small vector helpers
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const r3 = (p, k = 3) => p.map((x) => +x.toFixed(k));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fmtInt = (x) => Math.round(x).toLocaleString('en-US');
const fmt1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const hhmm = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compassWord = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8];

// ----------------------------------------------------------------------------- 2D geometry (roof u,v)
function polyArea2(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function pointInPoly(x, y, p) {
  let ins = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-300) + xi) ins = !ins;
  }
  return ins;
}
function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy + 1e-300), 0, 1);
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function distPtRect(px, py, r) {
  const dx = Math.max(r[0] - px, 0, px - r[2]), dy = Math.max(r[1] - py, 0, py - r[3]);
  return Math.hypot(dx, dy);
}
// segment vs axis-aligned rect [u0,v0,u1,v1]: does the segment enter the open rect?
function segHitsRect(ax, ay, bx, by, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy], q = [ax - r[0], r[2] - ax, ay - r[1], r[3] - ay];
  for (let k = 0; k < 4; k++) {
    if (Math.abs(p[k]) < 1e-300) { if (q[k] <= 0) return false; continue; }
    const t = q[k] / p[k];
    if (p[k] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9;
}
function distSegRect(ax, ay, bx, by, r) {
  if (segHitsRect(ax, ay, bx, by, r)) return 0;
  return Math.min(distPtRect(ax, ay, r), distPtRect(bx, by, r),
    distPtSeg(r[0], r[1], ax, ay, bx, by), distPtSeg(r[2], r[1], ax, ay, bx, by),
    distPtSeg(r[2], r[3], ax, ay, bx, by), distPtSeg(r[0], r[3], ax, ay, bx, by));
}
function distPolyRect(poly, r) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; d = Math.min(d, distSegRect(a[0], a[1], b[0], b[1], r)); }
  if (d > 0 && pointInPoly((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, poly)) d = 0;
  return d;
}

// ----------------------------------------------------------------------------- inputs
export function normalizePanel(p) {
  if (!p) p = PANELS.find((x) => x.id === DEFAULT_PANEL_ID) || PANELS[0];
  if (typeof p === 'string') p = PANELS.find((x) => x.id === p) || PANELS[0];
  const cat = PANELS.find((x) => x.id === p.id) || {};
  const q = { ...cat, ...p };
  const watt = q.watt ?? q.wattPeak ?? cat.watt;
  let a = q.widthM ?? (q.widthMm ? q.widthMm / 1000 : undefined) ?? cat.widthM;
  let b = q.lengthM ?? (q.lengthMm ? q.lengthMm / 1000 : undefined) ?? cat.lengthM;
  if (a > b) [a, b] = [b, a];
  return {
    id: q.id, name: q.name || q.label || q.id, maker: q.maker, watt, widthM: a, lengthM: b, depthM: q.depthM ?? (q.thicknessMm ? q.thicknessMm / 1000 : 0.03),
    weightKg: q.weightKg ?? 21, tempCoeff: q.tempCoeff ?? -0.0035, efficiency: watt / (a * b * 1000), cells: q.cells, vocV: q.vocV, vmpV: q.vmpV, iscA: q.iscA,
    vocTempCoeff: q.vocTempCoeff ?? -0.0028,
  };
}

function occupancyFrom(twin, occupancy) {
  if (!occupancy) return null;
  if (occupancy.data || occupancy.__grid) return makeGrid(occupancy);
  if (occupancy instanceof Uint8Array || occupancy instanceof ArrayBuffer) {
    const m = twin.occupancy;
    return makeGrid({ origin: m.origin, voxel: m.voxel, dims: m.dims, data: occupancy instanceof Uint8Array ? occupancy : new Uint8Array(occupancy) });
  }
  return null;
}

function targetRoofs(twin, o) {
  let roofs = twin.roofs || [];
  if (o.roofIds?.length) return roofs.filter((r) => o.roofIds.includes(r.id));
  if (o.allBuildings) return roofs;
  const blds = twin.buildings || [];
  const ids = o.buildingIds?.length ? o.buildingIds : blds.filter((b) => b.primary).map((b) => b.id);
  if (ids.length) roofs = roofs.filter((r) => !r.building || ids.includes(r.building));
  return roofs;
}

// ----------------------------------------------------------------------------- roof frame
export function roofFrame(roof, northBearing = 0, uOverride = null) {
  let n = norm(roof.normal);
  if (n[1] < 0) n = mul(n, -1);
  const tilt = Math.acos(clamp(n[1], -1, 1)) * DEG;
  let u;
  if (uOverride) u = uOverride;
  else if (roof.eaveDir) u = roof.eaveDir;
  else u = tilt > 0.5 ? cross([0, 1, 0], n) : [1, 0, 0];
  u = norm(sub(u, mul(n, dot(u, n))));
  let v = cross(n, u);
  if (!uOverride && tilt > 0.5 && v[1] < 0) { u = mul(u, -1); v = cross(n, u); }
  const o = roof.point || roof.outline[0];
  const toUV = (p) => { const d = sub(p, o); return [dot(d, u), dot(d, v)]; };
  const from = (a, b, h = 0) => [o[0] + u[0] * a + v[0] * b + n[0] * h, o[1] + u[1] * a + v[1] * b + n[1] * h, o[2] + u[2] * a + v[2] * b + n[2] * h];
  let poly = roof.outline.map(toUV);
  let edgesIn = roof.edges ? roof.edges.slice() : null;
  if (polyArea2(poly) < 0) { poly = poly.slice().reverse(); if (edgesIn) edgesIn = edgesIn.slice(0, poly.length).reverse(); }
  // when reversing, edge i (p[i]->p[i+1]) of the reversed ring is edge (n-2-i) of the original; handle via geometric fallback below
  const vmin = Math.min(...poly.map((p) => p[1])), vmax = Math.max(...poly.map((p) => p[1]));
  const umin = Math.min(...poly.map((p) => p[0])), umax = Math.max(...poly.map((p) => p[0]));
  const flat = tilt < (MOUNTING.tilted?.flatRoofMaxDeg ?? 5);
  const edges = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let type = null;
    if (roof.edges && polyArea2(roof.outline.map(toUV)) >= 0) type = roof.edges[i]?.type || null;
    if (!type) {
      const horiz = Math.abs(b[1] - a[1]) < 0.25 * L;
      type = flat ? 'edge' : horiz ? ((a[1] + b[1]) / 2 < (vmin + vmax) / 2 ? 'eave' : 'ridge') : 'verge';
    }
    if (flat) type = type === 'abutment' || type === 'valley' ? type : 'edge';
    if (type === 'hip') type = 'verge';
    return { a, b, L, type };
  });
  const azimuth = tilt > 0.5 ? compassAzimuthOf([n[0], 0, n[2]], northBearing) : 180;
  return { o, u, v, n, tilt, azimuth, flat, poly, edges, umin, umax, vmin, vmax, toUV, from };
}

function edgeSetbacks(o, flat) {
  const F = MOUNTING.flush || {}, T = MOUNTING.tilted || {};
  const user = Number.isFinite(o.setback ?? o.setbackM) ? (o.setback ?? o.setbackM) : 0;
  if (flat && o.mounting !== 'flush') {
    return { edge: Math.max(T.edgeSetbackM ?? 1.0, user), abutment: Math.max(T.edgeSetbackM ?? 1.0, user), valley: Math.max(T.edgeSetbackM ?? 1.0, user), obstacle: T.obstacleClearM ?? 0.5 };
  }
  const ridge = o.fireStrict ? (F.fireStrict?.ridgeClearM ?? 0.9) : (F.ridgeClearM ?? 0.5);
  return {
    eave: Math.max(F.eaveClearM ?? 0.4, user), ridge: Math.max(ridge, user), verge: Math.max(F.edgeSetbackM ?? 0.4, user),
    valley: Math.max(F.valleyClearM ?? 0.3, user), abutment: Math.max(F.valleyClearM ?? 0.3, user), edge: Math.max(F.edgeSetbackM ?? 0.4, user),
    obstacle: F.obstacleClearM ?? 0.3,
  };
}

const EDGE_WHY = {
  eave: 'gutter access and eave wind uplift', ridge: 'ridge capping, ventilation and access', verge: 'verge/hip wind zone and tile access',
  valley: 'valley water channel', abutment: 'abutting wall or higher roof (flashing, water)', edge: 'slab edge wind zone and safe access',
};

// ----------------------------------------------------------------------------- climate / sun (cached)
const sunCache = new Map();
function sunData(lat, lon, tz, northBearing, stepMin) {
  const key = `${lat.toFixed(4)}|${lon.toFixed(4)}|${tz}|${northBearing.toFixed(2)}|${stepMin}`;
  let d = sunCache.get(key);
  if (d) return d;
  const samples = climateSamples(typicalYearSamples(lat, lon, { tz, stepMin }), CLIMATE_KL);
  for (const s of samples) s.sv = sunVectorTwin(s.azimuth, s.elevation, northBearing);
  const ghiYear = samples.reduce((a, s) => a + s.ghi * s.weightH, 0) / 1000;
  d = { key, samples, ghiYear };
  sunCache.set(key, d);
  if (sunCache.size > 16) sunCache.delete(sunCache.keys().next().value);
  return d;
}

// ----------------------------------------------------------------------------- flux map per roof
const fluxCache = new WeakMap(); // grid -> Map(key -> flux)
const HEMI = cosineHemisphere(48);

function moduleOrientation(frame, o) {
  // returns { n (module normal), tilt, azimuthCompass, rackH }
  if (frame.flat && o.mounting !== 'flush') {
    const T = MOUNTING.tilted || {};
    const tilt = clamp(Number.isFinite(o.tiltDeg) ? o.tiltDeg : (T.defaultTiltFlatDeg ?? 10), T.minTiltFlatDeg ?? 5, T.maxTiltFlatDeg ?? 15);
    // face the equator side (south at 3°N; north if the site is south of the equator) along a roof axis
    const lat = o.lat ?? 3.11;
    const want = lat >= 0 ? 180 : 0;
    const cands = [frame.v, mul(frame.v, -1), frame.u, mul(frame.u, -1)].map((d) => ({ d, az: compassAzimuthOf(d, o.northBearing || 0) }));
    cands.sort((a, b) => angDist(a.az, want) - angDist(b.az, want));
    const face = norm([cands[0].d[0], 0, cands[0].d[2]]);
    const n = norm(add(mul([0, 1, 0], Math.cos(tilt * RAD)), mul(face, Math.sin(tilt * RAD))));
    return { n, tilt, azimuth: cands[0].az, face, rackH: 0.3 };
  }
  return { n: frame.n, tilt: frame.tilt, azimuth: frame.azimuth, face: null, rackH: 0 };
}
const angDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function buildFlux(twin, grid, roof, frame, sun, o) {
  const cell = o.cell;
  const mod = moduleOrientation(frame, o);
  const key = `${twin.id || ''}|${roof.id}|${sun.key}|${cell}|${o.rayStride ?? 2}|${o.shadeBlock ?? 1}|${frame.u.map((x) => x.toFixed(4)).join(',')}|${mod.n.map((x) => x.toFixed(4)).join(',')}|${o.albedo}`;
  let byGrid = grid ? fluxCache.get(grid) : null;
  if (grid && !byGrid) { byGrid = new Map(); fluxCache.set(grid, byGrid); }
  if (byGrid?.has(key)) return byGrid.get(key);
  const t0 = nowMs();
  const nu = Math.max(1, Math.ceil((frame.umax - frame.umin) / cell)), nv = Math.max(1, Math.ceil((frame.vmax - frame.vmin) / cell));
  const N = nu * nv;
  const active = new Uint8Array(N), clutter = new Uint8Array(N);
  const sky = new Float32Array(N), gnd = new Float32Array(N);
  const S = sun.samples, nS = S.length;
  const lit = new Uint8Array(N * nS);
  const poa = new Float32Array(N), poa0 = new Float32Array(N);
  // per-sample coefficients (same normal for every cell of this plane)
  const B = new Float64Array(nS), Dk = new Float64Array(nS), Gk = new Float64Array(nS), front = new Uint8Array(nS);
  for (let s = 0; s < nS; s++) {
    const c = S[s];
    const comp = poaComponents(c, mod.n, c.sv, 1, 1, 1, o.albedo);
    B[s] = comp.beam + comp.circ; Dk[s] = comp.sky; Gk[s] = comp.ground;
    front[s] = comp.cosTheta > 0 && c.sv[1] > 0 ? 1 : 0;
  }
  const n = frame.n;
  const ignore = ignorePlane(frame, grid ? grid.voxel : 0.25);
  const svfBlock = new Map();
  const startOff = 0.35 + mod.rackH;
  const stride = Math.max(1, Math.floor(o.rayStride ?? 2));
  const shadeBlock = Math.max(1, Math.floor(o.shadeBlock ?? 1)), litBlock = new Map();
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = frame.umin + (i + 0.5) * cell, b = frame.vmin + (j + 0.5) * cell;
    if (!pointInPoly(a, b, frame.poly)) continue;
    const k = i + nu * j;
    active[k] = 1;
    const p = frame.from(a, b, 0);
    // sky view: one evaluation per 0.5 m block
    const bk = (i >> 1) + 100000 * (j >> 1);
    let sv = svfBlock.get(bk);
    if (!sv) {
      sv = grid ? skyView(grid, p, mod.n, { dirs: HEMI, offset: startOff, ignore }) : { skyFrac: (1 + mod.n[1]) / 2, skyFrac0: (1 + mod.n[1]) / 2, gndFrac: (1 - mod.n[1]) / 2 };
      svfBlock.set(bk, sv);
    }
    sky[k] = sv.skyFrac; gnd[k] = sv.gndFrac;
    if (grid && solidAlongNormal(grid, p, n, 0.45 + mod.rackH, 2.0) >= 2) clutter[k] = 1;
    const ox = p[0] + n[0] * startOff, oy = p[1] + n[1] * startOff, oz = p[2] + n[2] * startOff;
    let e = 0, e0 = 0;
    const sky0 = (1 + mod.n[1]) / 2, gnd0 = 1 - sky0;
    const base = k * nS;
    if (shadeBlock > 1) {
      // coarse shading: cells of one shadeBlock × shadeBlock block share the first active cell's beam mask
      const bkey = Math.floor(i / shadeBlock) + 100000 * Math.floor(j / shadeBlock);
      const src = litBlock.get(bkey);
      if (src !== undefined) {
        lit.copyWithin(base, src * nS, src * nS + nS);
        for (let s = 0; s < nS; s++) {
          const w = S[s].weightH, l = lit[base + s];
          e += w * (B[s] * l + Dk[s] * sky[k] + Gk[s] * gnd[k]);
          e0 += w * (B[s] * front[s] + Dk[s] * sky0 + Gk[s] * gnd0);
        }
        poa[k] = e / 1000; poa0[k] = e0 / 1000;
        continue;
      }
      litBlock.set(bkey, k);
    }
    const cast = (s) => { const d = S[s].sv; return !grid || castRay(grid, ox, oy, oz, d[0], d[1], d[2], 200, ignore) < 0 ? 1 : 0; };
    // shading is coherent in time: cast every `stride`-th sample (default every other one),
    // and the ones between only at lit/shaded transitions
    for (let s = 0; s < nS; s += stride) lit[base + s] = front[s] ? cast(s) : 0;
    for (let s = 1; s < nS; s++) {
      if (s % stride === 0) continue;
      if (!front[s]) { lit[base + s] = 0; continue; }
      const a = s - (s % stride), b = a + stride;
      if (b < nS && front[a] && front[b] && S[a].month === S[s].month && S[b].month === S[s].month && lit[base + a] === lit[base + b]) lit[base + s] = lit[base + a];
      else lit[base + s] = cast(s);
    }
    for (let s = 0; s < nS; s++) {
      const w = S[s].weightH, l = lit[base + s];
      e += w * (B[s] * l + Dk[s] * sky[k] + Gk[s] * gnd[k]);
      e0 += w * (B[s] * front[s] + Dk[s] * sky0 + Gk[s] * gnd0);
    }
    poa[k] = e / 1000; poa0[k] = e0 / 1000;
  }
  let best = 0, best0 = 0;
  for (let k = 0; k < N; k++) if (active[k] && !clutter[k]) { best = Math.max(best, poa[k]); best0 = Math.max(best0, poa0[k]); }
  const flux = { roofId: roof.id, frame, mod, cell, nu, nv, active, clutter, sky, gnd, lit, poa, poa0, B, Dk, Gk, front, nS, best, best0, ms: nowMs() - t0 };
  if (byGrid) {
    byGrid.set(key, flux);
    if (byGrid.size > 64) byGrid.delete(byGrid.keys().next().value);
  }
  return flux;
}

// Voxels of the roof's own surface (splat noise and voxel quantisation put
// their centres up to ~0.35 m + half a voxel diagonal-projection above the fitted
// plane) are skipped so a roof never shades itself.
function ignorePlane(frame, voxel = 0.25) {
  const xs = frame.poly.map(([a, b]) => frame.from(a, b, 0));
  const min = [0, 1, 2].map((k) => Math.min(...xs.map((p) => p[k])) - 0.6);
  const max = [0, 1, 2].map((k) => Math.max(...xs.map((p) => p[k])) + 0.6);
  const quant = (voxel / 2) * (Math.abs(frame.n[0]) + Math.abs(frame.n[1]) + Math.abs(frame.n[2]));
  return { n: frame.n, d: dot(frame.n, frame.o), tol: 0.35 + quant, tolBelow: 1.5, min, max };
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// mean of a per-cell array over cells whose centres fall in rect [u0,v0,u1,v1]
function cellsIn(flux, r) {
  const { frame, cell, nu, nv } = flux;
  const i0 = Math.max(0, Math.ceil((r[0] - frame.umin) / cell - 0.5)), i1 = Math.min(nu - 1, Math.floor((r[2] - frame.umin) / cell - 0.5));
  const j0 = Math.max(0, Math.ceil((r[1] - frame.vmin) / cell - 0.5)), j1 = Math.min(nv - 1, Math.floor((r[3] - frame.vmin) / cell - 0.5));
  const out = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push(i + nu * j);
  return out;
}
function cellAt(flux, a, b) {
  const i = clamp(Math.floor((a - flux.frame.umin) / flux.cell), 0, flux.nu - 1), j = clamp(Math.floor((b - flux.frame.vmin) / flux.cell), 0, flux.nv - 1);
  return i + flux.nu * j;
}

// ----------------------------------------------------------------------------- slot test
function makeSlotTester(flux, frame, sb, obstaclesUV, thr) {
  const edges = frame.edges;
  return function test(r) {
    // footprint inside the roof polygon
    if (!pointInPoly(r[0], r[1], frame.poly) || !pointInPoly(r[2], r[1], frame.poly) || !pointInPoly(r[2], r[3], frame.poly) || !pointInPoly(r[0], r[3], frame.poly)) return { ok: false, why: 'outside' };
    let minClear = Infinity, which = null;
    for (const e of edges) {
      const d = distSegRect(e.a[0], e.a[1], e.b[0], e.b[1], r);
      const need = sb[e.type] ?? sb.verge ?? 0.4;
      if (d < need - 1e-9) return { ok: false, why: 'setback', type: e.type };
      if (d - need < minClear) { minClear = d - need; which = e.type; }
    }
    for (const ob of obstaclesUV) {
      if (r[2] < ob.box[0] - sb.obstacle || r[0] > ob.box[2] + sb.obstacle || r[3] < ob.box[1] - sb.obstacle || r[1] > ob.box[3] + sb.obstacle) continue;
      if (distPolyRect(ob.poly, r) < sb.obstacle - 1e-9) return { ok: false, why: 'obstacle', kind: ob.kind };
    }
    const cells = cellsIn(flux, r);
    let s = 0, s0 = 0, c = 0, cl = 0;
    for (const k of cells) { if (!flux.active[k]) continue; c++; s += flux.poa[k]; s0 += flux.poa0[k]; if (flux.clutter[k]) cl++; }
    if (!c) return { ok: false, why: 'outside' };
    if (cl / c > 0.1) return { ok: false, why: 'clutter' };
    const mean = s / c;
    if (mean < thr) return { ok: false, why: 'flux', mean };
    return { ok: true, mean, mean0: s0 / c, minClear, which };
  };
}

// largest all-ones rectangle in a boolean matrix (rows × cols), maximising count then flux
// 2D prefix sums of a rows × cols matrix: P[(r)*(cols+1)+c] = sum of M[<r][<c]
function prefix2(rows, cols, at) {
  const W = cols + 1, P = new Float64Array((rows + 1) * W);
  for (let r = 0; r < rows; r++) { let acc = 0; for (let c = 0; c < cols; c++) { acc += at(r, c); P[(r + 1) * W + c + 1] = P[r * W + c + 1] + acc; } }
  return (r0, r1, c0, c1) => P[(r1 + 1) * W + c1 + 1] - P[r0 * W + c1 + 1] - P[(r1 + 1) * W + c0] + P[r0 * W + c0]; // inclusive
}
const LARGE_MATRIX = 400; // above this many slots, sums use prefix tables (large map-twin roofs)

function bestRectangle(M, F, rows, cols, minBlock) {
  let best = null;
  const sumF = rows * cols > LARGE_MATRIX ? prefix2(rows, cols, (r, c) => F[r][c]) : null;
  const h = new Array(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) h[c] = M[r][c] ? h[c] + 1 : 0;
    // brute-force over column spans using min height (cols are small: < 40)
    for (let c0 = 0; c0 < cols; c0++) {
      let mh = Infinity;
      for (let c1 = c0; c1 < cols; c1++) {
        mh = Math.min(mh, h[c1]);
        if (!mh) break;
        for (let hh = mh; hh >= 1; hh--) {
          const nc = c1 - c0 + 1, n = nc * hh;
          if (n < minBlock) break;
          if (hh > 1 && nc < 2) continue; // no single-column stacks
          let f = 0;
          if (sumF) f = sumF(r - hh + 1, r, c0, c1);
          else for (let rr = r - hh + 1; rr <= r; rr++) for (let cc = c0; cc <= c1; cc++) f += F[rr][cc];
          const score = n * 1e6 + f;
          if (!best || score > best.score) best = { r0: r - hh + 1, r1: r, c0, c1, n, f, score };
          break; // tallest rectangle for this span is the one with most cells; shorter ones have fewer
        }
      }
    }
  }
  return best;
}

// ----------------------------------------------------------------------------- per-panel energy
// Half-cut module with 3 bypass diodes: 3 substrings across the width × 2
// parallel halves along the length. Each of the 6 units delivers in proportion
// to its least-lit sample point (series cells); units add up (bypass diodes).
const SUB_U = 3, SUB_V = 6; // sample points across width / along length

function panelSamples(flux, rect, orientation) {
  // returns array of 6 units, each an array of cell indices (2 sample points across × 3 along per unit)
  const pts = [];
  const wu = rect[2] - rect[0], wv = rect[3] - rect[1];
  const along = orientation === 'portrait' ? 'v' : 'u'; // module length direction
  const units = [];
  for (let s = 0; s < 3; s++) for (let half = 0; half < 2; half++) units.push([]);
  for (let a = 0; a < SUB_U; a++) for (let b = 0; b < SUB_V; b++) {
    // a across the width (substring index), b along the length (half = b < 3 ? 0 : 1)
    const fa = (a + 0.5) / SUB_U, fb = (b + 0.5) / SUB_V;
    const uu = along === 'v' ? rect[0] + fa * wu : rect[0] + fb * wu;
    const vv = along === 'v' ? rect[1] + fb * wv : rect[1] + fa * wv;
    const k = cellAt(flux, uu, vv);
    pts.push(k);
    units[a * 2 + (b < SUB_V / 2 ? 0 : 1)].push(k);
  }
  return { pts, units };
}

function panelEnergy(flux, rect, orientation, sun, panel, o) {
  const { units, pts } = panelSamples(flux, rect, orientation);
  const S = sun.samples, nS = flux.nS;
  const cells = cellsIn(flux, rect).filter((k) => flux.active[k]);
  let skyF = 0, gndF = 0;
  for (const k of cells) { skyF += flux.sky[k]; gndF += flux.gnd[k]; }
  skyF /= cells.length || 1; gndF /= cells.length || 1;
  const sky0 = (1 + flux.mod.n[1]) / 2, gnd0 = 1 - sky0;
  const iamD = iamDiffuse(flux.mod.tilt);
  const th = thermalParams(flux.frame.flat && o.mounting !== 'flush' ? 'tilted' : 'flush', o.losses);
  const derate = systemDerate(o.losses);
  const area = panel.widthM * panel.lengthM;
  let eDC = 0, eDCnoT = 0, poaY = 0, poaY0 = 0, sunH = 0, tcW = 0, wW = 0;
  const monthly = new Array(12).fill(0);
  const dayFirst = new Array(12).fill(null), dayLast = new Array(12).fill(null);
  const shadedW = []; // {s, w}
  for (let s = 0; s < nS; s++) {
    const c = S[s];
    const w = c.weightH;
    let f = 0;
    if (flux.front[s]) {
      let sum = 0;
      for (const u of units) { let m = 1; for (const k of u) m = Math.min(m, flux.lit[k * nS + s]); sum += m; }
      f = sum / units.length;
    }
    let fAvg = 0;
    if (flux.front[s]) { for (const k of pts) fAvg += flux.lit[k * nS + s]; fAvg /= pts.length; }
    const cosT = dot(flux.mod.n, c.sv);
    const beamOnly = c.dni * Math.max(0, cosT), circ = flux.B[s] - beamOnly;
    const g = flux.B[s] * fAvg + flux.Dk[s] * skyF + flux.Gk[s] * gndF; // received POA (geometric shading)
    const g0 = flux.B[s] * flux.front[s] + flux.Dk[s] * sky0 + flux.Gk[s] * gnd0;
    const iamb = iamBeam(cosT);
    const geff = (beamOnly + circ) * iamb * f + flux.Dk[s] * skyF * iamD.sky + flux.Gk[s] * gndF * iamD.ground; // electrical shading
    const tc = faimanCellTemp(g, c.tAmb, c.wind, th.U0, th.U1);
    const pdc = panel.watt * (geff / 1000) * (1 + panel.tempCoeff * (tc - 25));
    eDC += w * Math.max(0, pdc);
    eDCnoT += w * panel.watt * (geff / 1000);
    poaY += w * g; poaY0 += w * g0;
    monthly[c.month] += w * Math.max(0, pdc) * derate / 1000;
    tcW += tc * g * w; wW += g * w;
    if (flux.front[s] && fAvg >= 0.5 && c.elevation > 0) {
      sunH += w;
      const d = c.month;
      if (dayFirst[d] === null || c.hour < dayFirst[d]) dayFirst[d] = c.hour - c.stepH / 2;
      if (dayLast[d] === null || c.hour > dayLast[d]) dayLast[d] = c.hour + c.stepH / 2;
    }
    if (flux.front[s] && fAvg < 0.5 && c.elevation > 3) shadedW.push({ s, w: w * flux.B[s] });
  }
  const annualKwh = eDC * derate / 1000;
  const poa = poaY / 1000, poa0 = poaY0 / 1000;
  const firsts = dayFirst.filter((x) => x !== null), lasts = dayLast.filter((x) => x !== null);
  return {
    annualKwh, poaKwhM2: poa, poaUnshadedKwhM2: poa0, shadeLoss: poa0 > 0 ? clamp(1 - poa / poa0, 0, 1) : 0,
    sunHoursYear: sunH, skyFrac: skyF, skyFrac0: sky0, gndFrac: gndF,
    thermalLoss: eDCnoT > 0 ? 1 - eDC / eDCnoT : 0, cellTempC: wW > 0 ? tcW / wW : 25,
    monthlyKwh: monthly, sunFrom: firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : null,
    sunTo: lasts.length ? lasts.reduce((a, b) => a + b, 0) / lasts.length : null,
    shaded: shadedW, beamShadeLoss: 0, pr: poa > 0 ? annualKwh / (poa * area * panel.efficiency) : 0,
  };
}

// ----------------------------------------------------------------------------- lattice sweep on one roof
function sweepRoof(flux, frame, sb, obstaclesUV, panel, o, thr) {
  const test = makeSlotTester(flux, frame, sb, obstaclesUV, thr);
  const gap = o.mode === 'tilted' ? (MOUNTING.tilted?.gapM ?? 0.02) : (MOUNTING.flush?.gapM ?? 0.02);
  const rowGapFlush = MOUNTING.flush?.rowGapM ?? 0.02;
  const orients = o.orientation === 'portrait' || o.orientation === 'landscape' ? [o.orientation] : ['portrait', 'landscape'];
  let best = null;
  const step = o.phaseStep ?? 0.1;
  for (const orientation of orients) {
    // footprint in roof u,v. For tilted racks the v-extent is the horizontal projection.
    let Wu, Wv;
    if (orientation === 'portrait') { Wu = panel.widthM; Wv = panel.lengthM; } else { Wu = panel.lengthM; Wv = panel.widthM; }
    let pitchV;
    if (o.mode === 'tilted') {
      const L = Wv, beta = o.tilt * RAD;
      Wv = L * Math.cos(beta);
      pitchV = Math.max(Wv + gap, o.rowPitchFor(L), L / (MOUNTING.tilted?.maxGcr ?? 0.8)); // no inter-row shade in the window, GCR ≤ max
    } else pitchV = Wv + rowGapFlush;
    const pitchU = Wu + gap;
    const ncol = Math.floor((frame.umax - frame.umin + gap) / pitchU), nrow = Math.floor((frame.vmax - frame.vmin - Wv) / pitchV) + 1;
    if (ncol < 1 || nrow < 1) continue;
    for (let pu = 0; pu < pitchU - 1e-9; pu += step) for (let pv = 0; pv < pitchV - 1e-9; pv += step) {
      const u0 = frame.umin + pu, v0 = frame.vmin + pv;
      const M = [], F = [], R = [];
      let any = 0;
      for (let r = 0; r < nrow; r++) {
        M.push([]); F.push([]); R.push([]);
        for (let c = 0; c < ncol; c++) {
          const rect = [u0 + c * pitchU, v0 + r * pitchV, u0 + c * pitchU + Wu, v0 + r * pitchV + Wv];
          let res = null;
          if (rect[2] <= frame.umax + 1e-9 && rect[3] <= frame.vmax + 1e-9) res = test(rect);
          const ok = !!res?.ok;
          M[r].push(ok); F[r].push(ok ? res.mean : 0); R[r].push(rect);
          any += ok;
        }
      }
      if (any < o.minBlock) continue;
      // peel rectangles
      const used = M.map((row) => row.slice());
      const rects = [];
      let energy = 0;
      for (let it = 0; it < 6; it++) {
        const b = bestRectangle(used, F, nrow, ncol, o.minBlock);
        if (!b) break;
        rects.push(b);
        energy += b.f;
        // a 1-slot halo: arrays on one face never touch (no ragged-looking unions)
        for (let r = Math.max(0, b.r0 - 1); r <= Math.min(nrow - 1, b.r1 + 1); r++) for (let c = Math.max(0, b.c0 - 1); c <= Math.min(ncol - 1, b.c1 + 1); c++) used[r][c] = false;
      }
      if (!rects.length) continue;
      const score = energy * (1 - 0.02 * (rects.length - 1));
      if (!best || score > best.score + 1e-6) best = { score, energy, orientation, Wu, Wv, pitchU, pitchV, gap, u0, v0, rects, M, F, R, nrow, ncol };
    }
  }
  return best ? { ...best, test } : null;
}

// slide a rectangle (in u then v) to the centre of its free span
function centreRect(blk, test, others, sbMinGap, opt = {}) {
  const { pitchU, pitchV, Wu, Wv } = blk;
  const ring = !!opt.centrePerimeterOnly && blk.rows > 2 && blk.cols > 2;
  const rectsAt = (du, dv) => {
    const out = [];
    for (let r = 0; r < blk.rows; r++) for (let c = 0; c < blk.cols; c++) {
      if (ring && r > 0 && r < blk.rows - 1 && c > 0 && c < blk.cols - 1) continue; // interior slots stay inside the ring
      const u = blk.u0 + c * pitchU + du, v = blk.v0 + r * pitchV + dv;
      out.push([u, v, u + Wu, v + Wv]);
    }
    return out;
  };
  const okAt = (du, dv) => {
    let f = 0;
    for (const rc of rectsAt(du, dv)) {
      const t = test(rc);
      if (!t.ok) return null;
      f += t.mean;
    }
    const box = [blk.u0 + du, blk.v0 + dv, blk.u0 + du + blk.widthM, blk.v0 + dv + blk.lengthM];
    for (const ob of others) if (!(box[2] + sbMinGap <= ob[0] || box[0] >= ob[2] + sbMinGap || box[3] + sbMinGap <= ob[1] || box[1] >= ob[3] + sbMinGap)) return null;
    return f;
  };
  const f0 = okAt(0, 0);
  if (f0 === null) return { du: 0, dv: 0, f: 0, note: null };
  const st = opt.centreStep ?? 0.02;
  const span = (axis) => {
    let lo = 0, hi = 0;
    const lim = axis === 'u' ? pitchU * 1.5 : pitchV * 1.5;
    while (lo - st >= -lim && okAt(axis === 'u' ? lo - st : 0, axis === 'v' ? lo - st : 0) !== null) lo -= st;
    while (hi + st <= lim && okAt(axis === 'u' ? hi + st : 0, axis === 'v' ? hi + st : 0) !== null) hi += st;
    return [lo, hi];
  };
  const [ul, uh] = span('u');
  let du = Math.round(((ul + uh) / 2) / 0.01) * 0.01;
  // keep energy within 0.5% of the best shift along u
  let fBest = -Infinity, duBest = 0;
  for (let d = ul; d <= uh + 1e-9; d += st) { const f = okAt(d, 0); if (f !== null && f > fBest) { fBest = f; duBest = d; } }
  let fc = okAt(du, 0);
  if (fc === null || fc < fBest * 0.995) { du = duBest; fc = fBest; }
  const vSpan = (() => {
    let lo = 0, hi = 0;
    const lim = pitchV * 1.5;
    while (lo - st >= -lim && okAt(du, lo - st) !== null) lo -= st;
    while (hi + st <= lim && okAt(du, hi + st) !== null) hi += st;
    return [lo, hi];
  })();
  let dv = Math.round(((vSpan[0] + vSpan[1]) / 2) / 0.01) * 0.01;
  let fBv = -Infinity, dvBest = 0;
  for (let d = vSpan[0]; d <= vSpan[1] + 1e-9; d += st) { const f = okAt(du, d); if (f !== null && f > fBv) { fBv = f; dvBest = d; } }
  let fcv = okAt(du, dv);
  if (fcv === null || fcv < fBv * 0.995) { dv = dvBest; fcv = fBv; }
  return { du, dv, f: fcv, uSpan: [ul, uh], vSpan, centredU: Math.abs(du - (ul + uh) / 2) < 0.015, centredV: Math.abs(dv - (vSpan[0] + vSpan[1]) / 2) < 0.015 };
}

// ----------------------------------------------------------------------------- rejected-region outlines
function traceCells(mask, nu, nv) {
  // outer boundaries of 4-connected components as loops of grid-corner coords (i,j)
  const lab = new Int32Array(nu * nv).fill(-1);
  const comps = [];
  for (let k = 0; k < nu * nv; k++) {
    if (!mask[k] || lab[k] >= 0) continue;
    const id = comps.length, st = [k], cells = [];
    lab[k] = id;
    while (st.length) {
      const q = st.pop(); cells.push(q);
      const i = q % nu, j = (q / nu) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nu || b >= nv) continue;
        const r = a + nu * b;
        if (mask[r] && lab[r] < 0) { lab[r] = id; st.push(r); }
      }
    }
    comps.push(cells);
  }
  const loops = [];
  for (let id = 0; id < comps.length; id++) {
    const cells = comps[id];
    const inC = (i, j) => i >= 0 && j >= 0 && i < nu && j < nv && lab[i + nu * j] === id;
    const next = new Map(); // directed boundary edges, CCW around the component
    const addE = (a, b) => next.set(`${a[0]},${a[1]}`, b);
    for (const q of cells) {
      const i = q % nu, j = (q / nu) | 0;
      if (!inC(i, j - 1)) addE([i, j], [i + 1, j]);
      if (!inC(i + 1, j)) addE([i + 1, j], [i + 1, j + 1]);
      if (!inC(i, j + 1)) addE([i + 1, j + 1], [i, j + 1]);
      if (!inC(i - 1, j)) addE([i, j + 1], [i, j]);
    }
    // walk the longest loop
    let bestLoop = null;
    const seen = new Set();
    for (const startKey of next.keys()) {
      if (seen.has(startKey)) continue;
      const loop = [];
      let key = startKey;
      let guard = 0;
      while (!seen.has(key) && guard++ < 100000) {
        seen.add(key);
        const [x, y] = key.split(',').map(Number);
        loop.push([x, y]);
        const nb = next.get(key);
        if (!nb) break;
        key = `${nb[0]},${nb[1]}`;
      }
      if (!bestLoop || loop.length > bestLoop.length) bestLoop = loop;
    }
    // drop collinear vertices
    const L = bestLoop || [];
    const simp = L.filter((p, k) => {
      const a = L[(k - 1 + L.length) % L.length], b = L[(k + 1) % L.length];
      return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
    });
    loops.push({ loop: simp, count: cells.length, cells });
  }
  return loops;
}

// ----------------------------------------------------------------------------- reasons
// Name what a shadow ray hit: a listed occluder (tree), another building's roof, or this roof.
function nameHit(twin, roofId, q) {
  let best = null;
  for (const oc of twin?.occluders || []) {
    const d = Math.hypot(q[0] - oc.centre[0], q[2] - oc.centre[2]);
    if (d <= oc.radius + 1.5 && q[1] <= oc.top + 1.0 && (!best || d - oc.radius < best.d)) best = { d: d - oc.radius, label: oc.kind.startsWith('tree') ? `the tree ${oc.id}` : `a ${oc.kind.split(' (')[0]} (${oc.id})` };
  }
  if (best) return best.label;
  const own = twin?.roofs?.find((r) => r.id === roofId)?.building;
  for (const r of twin?.roofs || []) {
    if (r.id === roofId) continue;
    const xs = r.outline.map((p) => p[0]), zs = r.outline.map((p) => p[2]);
    if (q[0] < Math.min(...xs) - 0.5 || q[0] > Math.max(...xs) + 0.5 || q[2] < Math.min(...zs) - 0.5 || q[2] > Math.max(...zs) + 0.5) continue;
    const h = dot(sub(q, r.point), r.normal);
    if (Math.abs(h) < 1.0) return r.building === own ? `a higher part of this roof (${r.id})` : `the neighbouring house (${r.building})`;
  }
  return null;
}

function shadeStory(grid, flux, frame, rectCentreUV, ev, sun, o) {
  if (!ev.shaded.length || !grid) return null;
  const p = frame.from(rectCentreUV[0], rectCentreUV[1], 0);
  const n = frame.n;
  const ign = ignorePlane(frame, grid ? grid.voxel : 0.25);
  const start = add(p, mul(n, 0.3 + flux.mod.rackH));
  let wsum = 0, sx = 0, sy = 0, hours = [], dists = [], tops = [];
  const names = new Map();
  for (const { s, w } of ev.shaded) {
    const c = sun.samples[s];
    const d = castRay(grid, start[0], start[1], start[2], c.sv[0], c.sv[1], c.sv[2], 200, ign);
    if (d < 0) continue;
    wsum += w; sx += w * Math.sin(c.azimuth * RAD); sy += w * Math.cos(c.azimuth * RAD);
    hours.push([c.hour, w]); dists.push([d * Math.cos(c.elevation * RAD), w]); tops.push([start[1] + d * c.sv[1], w]);
    const nm = nameHit(o.twin, flux.roofId, add(start, mul(c.sv, d + 0.1)));
    if (nm) names.set(nm, (names.get(nm) || 0) + w);
  }
  if (!wsum) return null;
  const az = (Math.atan2(sx, sy) * DEG + 360) % 360;
  const wmed = (arr) => { arr.sort((a, b) => a[0] - b[0]); const tot = arr.reduce((a, b) => a + b[1], 0); let acc = 0; for (const [x, w] of arr) { acc += w; if (acc >= tot / 2) return x; } return arr[arr.length - 1][0]; };
  const hr = wmed(hours), dist = wmed(dists), top = wmed(tops);
  const when = hr < 10 ? 'in the morning' : hr < 14 ? 'around midday' : hr < 16 ? 'in the early afternoon' : 'in the late afternoon';
  let what = top - p[1] > 2.5 ? (top > 8 ? 'a tall object (tree or building)' : 'a nearby object') : 'part of the roof itself';
  const named = [...names.entries()].sort((a, b) => b[1] - a[1])[0];
  if (named && named[1] > 0.4 * wsum) what = named[0];
  return { az, word: compassWord(az), hour: hr, dist, top, when, what };
}

function clearanceInfo(frame, rect, sb, obstaclesUV) {
  const out = {};
  for (const e of frame.edges) {
    const d = distSegRect(e.a[0], e.a[1], e.b[0], e.b[1], rect);
    if (!(e.type in out) || d < out[e.type]) out[e.type] = d;
  }
  let ob = null;
  for (const o of obstaclesUV) { const d = distPolyRect(o.poly, rect); if (!ob || d < ob.d) ob = { d, kind: o.kind }; }
  return { edges: out, obstacle: ob };
}

// ----------------------------------------------------------------------------- main API
// Plans, then checks the strings. A capped (system-design) plan that cannot be
// wired as equal strings inside the inverter's voltage window is re-planned one
// module smaller, so the result is always something an installer could string.
//
// Performance / non-domestic options (all optional; defaults keep the drone-twin
// behaviour). A twin may carry `planDefaults` (e.g. procedural map twins), merged
// under the caller's options:
//   fluxCell (m, default 0.25)  flux-map cell (alias: cell); large roofs use 0.5-1.0
//   stepMin (default 30)        sun-sample step of the typical year
//   rayStride (default 2)       beam rays cast every k-th sun sample, others only at lit/shade transitions
//   shadeBlock (default 1)      k × k flux cells share one beam-shading mask
//   phaseStep (default 0.1)     lattice phase step (m)
//   centreStep (default 0.02)   re-centring slide step (m)
//   centrePerimeterOnly         re-centring tests only the block's outer ring of slots
//   commercial                  non-domestic system: Solar ATAP non-domestic cap
//                               (commercialCapKwp, default 1000 kWp), no single-phase
//                               restring loop, no 2-MPPT limit, commercial inverter check
export function planArray(twin, occupancy, options = {}) {
  if (twin?.planDefaults) options = { ...twin.planDefaults, ...options };
  let plan = planOnce(twin, occupancy, options);
  const first = plan.summary.panels;
  // every size whose DC/AC exceeds the design ratio on the capped inverter fails the check: skip them
  const g = plan.summary.grid, watt = plan.summary.watt || 1;
  const dcacMax = (Number.isFinite(options.dcAc) ? options.dcAc : (GRID_RULES_MY?.defaultDcAcRatio ?? 1.2)) + 0.05;
  const nDcAc = g?.limitKwac ? Math.floor((g.limitKwac * dcacMax * 1000) / watt) + 2 : Infinity;
  for (let n = Math.min(first - 1, nDcAc); !options.commercial && plan.summary.mode === 'system' && !plan.summary.grid.withinLimits && n >= 4; n--) {
    plan = planOnce(twin, occupancy, { ...options, maxPanels: n, _capWhy: plan.summary.capWhy });
  }
  if (plan.summary.panels < first) plan.summary.grid.notes.unshift(`Reduced from ${first} to ${plan.summary.panels} modules so every MPPT gets equal strings within the inverter's voltage window.`);
  return plan;
}

function planOnce(twin, occupancy, options = {}) {
  const T0 = nowMs();
  const panel = normalizePanel(options.panel || options.panelId);
  const loc = twin.location || {};
  const lat = options.lat ?? loc.lat ?? CLIMATE_KL.lat, lon = options.lon ?? loc.lon ?? CLIMATE_KL.lon, tz = loc.timezone ?? 8;
  const northBearing = Number.isFinite(twin.northBearing) ? twin.northBearing : (options.northOffsetDeg || 0);
  const o = {
    mounting: options.mounting || 'flush', tiltDeg: options.tiltDeg, orientation: options.orientation,
    setback: options.setback ?? options.setbackM, fireStrict: !!options.fireStrict, cell: options.fluxCell ?? options.cell ?? 0.25,
    centreStep: options.centreStep ?? 0.02, rayStride: options.rayStride, shadeBlock: options.shadeBlock, centrePerimeterOnly: !!options.centrePerimeterOnly, commercial: !!options.commercial,
    stepMin: options.stepMin ?? 30, minBlock: Math.max(1, options.minBlock ?? 4), albedo: options.albedo ?? 0.2,
    minFluxRatio: options.minFluxRatio ?? 0.8, minFluxKwhM2: options.minFluxKwhM2 ?? options.fluxThreshold ?? 0,
    losses: { ...LOSSES, ...(options.lossFactors || {}) }, lat, lon, northBearing,
    roofIds: options.roofIds, buildingIds: options.buildingIds, allBuildings: options.allBuildings, phaseStep: options.phaseStep,
    maxMppt: options.maxMppt, minPerMppt: options.minPerMppt ?? 6, twin,
  };
  const F = MOUNTING.flush || {};
  const standoff = clamp(Number.isFinite(options.standoffM) ? options.standoffM : (F.standoffM ?? 0.12), F.standoffRangeM?.[0] ?? 0.08, F.standoffRangeM?.[1] ?? 0.15);
  // size cap
  const phase = options.phase || 'single';
  const capKwac = phase === 'three' ? (GRID_RULES_MY?.domesticThreePhaseMaxKw ?? 15) : (GRID_RULES_MY?.domesticSinglePhaseMaxKw ?? 5);
  const dcac = Number.isFinite(options.dcAc) ? options.dcAc : (GRID_RULES_MY?.defaultDcAcRatio ?? 1.2);
  const atapKwp = capKwac * dcac;
  let capPanels = Infinity, capWhy = 'no size cap ("max" mode): every valid block is used';
  const commCap = Number.isFinite(options.commercialCapKwp) ? options.commercialCapKwp : 1000;
  if (o.commercial) {
    // non-domestic: the caller's target (modelled demand), never above the Solar ATAP non-domestic cap
    const want = Number.isFinite(options.maxPanels) && options.maxPanels > 0 ? null : Number.isFinite(options.targetKwp) && options.targetKwp > 0 ? Math.min(options.targetKwp, commCap) : options.sizeMode === 'max' ? null : commCap;
    if (Number.isFinite(options.maxPanels) && options.maxPanels > 0) { capPanels = Math.min(Math.floor(options.maxPanels), Math.floor((commCap * 1000 + 1e-6) / panel.watt)); capWhy = `capped at ${capPanels} modules (your limit, ≤ ${fmtInt(commCap)} kWp non-domestic cap)`; }
    else if (want !== null) { capPanels = Math.floor((want * 1000 + 1e-6) / panel.watt); capWhy = Number.isFinite(options.targetKwp) && options.targetKwp > 0 ? `capped at ${fmt1(want)} kWp target${options.targetKwp > commCap ? ` (${fmt1(options.targetKwp)} kWp requested; Solar ATAP non-domestic cap ${fmtInt(commCap)} kWp)` : ''} (${capPanels} × ${panel.watt} W)` : `capped at ${fmtInt(commCap)} kWp: Solar ATAP non-domestic limit (${capPanels} × ${panel.watt} W)`; }
  } else if (Number.isFinite(options.maxPanels) && options.maxPanels > 0) { capPanels = Math.floor(options.maxPanels); capWhy = options._capWhy ? `${options._capWhy}, then ${capPanels} modules so the strings wire up evenly` : `capped at ${capPanels} modules (your limit)`; }
  else if (Number.isFinite(options.targetKwp) && options.targetKwp > 0) { capPanels = Math.floor((options.targetKwp * 1000 + 1e-6) / panel.watt); capWhy = `capped at ${fmt1(options.targetKwp)} kWp target (${capPanels} × ${panel.watt} W)`; }
  else if (options.targetKwp === undefined && options.sizeMode !== 'max') { capPanels = Math.floor((atapKwp * 1000 + 1e-6) / panel.watt); capWhy = `capped at ${fmt1(atapKwp)} kWp DC: Solar ATAP ${phase}-phase limit is a ${capKwac} kWac inverter (AC rating), with DC/AC ${dcac}`; }
  // a capped (residential single-inverter) plan uses at most 2 roof orientations (2 MPPT inputs), ≥ 6 modules each
  if (o.maxMppt === undefined) o.maxMppt = o.commercial ? Infinity : Number.isFinite(capPanels) ? (phase === 'three' ? 3 : 2) : Infinity;

  const grid = occupancyFrom(twin, occupancy);
  const sun = sunData(lat, lon, tz, northBearing, o.stepMin);
  const roofs = targetRoofs(twin, o);
  const assumptions = [];
  const rejected = [];
  const candidates = []; // per array candidate
  const roofInfo = [];
  const timings = { fluxMs: 0, sweepMs: 0 };

  for (const roof of roofs) {
    let frame = roofFrame(roof, northBearing);
    const mode = frame.flat && o.mounting !== 'flush' ? 'tilted' : 'flush';
    if (mode === 'tilted') {
      // rows run across the facing direction: v = back of the rack (opposite the face), u = v × n
      const face = moduleOrientation(frame, { ...o, mounting: 'tilted' }).face;
      frame = roofFrame(roof, northBearing, cross(mul(face, -1), frame.n));
    }
    if (!frame.flat && o.mounting === 'tilted') assumptions.push(`Roof ${roof.id} is pitched (${fmt1(frame.tilt)}°): modules mounted flush, never tilted up on a pitched roof.`);
    const sb = edgeSetbacks({ ...o, mounting: mode === 'tilted' ? 'tilted' : 'flush' }, frame.flat && mode === 'tilted');
    const area = Math.abs(polyArea2(frame.poly));
    if (frame.tilt > 60) { rejected.push(rejectRoof(roof, frame, 'steep', `Roof plane is ${fmt1(frame.tilt)}° steep: too steep for safe rail mounting.`)); continue; }
    if (area < panel.widthM * panel.lengthM * o.minBlock) { rejected.push(rejectRoof(roof, frame, 'small', `Only ${fmt1(area)} m²: too small for a ${o.minBlock}-module block after setbacks.`)); continue; }
    const tf = nowMs();
    const flux = buildFlux(twin, grid, roof, frame, sun, { ...o, mounting: mode === 'tilted' ? 'tilted' : 'flush' });
    timings.fluxMs += nowMs() - tf;
    const obstaclesUV = (roof.obstacles || []).map((ob) => {
      const poly = ob.outline.map(frame.toUV);
      const box = [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))];
      return { poly, box, kind: ob.kind || 'obstacle', height: ob.height };
    });
    roofInfo.push({ roof, frame, flux, sb, obstaclesUV, mode, area });
  }
  // flux thresholds: per roof best (unshaded-cell best), and a building-level floor
  const buildingBest = Math.max(0, ...roofInfo.map((r) => r.flux.best));
  for (const ri of roofInfo) {
    const { roof, frame, flux, sb, obstaclesUV, mode } = ri;
    const thr = Math.max(o.minFluxRatio * flux.best, o.minFluxKwhM2 || 0, 0.7 * buildingBest);
    ri.thr = thr;
    if (flux.best < 0.7 * buildingBest) {
      rejected.push(rejectRoof(roof, frame, 'orientation', `Best spot on this roof gets ${fmtInt(flux.best)} kWh/m²/yr, ${pct(1 - flux.best / buildingBest)} less than the house's best roof (${fmtInt(buildingBest)}): faces ${compassWord(frame.azimuth)} at ${fmt1(frame.tilt)}° or is heavily shaded.`));
      continue;
    }
    const ts = nowMs();
    let tiltInfo = null;
    const oo = { ...o, mode, minBlock: o.minBlock };
    if (mode === 'tilted') {
      tiltInfo = tiltedRowPitch(flux.mod.tilt, lat, lon, tz, northBearing, flux.mod.face);
      oo.tilt = flux.mod.tilt; oo.rowPitchFor = tiltInfo.pitchFor;
    }
    const sw = sweepRoof(flux, frame, sb, obstaclesUV, panel, oo, thr);
    timings.sweepMs += nowMs() - ts;
    ri.sweep = sw;
    if (!sw) { rejected.push(rejectRoof(roof, frame, 'no-fit', `No room for a ${o.minBlock}-module rectangular block inside the setbacks (eave ${fmt2(sb.eave ?? sb.edge)} m, ridge ${fmt2(sb.ridge ?? sb.edge)} m, verge ${fmt2(sb.verge ?? sb.edge)} m) at ≥ ${fmtInt(thr)} kWh/m²/yr.`)); continue; }
    // build array candidates (centred)
    const blks = sw.rects.map((b) => {
      const blk = {
        rows: b.r1 - b.r0 + 1, cols: b.c1 - b.c0 + 1, u0: sw.u0 + b.c0 * sw.pitchU, v0: sw.v0 + b.r0 * sw.pitchV,
        pitchU: sw.pitchU, pitchV: sw.pitchV, Wu: sw.Wu, Wv: sw.Wv, orientation: sw.orientation, gap: sw.gap, meanF: b.f / b.n,
      };
      blk.widthM = blk.cols * sw.pitchU - sw.gap; blk.lengthM = (blk.rows - 1) * sw.pitchV + sw.Wv;
      return blk;
    });
    const boxOf = (k) => [k.u0, k.v0, k.u0 + k.widthM, k.v0 + k.lengthM];
    blks.forEach((blk) => {
      const c = centreRect(blk, sw.test, blks.filter((x) => x !== blk).map(boxOf), ARRAY_SEPARATION, o);
      blk.u0 += c.du; blk.v0 += c.dv; blk.centre = c;
    });
    ri.blocks = blks;
    let use = blks;
    if (o.commercial && Number.isFinite(capPanels)) {
      // large non-domestic roofs: evaluate only the best-flux blocks needed to reach the cap (with margin)
      use = []; let tot = 0;
      for (const blk of blks.slice().sort((a, b) => b.meanF - a.meanF)) {
        if (tot >= 1.3 * capPanels + o.minBlock) { rejected.push({ roofId: roof.id, kind: 'size-cap', outline: blockOutline(frame, blk, 0.03), why: `Valid ${blk.rows}×${blk.cols} block not needed: ${capWhy}.` }); continue; }
        use.push(blk); tot += blk.rows * blk.cols;
      }
    }
    for (const blk of use) candidates.push(makeCandidate(ri, blk, panel, sun, oo));
  }

  // ---- selection under the size cap: exact knapsack over whole-row/column
  // sub-rectangles of every candidate block (max energy; each array costs half a
  // 1.2 module-years of energy so fewer, larger arrays win)
  candidates.sort((a, b) => b.perPanel - a.perPanel);
  const chosen = selectUnderCap(candidates, capPanels, o, panel, sun);
  // ---- materialise panels / arrays
  const panels = [], arrays = [];
  chosen.forEach((cand, ai) => {
    const arrId = `A${ai + 1}`;
    const { ri, blk } = cand;
    const { frame, flux, roof, sb, obstaclesUV, mode } = ri;
    const plist = [];
    for (let r = 0; r < blk.rows; r++) for (let c = 0; c < blk.cols; c++) {
      const ev = cand.cells[r][c];
      const rect = ev.rect;
      const geom = panelGeometry(frame, flux, rect, blk, standoff, mode);
      const pid = `${arrId}-r${r + 1}c${c + 1}`;
      plist.push({ id: pid, roofId: roof.id, arrayId: arrId, row: r + 1, col: c + 1, ...geom, ev, rect });
    }
    const arr = buildArray(arrId, cand, plist, panel, standoff, sb, mode);
    arrays.push(arr);
    for (const p of plist) panels.push(p);
  });
  // ranks + reasons
  const ranked = panels.slice().sort((a, b) => b.ev.annualKwh - a.ev.annualKwh);
  ranked.forEach((p, i) => { p.rank = i + 1; });
  const outPanels = panels.map((p) => panelOut(p, ranked.length, roofInfo.find((r) => r.roof.id === p.roofId), grid, sun, o, panel));
  for (const arr of arrays) arr.reason = arrayReason(arr, outPanels.filter((p) => p.arrayId === arr.id), roofInfo.find((r) => r.roof.id === arr.roofId), capWhy, panel);

  // rejected regions on planned roofs (cells grouped by why)
  for (const ri of roofInfo) if (ri.sweep) rejected.push(...rejectedRegions(ri, outPanels.filter((p) => p.roofId === ri.roof.id)));
  for (const cand of candidates) if (cand.dropped && !chosen.includes(cand)) {
    rejected.push({ roofId: cand.ri.roof.id, kind: 'size-cap', outline: blockOutline(cand.ri.frame, cand.blk, 0.03),
      why: `Valid ${cand.blk.rows}×${cand.blk.cols} block (${fmtInt(cand.perPanel)} kWh/module/yr) not used: ${cand.dropped === 'size cap reached' ? capWhy : cand.dropped}.` });
  }

  // ---- summary
  const n = outPanels.length;
  const kWp = (n * panel.watt) / 1000;
  const annualKwh = outPanels.reduce((a, p) => a + p.annualKwh, 0);
  const monthly = new Array(12).fill(0);
  for (const p of panels) p.ev.monthlyKwh.forEach((x, m) => { monthly[m] += x; });
  const poaMean = n ? outPanels.reduce((a, p) => a + p.poaKwhM2, 0) / n : 0;
  const area = panel.widthM * panel.lengthM;
  const pr = n ? annualKwh / (outPanels.reduce((a, p) => a + p.poaKwhM2, 0) * area * panel.efficiency) : 0;
  const thermal = n ? panels.reduce((a, p) => a + p.ev.thermalLoss * p.ev.annualKwh, 0) / Math.max(1e-9, annualKwh) : 0;
  const tcell = n ? panels.reduce((a, p) => a + p.ev.cellTempC, 0) / n : 0;
  const sc = twin.scale || {};
  assumptions.unshift(
    `Scan scale ${sc.metresPerUnit ? fmt2(sc.metresPerUnit) + ' m per scan unit' : 'unknown'} (${sc.confidence || 'unknown'} confidence): ${sc.method || 'not documented'}. Every length, area and kWp scales with it.`,
    `Location ${loc.name || `${lat}, ${lon}`} (${fmt2(lat)}°, ${fmt2(lon)}°), UTC+${tz}. A drone scan has no GPS or compass: north bearing ${fmt1(northBearing)}° is an assumption the viewer lets you change.`,
    `Climate: ${CLIMATE_KL.source}; GHI ${fmtInt(sun.ghiYear)} kWh/m²/yr in this model (catalogue ${CLIMATE_KL.annualGhiKwhM2}), diffuse fraction ${fmt2(CLIMATE_KL.annualDiffuseFraction)}. Ground stations in the Klang Valley often read 5-10% lower.`,
    `Typical year: 12 representative days (Klein) × ${o.stepMin}-min steps; Haurwitz clear-sky shape scaled to monthly GHI, Erbs split rescaled to monthly DHI, Hay-Davies transposition, albedo ${o.albedo}.`,
    `Shading: DDA rays through a ${grid ? grid.voxel : '—'} m occupancy grid for every ${o.cell} m roof cell and sun sample; 48-direction sky view for diffuse; trees treated as opaque (conservative). Module electrical shading: half-cut, 3 bypass diodes (6 units, each limited by its darkest point).`,
    `Optics Martin-Ruiz (ar 0.16); cell temperature Faiman (${mountingWord(o.mounting)} U0 ${thermalParams(o.mounting, o.losses).U0}, U1 ${thermalParams(o.mounting, o.losses).U1}); system derate ${fmt2(systemDerate(o.losses))} (soiling, mismatch, wiring, LID, low light, inverter ${o.losses.inverterEff}, availability). Year-1 energy, no degradation (${pct(o.losses.degradationPerYear ?? 0.004, 1)}/yr after).`,
    `Size: ${capWhy}.`,
  );
  const mode = Number.isFinite(capPanels) ? 'system' : 'roof-potential';
  if (o.commercial) assumptions.push(`Non-domestic system: Solar ATAP non-domestic cap ${fmtInt(commCap)} kWp and the site's modelled demand set the size; three-phase commercial string inverters (one MPPT per array).`);
  else assumptions.push('Solar ATAP limit read as the inverter AC rating (5 kWac single-phase, 15 kWac three-phase); confirm with a registered installer whether TNB applies it to the inverter or the panel (DC) rating.');
  if (!o.commercial && mode === 'system' && kWp > atapKwp + 1e-9) assumptions.push(`Warning: ${fmt1(kWp)} kWp exceeds the Solar ATAP single-phase guide (${capKwac} kWac × ${dcac} = ${fmt1(atapKwp)} kWp DC); a three-phase supply (≤ ${GRID_RULES_MY?.domesticThreePhaseMaxKw ?? 15} kWac) or a smaller array is needed.`);
  const summary = {
    panels: n, kWp: +kWp.toFixed(3), annualKwh: Math.round(annualKwh), specificYield: kWp ? Math.round(annualKwh / kWp) : 0,
    avgShadeLoss: n ? +(outPanels.reduce((a, p) => a + p.shadeLoss, 0) / n).toFixed(4) : 0,
    performanceRatio: +pr.toFixed(3), poaKwhM2: Math.round(poaMean), thermalLoss: +thermal.toFixed(4), meanCellTempC: +tcell.toFixed(1),
    monthlyKwh: monthly.map((x) => Math.round(x)), arrays: arrays.length, panelModel: panel.name, panelId: panel.id, watt: panel.watt,
    weightKg: Math.round(arrays.reduce((a, x) => a + x.weightKg, 0)),
    mode, capWhy,
    grid: o.commercial ? commercialGridCheck(arrays, panel, kWp, dcac, commCap) : gridCheck(arrays, panel, kWp, mode === 'system' ? capKwac : (GRID_RULES_MY?.domesticThreePhaseMaxKw ?? 15), dcac, mode === 'system' ? phase : 'three', mode),
    yield: { modelledKwh: Math.round(annualKwh), groundCalibratedKwh: Math.round(annualKwh * GROUND_FACTOR), factor: GROUND_FACTOR,
      note: 'NASA POWER satellite irradiance reads about 5-10% above Klang Valley ground stations; the calibrated figure scales it by 0.93. A measured Shah Alam home makes 1,144-1,196 kWh/kWp.' },
    specificYieldCalibrated: kWp ? Math.round(annualKwh * GROUND_FACTOR / kWp) : 0,
    assumptions,
    timings: { totalMs: Math.round(nowMs() - T0), fluxMs: Math.round(timings.fluxMs), sweepMs: Math.round(timings.sweepMs) },
  };
  return { panels: outPanels, arrays, rejected, summary };
}

const mountingWord = (m) => (m === 'tilted' ? 'tilted rack' : 'flush, close to roof');

function rejectRoof(roof, frame, kind, why) {
  return { roofId: roof.id, kind, outline: frame.poly.map(([a, b]) => r3(frame.from(a, b, 0.03))), why };
}

function makeCandidate(ri, blk, panel, sun, o) {
  const cells = [];
  let e = 0;
  for (let r = 0; r < blk.rows; r++) {
    cells.push([]);
    for (let c = 0; c < blk.cols; c++) {
      const u = blk.u0 + c * blk.pitchU, v = blk.v0 + r * blk.pitchV;
      const rect = [u, v, u + blk.Wu, v + blk.Wv];
      const ev = panelEnergy(ri.flux, rect, blk.orientation, sun, panel, o);
      ev.rect = rect;
      cells[r].push(ev);
      e += ev.annualKwh;
    }
  }
  const n = blk.rows * blk.cols;
  return { ri, blk, cells, n, energy: e, perPanel: e / n };
}

// For each size n (≤ maxN) the best sub-rectangle of a block: max energy, then most central.
function subRectOptions(cand, maxN, o) {
  const { blk } = cand;
  const bySize = new Map();
  const sumE = blk.rows * blk.cols > 200 ? prefix2(blk.rows, blk.cols, (r, c) => cand.cells[r][c].annualKwh) : null;
  for (let rr = 1; rr <= blk.rows; rr++) for (let cc = 1; cc <= blk.cols; cc++) {
    const n = rr * cc;
    if (n > maxN || n < o.minBlock || (rr > 1 && cc < 2)) continue;
    for (let r0 = 0; r0 + rr <= blk.rows; r0++) for (let c0 = 0; c0 + cc <= blk.cols; c0++) {
      let e = 0;
      if (sumE) e = sumE(r0, r0 + rr - 1, c0, c0 + cc - 1);
      else for (let r = r0; r < r0 + rr; r++) for (let c = c0; c < c0 + cc; c++) e += cand.cells[r][c].annualKwh;
      const off = Math.abs(c0 + cc / 2 - blk.cols / 2) + Math.abs(r0 + rr / 2 - blk.rows / 2);
      const score = e - off * 1e-3 - Math.abs(rr - cc) * 1e-4; // energy, then centred, then squarer
      const cur = bySize.get(n);
      if (!cur || score > cur.score) bySize.set(n, { rr, cc, r0, c0, n, e, score });
    }
  }
  return [...bySize.values()];
}

// Orientation groups (one MPPT each): same azimuth within 15° and tilt within 7°.
function orientationGroups(candidates) {
  const groups = [];
  for (const c of candidates) {
    const az = c.ri.flux.mod.azimuth, tl = c.ri.flux.mod.tilt;
    let g = groups.find((x) => angDist(x.az, az) <= 15 && Math.abs(x.tilt - tl) <= 7);
    if (!g) { g = { id: groups.length, az, tilt: tl }; groups.push(g); }
    c.group = g.id;
  }
  return groups;
}

const ARRAY_COST = 1.2;
const ARRAY_SEPARATION = MOUNTING.tilted?.walkwayM ?? 0.6; // min clear gap between two arrays on one roof face

function selectUnderCap(candidates, cap, o, panel, sun) {
  const groups = orientationGroups(candidates);
  const total = candidates.reduce((a, c) => a + c.n, 0);
  const maxMppt = o.maxMppt, minString = o.minPerMppt;
  if ((!Number.isFinite(cap) || cap >= total) && !(Number.isFinite(maxMppt) && groups.length > maxMppt)) return candidates;
  if (!Number.isFinite(maxMppt) || groups.length <= maxMppt) {
    const r = knapsack(candidates, cap, o, panel, sun);
    if (!Number.isFinite(maxMppt) || validGroups(r, minString)) return r;
  }
  // enumerate subsets of ≤ maxMppt orientation groups; keep the best plan whose every group has ≥ minString modules
  let best = null;
  const ids = groups.map((g) => g.id);
  const subsets = [];
  const rec = (start, cur) => { if (cur.length) subsets.push(cur.slice()); if (cur.length === maxMppt) return; for (let i = start; i < ids.length; i++) { cur.push(ids[i]); rec(i + 1, cur); cur.pop(); } };
  rec(0, []);
  for (const sub of subsets) {
    const cs = candidates.filter((c) => sub.includes(c.group));
    for (const c of candidates) c.dropped = null;
    const r = knapsack(cs, cap, o, panel, sun);
    if (!validGroups(r, minString)) continue;
    const e = r.reduce((a, c) => a + c.energy, 0) - ARRAY_COST * (candidates[0]?.perPanel || 0) * r.length;
    if (!best || e > best.e) best = { e, r, sub };
  }
  const chosen = best ? best.r : [];
  for (const c of candidates) c.dropped = chosen.some((x) => x === c || x.parent === c) ? null : (best && !best.sub.includes(c.group) ? `uses a third roof orientation (inverter has ${maxMppt} MPPT inputs)` : 'size cap reached');
  return chosen;
}

function validGroups(chosen, minString) {
  const per = new Map();
  for (const c of chosen) per.set(c.group, (per.get(c.group) || 0) + c.n);
  for (const n of per.values()) if (n < minString) return false;
  return true;
}

function knapsack(candidates, cap, o, panel, sun) {
  const total = candidates.reduce((a, c) => a + c.n, 0);
  if (!Number.isFinite(cap) || cap >= total) return candidates.slice();
  const C = Math.max(0, Math.floor(cap));
  const opts = candidates.map((c) => subRectOptions(c, C, o));
  // each extra array costs ~1.2 module-years: one more module never justifies splitting a roof into strips
  const arrCost = ARRAY_COST * (candidates[0]?.perPanel || 0);
  // dp[i][k] = best score using candidates < i with k modules
  const NEG = -Infinity;
  let dp = new Array(C + 1).fill(NEG); dp[0] = 0;
  const choice = [];
  for (let i = 0; i < candidates.length; i++) {
    const nd = dp.slice();
    const ch = new Array(C + 1).fill(null);
    for (let k = 0; k <= C; k++) {
      if (dp[k] === NEG) continue;
      for (const op of opts[i]) {
        const k2 = k + op.n;
        if (k2 > C) continue;
        const v = dp[k] + op.e - arrCost;
        if (v > nd[k2] + 1e-9) { nd[k2] = v; ch[k2] = { op, from: k }; }
      }
    }
    choice.push(ch); dp = nd;
  }
  let k = 0;
  for (let j = 0; j <= C; j++) if (dp[j] > dp[k]) k = j;
  const picks = new Array(candidates.length).fill(null);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const ch = choice[i][k]; // non-null only if candidate i set the stage-i optimum for k
    if (ch) { picks[i] = ch.op; k = ch.from; }
  }
  const out = [];
  candidates.forEach((cand, i) => {
    const op = picks[i];
    if (!op) { cand.dropped = 'size cap reached'; return; }
    if (op.n === cand.n) { out.push(cand); return; }
    const others = (cand.ri.blocks || []).filter((x) => x !== cand.blk).map((b) => [b.u0, b.v0, b.u0 + b.widthM, b.v0 + b.lengthM]);
    const t = trimCandidate(cand, op, panel, sun, o, others);
    t.parent = cand; t.group = cand.group;
    out.push(t);
    cand.dropped = null;
  });
  return out;
}

function trimCandidate(cand, best, panel, sun, o, others = []) {
  const { blk } = cand;
  const nb = { ...blk, rows: best.rr, cols: best.cc, u0: blk.u0 + best.c0 * blk.pitchU, v0: blk.v0 + best.r0 * blk.pitchV };
  nb.widthM = nb.cols * nb.pitchU - nb.gap; nb.lengthM = (nb.rows - 1) * nb.pitchV + nb.Wv;
  // re-centre the trimmed block inside the roof's free span
  const c = centreRect(nb, cand.ri.sweep.test, others, ARRAY_SEPARATION, o);
  nb.u0 += c.du; nb.v0 += c.dv; nb.centre = c; nb.trimmedFrom = [blk.rows, blk.cols];
  const t = makeCandidate(cand.ri, nb, panel, sun, o);
  t.trimmed = true;
  return t;
}

function panelGeometry(frame, flux, rect, blk, standoff, mode) {
  let corners, normal, tiltDeg, azimuthDeg, centre;
  if (mode === 'tilted') {
    // rack: lower edge at lowEdgeClear above the slab; module rises toward the back
    const T = MOUNTING.tilted || {};
    const tilt = flux.mod.tilt * RAD;
    const face = flux.mod.face; // horizontal facing direction (twin)
    // frame.v points to the back of the rack (opposite the face): low edge at rect[1]
    void face;
    const lo = T.lowEdgeClearM ?? 0.15;
    const pts2 = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    corners = pts2.map(([a, b]) => frame.from(a, b, lo + (b - rect[1]) * Math.tan(tilt)));
    normal = flux.mod.n; tiltDeg = flux.mod.tilt; azimuthDeg = flux.mod.azimuth;
  } else {
    corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map(([a, b]) => frame.from(a, b, standoff));
    normal = frame.n; tiltDeg = frame.tilt; azimuthDeg = frame.azimuth;
  }
  // CCW seen from above: signed area in (x, -z) must be positive
  let s = 0;
  for (let i = 0; i < 4; i++) { const p = corners[i], q = corners[(i + 1) % 4]; s += p[0] * -q[2] - q[0] * -p[2]; }
  if (s < 0) corners = [corners[0], corners[3], corners[2], corners[1]];
  centre = mul(corners.reduce((a, p) => add(a, p), [0, 0, 0]), 0.25);
  return { corners: corners.map((p) => r3(p, 4)), centre: r3(centre, 4), normal: r3(normal, 5), tiltDeg: +tiltDeg.toFixed(2), azimuthDeg: +azimuthDeg.toFixed(1) };
}

function blockOutline(frame, blk, h) {
  return [[blk.u0, blk.v0], [blk.u0 + blk.widthM, blk.v0], [blk.u0 + blk.widthM, blk.v0 + blk.lengthM], [blk.u0, blk.v0 + blk.lengthM]].map(([a, b]) => r3(frame.from(a, b, h)));
}

function buildArray(id, cand, plist, panel, standoff, sb, mode) {
  const { ri, blk } = cand;
  const { frame, roof } = ri;
  const n = plist.length;
  const area = blk.widthM * blk.lengthM;
  const rack = mode === 'tilted' ? (MOUNTING.tilted?.rackingKgM2 ?? 6) : (MOUNTING.flush?.rackingKgM2 ?? 3);
  const weightKg = n * panel.weightKg + rack * area;
  const annualKwh = plist.reduce((a, p) => a + p.ev.annualKwh, 0);
  const kWp = (n * panel.watt) / 1000;
  const h = mode === 'tilted' ? 0.03 : standoff;
  const origin = frame.from(blk.u0, blk.v0, h);
  const box = [blk.u0, blk.v0, blk.u0 + blk.widthM, blk.v0 + blk.lengthM];
  const clr = clearanceInfo(frame, box, sb, ri.obstaclesUV);
  // CAD: rails under the modules (2 per module row, at L/4 and 3L/4 of the module length)
  const rails = [];
  const railH = Math.max(0.03, (mode === 'tilted' ? 0.1 : standoff) - panel.depthM - 0.01);
  const margin = MOUNTING.flush?.endClampMarginM ?? 0.03;
  if (blk.orientation === 'portrait') {
    for (let r = 0; r < blk.rows; r++) for (const f of [0.25, 0.75]) {
      const v = blk.v0 + r * blk.pitchV + f * blk.Wv;
      rails.push({ from: r3(frame.from(blk.u0 - margin, v, railH)), to: r3(frame.from(blk.u0 + blk.widthM + margin, v, railH)) });
    }
  } else {
    for (let c = 0; c < blk.cols; c++) for (const f of [0.25, 0.75]) {
      const u = blk.u0 + c * blk.pitchU + f * blk.Wu;
      rails.push({ from: r3(frame.from(u, blk.v0 - margin, railH)), to: r3(frame.from(u, blk.v0 + blk.lengthM + margin, railH)) });
    }
  }
  return {
    id, roofId: roof.id, rows: blk.rows, cols: blk.cols, orientation: blk.orientation, panels: n, panelIds: plist.map((p) => p.id),
    widthM: +blk.widthM.toFixed(3), lengthM: +blk.lengthM.toFixed(3), origin: r3(origin, 4), axisU: r3(frame.u, 5), axisV: r3(frame.v, 5), normal: r3(frame.n, 5),
    outline: blockOutline(frame, blk, h),
    colPitchM: +blk.pitchU.toFixed(4), rowPitchM: +blk.pitchV.toFixed(4), gapM: blk.gap, rowGapM: +(blk.pitchV - blk.Wv).toFixed(4),
    setbackM: +Math.min(...Object.values(clr.edges)).toFixed(3),
    setbacks: Object.fromEntries(Object.entries(clr.edges).map(([k, v]) => [k, +v.toFixed(3)])),
    setbackRules: Object.fromEntries(Object.entries(sb).map(([k, v]) => [k, +v.toFixed(3)])),
    obstacleClearM: clr.obstacle ? +clr.obstacle.d.toFixed(3) : null,
    standoffM: mode === 'tilted' ? null : standoff, mounting: mode,
    tiltDeg: +(mode === 'tilted' ? ri.flux.mod.tilt : frame.tilt).toFixed(2), azimuthDeg: +(mode === 'tilted' ? ri.flux.mod.azimuth : frame.azimuth).toFixed(1),
    weightKg: Math.round(weightKg), loadKgM2: +(weightKg / area).toFixed(2), areaM2: +area.toFixed(2),
    kWp: +kWp.toFixed(3), annualKwh: Math.round(annualKwh), specificYield: Math.round(annualKwh / kWp),
    centred: { u: !!blk.centre?.centredU, v: !!blk.centre?.centredV }, trimmedFrom: blk.trimmedFrom || null,
    cad: { rails, railsPerRow: 2, moduleWidthM: panel.widthM, moduleLengthM: panel.lengthM, moduleDepthM: panel.depthM },
  };
}

function panelOut(p, total, ri, grid, sun, o, panel) {
  const ev = p.ev;
  const { frame, flux, sb, obstaclesUV } = ri;
  const best = flux.best;
  const frac = best > 0 ? ev.poaKwhM2 / best : 1;
  const clr = clearanceInfo(frame, p.rect, sb, obstaclesUV);
  const story = ev.shadeLoss > 0.02 ? shadeStory(grid, flux, frame, [(p.rect[0] + p.rect[2]) / 2, (p.rect[1] + p.rect[3]) / 2], ev, sun, o) : null;
  let headline;
  if (ev.shadeLoss > 0.10 && story) headline = `Partly shaded: loses ${pct(ev.shadeLoss)} of its sun, mostly ${story.when} from ${story.what} to the ${story.word}`;
  else if (ev.shadeLoss > 0.10) headline = `Partly shaded: loses ${pct(ev.shadeLoss)} of its sun to nearby obstructions`;
  else headline = `Receives ${fmtInt(ev.poaKwhM2)} kWh/m²/yr, ${pct(Math.min(1, frac))} of this roof's best spot`;
  const bullets = [];
  bullets.push(`${fmtInt(ev.annualKwh)} kWh/yr (${fmtInt(ev.annualKwh / (panel.watt / 1000))} kWh/kWp); rank ${p.rank} of ${total} modules by yield.`);
  bullets.push(`Faces ${compassWord(p.azimuthDeg)} (${fmtInt(p.azimuthDeg)}°) at ${fmt1(p.tiltDeg)}°: ${fmtInt(ev.poaUnshadedKwhM2)} kWh/m²/yr unshaded vs ${fmtInt(sun.ghiYear)} on flat ground.`);
  if (ev.sunFrom !== null) bullets.push(`Direct sun on the module on average ${hhmm(ev.sunFrom)}–${hhmm(ev.sunTo)}; ${fmtInt(ev.sunHoursYear)} sun-hours a year.`);
  bullets.push(story
    ? `Shade loss ${pct(ev.shadeLoss, 1)}: beam blocked mostly ${story.when} (around ${hhmm(story.hour)}) by ${story.what} ~${fmt1(story.dist)} m to the ${story.word} (top ~${fmt1(story.top)} m); sky view ${pct(ev.skyFrac / ev.skyFrac0)} of open.`
    : `Shade loss ${pct(ev.shadeLoss, 1)}; sky view ${pct(Math.min(1, ev.skyFrac / ev.skyFrac0))} of an open roof.`);
  const ce = Object.entries(clr.edges).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k, d]) => `${fmt2(d)} m from the ${k} (min ${fmt2(sb[k] ?? sb.verge)})`);
  bullets.push(`Clearances: ${ce.join(', ')}${clr.obstacle ? `; ${fmt2(clr.obstacle.d)} m from the ${clr.obstacle.kind}` : ''}.`);
  bullets.push(`Cell temperature ~${fmtInt(ev.cellTempC)} °C when producing (irradiance-weighted): thermal loss ${pct(ev.thermalLoss, 1)}.`);
  bullets.push(`Row ${p.row}, column ${p.col} of array ${p.arrayId}; corners ${p.tiltDeg > 5 && ri.mode !== 'tilted' ? `on rails ${fmtInt((ri.mode === 'tilted' ? 0 : (p.corners && dot(sub(p.corners[0], frame.o), frame.n))) * 1000)} mm above the roof plane` : 'on the rack'}.`);
  return {
    id: p.id, roofId: p.roofId, arrayId: p.arrayId, row: p.row, col: p.col, rank: p.rank,
    corners: p.corners, centre: p.centre, normal: p.normal, tiltDeg: p.tiltDeg, azimuthDeg: p.azimuthDeg,
    annualKwh: +ev.annualKwh.toFixed(1), poaKwhM2: +ev.poaKwhM2.toFixed(1), poaUnshadedKwhM2: +ev.poaUnshadedKwhM2.toFixed(1),
    shadeLoss: +ev.shadeLoss.toFixed(4), sunHoursYear: Math.round(ev.sunHoursYear), skyView: +(ev.skyFrac / ev.skyFrac0).toFixed(3),
    skyFrac: +ev.skyFrac.toFixed(4), gndFrac: +ev.gndFrac.toFixed(4),
    cellTempC: +ev.cellTempC.toFixed(1), thermalLoss: +ev.thermalLoss.toFixed(4), pr: +ev.pr.toFixed(3),
    fluxFractionOfRoofBest: +frac.toFixed(3), monthlyKwh: ev.monthlyKwh.map((x) => +x.toFixed(1)),
    reason: { headline, bullets },
  };
}

function arrayReason(arr, ps, ri, capWhy, panel) {
  const { frame, flux } = ri;
  const ori = arr.orientation;
  const headline = `${arr.rows} × ${arr.cols} ${ori} block on the ${compassWord(arr.azimuthDeg)}-facing ${fmt1(arr.tiltDeg)}° roof ${arr.roofId}: ${fmt2(arr.kWp)} kWp, ${fmtInt(arr.annualKwh)} kWh/yr`;
  const minFrac = Math.min(...ps.map((p) => p.fluxFractionOfRoofBest));
  const bullets = [
    `${arr.panels} × ${panel.name} (${panel.watt} W) in a regular grid: ${fmt2(arr.widthM)} m along the eave × ${fmt2(arr.lengthM)} m up the slope, ${Math.round(arr.gapM * 1000)} mm clamp gaps, every row the same length.`,
    `Every module gets ≥ ${pct(minFrac)} of this roof's best flux (${fmtInt(flux.best)} kWh/m²/yr); threshold ${fmtInt(ri.thr)}.`,
    `Specific yield ${fmtInt(arr.specificYield)} kWh/kWp/yr; mean shade loss ${pct(ps.reduce((a, p) => a + p.shadeLoss, 0) / ps.length, 1)}.`,
    `Clearances to roof edges: ${Object.entries(arr.setbacks).map(([k, v]) => `${k} ${fmt2(v)} m (min ${fmt2(arr.setbackRules[k] ?? 0)})`).join(', ')}${arr.obstacleClearM !== null ? `; nearest obstacle ${fmt2(arr.obstacleClearM)} m` : ''}.`,
    arr.centred.u ? 'Centred along the eave between its limits, so the margins left and right are equal.' : 'Shifted off-centre along the eave because centring would cost > 0.5% energy (shade).',
    arr.mounting === 'tilted'
      ? `Tilted racks at ${fmt1(arr.tiltDeg)}°, row pitch ${fmt2(arr.rowPitchM)} m so rows do not shade each other 9:00-15:00 on the winter solstice.`
      : `Flush on 2 rails per row, module top ${Math.round((arr.standoffM || 0) * 1000)} mm above the roof plane, same tilt and azimuth as the roof (no wind sail).`,
    `Dead load ${fmtInt(arr.weightKg)} kg = ${fmt1(arr.loadKgM2)} kg/m² (modules ${panel.weightKg} kg each + racking), within the ~${arr.mounting === 'tilted' ? '30-60 ballasted' : '12-16 flush'} kg/m² typical.`,
  ];
  if (arr.trimmedFrom) bullets.push(`Trimmed from a ${arr.trimmedFrom[0]} × ${arr.trimmedFrom[1]} block by whole rows/columns to meet the size cap (${capWhy}); kept the best-yield, most central part.`);
  void frame;
  return { headline, bullets };
}

function rejectedRegions(ri, panelsOnRoof) {
  const { roof, frame, flux, sb, obstaclesUV, thr } = ri;
  const out = [];
  // setback strips per edge
  for (const e of frame.edges) {
    if (e.L < 0.3) continue;
    const s = sb[e.type] ?? sb.verge ?? 0.4;
    const dx = (e.b[0] - e.a[0]) / e.L, dy = (e.b[1] - e.a[1]) / e.L;
    const inx = -dy, iny = dx; // inward for a CCW ring
    const q = [e.a, e.b, [e.b[0] + inx * s, e.b[1] + iny * s], [e.a[0] + inx * s, e.a[1] + iny * s]];
    out.push({ roofId: roof.id, kind: 'setback', edge: e.type, outline: q.map(([a, b]) => r3(frame.from(a, b, 0.02))), areaM2: +(e.L * s).toFixed(2),
      why: `Within ${fmt2(s)} m of the ${e.type} (${EDGE_WHY[e.type] || 'edge zone'}).` });
  }
  for (const ob of obstaclesUV) {
    const c = sb.obstacle;
    const q = [[ob.box[0] - c, ob.box[1] - c], [ob.box[2] + c, ob.box[1] - c], [ob.box[2] + c, ob.box[3] + c], [ob.box[0] - c, ob.box[3] + c]];
    out.push({ roofId: roof.id, kind: 'obstacle', outline: q.map(([a, b]) => r3(frame.from(a, b, 0.02))),
      why: `Obstacle: ${ob.kind}${ob.height ? ` (${fmt2(ob.height)} m high)` : ''}, plus ${fmt2(c)} m clearance.` });
  }
  // cells by flux / clutter (only inside the usable zone, i.e. not in a setback strip)
  const { nu, nv, cell } = flux;
  const low = new Uint8Array(nu * nv), clut = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const k = i + nu * j;
    if (!flux.active[k]) continue;
    const a = frame.umin + (i + 0.5) * cell, b = frame.vmin + (j + 0.5) * cell;
    let inSb = false;
    for (const e of frame.edges) if (distPtSeg(a, b, e.a[0], e.a[1], e.b[0], e.b[1]) < (sb[e.type] ?? 0.4)) { inSb = true; break; }
    if (inSb) continue;
    if (flux.clutter[k]) clut[k] = 1;
    else if (flux.poa[k] < thr) low[k] = 1;
  }
  const loopsOut = (mask, kind, whyFn) => {
    for (const L of traceCells(mask, nu, nv)) {
      if (L.count < 4 || L.loop.length < 3) continue;
      let s = 0, s0 = 0;
      for (const k of L.cells) { s += flux.poa[k]; s0 += flux.poa0[k]; }
      const mean = s / L.cells.length, mean0 = s0 / L.cells.length;
      out.push({ roofId: roof.id, kind, outline: L.loop.map(([i, j]) => r3(frame.from(frame.umin + i * cell, frame.vmin + j * cell, 0.025))),
        areaM2: +(L.count * cell * cell).toFixed(2), why: whyFn(mean, mean0) });
    }
  };
  loopsOut(low, 'shade', (m, m0) => `Below the sun threshold: ${fmtInt(m)} kWh/m²/yr (${pct(1 - m / Math.max(1, m0))} lost to shade; needs ≥ ${fmtInt(thr)}, i.e. 80% of this roof's best ${fmtInt(flux.best)}).`);
  loopsOut(clut, 'clutter', () => 'Something stands 0.45-2 m above the roof here in the scan (unlisted obstacle, antenna, tree branch or scan noise).');
  void panelsOnRoof;
  return out;
}

// tilted rows on a flat slab: minimum pitch so a row does not shade the next
// 9:00-15:00 (solar time) on the winter solstice (MOUNTING.tilted.shadeFreeWindow)
function tiltedRowPitch(tiltDeg, lat, lon, tz, northBearing, face) {
  const win = MOUNTING.tilted?.shadeFreeWindow || { date: '12-21', fromHour: 9, toHour: 15 };
  const [mm, dd] = win.date.split('-').map(Number);
  const dates = lat >= 0 ? [[mm, dd]] : [[6, 21]];
  let worstTan = Infinity, worst = null;
  for (const [m, d] of dates) for (let h = 0; h < 24; h += 0.25) {
    const g = solarGeometry(localDate(2026, m, d, h, tz), lat, lon);
    const sh = g.trueSolarMin / 60;
    if (sh < win.fromHour || sh > win.toHour || g.elevation <= 0) continue;
    const sv = sunVectorTwin(g.azimuth, g.elevation, northBearing);
    const along = sv[0] * face[0] + sv[2] * face[2]; // horizontal component toward the facing direction
    if (along <= 1e-6) { worstTan = 0; worst = { h: sh, el: g.elevation }; continue; }
    const tanProfile = sv[1] / along; // profile angle tangent
    if (tanProfile < worstTan) { worstTan = tanProfile; worst = { h: sh, el: g.elevation }; }
  }
  const beta = tiltDeg * RAD;
  const pitchFor = (L) => (worstTan > 0 ? L * Math.cos(beta) + (L * Math.sin(beta)) / worstTan : L * Math.cos(beta) + L * Math.sin(beta) * 10);
  return { pitchFor, worstProfileDeg: Math.atan(worstTan) * DEG, worst };
}

const GROUND_FACTOR = 0.93;
// Inverter window assumed for a typical 5 kWac single-phase string inverter
// (e.g. Huawei SUN2000-5KTL-L1): 600 V max DC, 90-560 V MPPT, 2 MPPT inputs.
const INVERTER = { maxDcV: 600, mpptMinV: 90, mpptMaxV: 560, mpptsSingle: 2, maxParallel: 2 };

// One MPPT per roof orientation; each MPPT gets equal strings (never unequal
// strings in parallel) whose cold Voc stays under the inverter maximum.
function gridCheck(arrays, panel, kWp, capKwac, dcac, phase, mode) {
  const notes = [];
  const inverterKwac = Math.min(capKwac, Math.max(1, Math.ceil((kWp / dcac) * 2) / 2));
  const vocCold = panel.vocV ? panel.vocV * (1 + panel.vocTempCoeff * ((CLIMATE_KL.designMinCellC ?? 15) - 25)) : null;
  const vmpHot = panel.vocV ? (panel.vmpV || panel.vocV * 0.83) * (1 + panel.tempCoeff * ((CLIMATE_KL.designMaxCellC ?? 75) - 25)) : null;
  const maxSeries = vocCold ? Math.floor(INVERTER.maxDcV / vocCold) : Infinity;
  const minSeries = vmpHot ? Math.ceil(INVERTER.mpptMinV / vmpHot) : 1;
  const groups = new Map();
  for (const a of arrays) {
    const k = `${Math.round(a.azimuthDeg / 5) * 5}/${Math.round(a.tiltDeg / 5) * 5}`;
    if (!groups.has(k)) groups.set(k, { arrayIds: [], modules: 0, azimuthDeg: a.azimuthDeg, tiltDeg: a.tiltDeg });
    const gr = groups.get(k); gr.arrayIds.push(a.id); gr.modules += a.panels;
  }
  let ok = true;
  const mppts = [...groups.values()].map((gr) => {
    let strings = null;
    for (let k = 1; k <= INVERTER.maxParallel; k++) {
      const per = gr.modules / k;
      if (Number.isInteger(per) && per >= minSeries && per <= maxSeries) { strings = k; break; }
    }
    if (!strings) ok = false;
    const per = strings ? gr.modules / strings : gr.modules;
    return { arrayIds: gr.arrayIds, modules: gr.modules, strings: strings || 1, modulesPerString: per,
      vocColdV: vocCold ? +(vocCold * per).toFixed(0) : null, vmpHotV: vmpHot ? +(vmpHot * per).toFixed(0) : null, valid: !!strings };
  });
  const mpptLimit = phase === 'single' ? INVERTER.mpptsSingle : 3;
  if (mppts.length > mpptLimit) { ok = false; notes.push(`${mppts.length} roof orientations need ${mppts.length} MPPT inputs; a ${phase}-phase inverter typically has ${mpptLimit}.`); }
  for (const m of mppts) if (!m.valid) notes.push(`${m.modules} modules on ${m.arrayIds.join(', ')} cannot be split into equal strings of ${minSeries}-${maxSeries} modules.`);
  const dcAc = +(kWp / inverterKwac).toFixed(2);
  if (dcAc > dcac + 0.05) { ok = false; notes.push(`DC/AC ${dcAc} is above the ${dcac} design ratio.`); }
  if (mode === 'roof-potential') notes.unshift('Roof potential: needs a three-phase supply (up to 15 kWac under Solar ATAP); not a system design.');
  notes.push(`String window: ${minSeries}-${maxSeries} modules (Voc at ${CLIMATE_KL.designMinCellC ?? 15} °C = ${vocCold?.toFixed(1)} V each, 600 V max; MPPT from 90 V at ${CLIMATE_KL.designMaxCellC ?? 75} °C cell).`);
  return { programme: GRID_RULES_MY?.programme || 'Solar ATAP', phase, limitKwac: capKwac, inverterKwac, dcAc, mppts,
    withinLimits: ok, notes, maxModulesPerString: maxSeries, minModulesPerString: minSeries,
    // older field names, still read by the viewer's fallbacks
    suggestedInverterKwac: inverterKwac, dcAcRatio: dcAc, withinLimit: ok };
}

// Non-domestic: commercial three-phase string inverters (100 kWac class, many
// MPPTs), so the per-orientation single-inverter string rules do not bind.
function commercialGridCheck(arrays, panel, kWp, dcac, capKwp) {
  const unitKwac = kWp > 60 ? 100 : kWp > 20 ? 30 : 10;
  const inverters = Math.max(1, Math.ceil(kWp / dcac / unitKwac));
  const inverterKwac = inverters * unitKwac;
  const vocCold = panel.vocV ? panel.vocV * (1 + panel.vocTempCoeff * ((CLIMATE_KL.designMinCellC ?? 15) - 25)) : null;
  const maxSeries = vocCold ? Math.floor(1100 / vocCold) : 20;
  const ok = kWp <= capKwp + 1e-9;
  const notes = [
    `${inverters} × ${unitKwac} kWac three-phase string inverter${inverters > 1 ? 's' : ''} (DC/AC ${(kWp / inverterKwac).toFixed(2)}); strings of up to ${maxSeries} modules at 1,100 V DC.`,
    ok ? `Within the Solar ATAP non-domestic cap (${fmtInt(capKwp)} kWp).` : `Above the Solar ATAP non-domestic cap (${fmtInt(capKwp)} kWp).`,
    'Non-domestic connection: TNB/ST application and a single-line diagram from a registered installer required.',
  ];
  // Strings per array: the longest equal length inside the 1,100 V / MPPT window
  // that divides the array; otherwise full strings plus one shorter string on
  // its own MPPT (commercial inverters have many).
  const vmpHot = panel.vocV ? (panel.vmpV || panel.vocV * 0.83) * (1 + panel.tempCoeff * ((CLIMATE_KL.designMaxCellC ?? 75) - 25)) : null;
  const minSeries = vmpHot ? Math.ceil(200 / vmpHot) : 1;
  const mppts = [];
  for (const a of arrays) {
    let per = null;
    for (let s = maxSeries; s >= minSeries; s--) if (a.panels % s === 0) { per = s; break; }
    const v = (s) => (vocCold ? +(vocCold * s).toFixed(0) : null);
    const vh = (s) => (vmpHot ? +(vmpHot * s).toFixed(0) : null);
    if (per) mppts.push({ arrayIds: [a.id], modules: a.panels, strings: a.panels / per, modulesPerString: per, vocColdV: v(per), vmpHotV: vh(per), valid: true });
    else {
      const full = Math.floor(a.panels / maxSeries), rest = a.panels - full * maxSeries;
      mppts.push({ arrayIds: [a.id], modules: full * maxSeries, strings: full, modulesPerString: maxSeries, vocColdV: v(maxSeries), vmpHotV: vh(maxSeries), valid: true });
      if (rest) mppts.push({ arrayIds: [a.id], modules: rest, strings: 1, modulesPerString: rest, vocColdV: v(rest), vmpHotV: vh(rest), valid: rest >= minSeries });
    }
  }
  const stringCount = mppts.reduce((t, m) => t + m.strings, 0);
  notes.splice(1, 0, `${fmtInt(stringCount)} strings across ${inverters} inverter${inverters > 1 ? 's' : ''} (about ${Math.ceil(stringCount / inverters)} per inverter).`);
  return { programme: GRID_RULES_MY?.programme || 'Solar ATAP', phase: 'three', limitKwac: inverterKwac, inverterKwac, dcAc: +(kWp / inverterKwac).toFixed(2), mppts,
    withinLimits: ok && mppts.every((m) => m.valid), notes, maxModulesPerString: maxSeries, minModulesPerString: minSeries, commercial: true, inverters, unitKwac,
    suggestedInverterKwac: inverterKwac, dcAcRatio: +(kWp / inverterKwac).toFixed(2), withinLimit: ok };
}

// ----------------------------------------------------------------------------- heatmap
export function roofHeatmap(twin, occupancy, options = {}) {
  const loc = twin.location || {};
  const lat = options.lat ?? loc.lat ?? CLIMATE_KL.lat, lon = options.lon ?? loc.lon ?? CLIMATE_KL.lon, tz = loc.timezone ?? 8;
  const northBearing = Number.isFinite(options.northBearing) ? options.northBearing : (twin.northBearing || 0) + (options.northOffsetDeg || 0);
  const grid = occupancyFrom(twin, occupancy);
  const sun = sunData(lat, lon, tz, northBearing, options.stepMin ?? twin?.planDefaults?.stepMin ?? 30);
  const fc = options.fluxCell ?? twin?.planDefaults?.fluxCell ?? 0.25;
  const o = { mounting: options.mounting || twin?.planDefaults?.mounting || 'flush', tiltDeg: options.tiltDeg, cell: fc, rayStride: options.rayStride ?? twin?.planDefaults?.rayStride, shadeBlock: options.shadeBlock ?? twin?.planDefaults?.shadeBlock, albedo: options.albedo ?? 0.2, lat, northBearing,
    roofIds: options.roofIds, buildingIds: options.buildingIds, allBuildings: options.allBuildings };
  const want = Math.max(fc, options.cell ?? 0.5);
  const agg = Math.max(1, Math.round(want / fc));
  let min = Infinity, max = -Infinity;
  const roofs = [];
  for (const roof of targetRoofs(twin, o)) {
    const frame = roofFrame(roof, northBearing);
    const flux = buildFlux(twin, grid, roof, frame, sun, o);
    const nu = Math.ceil(flux.nu / agg), nv = Math.ceil(flux.nv / agg);
    const values = new Float32Array(nu * nv).fill(NaN);
    const cells = [];
    const c = flux.cell * agg;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      let s = 0, k = 0;
      for (let jj = j * agg; jj < Math.min(flux.nv, (j + 1) * agg); jj++) for (let ii = i * agg; ii < Math.min(flux.nu, (i + 1) * agg); ii++) {
        const q = ii + flux.nu * jj;
        if (flux.active[q]) { s += flux.poa[q]; k++; }
      }
      if (!k) continue;
      const v = s / k;
      values[i + nu * j] = v;
      min = Math.min(min, v); max = Math.max(max, v);
      const a = frame.umin + i * c, b = frame.vmin + j * c;
      cells.push({ i, j, poa: +v.toFixed(1), centre: r3(frame.from(a + c / 2, b + c / 2, 0.03)),
        corners: [[a, b], [a + c, b], [a + c, b + c], [a, b + c]].map(([x, y]) => r3(frame.from(x, y, 0.03))) });
    }
    roofs.push({ roofId: roof.id, cell: c, nu, nv, origin: r3(frame.from(frame.umin, frame.vmin, 0)), axisU: r3(frame.u, 5), axisV: r3(frame.v, 5), values, best: flux.best, cells });
  }
  return { roofs, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0, units: 'kWh/m²/yr (plane of array, shaded)' };
}

// ----------------------------------------------------------------------------- time-of-day mode
export function instantShading(a, b, c, d, e) {
  // Accepted forms:
  //   (twin, occ, plan, date)               contract
  //   (twin, occ, plan, sun, date)          sun = { azimuth, elevation, s: twin-frame vector }
  //   (plan, occ, sun, { twin, date })      older viewer form
  let twin, occ, plan, date, sunArg = null;
  if (a && Array.isArray(a.panels) && !a.roofs) { plan = a; occ = b; sunArg = c; twin = d?.twin; date = d?.date; }
  else {
    twin = a; occ = b; plan = c;
    if (d instanceof Date || typeof d === 'number' || typeof d === 'string') date = d;
    else { sunArg = d || null; date = e; }
  }
  if (!plan) return { panels: [], totalW: 0 };
  date = date instanceof Date ? date : new Date(date ?? Date.now());
  const loc = twin?.location || {};
  const lat = loc.lat ?? CLIMATE_KL.lat, lon = loc.lon ?? CLIMATE_KL.lon;
  const nb = twin?.northBearing || 0;
  const g = solarGeometry(date, lat, lon);
  const elevation = sunArg?.elevation ?? g.elevation, azimuth = sunArg?.azimuth ?? g.azimuth;
  const sv = Array.isArray(sunArg?.s) ? norm(sunArg.s) : Array.isArray(sunArg) ? norm(sunArg) : sunVectorTwin(azimuth, elevation, nb);
  const grid = twin ? occupancyFrom(twin, occ) : (occ?.data ? makeGrid(occ) : null);
  // typical-sky irradiance for this month at this sun height
  const month = new Date(date.getTime() + 8 * 3600e3).getUTCMonth();
  const cosZ = Math.max(0, Math.sin(elevation * RAD));
  const clr = (CLIMATE_KL.ghiKwhM2Day?.[month] ?? 4.8) / (CLIMATE_KL.clearSkyGhiKwhM2Day?.[month] ?? 6.5);
  const ghi = haurwitzGhi(cosZ) * clr;
  const doy = dayOfYear(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  const e0 = extraterrestrialNormal(doy);
  const fd = erbsDiffuseFraction(Math.min(1, ghi / Math.max(1, e0 * Math.max(cosZ, 0.0436))));
  const dhi = ghi * fd, dni = cosZ > 0.0436 ? (ghi - dhi) / cosZ : 0;
  const cs = { ghi, dhi, dni, cosZ, ai: Math.min(1, dni / e0) };
  const hourLocal = ((date.getTime() / 3600e3 + 8) % 24 + 24) % 24;
  const tAmb = ambientAt(month, hourLocal);
  const wind = CLIMATE_KL.windMS2m?.[month] ?? 0.8;
  const derate = systemDerate(LOSSES);
  const cache = new Map();
  const out = [];
  let total = 0;
  for (const p of plan.panels) {
    const n = p.normal;
    const roof = twin?.roofs?.find((r) => r.id === p.roofId);
    let ign = null;
    if (roof) { if (!cache.has(roof.id)) cache.set(roof.id, ignorePlane(roofFrame(roof, nb), grid ? grid.voxel : 0.25)); ign = cache.get(roof.id); }
    let sunlit = 0;
    const cosT = dot(n, sv);
    if (elevation > 0 && cosT > 0) {
      if (!grid) sunlit = 1;
      else {
        // 3 × 6 points on the module, 6 bypass units (min within each)
        const [c0, c1, , c3] = p.corners;
        const eu = sub(c1, c0), ev = sub(c3, c0);
        const longV = Math.hypot(...ev) >= Math.hypot(...eu);
        let sum = 0;
        for (let s = 0; s < 3; s++) for (let half = 0; half < 2; half++) {
          let m = 1;
          for (let b = 0; b < 3; b++) {
            const fa = (s + 0.5) / 3, fb = (half * 3 + b + 0.5) / 6;
            const q = longV ? add(c0, add(mul(eu, fa), mul(ev, fb))) : add(c0, add(mul(eu, fb), mul(ev, fa)));
            const st = add(q, mul(n, 0.2));
            if (castRay(grid, st[0], st[1], st[2], sv[0], sv[1], sv[2], 200, ign) >= 0) { m = 0; break; }
          }
          sum += m;
        }
        sunlit = sum / 6;
      }
    }
    const skyF = p.skyFrac ?? (1 + n[1]) / 2, gndF = p.gndFrac ?? (1 - n[1]) / 2;
    const comp = poaComponents(cs, n, sv, 1, skyF, gndF, 0.2);
    const iam = iamBeam(cosT), iamD = iamDiffuse(p.tiltDeg ?? 20);
    const geff = (comp.beam + comp.circ) * iam * sunlit + comp.sky * iamD.sky + comp.ground * iamD.ground;
    const poa = (comp.beam + comp.circ) * sunlit + comp.sky + comp.ground;
    const pan = normalizePanel(plan.summary?.panelId);
    const tc = faimanCellTemp(poa, tAmb, wind, 20, 5);
    const w = elevation > 0 ? Math.max(0, pan.watt * (geff / 1000) * (1 + pan.tempCoeff * (tc - 25)) * derate) : 0;
    total += w;
    out.push({ id: p.id, sunlit: +sunlit.toFixed(3), watts: Math.round(w), poaWm2: Math.round(poa), cellTempC: +tc.toFixed(1) });
  }
  return { panels: out, totalW: Math.round(total), sun: { azimuth, elevation, vector: sv }, irradiance: { ghi: Math.round(ghi), dni: Math.round(dni), dhi: Math.round(dhi) } };
}
