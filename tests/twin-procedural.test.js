// Level-1 map twins (src/twin/procedural.js) + the planner's large-roof options.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSiteTwin, minRect } from '../src/twin/procedural.js';
import { planArray } from '../src/twin/placement.js';
import { placeBattery } from '../src/twin/battery.js';
import { buildSites, scoreSites, rankSites, DEFAULT_ASSUMPTIONS, BUSINESS_CATEGORIES } from '../src/solar.js';

// site in map metres (x east, y NORTH), as buildSites() makes them
const rect = (x0, y0, w, h) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]];
function site(id, xy, category, height, extra = {}) {
  const ring = xy.slice(0, -1);
  const c = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
  let area = 0; for (let i = 0; i < ring.length; i++) { const q = ring[(i + 1) % ring.length]; area += ring[i][0] * q[1] - q[0] * ring[i][1]; }
  return { id, xy, centroid: c, category, height, area: Math.abs(area / 2), position: [101.58, 3.11], tags: {}, ...extra };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function checkContract(r) {
  const { twin, occupancy } = r;
  assert.equal(twin.level, 1);
  assert.match(twin.source, /OpenStreetMap footprint/);
  assert.deepEqual(twin.scale, { metresPerUnit: 1, method: 'map metres', confidence: 'medium' });
  assert.equal(occupancy.data.length, occupancy.dims[0] * occupancy.dims[1] * occupancy.dims[2]);
  assert.deepEqual(twin.occupancy.dims, occupancy.dims);
  assert.ok(occupancy.dims[0] * occupancy.dims[1] * occupancy.dims[2] <= 8.5e6, `grid ${occupancy.dims}`);
  assert.equal(twin.buildings.filter((b) => b.primary).length, 1);
  for (const roof of twin.roofs) {
    assert.ok(Math.abs(Math.hypot(...roof.normal) - 1) < 1e-3 && roof.normal[1] > 0, `${roof.id} normal`);
    assert.equal(roof.edges.length, roof.outline.length);
    assert.ok(roof.area > 0 && Math.abs(roof.eaveDir[1]) < 1e-6);
    for (const p of roof.outline) assert.ok(Math.abs(dot([p[0] - roof.point[0], p[1] - roof.point[1], p[2] - roof.point[2]], roof.normal)) < 0.02, `${roof.id} planar`);
    assert.deepEqual(roof.obstacles, []);
  }
  assert.ok(r.notes.length >= 3 && r.meshes.buildings.some((b) => b.isSite));
}

test('minimum bounding rectangle of a rotated rectangle', () => {
  const a = 30 * Math.PI / 180, R = (x, y) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const m = minRect([R(-10, -4), R(10, -4), R(10, 4), R(-10, 4), R(0, 0)]);
  assert.ok(Math.abs(m.l - 10) < 1e-6 && Math.abs(m.w - 4) < 1e-6);
  assert.ok(Math.abs(Math.abs(m.a[0] * Math.cos(a) + m.a[1] * Math.sin(a)) - 1) < 1e-6);
});

test('home: hip roof with 4 planes, flush arrays on 2+ faces inside the setbacks', () => {
  const home = site('way/1', rect(-8, -6, 16, 12), 'residential', 7.5);
  const r = buildSiteTwin(home, []);
  checkContract(r);
  const { twin } = r;
  assert.equal(twin.roofType, 'hip');
  assert.equal(twin.roofs.length, 4);
  for (const roof of twin.roofs) {
    assert.ok(Math.abs(roof.tilt - 25) < 0.01);
    const types = roof.edges.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'eave').length, 1);
    assert.ok(types.includes('hip'));
  }
  assert.equal(twin.roofs.filter((roof) => roof.edges.some((e) => e.type === 'ridge')).length, 2, 'ridge on the two long faces');
  assert.deepEqual(twin.roofs.map((x) => Math.round(x.azimuth)).sort((a, b) => a - b), [0, 90, 180, 270]);
  assert.ok(r.notes.some((n) => /hip/.test(n)) && r.notes.some((n) => /minimum bounding rectangle/.test(n)));
  assert.equal(twin.planDefaults.mounting, 'flush');

  const t0 = performance.now();
  const plan = planArray(twin, r.occupancy, { targetKwp: 10, phase: 'three' });
  const ms = performance.now() - t0;
  console.log(`  home plan ${ms.toFixed(0)} ms: ${plan.summary.panels} modules, ${plan.summary.kWp} kWp, ${plan.summary.specificYield} kWh/kWp, faces ${[...new Set(plan.arrays.map((a) => a.roofId))]}`);
  assert.ok(new Set(plan.arrays.map((a) => a.roofId)).size >= 2, 'arrays on 2+ faces');
  for (const p of plan.panels) assert.ok(Math.abs(p.tiltDeg - 25) < 0.5, 'flush on the 25° roof');
  for (const a of plan.arrays) for (const [k, d] of Object.entries(a.setbacks)) assert.ok(d >= (a.setbackRules[k] ?? 0) - 0.01, `${a.id} ${k} ${d}`);
  assert.ok(plan.summary.kWp <= 10 + 1e-9);
  assert.ok(plan.summary.specificYield > 1100 && plan.summary.specificYield < 1450);
  // default (no target): residential Solar ATAP single-phase cap still applies
  const def = planArray(twin, r.occupancy, {});
  assert.ok(def.summary.kWp <= 6.0 + 1e-9 && def.summary.panels > 0);
  const bat = placeBattery(twin, r.occupancy, def);
  assert.ok(bat.battery, bat.why);
});

test('long narrow residential footprint gets a gable roof with verges', () => {
  const r = buildSiteTwin(site('way/2', rect(0, 0, 42, 8), 'residential', 8), []);
  checkContract(r);
  assert.equal(r.twin.roofType, 'gable');
  assert.equal(r.twin.roofs.length, 2);
  for (const roof of r.twin.roofs) assert.deepEqual(roof.edges.map((e) => e.type).sort(), ['eave', 'ridge', 'verge', 'verge']);
  const forced = buildSiteTwin(site('way/2', rect(0, 0, 42, 8), 'residential', 8), [], { roofType: 'hip' });
  assert.equal(forced.twin.roofs.length, 4);
});

test('mall 100 × 60 m: flat slab, parapet voxels, tilted racks, kWp ≤ target, < 4 s', () => {
  const mall = site('way/3', rect(-50, -30, 100, 60), 'retail', 14, { name: 'Test Mall' });
  const r = buildSiteTwin(mall, []);
  checkContract(r);
  const { twin, occupancy } = r;
  assert.equal(twin.roofType, 'flat');
  assert.equal(twin.roofs.length, 1);
  assert.ok(twin.roofs[0].flat && twin.roofs[0].edges.every((e) => e.type === 'edge'));
  assert.ok(r.notes.some((n) => /rooftop plant not mapped|Rooftop plant .* not mapped/i.test(n)));
  assert.ok(occupancy.voxel >= 0.5);
  // parapet: a solid voxel above the slab at the edge, none in the middle
  const { origin, voxel, dims: [nx, ny] } = occupancy;
  const solid = (x, y, z) => occupancy.data[Math.floor((x - origin[0]) / voxel) + nx * (Math.floor((y - origin[1]) / voxel) + ny * Math.floor((z - origin[2]) / voxel))];
  assert.equal(solid(-49.9, 14.6, 0), 1, 'parapet');
  assert.equal(solid(0, 14.6, 0), 0, 'open slab');
  assert.equal(solid(0, 10, 0), 1, 'building');
  const t0 = performance.now();
  const plan = planArray(twin, occupancy, { targetKwp: 500 });
  const ms = performance.now() - t0;
  console.log(`  mall plan ${ms.toFixed(0)} ms: ${plan.summary.panels} modules, ${plan.summary.kWp} kWp, ${plan.summary.specificYield} kWh/kWp`);
  assert.ok(ms < 4000, `${ms} ms`);
  assert.ok(plan.summary.kWp <= 500 + 1e-9 && plan.summary.kWp > 400);
  assert.ok(plan.arrays.every((a) => a.mounting === 'tilted'));
  for (const p of plan.panels) assert.ok(p.tiltDeg >= 5 && p.tiltDeg <= 15);
  for (const a of plan.arrays) for (const d of Object.values(a.setbacks)) assert.ok(d >= 1.0 - 0.01, `${a.id} edge ${d}`);
  assert.ok(plan.summary.grid.withinLimits && plan.summary.grid.commercial);
  // a target above the Solar ATAP non-domestic cap is clamped
  const big = planArray(twin, occupancy, { targetKwp: 5000 });
  assert.ok(big.summary.kWp <= 1000 + 1e-9);
});

test('30,000 m² roof at the 1 MWp cap plans in < 4 s', () => {
  const shed = site('way/4', rect(-100, -75, 200, 150), 'industrial', 12);
  const r = buildSiteTwin(shed, []);
  const t0 = performance.now();
  const plan = planArray(r.twin, r.occupancy, { targetKwp: 1000 });
  const ms = performance.now() - t0;
  console.log(`  30,000 m² plan ${ms.toFixed(0)} ms: ${plan.summary.panels} modules, ${plan.summary.kWp} kWp`);
  assert.ok(ms < 4000, `${ms} ms`);
  assert.ok(plan.summary.kWp <= 1000 + 1e-9 && plan.summary.kWp > 900);
});

test('a tower to the west shades the west part of the roof', () => {
  const roofSite = site('way/5', rect(-30, -20, 60, 40), 'commercial', 8);
  const tower = site('way/6', rect(-56, -20, 22, 40), 'apartments', 60);
  const far = site('way/7', rect(500, 500, 10, 10), 'commercial', 10); // outside the radius
  const withTower = buildSiteTwin(roofSite, [roofSite, tower, far]);
  const open = buildSiteTwin(roofSite, []);
  assert.equal(withTower.twin.buildings.length, 2, 'tower only');
  assert.ok(withTower.notes.some((n) => /Neighbours within 80 m/.test(n)));
  const westCount = (r) => {
    const p = planArray(r.twin, r.occupancy, { sizeMode: 'max' });
    const west = p.panels.filter((q) => q.centre[0] < 0), east = p.panels.filter((q) => q.centre[0] >= 0);
    const loss = (ps) => ps.reduce((a, q) => a + q.shadeLoss, 0) / Math.max(1, ps.length);
    return { west: west.length, east: east.length, lossW: loss(west), lossE: loss(east), plan: p };
  };
  const a = westCount(withTower), b = westCount(open);
  console.log(`  west/east modules with tower ${a.west}/${a.east}, open ${b.west}/${b.east}`);
  assert.ok(a.west < b.west, 'fewer panels in the west half');
  assert.ok(a.west < a.east);
  assert.ok(a.lossW >= a.lossE);
  const shaded = a.plan.panels.find((q) => q.shadeLoss > 0.1);
  if (shaded) assert.match(shaded.reason.headline + shaded.reason.bullets.join(' '), /building|tall object/);
});

test('car park becomes a proposed solar canopy (flat slab at ~4.5 m, no walls)', () => {
  const cp = site('way/8', rect(0, 0, 50, 30), 'carpark', 4.5);
  const r = buildSiteTwin(cp, []);
  checkContract(r);
  assert.ok(r.notes.some((n) => /proposed solar canopy/.test(n)));
  assert.ok(Math.abs(r.twin.roofs[0].point[1] - 4.5) < 1e-6);
  const { origin, voxel, dims: [nx, ny] } = r.occupancy;
  const solid = (x, y, z) => r.occupancy.data[Math.floor((x - origin[0]) / voxel) + nx * (Math.floor((y - origin[1]) / voxel) + ny * Math.floor((z - origin[2]) / voxel))];
  assert.equal(solid(0, 1.5, 0), 0, 'no walls under the canopy');
  assert.equal(solid(0, 4.4, 0), 1, 'canopy slab');
  const plan = planArray(r.twin, r.occupancy, { targetKwp: 150 });
  assert.ok(plan.summary.kWp > 50 && plan.summary.kWp <= 150 + 1e-9);
});

const dataUrl = new URL('../public/data/ara-damansara.json', import.meta.url);
test('real sites in Ara Damansara: top business site and a home', { skip: !fs.existsSync(dataUrl) }, () => {
  const raw = JSON.parse(fs.readFileSync(dataUrl, 'utf8'));
  const { sites } = buildSites(raw);
  const yUrl = new URL('../public/data/yield-ara-damansara.json', import.meta.url);
  scoreSites(sites, DEFAULT_ASSUMPTIONS, fs.existsSync(yUrl) ? JSON.parse(fs.readFileSync(yUrl, 'utf8')) : null);
  const ranked = rankSites(sites);
  const biz = ranked.find((s) => BUSINESS_CATEGORIES.includes(s.category));
  const home = ranked.find((s) => s.category === 'residential' && s.area > 120 && s.area < 400);
  assert.ok(biz && home);
  for (const [s, opts] of [[biz, { targetKwp: biz.kwp }], [home, {}]]) {
    const t0 = performance.now();
    const r = buildSiteTwin(s, sites);
    const tb = performance.now() - t0;
    checkContract(r);
    const t1 = performance.now();
    const plan = planArray(r.twin, r.occupancy, opts);
    const tp = performance.now() - t1;
    const bat = placeBattery(r.twin, r.occupancy, plan);
    const sy = plan.summary.specificYield;
    console.log(`  ${s.id} ${s.name || s.category} (${Math.round(s.area)} m², ${r.twin.roofType}, ${r.twin.buildings.length - 1} neighbours, grid ${r.occupancy.dims.join('×')} @ ${r.occupancy.voxel} m): build ${tb.toFixed(0)} ms, plan ${tp.toFixed(0)} ms, ${plan.summary.kWp} kWp (map ${Math.round(s.kwp)}), ${sy} kWh/kWp, shade ${(plan.summary.avgShadeLoss * 100).toFixed(1)}%, battery ${bat.battery ? bat.battery.wallFaces : bat.why}`);
    assert.ok(plan.summary.panels > 0);
    assert.ok(sy >= 1100 && sy <= 1450, `specific yield ${sy}`);
    assert.ok(tp < 4000, `plan ${tp} ms`);
    if (s === biz) assert.ok(plan.summary.kWp <= Math.min(1000, s.kwp) + 1e-9);
    else assert.ok(plan.summary.kWp <= 6 + 1e-9);
    assert.ok(bat.battery, bat.why);
  }
});
