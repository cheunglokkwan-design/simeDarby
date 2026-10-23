// Synthetic digital twins for the placement tests (twin frame: x east, y up, z south).
// Not a test file itself (node --test only runs *.test.js).

const RAD = Math.PI / 180;

function makeOcc(min, max, voxel = 0.25) {
  const dims = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k]) / voxel));
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const set = (x, y, z) => {
    const i = Math.floor((x - min[0]) / voxel), j = Math.floor((y - min[1]) / voxel), k = Math.floor((z - min[2]) / voxel);
    if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return;
    data[i + dims[0] * (j + dims[1] * k)] = 1;
  };
  return { occ: { origin: min, voxel, dims, data }, set };
}

// Gable house 10 m (x) × 8 m (z), eave 3 m, ridge along x at z = 0.
// options: pitch (deg), vent: [x, along-slope fraction] on the south face,
// tree: { x, z, r, top } tall canopy, southOnly etc.
export function gableHouse({ pitch = 25, vent = true, tree = true, wall = null } = {}) {
  const halfSpan = 4, eaveY = 3, L = 10;
  const rise = halfSpan * Math.tan(pitch * RAD);
  const ridgeY = eaveY + rise;
  const { occ, set } = makeOcc([-30, -1, -30], [30, 16, 30]);
  const step = 0.08;
  // roof surfaces
  for (let x = -L / 2; x <= L / 2; x += step) for (let s = 0; s <= halfSpan; s += step) {
    const y = ridgeY - s * Math.tan(pitch * RAD);
    set(x, y, s); set(x, y, -s);
  }
  // walls
  for (let x = -L / 2; x <= L / 2; x += step) for (let y = 0; y <= eaveY; y += step) { set(x, y, halfSpan); set(x, y, -halfSpan); }
  for (let z = -halfSpan; z <= halfSpan; z += step) for (let y = 0; y <= ridgeY - Math.abs(z) * Math.tan(pitch * RAD); y += step) { set(-L / 2, y, z); set(L / 2, y, z); }
  const roofs = [];
  const nS = [0, Math.cos(pitch * RAD), Math.sin(pitch * RAD)]; // south face normal (+z = south)
  const nN = [0, Math.cos(pitch * RAD), -Math.sin(pitch * RAD)];
  const obstacles = [];
  if (vent) {
    // 0.6 × 0.6 m box, 0.5 m high, centred at x = 1.5, 2.0 m down-slope from the ridge (south face)
    const cx = 1.5, cs = 2.0, h = 0.5;
    const pts = [];
    for (const [dx, ds] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) pts.push([cx + dx, ridgeY - (cs + ds) * Math.tan(pitch * RAD), cs + ds]);
    obstacles.push({ outline: pts, height: h, kind: 'vent / pipe / small protrusion' });
    for (let x = cx - 0.3; x <= cx + 0.3; x += 0.05) for (let s = cs - 0.3; s <= cs + 0.3; s += 0.05) {
      const y0 = ridgeY - s * Math.tan(pitch * RAD);
      for (let y = y0; y <= y0 + h; y += 0.05) set(x, y, s);
    }
  }
  roofs.push({
    id: 'S', building: 'B1', normal: nS, point: [0, (ridgeY + eaveY) / 2, halfSpan / 2], tilt: pitch, azimuth: 180,
    outline: [[-L / 2, eaveY, halfSpan], [L / 2, eaveY, halfSpan], [L / 2, ridgeY, 0], [-L / 2, ridgeY, 0]],
    eaveDir: [1, 0, 0], area: L * halfSpan / Math.cos(pitch * RAD), obstacles,
  });
  roofs.push({
    id: 'N', building: 'B1', normal: nN, point: [0, (ridgeY + eaveY) / 2, -halfSpan / 2], tilt: pitch, azimuth: 0,
    outline: [[L / 2, eaveY, -halfSpan], [-L / 2, eaveY, -halfSpan], [-L / 2, ridgeY, 0], [L / 2, ridgeY, 0]],
    eaveDir: [-1, 0, 0], area: L * halfSpan / Math.cos(pitch * RAD), obstacles: [],
  });
  if (tree) {
    const t = typeof tree === 'object' ? tree : { x: -8, z: 2, r: 2.5, bottom: 3, top: 14 };
    for (let x = t.x - t.r; x <= t.x + t.r; x += 0.2) for (let z = t.z - t.r; z <= t.z + t.r; z += 0.2) {
      if (Math.hypot(x - t.x, z - t.z) > t.r) continue;
      for (let y = t.bottom; y <= t.top; y += 0.2) set(x, y, z);
    }
    for (let y = 0; y < t.bottom; y += 0.2) set(t.x, y, t.z); // trunk
  }
  if (wall) for (let x = wall.x0; x <= wall.x1; x += 0.1) for (let z = wall.z0; z <= wall.z1; z += 0.1) for (let y = 0; y <= wall.h; y += 0.1) set(x, y, z);
  const twin = {
    id: `synthetic-gable-${pitch}-${vent ? 'v' : ''}${tree ? 't' : ''}`, title: 'synthetic gable', northBearing: 0,
    location: { lat: 3.11, lon: 101.58, name: 'Ara Damansara (assumed)', timezone: 8 },
    scale: { metresPerUnit: 1, method: 'synthetic', confidence: 'high' },
    buildings: [{ id: 'B1', primary: true, roofIds: ['S', 'N'] }], roofs,
    occupancy: { origin: occ.origin, voxel: occ.voxel, dims: occ.dims, file: 'none' },
  };
  return { twin, occ, ridgeY, eaveY, halfSpan, L, pitch };
}

// Flat RC slab 12 × 9 m at 6 m with a 0.2 m parapet edge (no occluders).
export function flatSlab() {
  const { occ, set } = makeOcc([-25, -1, -25], [25, 14, 25]);
  for (let x = -6; x <= 6; x += 0.08) for (let z = -4.5; z <= 4.5; z += 0.08) set(x, 6, z);
  const roofs = [{
    id: 'F', building: 'B1', normal: [0, 1, 0], point: [0, 6.05, 0], tilt: 0, azimuth: 180, flat: true,
    outline: [[-6, 6.05, 4.5], [6, 6.05, 4.5], [6, 6.05, -4.5], [-6, 6.05, -4.5]], eaveDir: [1, 0, 0], area: 108, obstacles: [],
  }];
  const twin = {
    id: 'synthetic-flat', northBearing: 0, location: { lat: 3.11, lon: 101.58, timezone: 8 }, scale: { metresPerUnit: 1, method: 'synthetic', confidence: 'high' },
    buildings: [{ id: 'B1', primary: true, roofIds: ['F'] }], roofs, occupancy: { origin: occ.origin, voxel: occ.voxel, dims: occ.dims },
  };
  return { twin, occ };
}
