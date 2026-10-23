// Checks on the prepared drone-scan twin (public/twins/friend-house). Skipped if not prepared.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planArray } from '../src/twin/placement.js';
import { PANELS, DEFAULT_PANEL_ID } from '../src/twin/catalogue.js';

const dir = new URL('../public/twins/friend-house/', import.meta.url);
const have = fs.existsSync(new URL('twin.json', dir)) && fs.existsSync(new URL('occupancy.bin', dir));
const PANEL = PANELS.find((p) => p.id === DEFAULT_PANEL_ID);

test('prepared twin follows the contract', { skip: !have }, () => {
  const twin = JSON.parse(fs.readFileSync(new URL('twin.json', dir), 'utf8'));
  for (const k of ['id', 'pointCount', 'bounds', 'scale', 'northBearing', 'location', 'ground', 'roofs', 'occupancy']) assert.ok(k in twin, k);
  assert.ok(twin.scale.metresPerUnit > 0 && /low|medium|high/.test(twin.scale.confidence));
  const occ = fs.readFileSync(new URL('occupancy.bin', dir));
  const [nx, ny, nz] = twin.occupancy.dims;
  assert.equal(occ.length, nx * ny * nz);
  const pts = fs.statSync(new URL('points.bin', dir)).size;
  assert.equal(pts, twin.pointCount * 12);
  assert.ok(pts <= 6.3e6, `points.bin ${pts} B`);
  for (const r of twin.roofs) {
    assert.ok(Math.abs(Math.hypot(...r.normal) - 1) < 1e-3 && r.normal[1] > 0, `${r.id} normal`);
    assert.ok(r.outline.length >= 3 && r.area > 0);
    for (const p of r.outline) assert.ok(Math.abs((p[0] - r.point[0]) * r.normal[0] + (p[1] - r.point[1]) * r.normal[1] + (p[2] - r.point[2]) * r.normal[2]) < 0.02, `${r.id} outline on plane`);
    assert.ok(Math.abs(r.eaveDir[1]) < 0.02, `${r.id} eave horizontal`);
  }
  assert.ok(twin.buildings.filter((b) => b.primary).length === 1);
});

test('default plan on the real scan is physical and within the ATAP cap', { skip: !have }, () => {
  const twin = JSON.parse(fs.readFileSync(new URL('twin.json', dir), 'utf8'));
  const occ = { ...twin.occupancy, data: new Uint8Array(fs.readFileSync(new URL('occupancy.bin', dir))) };
  const t0 = performance.now();
  const plan = planArray(twin, occ, {});
  const ms = performance.now() - t0;
  const s = plan.summary;
  assert.ok(s.panels >= 6, `panels ${s.panels}`);
  assert.ok(s.kWp <= 6.5 + 1e-9);
  assert.equal(s.kWp, +(s.panels * PANEL.watt / 1000).toFixed(3));
  assert.ok(s.specificYield >= 1100 && s.specificYield <= 1450, `yield ${s.specificYield}`);
  assert.ok(s.performanceRatio >= 0.72 && s.performanceRatio <= 0.84, `PR ${s.performanceRatio}`);
  const prim = twin.buildings.find((b) => b.primary).roofIds;
  for (const p of plan.panels) {
    assert.ok(prim.includes(p.roofId));
    const r = twin.roofs.find((x) => x.id === p.roofId);
    for (const c of p.corners) {
      const h = (c[0] - r.point[0]) * r.normal[0] + (c[1] - r.point[1]) * r.normal[1] + (c[2] - r.point[2]) * r.normal[2];
      assert.ok(h > 0.08 && h < 0.15, `${p.id} ${h}`);
    }
  }
  assert.ok(ms < 4000, `plan took ${ms} ms in node`);
});

test('max plan on the real scan: disjoint modules inside each roof outline, setbacks met', { skip: !have }, async () => {
  const { roofFrame } = await import('../src/twin/placement.js');
  const twin = JSON.parse(fs.readFileSync(new URL('twin.json', dir), 'utf8'));
  const occ = { ...twin.occupancy, data: new Uint8Array(fs.readFileSync(new URL('occupancy.bin', dir))) };
  const plan = planArray(twin, occ, { sizeMode: 'max', targetKwp: null });
  assert.ok(plan.panels.length > 15);
  const seg = (p, a, b) => { const d = [b[0] - a[0], b[1] - a[1]]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2 + 1e-12))); return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]); };
  const need = { eave: 0.4, ridge: 0.5, verge: 0.4, valley: 0.3, abutment: 0.3, edge: 0.4 };
  const rects = [];
  for (const p of plan.panels) {
    const f = roofFrame(twin.roofs.find((r) => r.id === p.roofId));
    const uv = p.corners.map((c) => f.toUV(c));
    for (const e of f.edges) for (const q of uv) assert.ok(seg(q, e.a, e.b) >= need[e.type] - 1e-6, `${p.id} ${e.type}`);
    const us = uv.map((q) => q[0]), vs = uv.map((q) => q[1]);
    rects.push({ id: p.id, roof: p.roofId, box: [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)], c: p.centre });
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const A = rects[i], B = rects[j];
    if (A.roof === B.roof) {
      const sep = Math.max(B.box[0] - A.box[2], A.box[0] - B.box[2], B.box[1] - A.box[3], A.box[1] - B.box[3]);
      assert.ok(sep >= 0.018, `${A.id} overlaps ${B.id} (${sep})`);
    } else assert.ok(Math.hypot(A.c[0] - B.c[0], A.c[1] - B.c[1], A.c[2] - B.c[2]) > 1.0, `${A.id} clashes with ${B.id}`);
  }
});

test('default plan wires as equal strings under 600 V and reports a ground-calibrated yield', { skip: !have }, () => {
  const twin = JSON.parse(fs.readFileSync(new URL('twin.json', dir), 'utf8'));
  const occ = { ...twin.occupancy, data: new Uint8Array(fs.readFileSync(new URL('occupancy.bin', dir))) };
  const s = planArray(twin, occ, {}).summary;
  assert.equal(s.mode, 'system');
  assert.ok(s.grid.withinLimits, s.grid.notes.join(' '));
  assert.ok(s.grid.inverterKwac <= 5 && s.grid.dcAc <= 1.25, `${s.grid.inverterKwac} kWac, DC/AC ${s.grid.dcAc}`);
  assert.ok(s.grid.mppts.length <= 2);
  for (const m of s.grid.mppts) {
    assert.equal(m.strings * m.modulesPerString, m.modules, 'equal strings only');
    assert.ok(m.vocColdV <= 600, `Voc cold ${m.vocColdV} V`);
  }
  assert.ok(s.yield.groundCalibratedKwh < s.yield.modelledKwh);
  assert.ok(s.specificYieldCalibrated >= 1100 && s.specificYieldCalibrated <= 1350, `${s.specificYieldCalibrated} kWh/kWp`);
});
