// Battery placement: a synthetic box house, then the prepared drone scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { placeBattery, BATTERIES } from '../src/twin/battery.js';

// 12 m (x) × 8 m (z) house, walls 3 m high, flat roof slab at 3.0-3.25 m with a
// 0.75 m eave overhang, on a ground slab at y = 0. Voxels 0.25 m.
function boxHouse({ car = false } = {}) {
  const voxel = 0.25, origin = [-12, -0.5, -10], dims = [96, 24, 80];
  const [nx, ny, nz] = dims, data = new Uint8Array(nx * ny * nz);
  const set = (x, y, z) => {
    const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((y - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
    if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) data[i + nx * (j + ny * k)] = 1;
  };
  const fill = (x0, x1, y0, y1, z0, z1) => { for (let x = x0; x < x1; x += voxel) for (let y = y0; y < y1; y += voxel) for (let z = z0; z < z1; z += voxel) set(x + 0.01, y + 0.01, z + 0.01); };
  fill(-12, 12, -0.5, 0, -10, 10);                  // ground
  fill(-6, 6, 0, 3, -4, -3.75); fill(-6, 6, 0, 3, 3.75, 4); // north and south walls
  fill(-6, -5.75, 0, 3, -4, 4); fill(5.75, 6, 0, 3, -4, 4); // west and east walls
  fill(-6.75, 6.75, 3, 3.25, -4.75, 4.75);          // roof slab with eaves
  if (car) fill(-6.5, 6.5, 0, 1.5, 4.25, 6);         // cars parked along the whole south wall
  const outline = [[-6.75, 3.25, -4.75], [6.75, 3.25, -4.75], [6.75, 3.25, 4.75], [-6.75, 3.25, 4.75]];
  const twin = {
    northBearing: 0, location: { lat: 3.11, lon: 101.58, timezone: 8 }, ground: { y: 0 },
    buildings: [{ id: 'B1', primary: true }],
    roofs: [{ id: 'R1', building: 'B1', outline, normal: [0, 1, 0], point: [0, 3.25, 0] }],
    occupancy: { origin, voxel, dims },
  };
  // a panel block over the south-east corner of the roof
  const panel = (x, z) => ({ corners: [[x, 3.4, z], [x + 1.1, 3.4, z], [x + 1.1, 3.4, z + 1.7], [x, 3.4, z + 1.7]], centre: [x + 0.55, 3.4, z + 0.85] });
  const plan = { panels: [panel(3, 1.5), panel(4.2, 1.5)], summary: { annualKwh: 7000 } };
  return { twin, occ: { ...twin.occupancy, data }, plan };
}

const onWall = (b, occ) => {
  // a solid voxel just behind the unit, at mid height
  const { origin, voxel, dims: [nx, ny] } = occ;
  const x = b.position[0] - b.normal[0] * (b.depthM / 2 + 0.15), z = b.position[2] - b.normal[2] * (b.depthM / 2 + 0.15);
  const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((b.position[1] - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
  return occ.data[i + nx * (j + ny * k)] === 1;
};

test('battery goes on the wall nearest the array, under the eave, off the ground', () => {
  const { twin, occ, plan } = boxHouse();
  const r = placeBattery(twin, occ, plan);
  const b = r.battery;
  assert.ok(b, r.why);
  assert.ok(onWall(b, occ), 'unit is against a wall');
  assert.ok(b.sheltered, 'under the eave');
  assert.ok(b.position[1] - b.heightM / 2 >= 0.29, 'plinth above the ground');
  assert.ok(b.position[0] > 0 && b.position[2] > 0, `near the south-east panels, got ${b.position.map((v) => v.toFixed(1))}`);
  assert.ok(b.cableRunM < 8, `cable ${b.cableRunM} m`);
  assert.ok(b.reason.headline && b.reason.bullets.length >= 5);
  assert.ok(BATTERIES.some((x) => x.id === b.id));
  assert.ok(b.cablePath.length === 4);
});

test('a car parked in front of the best wall moves the battery to another wall', () => {
  const { twin, occ, plan } = boxHouse({ car: true });
  const b = placeBattery(twin, occ, plan).battery;
  assert.ok(b);
  assert.ok(b.normal[2] < 0.5, `should not face the blocked south wall, normal ${b.normal}`);
  assert.ok(onWall(b, occ));
});

test('battery is sized from the daily solar yield', () => {
  const { twin, occ, plan } = boxHouse();
  const small = placeBattery(twin, occ, { ...plan, summary: { annualKwh: 3000 } }).battery;
  const big = placeBattery(twin, occ, { ...plan, summary: { annualKwh: 12000 } }).battery;
  assert.ok(small.capacityKwh <= big.capacityKwh);
  assert.equal(small.capacityKwh, 10);
});

const dir = new URL('../public/twins/friend-house/', import.meta.url);
const have = fs.existsSync(new URL('twin.json', dir)) && fs.existsSync(new URL('occupancy.bin', dir));
test('battery on the real scan sits on a sheltered wall of the house', { skip: !have }, async () => {
  const { planArray } = await import('../src/twin/placement.js');
  const twin = JSON.parse(fs.readFileSync(new URL('twin.json', dir), 'utf8'));
  const occ = { ...twin.occupancy, data: new Uint8Array(fs.readFileSync(new URL('occupancy.bin', dir))) };
  const r = placeBattery(twin, occ, planArray(twin, occ, {}));
  const b = r.battery;
  assert.ok(b, r.why);
  assert.ok(b.sheltered);
  assert.ok(b.cableRunM > 0 && b.cableRunM < 25, `cable ${b.cableRunM} m`);
  assert.ok(Math.abs(b.groundY - (twin.ground?.y ?? 0)) < 1.5);
});
