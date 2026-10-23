import test from 'node:test';
import assert from 'node:assert/strict';
import { planArray, roofHeatmap, instantShading, roofFrame } from '../src/twin/placement.js';
import { PANELS, DEFAULT_PANEL_ID, MOUNTING, CLIMATE_KL } from '../src/twin/catalogue.js';
import { solarGeometry, localDate, sunVectorTwin } from '../src/twin/sun.js';
import { gableHouse, flatSlab } from './twin-fixtures.js';

const PANEL = PANELS.find((p) => p.id === DEFAULT_PANEL_ID);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);

function distPtSeg(p, a, b) {
  const d = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2)));
  return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]);
}
// min distance between two convex polygons that do not overlap (vertex-to-edge both ways)
function polyDist(P, Q) {
  let d = Infinity;
  for (const p of P) for (let i = 0; i < Q.length; i++) d = Math.min(d, distPtSeg(p, Q[i], Q[(i + 1) % Q.length]));
  for (const q of Q) for (let i = 0; i < P.length; i++) d = Math.min(d, distPtSeg(q, P[i], P[(i + 1) % P.length]));
  return d;
}

const house = gableHouse({});
const plan = planArray(house.twin, house.occ, { sizeMode: 'max', targetKwp: null });

test('max plan on the synthetic gable produces arrays on both faces', () => {
  assert.ok(plan.panels.length >= 12, `panels ${plan.panels.length}`);
  assert.ok(plan.arrays.length >= 2);
  assert.equal(plan.summary.panels, plan.panels.length);
});

test('kWp arithmetic is exact and arrays add up', () => {
  assert.equal(plan.summary.kWp, +(plan.panels.length * PANEL.watt / 1000).toFixed(3));
  const sumA = plan.arrays.reduce((a, x) => a + x.kWp, 0);
  assert.ok(Math.abs(sumA - plan.summary.kWp) < 1e-6);
  assert.equal(plan.arrays.reduce((a, x) => a + x.panels, 0), plan.panels.length);
});

test('arrays are full rectangles on a lattice with 20 mm gaps and true module sizes', () => {
  for (const a of plan.arrays) {
    const ps = plan.panels.filter((p) => p.arrayId === a.id);
    assert.equal(ps.length, a.rows * a.cols);
    const rows = new Map();
    for (const p of ps) rows.set(p.row, (rows.get(p.row) || 0) + 1);
    for (const n of rows.values()) assert.equal(n, a.cols, 'every row the same length');
    assert.ok(a.rows * a.cols >= 4);
    assert.ok(a.gapM >= 0.018 && a.gapM <= 0.025);
    const c0 = ps.find((p) => p.row === 1 && p.col === 1).centre;
    for (const p of ps) {
      const d = sub(p.centre, c0);
      const du = dot(d, a.axisU) / a.colPitchM, dv = dot(d, a.axisV) / a.rowPitchM;
      assert.ok(Math.abs(du - (p.col - 1)) * a.colPitchM < 0.005, `u lattice ${du}`);
      assert.ok(Math.abs(dv - (p.row - 1)) * a.rowPitchM < 0.005, `v lattice ${dv}`);
      const e1 = len(sub(p.corners[1], p.corners[0])), e2 = len(sub(p.corners[2], p.corners[1]));
      const [s, l] = [Math.min(e1, e2), Math.max(e1, e2)];
      assert.ok(Math.abs(s - PANEL.widthM) < 0.005 && Math.abs(l - PANEL.lengthM) < 0.005, `dims ${s} ${l}`);
      // CCW seen from above (x east right, north up)
      let area = 0;
      for (let i = 0; i < 4; i++) { const q = p.corners[i], r = p.corners[(i + 1) % 4]; area += q[0] * -r[2] - r[0] * -q[2]; }
      assert.ok(area > 0, 'corners CCW from above');
    }
  }
});

test('flush modules are coplanar with their roof at the rail standoff (checklist 6, 13)', () => {
  const standoff = MOUNTING.flush.standoffM;
  for (const p of plan.panels) {
    const roof = house.twin.roofs.find((r) => r.id === p.roofId);
    const n = roof.normal;
    for (const c of p.corners) {
      const h = dot(sub(c, roof.point), n);
      assert.ok(Math.abs(h - standoff) < 1e-3, `corner ${h} m above plane`);
      assert.ok(h >= 0.08 && h <= 0.15);
    }
    assert.ok(dot(p.normal, n) >= Math.cos(Math.PI / 180));
    assert.ok(Math.abs(p.tiltDeg - roof.tilt) < 1);
  }
});

test('every module is inside the roof, clear of eave/verge 0.4 m, ridge 0.5 m and the vent by 0.3 m', () => {
  for (const p of plan.panels) {
    const roof = house.twin.roofs.find((r) => r.id === p.roofId);
    const f = roofFrame(roof);
    const rect = p.corners.map((c) => f.toUV(c));
    for (const e of f.edges) {
      const need = { eave: 0.4, ridge: 0.5, verge: 0.4 }[e.type];
      const d = Math.min(...rect.map((q) => distPtSeg(q, e.a, e.b)), distPtSeg(e.a, rect[0], rect[1]), distPtSeg(e.a, rect[1], rect[2]), distPtSeg(e.a, rect[2], rect[3]), distPtSeg(e.a, rect[3], rect[0]));
      assert.ok(d >= need - 1e-6, `${p.id} ${d.toFixed(3)} m from ${e.type}`);
    }
    for (const ob of roof.obstacles) {
      const q = ob.outline.map((c) => f.toUV(c));
      assert.ok(polyDist(rect, q) >= 0.3 - 1e-6, `${p.id} too close to the vent`);
    }
  }
});

test('modules avoid the tree-shaded zone: each has ≥ 80% of its roof\'s best flux', () => {
  const heat = roofHeatmap(house.twin, house.occ, { cell: 0.25 });
  for (const r of heat.roofs) {
    const ps = plan.panels.filter((p) => p.roofId === r.roofId);
    for (const p of ps) assert.ok(p.poaKwhM2 >= 0.8 * r.best - 1, `${p.id} ${p.poaKwhM2} vs best ${r.best}`);
  }
  // the tree west of the house shades the west end of the south face: there must be low-flux cells there and none under modules
  const south = heat.roofs.find((r) => r.roofId === 'S');
  const shaded = south.cells.filter((c) => c.poa < 0.8 * south.best);
  assert.ok(shaded.length > 5, 'tree casts a measurable shadow');
  // apart from the vent's own small shadow, the shaded cells are on the west (tree) side
  const vent = house.twin.roofs[0].obstacles[0].outline;
  const vc = vent.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4, a[2] + q[2] / 4], [0, 0, 0]);
  const farFromVent = shaded.filter((c) => Math.hypot(c.centre[0] - vc[0], c.centre[2] - vc[2]) > 1.5);
  assert.ok(farFromVent.length > 5 && farFromVent.every((c) => c.centre[0] < 0), 'tree shadow is on the west side');
  for (const p of plan.panels.filter((x) => x.roofId === 'S')) {
    for (const c of shaded) {
      const f = roofFrame(house.twin.roofs[0]);
      const [a, b] = f.toUV(c.centre), rect = p.corners.map((q) => f.toUV(q));
      const inside = a > Math.min(...rect.map((q) => q[0])) && a < Math.max(...rect.map((q) => q[0])) && b > Math.min(...rect.map((q) => q[1])) && b < Math.max(...rect.map((q) => q[1]));
      assert.ok(!inside, `${p.id} sits on a shaded cell`);
    }
  }
  assert.ok(plan.rejected.some((r) => r.kind === 'shade' && r.roofId === 'S'), 'shaded zone reported as rejected with a reason');
  assert.ok(plan.rejected.some((r) => r.kind === 'obstacle' && /vent/.test(r.why)));
});

test('loads and weights are physical (checklist 11)', () => {
  for (const a of plan.arrays) {
    assert.ok(a.loadKgM2 >= 10 && a.loadKgM2 <= 20, `load ${a.loadKgM2}`);
    const ratio = a.weightKg / (a.panels * PANEL.weightKg);
    assert.ok(ratio >= 1.1 && ratio <= 1.4, `weight ratio ${ratio}`);
  }
});

test('energy: specific yield, PR, POA, thermal and monthly shape are plausible for KL', () => {
  const open = gableHouse({ vent: false, tree: false, pitch: 20 });
  const p = planArray(open.twin, open.occ, { sizeMode: 'max', targetKwp: null });
  const s = p.summary;
  assert.ok(s.specificYield >= 1100 && s.specificYield <= 1450, `yield ${s.specificYield}`);
  assert.ok(s.performanceRatio >= 0.72 && s.performanceRatio <= 0.84, `PR ${s.performanceRatio}`);
  assert.ok(s.avgShadeLoss < 0.05, `open roof shade ${s.avgShadeLoss}`);
  assert.ok(s.meanCellTempC >= 45 && s.meanCellTempC <= 60);
  assert.ok(s.thermalLoss >= 0.05 && s.thermalLoss <= 0.11);
  const m = s.monthlyKwh, ratio = Math.max(...m) / Math.min(...m);
  assert.ok(ratio >= 1.1 && ratio <= 1.4, `monthly ratio ${ratio}`);
  for (const q of p.panels) {
    assert.ok(q.poaUnshadedKwhM2 >= 0.9 * CLIMATE_KL.annualGhiKwhM2 && q.poaUnshadedKwhM2 <= 1.03 * CLIMATE_KL.annualGhiKwhM2, `POA ${q.poaUnshadedKwhM2}`);
    assert.ok(q.poaKwhM2 <= 1820);
  }
  // north- vs south-facing 20° faces within ±8% at 3°N (checklist 20)
  const yS = p.arrays.filter((a) => a.roofId === 'S'), yN = p.arrays.filter((a) => a.roofId === 'N');
  const sy = (as) => as.reduce((a, x) => a + x.annualKwh, 0) / as.reduce((a, x) => a + x.kWp, 0);
  assert.ok(yS.length && yN.length);
  assert.ok(Math.abs(sy(yN) / sy(yS) - 1) <= 0.08, `N/S ${sy(yN)} ${sy(yS)}`);
});

test('size cap: default follows Solar ATAP single-phase (≤ 6.5 kWp DC cap, ≤ 2 orientations, ≥ 6 per MPPT), target shrinks whole rows/columns', () => {
  const d = planArray(house.twin, house.occ, {});
  assert.ok(d.summary.kWp <= 6.5 + 1e-9 && d.summary.kWp > 4, `default ${d.summary.kWp}`);
  const per = new Map();
  for (const a of d.arrays) per.set(`${Math.round(a.azimuthDeg)}/${Math.round(a.tiltDeg)}`, (per.get(`${Math.round(a.azimuthDeg)}/${Math.round(a.tiltDeg)}`) || 0) + a.panels);
  assert.ok(per.size <= 2);
  for (const n of per.values()) assert.ok(n >= 6);
  const t = planArray(house.twin, house.occ, { targetKwp: 3 });
  assert.ok(t.summary.kWp <= 3 + 1e-9 && t.summary.panels >= 4, `target ${t.summary.kWp}`);
  for (const a of t.arrays) assert.equal(t.panels.filter((p) => p.arrayId === a.id).length, a.rows * a.cols);
  const mp = planArray(house.twin, house.occ, { maxPanels: 8 });
  assert.ok(mp.summary.panels <= 8);
});

test('ranking and reasons are data-driven (checklist 14)', () => {
  const ranked = plan.panels.slice().sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].annualKwh >= ranked[i].annualKwh - 1e-6);
  for (const p of plan.panels) {
    assert.ok(p.reason.headline.length > 10 && p.reason.bullets.length >= 4);
    if (p.shadeLoss > 0.10) assert.ok(/shade/i.test(p.reason.headline));
    assert.ok(/kWh/.test(p.reason.headline) || /shade/i.test(p.reason.headline));
  }
  for (const a of plan.arrays) assert.ok(a.reason.headline.includes('kWp'));
});

test('flat slab gets tilted racks facing the equator with a shade-free row pitch (checklist 12)', () => {
  const f = flatSlab();
  const p = planArray(f.twin, f.occ, { mounting: 'tilted' });
  assert.ok(p.panels.length >= 8);
  const beta = 10 * Math.PI / 180;
  // independent profile-angle check: Dec 21, 9:00-15:00 solar time
  let minTan = Infinity;
  for (let h = 0; h < 24; h += 0.1) {
    const g = solarGeometry(localDate(2026, 12, 21, h, 8), 3.11, 101.58);
    const sh = g.trueSolarMin / 60;
    if (sh < 9 || sh > 15) continue;
    const v = sunVectorTwin(g.azimuth, g.elevation, 0);
    const along = v[2]; // racks face south (+z)
    if (along > 0) minTan = Math.min(minTan, v[1] / along);
  }
  for (const a of p.arrays) {
    const L = a.orientation === 'portrait' ? PANEL.lengthM : PANEL.widthM; // slant length up the rack
    const need = L * Math.cos(beta) + L * Math.sin(beta) / minTan;
    assert.equal(a.tiltDeg, 10);
    assert.ok(Math.abs(a.azimuthDeg - 180) < 1);
    if (a.rows > 1) assert.ok(a.rowPitchM >= need - 0.01, `pitch ${a.rowPitchM} < ${need}`);
    // ground-cover ratio ≤ 0.8
    assert.ok(L / a.rowPitchM <= 0.8 + 1e-9 || a.rows === 1, `GCR ${L / a.rowPitchM}`);
  }
  for (const q of p.panels) {
    const low = Math.min(...q.corners.map((c) => c[1])) - 6.05;
    assert.ok(low >= 0.15 - 1e-6, `low edge ${low}`);
    assert.ok(Math.abs(q.tiltDeg - 10) < 1e-6);
    const roof = f.twin.roofs[0];
    const f2 = roofFrame(roof);
    const rect = q.corners.map((c) => f2.toUV(c));
    for (const e of f2.edges) assert.ok(Math.min(...rect.map((r) => distPtSeg(r, e.a, e.b))) >= 1.0 - 1e-6, 'slab edge setback 1.0 m');
  }
  assert.ok(p.summary.specificYield >= 1100 && p.summary.specificYield <= 1450, `flat yield ${p.summary.specificYield}`);
});

test('pitched roof never gets tilt-up racks even if asked', () => {
  const p = planArray(house.twin, house.occ, { mounting: 'tilted', sizeMode: 'max', targetKwp: null });
  for (const q of p.panels) assert.ok(Math.abs(q.tiltDeg - house.pitch) < 1);
  assert.ok(p.summary.assumptions.some((a) => /flush/.test(a)));
});

test('instantShading: dark at night, mostly lit at noon, both call forms', () => {
  const night = instantShading(house.twin, house.occ, plan, localDate(2026, 3, 20, 23, 8));
  assert.ok(night.panels.every((p) => p.sunlit === 0 && p.watts === 0));
  const noon = instantShading(house.twin, house.occ, plan, localDate(2026, 3, 20, 13.3, 8));
  const lit = noon.panels.filter((p) => p.sunlit > 0.99).length;
  assert.ok(lit >= plan.panels.length * 0.9, `lit ${lit}/${plan.panels.length}`);
  assert.ok(noon.totalW > plan.summary.kWp * 1000 * 0.45 && noon.totalW < plan.summary.kWp * 1000, `noon W ${noon.totalW}`);
  const viewerForm = instantShading(plan, house.occ, { azimuth: 180, elevation: 80 }, { twin: house.twin, date: localDate(2026, 3, 20, 13.3, 8) });
  assert.equal(viewerForm.panels.length, plan.panels.length);
  // late afternoon: the tree to the west shades part of the south face
  const late = instantShading(house.twin, house.occ, plan, localDate(2026, 3, 20, 18.2, 8));
  assert.ok(late.panels.some((p) => p.sunlit < 1) || late.totalW < noon.totalW * 0.3);
});

test('deterministic and fast re-plan', () => {
  const strip = (p) => JSON.stringify({ ...p, summary: { ...p.summary, timings: null } });
  const a = planArray(house.twin, house.occ, { sizeMode: 'max', targetKwp: null });
  const b = planArray(house.twin, house.occ, { sizeMode: 'max', targetKwp: null });
  assert.equal(strip(a), strip(b));
  const t0 = performance.now();
  planArray(house.twin, house.occ, { setback: 0.6, sizeMode: 'max', targetKwp: null });
  assert.ok(performance.now() - t0 < 1500);
});
