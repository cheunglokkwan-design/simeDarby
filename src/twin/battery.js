// Home battery placement on the digital twin: a simpler companion to
// placement.js. The battery goes on an outside wall of the house, close to
// where the array's cables come down, out of the sun and rain.
//
//  1. Wall candidates: the primary roofs' plan outline is the eave line. From
//     every ~0.5 m of it, march inward at chest height until the scan hits the
//     wall; the battery sits just in front of it.
//  2. Reject spots with no working space (anything solid within 0.9 m in front,
//     e.g. a parked car, a fence, a hedge) or no ground found under them.
//  3. Score what matters on site:
//     - cable run from the array's lowest edge down to the battery (DC losses,
//       cost): roof drop + plan distance along the walls;
//     - direct sun on the unit over a typical year (heat shortens lithium life
//       and triggers derating; Malaysian afternoons are the worst, so
//       west-facing walls are penalised as well);
//     - shelter: a roof or eave overhead keeps rain off the unit and its
//       glands.
//  4. Pick the best; report the next-best spots on other walls.
// Pure ES module, runs in node and the browser.
import { makeGrid, castRay } from './shade.js';
import { typicalYearSamples, sunVectorTwin } from './sun.js';

// Approximate datasheet figures; check the current datasheet before quoting.
export const BATTERIES = [
  { id: 'huawei-luna-10', name: 'Huawei LUNA2000-10-S0 (10 kWh, 2 modules)', usableKwh: 10, widthM: 0.67, heightM: 0.96, depthM: 0.15, weightKg: 114, mount: 'floor or wall', ip: 'IP66', source: 'Huawei LUNA2000-5/10/15-S0 datasheet (approx.)' },
  { id: 'huawei-luna-15', name: 'Huawei LUNA2000-15-S0 (15 kWh, 3 modules)', usableKwh: 15, widthM: 0.67, heightM: 1.32, depthM: 0.15, weightKg: 164, mount: 'floor', ip: 'IP66', source: 'Huawei LUNA2000-5/10/15-S0 datasheet (approx.)' },
  { id: 'tesla-pw3', name: 'Tesla Powerwall 3 (13.5 kWh)', usableKwh: 13.5, widthM: 0.61, heightM: 1.1, depthM: 0.19, weightKg: 130, mount: 'floor or wall', ip: 'IP67', source: 'Tesla Powerwall 3 datasheet (approx.)' },
];

const DEFAULTS = {
  stepM: 0.5,          // spacing of wall candidates along the eave line
  plinthM: 0.3,        // unit bottom above ground: splash and flash-flood margin
  clearFrontM: 0.9,    // working space needed in front of the unit
  sunPenaltyPer100h: 1, // metres of cable "worth" 100 h/yr of direct sun on the unit
  westPenaltyM: 2,
  unshelteredPenaltyM: 4,
  eveningShare: 0.5,   // share of daily PV a battery is sized to shift into the evening
};

const RAD = Math.PI / 180;
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');

function pointInPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function solidAt(grid, x, y, z) {
  const { origin, voxel, nx, ny, nz, data } = grid;
  const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((y - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
  return data[i + nx * (j + ny * k)] === 1;
}

// Plan mask (x, z) of the primary building's roofs, with its outward boundary.
function roofPlan(twin) {
  const primary = new Set((twin.buildings || []).filter((b) => b.primary).map((b) => b.id));
  const roofs = (twin.roofs || []).filter((r) => !primary.size || primary.has(r.building));
  const polys = roofs.map((r) => r.outline.map((p) => [p[0], p[2]]));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of polys) for (const [x, z] of p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const c = 0.25, nx = Math.ceil((x1 - x0) / c) + 3, nz = Math.ceil((z1 - z0) / c) + 3;
  const ox = x0 - c, oz = z0 - c;
  const mask = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = ox + (i + 0.5) * c, z = oz + (k + 0.5) * c;
    if (polys.some((p) => pointInPoly(x, z, p))) mask[i + nx * k] = 1;
  }
  // close one-cell gaps between roof faces
  const closed = mask.slice();
  for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) {
    if (mask[i + nx * k]) continue;
    if ((mask[i - 1 + nx * k] && mask[i + 1 + nx * k]) || (mask[i + nx * (k - 1)] && mask[i + nx * (k + 1)])) closed[i + nx * k] = 1;
  }
  const edge = [];
  const at = (i, k) => (i >= 0 && k >= 0 && i < nx && k < nz ? closed[i + nx * k] : 0);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    if (!at(i, k)) continue;
    // outward normal from the mask gradient over a 5×5 window
    let gx = 0, gz = 0, open = false;
    for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) {
      if (!at(i + di, k + dk)) { gx += di; gz += dk; if (Math.abs(di) <= 1 && Math.abs(dk) <= 1) open = true; }
    }
    const L = Math.hypot(gx, gz);
    if (open && L > 0) edge.push({ x: ox + (i + 0.5) * c, z: oz + (k + 0.5) * c, nx: gx / L, nz: gz / L });
  }
  return { edge, roofs };
}

function groundBelow(grid, x, z, from, fallback) {
  const d = castRay(grid, x, from, z, 0, -1, 0, 6);
  return d >= 0 ? from - d : fallback;
}

// Walk the eave line, find the wall under it and test each spot.
function wallCandidates(twin, grid, o) {
  const { edge } = roofPlan(twin);
  const g0 = twin.ground?.y ?? 0;
  const out = [];
  const used = [];
  for (const e of edge) {
    if (used.some((u) => Math.hypot(u[0] - e.x, u[1] - e.z) < o.stepM)) continue;
    used.push([e.x, e.z]);
    // march inward at 1.0-1.8 m above the ground until two heights hit the wall
    let wall = null;
    for (let s = -0.25; s <= 3.0; s += 0.125) {
      const x = e.x - e.nx * s, z = e.z - e.nz * s;
      const hits = [1.0, 1.4, 1.8].filter((h) => solidAt(grid, x, g0 + h, z)).length;
      if (hits >= 2) { wall = [x, z]; break; }
    }
    if (!wall) continue;
    out.push({ wx: wall[0], wz: wall[1], nx: e.nx, nz: e.nz });
  }
  return out;
}

function lowestPanelEdge(plan) {
  let best = null;
  for (const p of plan?.panels || []) for (const c of p.corners) if (!best || c[1] < best[1]) best = c;
  return best;
}

function sizeBattery(plan, o) {
  const daily = (plan?.summary?.yield?.groundCalibratedKwh ?? plan?.summary?.annualKwh ?? 0) / 365;
  const want = daily * o.eveningShare;
  const sorted = [...BATTERIES].sort((a, b) => a.usableKwh - b.usableKwh);
  const pick = o.batteryId ? BATTERIES.find((b) => b.id === o.batteryId) : (sorted.find((b) => b.usableKwh >= want) || sorted[sorted.length - 1]);
  return { battery: pick || sorted[0], dailyKwh: daily, wantKwh: want };
}

const wallWord = (az) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((az % 360) + 360) % 360 / 45) % 8];

export function placeBattery(twin, occupancy, plan, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const grid = occupancy?.__grid ? occupancy : makeGrid(occupancy?.data ? occupancy : { ...twin.occupancy, data: occupancy });
  if (!grid) return { battery: null, why: 'No occupancy grid: cannot find the walls.' };
  const { battery, dailyKwh, wantKwh } = sizeBattery(plan, o);
  const north = options.northBearing ?? twin.northBearing ?? 0;
  const lat = options.lat ?? twin.location?.lat ?? 3.11, lon = options.lon ?? twin.location?.lon ?? 101.58;
  const suns = typicalYearSamples(lat, lon, { tz: twin.location?.timezone ?? 8, stepMin: 60 })
    .map((s) => ({ v: sunVectorTwin(s.azimuth, s.elevation, north), w: s.weightH }));
  const drop = lowestPanelEdge(plan);
  const g0 = twin.ground?.y ?? 0;
  const rejected = { space: 0, ground: 0 };
  const scored = [];
  for (const c of wallCandidates(twin, grid, o)) {
    const ground = groundBelow(grid, c.wx + c.nx * 0.5, c.wz + c.nz * 0.5, g0 + 1.0, g0);
    if (Math.abs(ground - g0) > 1.5) { rejected.ground++; continue; }
    const yMid = ground + o.plinthM + battery.heightM / 2;
    const off = 0.06 + battery.depthM / 2;
    const cx = c.wx + c.nx * off, cz = c.wz + c.nz * off;
    // working space in front of the unit, from knee to head height
    let blocked = false;
    for (let s = off + battery.depthM / 2 + 0.1; s <= off + o.clearFrontM && !blocked; s += 0.125)
      for (const h of [0.5, 1.0, 1.5]) if (solidAt(grid, c.wx + c.nx * s, ground + h, c.wz + c.nz * s)) { blocked = true; break; }
    if (blocked) { rejected.space++; continue; }
    // direct sun on the unit's face over a typical year
    let sunH = 0;
    const px = cx + c.nx * 0.2, py = yMid, pz = cz + c.nz * 0.2;
    for (const s of suns) {
      if (s.v[0] * c.nx + s.v[2] * c.nz <= 0) continue;
      if (castRay(grid, px, py, pz, s.v[0], s.v[1], s.v[2], 60) < 0) sunH += s.w;
    }
    const roofHit = castRay(grid, cx, ground + 2.0, cz, 0, 1, 0, 8);
    const sheltered = roofHit >= 0;
    const azimuth = ((Math.atan2(c.nx, -c.nz) / RAD - north) % 360 + 360) % 360;
    const west = azimuth >= 225 && azimuth <= 315;
    const cable = drop ? Math.max(0, drop[1] - yMid) + 1.2 * Math.hypot(drop[0] - cx, drop[2] - cz) : 0;
    const score = cable + o.sunPenaltyPer100h * sunH / 100 + (west ? o.westPenaltyM : 0) + (sheltered ? 0 : o.unshelteredPenaltyM);
    scored.push({ position: [cx, yMid, cz], wall: [c.wx, ground, c.wz], normal: [c.nx, 0, c.nz], groundY: ground, azimuthDeg: azimuth, wallFaces: wallWord(azimuth), sunHoursYear: Math.round(sunH), sheltered, roofAboveM: sheltered ? +(roofHit + 2.0 - o.plinthM - battery.heightM).toFixed(1) : null, west, cableRunM: +cable.toFixed(1), score });
  }
  if (!scored.length) return { battery: null, why: 'No wall spot with ground and working space was found in the scan.', rejected };
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  // next-best spots on clearly different walls
  const alternatives = [];
  for (const s of scored.slice(1)) {
    if (alternatives.length >= 3) break;
    if ([best, ...alternatives].some((a) => Math.hypot(a.position[0] - s.position[0], a.position[2] - s.position[2]) < 3)) continue;
    alternatives.push(s);
  }
  const cablePath = drop ? [drop, [drop[0], best.groundY + 2.4, drop[2]], [best.position[0], best.groundY + 2.4, best.position[2]], [best.position[0], best.position[1] + battery.heightM / 2, best.position[2]]] : [];
  const sunNote = best.sunHoursYear < 150 ? `almost never in direct sun (${fmt(best.sunHoursYear)} h/yr), so it stays cool` : `${fmt(best.sunHoursYear)} h/yr of direct sun on its face, the least among the sheltered walls`;
  const reason = {
    headline: `On the ${best.wallFaces}-facing wall, ${fmt(best.cableRunM, 1)} m of cable from the array`,
    bullets: [
      `Closest sheltered, shaded wall to where the array's cables come down (lowest panel edge at ${fmt(drop?.[1] ?? 0, 1)} m): about ${fmt(best.cableRunM, 1)} m of cable, so lower DC losses and cost.`,
      `${sunNote[0].toUpperCase()}${sunNote.slice(1)}. Lithium batteries derate and age faster when hot.`,
      best.sheltered ? `Under a roof or eave (${fmt(best.roofAboveM, 1)} m clear above the unit), which keeps rain off the unit and its cable glands.` : 'No roof above this spot: add a rain hood.',
      best.west ? 'Faces west: afternoon heat; shade it if possible.' : `Not west-facing, so it avoids the hottest afternoon sun.`,
      `${fmt(o.clearFrontM, 1)} m of clear working space in front; bottom ${fmt(o.plinthM * 1000)} mm above the ground for splash and flash-flood protection.`,
      `${battery.name}: ${fmt(battery.widthM * 1000)} × ${fmt(battery.heightM * 1000)} × ${fmt(battery.depthM * 1000)} mm, ${fmt(battery.weightKg)} kg (${battery.mount}; needs a masonry wall or a floor plinth).`,
      `Sized to shift about ${fmt(wantKwh, 1)} kWh of the ${fmt(dailyKwh, 1)} kWh daily solar into the evening.`,
      'Check on site: keep it away from bedroom windows, doors and gas meters (installers commonly use 600 mm, as in AS/NZS 5139), and close to the main switchboard.',
    ],
  };
  return {
    battery: { ...battery, ...best, capacityKwh: battery.usableKwh, cablePath, reason },
    alternatives: alternatives.map((a) => ({ position: a.position, normal: a.normal, wallFaces: a.wallFaces, cableRunM: a.cableRunM, sunHoursYear: a.sunHoursYear, sheltered: a.sheltered })),
    candidates: scored.length, rejected,
  };
}
