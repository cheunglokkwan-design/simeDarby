// Fallback data and algorithms for the digital-twin viewer.
//
// The real scan (public/twins/friend-house/*) and the real algorithms
// (src/twin/{placement,sun,shade,catalogue}.js) are owned by other pieces of
// the project (see docs/internal/twin-contract.md). This module lets twin.html run
// before they exist, and supplies small geometric helpers (voxel ray casting,
// clear-sky irradiance) the viewer uses for visuals such as the moving shadow
// pattern on each panel. Everything here follows the twin frame of the
// contract: metres, x = east, y = up, z = south, origin on the ground.

const RAD = Math.PI / 180;

// ---------------------------------------------------------------- catalogue
// Indicative datasheet values for common residential modules in Malaysia.
export const MOCK_PANELS = [
  { id: 'jinko-tiger-neo-440', maker: 'Jinko Solar', model: 'Tiger Neo 54HL4R-B', wattPeak: 440, lengthMm: 1722, widthMm: 1134, thicknessMm: 30, weightKg: 21.3, efficiency: 0.225, cells: 108, tempCoeff: -0.0029 },
  { id: 'longi-himo6-430', maker: 'LONGi', model: 'Hi-MO 6 LR5-54HTH', wattPeak: 430, lengthMm: 1722, widthMm: 1134, thicknessMm: 30, weightKg: 20.8, efficiency: 0.22, cells: 108, tempCoeff: -0.0029 },
  { id: 'trina-vertex-s-445', maker: 'Trina Solar', model: 'Vertex S+ TSM-NEG9R.28', wattPeak: 445, lengthMm: 1762, widthMm: 1134, thicknessMm: 30, weightKg: 21.0, efficiency: 0.223, cells: 108, tempCoeff: -0.0029 },
  { id: 'canadian-hiku7-600', maker: 'Canadian Solar', model: 'HiKu7 CS7L-600MS', wattPeak: 600, lengthMm: 2172, widthMm: 1303, thicknessMm: 35, weightKg: 32.0, efficiency: 0.212, cells: 120, tempCoeff: -0.0034 }
];

// Kuala Lumpur area monthly mean GHI, kWh/m²/day (indicative, NASA POWER-like
// climatology). Used to scale the clear-sky shape to a realistic annual total.
export const MOCK_CLIMATE = {
  source: 'Indicative Klang Valley monthly GHI climatology (mock; ~1,720 kWh/m²/yr), 45% diffuse',
  ghiDay: [4.6, 5.2, 5.3, 5.2, 4.9, 4.8, 4.8, 4.8, 4.6, 4.5, 4.2, 4.1],
  diffuseFraction: 0.45,
  albedo: 0.2
};
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ---------------------------------------------------------------- sun
// Low-precision solar position (Astronomical Almanac / NOAA style), about
// 0.1° over 1950-2050. Azimuth in degrees clockwise from true north.
export function mockSunPosition(date, lat, lon) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = ((gmst * 15 + lon) * RAD - ra);
  const phi = lat * RAD;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(-Math.sin(ha), Math.cos(phi) * Math.tan(dec) - Math.sin(phi) * Math.cos(ha)) / RAD;
  az = (az + 360) % 360;
  return { azimuth: az, elevation: el / RAD };
}

// Unit vector towards the sun in the twin frame. northOffsetDeg rotates true
// north clockwise (seen from above) away from -z, for when the user corrects
// the scan's heading in the viewer.
export function sunVector(azimuthDeg, elevationDeg, northOffsetDeg = 0) {
  const d = northOffsetDeg * RAD, a = azimuthDeg * RAD, e = elevationDeg * RAD;
  const north = [Math.sin(d), 0, -Math.cos(d)], east = [Math.cos(d), 0, Math.sin(d)];
  const h = Math.cos(e);
  return [
    h * (Math.sin(a) * east[0] + Math.cos(a) * north[0]),
    Math.sin(e),
    h * (Math.sin(a) * east[2] + Math.cos(a) * north[2])
  ];
}

// Local clock time (hours) on a calendar day → UTC Date for the twin's zone.
export function localDate(y, m, d, hours, tz = 8) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0) + (hours - tz) * 3600000);
}

// Clear-sky irradiance (W/m²) for a solar elevation, Meinel beam model.
export function clearSky(elevationDeg) {
  if (elevationDeg <= 0) return { dni: 0, dhi: 0, ghi: 0 };
  const am = 1 / (Math.sin(elevationDeg * RAD) + 0.50572 * Math.pow(elevationDeg + 6.07995, -1.6364));
  const dni = 1353 * Math.pow(0.7, Math.pow(am, 0.678));
  const dhi = 0.1 * dni + 20;
  return { dni, dhi, ghi: dni * Math.sin(elevationDeg * RAD) + dhi };
}

// ---------------------------------------------------------------- occupancy
export function makeOccupancy(meta, data) {
  return { origin: meta.origin, voxel: meta.voxel, dims: meta.dims, data };
}

// First solid voxel along a ray (Amanatides-Woo DDA). Returns the distance in
// metres, or -1 when the ray leaves the grid or exceeds maxDist.
export function raycastOcc(occ, ox, oy, oz, dx, dy, dz, maxDist = 80) {
  if (!occ || !occ.data) return -1;
  const { origin, voxel, dims, data } = occ;
  const nx = dims[0], ny = dims[1], nz = dims[2];
  let px = (ox - origin[0]) / voxel, py = (oy - origin[1]) / voxel, pz = (oz - origin[2]) / voxel;
  let tmin = 0, tmax = maxDist / voxel;
  const p = [px, py, pz], d = [dx, dy, dz], n = [nx, ny, nz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (p[i] < 0 || p[i] >= n[i]) return -1; continue; }
    let t1 = -p[i] / d[i], t2 = (n[i] - p[i]) / d[i];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  }
  if (tmin > tmax) return -1;
  px += dx * tmin; py += dy * tmin; pz += dz * tmin;
  let ix = Math.min(nx - 1, Math.max(0, Math.floor(px)));
  let iy = Math.min(ny - 1, Math.max(0, Math.floor(py)));
  let iz = Math.min(nz - 1, Math.max(0, Math.floor(pz)));
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
  let tmx = Math.abs(dx) < 1e-12 ? Infinity : (dx > 0 ? (ix + 1 - px) : (px - ix)) * tdx + tmin;
  let tmy = Math.abs(dy) < 1e-12 ? Infinity : (dy > 0 ? (iy + 1 - py) : (py - iy)) * tdy + tmin;
  let tmz = Math.abs(dz) < 1e-12 ? Infinity : (dz > 0 ? (iz + 1 - pz) : (pz - iz)) * tdz + tmin;
  let t = tmin;
  for (let guard = 0; guard < 4096; guard++) {
    if (data[ix + nx * (iy + ny * iz)]) return t * voxel;
    if (tmx < tmy && tmx < tmz) { ix += sx; t = tmx; tmx += tdx; if (ix < 0 || ix >= nx) return -1; }
    else if (tmy < tmz) { iy += sy; t = tmy; tmy += tdy; if (iy < 0 || iy >= ny) return -1; }
    else { iz += sz; t = tmz; tmz += tdz; if (iz < 0 || iz >= nz) return -1; }
    if (t > tmax) return -1;
  }
  return -1;
}

// Is a point (slightly above a surface with normal n) in direct sun?
export function sunlitAt(occ, p, n, s) {
  if (s[1] <= 0) return 0;
  const lift = 0.18, off = 0.38;
  const ox = p[0] + n[0] * lift + s[0] * off, oy = p[1] + n[1] * lift + s[1] * off, oz = p[2] + n[2] * lift + s[2] * off;
  return raycastOcc(occ, ox, oy, oz, s[0], s[1], s[2]) < 0 ? 1 : 0;
}

// Per-panel grid of sunlit samples (nu × nv, row-major along the panel's long
// edge), used to draw moving partial shadows on each module.
export function panelShadeMask(occ, panel, s, nu = 4, nv = 6) {
  const c = panel.corners, out = new Float32Array(nu * nv);
  const e1 = sub(c[1], c[0]), e3 = sub(c[3], c[0]);
  const n = panel.normal;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = (i + 0.5) / nu, b = (j + 0.5) / nv;
    const p = [c[0][0] + e1[0] * a + e3[0] * b, c[0][1] + e1[1] * a + e3[1] * b, c[0][2] + e1[2] * a + e3[2] * b];
    out[j * nu + i] = dot(n, s) > 0 ? sunlitAt(occ, p, n, s) : 0;
  }
  return out;
}

export function mockInstantShading(twin, occ, plan, s) {
  return plan.panels.map((p) => {
    if (s[1] <= 0 || dot(p.normal, s) <= 0) return 0;
    const m = panelShadeMask(occ, p, s, 3, 3);
    let k = 0; for (const v of m) k += v;
    return k / m.length;
  });
}

// ---------------------------------------------------------------- vectors
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function mad(o, u, a, v, b, n, c = 0) { return [o[0] + u[0] * a + v[0] * b + n[0] * c, o[1] + u[1] * a + v[1] * b + n[1] * c, o[2] + u[2] * a + v[2] * b + n[2] * c]; }

// In-plane frame of a roof: u horizontal (along the eave), v downslope.
// The prepared twin gives eaveDir as the horizontal direction along the eave
// and upSlopeDir; downslope is derived from gravity when upSlopeDir is absent.
export function roofFrame(roof) {
  const n = norm(roof.normal);
  let v = null;
  if (roof.upSlopeDir) v = norm(scale(roof.upSlopeDir, -1));
  if (!v || Math.abs(dot(v, n)) > 0.2) {
    const g = [0, -1, 0];
    v = sub(g, scale(n, dot(g, n)));
    if (Math.hypot(...v) < 1e-6) v = roof.eaveDir ? norm(cross(n, roof.eaveDir)) : [0, 0, 1]; // flat roof
    v = norm(v);
  }
  const u = norm(cross(n, v));
  return { o: roof.point, u, v, n };
}
// Roofs of the primary building only (the scan also contains the neighbours).
export function primaryRoofs(twin) {
  const b = twin.buildings?.find((x) => x.primary);
  return b ? twin.roofs.filter((r) => b.roofIds.includes(r.id)) : twin.roofs;
}
function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}
export function toPlane(f, p) { const d = sub(p, f.o); return [dot(d, f.u), dot(d, f.v)]; }
export function fromPlane(f, a, b, h = 0) { return mad(f.o, f.u, a, f.v, b, f.n, h); }

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function polyEdgeDist(x, y, poly) {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; m = Math.min(m, segDist(x, y, a[0], a[1], b[0], b[1])); }
  return m;
}
function polyArea2(poly) { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
// Inset a convex polygon by d (positive = inwards).
function insetConvex(poly, d) {
  const sgn = polyArea2(poly) > 0 ? 1 : -1, lines = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; nx = (nx / l) * sgn; ny = (ny / l) * sgn;
    lines.push([a[0] + nx * d, a[1] + ny * d, b[0] - a[0], b[1] - a[1]]);
  }
  return lines.map((l1, i) => {
    const l0 = lines[(i - 1 + lines.length) % lines.length];
    const den = l0[2] * l1[3] - l0[3] * l1[2];
    if (Math.abs(den) < 1e-9) return [l1[0], l1[1]];
    const t = ((l1[0] - l0[0]) * l1[3] - (l1[1] - l0[1]) * l1[2]) / den;
    return [l0[0] + l0[2] * t, l0[1] + l0[3] * t];
  });
}

// ---------------------------------------------------------------- irradiance
// Sun samples for a year: 15th of each month, every 30 min. Cached per site.
const sunCache = new Map();
function yearSamples(lat, lon, tz, north, step = 0.5) {
  const key = [lat, lon, tz, north, step].join('|');
  if (sunCache.has(key)) return sunCache.get(key);
  const out = [];
  for (let m = 0; m < 12; m++) {
    const day = [];
    let csSum = 0;
    for (let h = 6; h <= 20; h += step) {
      const sp = mockSunPosition(localDate(2026, m, 15, h, tz), lat, lon);
      if (sp.elevation <= 0.5) continue;
      const cs = clearSky(sp.elevation);
      csSum += cs.ghi * step;
      day.push({ s: sunVector(sp.azimuth, sp.elevation, north), el: sp.elevation, az: sp.azimuth, ghi: cs.ghi, h });
    }
    // scale clear-sky shape so the day integrates to the climatology
    const k = (MOCK_CLIMATE.ghiDay[m] * 1000) / (csSum || 1);
    for (const d of day) {
      const ghi = d.ghi * k;
      const beamH = ghi * (1 - MOCK_CLIMATE.diffuseFraction);
      d.dni = beamH / Math.sin(d.el * RAD);
      d.dhi = ghi * MOCK_CLIMATE.diffuseFraction;
      d.ghiScaled = ghi;
      d.w = (step * MONTH_DAYS[m]) / 1000; // W/m² → kWh/m² over the month
      d.month = m;
      out.push(d);
    }
  }
  sunCache.set(key, out);
  return out;
}

// Annual plane-of-array irradiation at points on one plane. Returns poa and
// unshaded poa (kWh/m²/yr), sun-hours on the surface, and where shade comes from.
function annualAt(occ, pts, n, samples) {
  const tiltCos = Math.max(-1, Math.min(1, n[1]));
  let poa = 0, poa0 = 0, sunH = 0;
  const lostBySector = { morning: 0, midday: 0, afternoon: 0 };
  for (const d of samples) {
    const ci = dot(n, d.s);
    const diffuse = d.dhi * (1 + tiltCos) / 2 + d.ghiScaled * MOCK_CLIMATE.albedo * (1 - tiltCos) / 2;
    let beam0 = ci > 0 ? d.dni * ci : 0, lit = 0;
    if (beam0 > 0) { for (const p of pts) lit += sunlitAt(occ, p, n, d.s); lit /= pts.length; }
    poa0 += (beam0 + diffuse) * d.w;
    poa += (beam0 * lit + diffuse) * d.w;
    if (beam0 > 0 && lit > 0.5) sunH += d.w * 1000 / 1; // hours (w = step*days/1000)
    const lost = beam0 * (1 - lit) * d.w;
    if (lost > 0) lostBySector[d.h < 10.5 ? 'morning' : d.h > 15.5 ? 'afternoon' : 'midday'] += lost;
  }
  return { poa, poa0, sunHours: sunH, lostBySector };
}

// Roof flux heatmap: annual POA (kWh/m²/yr) on a grid over each roof plane.
export function mockRoofHeatmap(twin, occ, { cell = 0.5, northOffsetDeg = 0, lat, lon } = {}) {
  const loc = twin.location || {};
  const samples = yearSamples(lat ?? loc.lat ?? 3.11, lon ?? loc.lon ?? 101.58, loc.timezone ?? 8, northOffsetDeg);
  let min = Infinity, max = -Infinity;
  const roofs = primaryRoofs(twin).map((roof) => {
    const f = roofFrame(roof);
    const poly = roof.outline.map((p) => toPlane(f, p));
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const cells = [];
    for (let a = Math.min(...xs) + cell / 2; a < Math.max(...xs); a += cell) {
      for (let b = Math.min(...ys) + cell / 2; b < Math.max(...ys); b += cell) {
        if (!pointInPoly(a, b, poly)) continue;
        const centre = fromPlane(f, a, b, 0.02);
        const r = annualAt(occ, [centre], f.n, samples);
        const h = cell / 2;
        cells.push({ a, b, centre, poa: r.poa, corners: [fromPlane(f, a - h, b - h, 0.03), fromPlane(f, a + h, b - h, 0.03), fromPlane(f, a + h, b + h, 0.03), fromPlane(f, a - h, b + h, 0.03)] });
        min = Math.min(min, r.poa); max = Math.max(max, r.poa);
      }
    }
    return { roofId: roof.id, cell, cells };
  });
  return { roofs, min, max, unit: 'kWh/m²/yr' };
}

// ---------------------------------------------------------------- placement
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassName = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8];

function edgeKind(f, a, b) {
  // classify a roof edge in the plane: along u = eave/ridge, along v = verge
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.abs(dx) > Math.abs(dy)) return (a[1] + b[1]) / 2 > 0 ? 'eave' : 'ridge';
  return 'verge';
}

export function mockPlanArray(twin, occ, options = {}) {
  const panel = options.panel || MOCK_PANELS[0];
  const loc = twin.location || {};
  const north = options.northOffsetDeg || 0; // sun vectors (full bearing)
  const azOff = options.azimuthOffsetDeg ?? north; // correction to the roofs' stored compass azimuths
  const samples = yearSamples(options.lat ?? loc.lat ?? 3.11, options.lon ?? loc.lon ?? 101.58, loc.timezone ?? 8, north);
  const setback = options.setback ?? 0.4, gap = options.gapM ?? 0.02, keepout = options.keepout ?? 0.3;
  // standoffM = roof surface to module top (catalogue MOUNTING convention)
  const thick = (panel.thicknessMm || 30) / 1000, standoff = Math.max(options.standoffM ?? 0.12, thick + 0.03);
  const W = panel.widthMm / 1000, L = panel.lengthMm / 1000;
  const orientation = options.orientation || 'portrait';
  const pu = orientation === 'portrait' ? W : L, pv = orientation === 'portrait' ? L : W;
  const threshold = options.fluxThreshold ?? 0;
  const pr = options.performanceRatio ?? 0.8;
  const heat = options.heatmap;
  const rejected = [], candidates = [];

  for (const roof of primaryRoofs(twin)) {
    const f = roofFrame(roof);
    const poly = roof.outline.map((p) => toPlane(f, p));
    const convex = isConvex(poly);
    const inner = convex ? insetConvex(poly, setback) : poly;
    // setback strips → rejected bands with their edge type (convex roofs only)
    for (let i = 0; convex && i < poly.length; i++) {
      const j = (i + 1) % poly.length, kind = roof.edges?.[i]?.type || edgeKind(f, poly[i], poly[j]);
      const quad = [poly[i], poly[j], inner[j], inner[i]].map(([a, b]) => fromPlane(f, a, b, 0.04));
      rejected.push({ roofId: roof.id, outline: quad, kind: 'setback', why: `${setback.toFixed(2)} m ${kind} setback: kept clear for maintenance access, fire-fighting access and the higher wind-uplift zone at roof ${kind === 'verge' ? 'verges' : kind === 'hip' ? 'hips' : kind + 's'}.` });
    }
    const obst = (roof.obstacles || []).map((o) => {
      const q = o.outline.map((p) => toPlane(f, p));
      const box = [Math.min(...q.map((p) => p[0])) - keepout, Math.min(...q.map((p) => p[1])) - keepout, Math.max(...q.map((p) => p[0])) + keepout, Math.max(...q.map((p) => p[1])) + keepout];
      rejected.push({ roofId: roof.id, kind: 'obstacle', outline: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([a, b]) => fromPlane(f, a, b, 0.05)), why: `${o.kind || 'Obstacle'} (${(o.height || 0).toFixed(1)} m tall) plus ${keepout.toFixed(1)} m keep-out: no modules over penetrations, and the clearance avoids its shadow edge and allows flashing repairs.` });
      return { box, o };
    });
    // low-flux cells from the heatmap
    const hr = heat?.roofs?.find((r) => r.roofId === roof.id);
    const lowCells = [];
    if (hr && threshold > 0) {
      for (const c of hr.cells) if (c.poa < threshold) lowCells.push(c);
      // merge runs of low cells along u per v-row into strips
      const rows = new Map();
      for (const c of lowCells) { const k = Math.round(c.b / hr.cell); (rows.get(k) || rows.set(k, []).get(k)).push(c); }
      for (const [, cs] of rows) {
        cs.sort((x, y) => x.a - y.a);
        let s = 0;
        for (let i = 1; i <= cs.length; i++) {
          if (i === cs.length || cs[i].a - cs[i - 1].a > hr.cell * 1.5) {
            const a0 = cs[s].a - hr.cell / 2, a1 = cs[i - 1].a + hr.cell / 2, b = cs[s].b, h = hr.cell / 2;
            const mean = cs.slice(s, i).reduce((t, c) => t + c.poa, 0) / (i - s);
            rejected.push({ roofId: roof.id, kind: 'flux', outline: [[a0, b - h], [a1, b - h], [a1, b + h], [a0, b + h]].map(([x, y]) => fromPlane(f, x, y, 0.05)), why: `Low sun: about ${Math.round(mean)} kWh/m²/yr here, below the ${Math.round(threshold)} kWh/m²/yr threshold you set (mostly from shading by nearby objects).` });
            s = i;
          }
        }
      }
    }
    const fluxAt = (a, b) => {
      if (!hr) return Infinity;
      let best = null, bd = Infinity;
      for (const c of hr.cells) { const d = (c.a - a) ** 2 + (c.b - b) ** 2; if (d < bd) { bd = d; best = c; } }
      return best ? best.poa : Infinity;
    };
    // grid search for the offset giving the most modules
    const xs = inner.map((p) => p[0]), ys = inner.map((p) => p[1]);
    const ax0 = Math.min(...xs), ax1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const fits = (a, b) => {
      const cs = [[a, b], [a + pu, b], [a + pu, b + pv], [a, b + pv]];
      for (const [x, y] of cs) if (!pointInPoly(x, y, poly) || polyEdgeDist(x, y, poly) < setback - 1e-6) return false;
      for (const { box } of obst) if (a < box[2] && a + pu > box[0] && b < box[3] && b + pv > box[1]) return false;
      if (threshold > 0 && fluxAt(a + pu / 2, b + pv / 2) < threshold) return false;
      return true;
    };
    let best = [];
    const nCols = Math.floor((ax1 - ax0 + gap) / (pu + gap)), nRows = Math.floor((by1 - by0 + gap) / (pv + gap));
    const slackU = ax1 - ax0 - (nCols * (pu + gap) - gap), slackV = by1 - by0 - (nRows * (pv + gap) - gap);
    for (const fu of [0.5, 0, 1, 0.25, 0.75]) for (const fv of [0, 0.5, 1]) {
      const cells = [];
      for (let r = 0; r < nRows + 1; r++) for (let c = 0; c < nCols + 1; c++) {
        const a = ax0 + slackU * fu + c * (pu + gap), b = by0 + slackV * fv + r * (pv + gap);
        if (fits(a, b)) cells.push({ a, b, r, c });
      }
      if (cells.length > best.length) best = cells;
    }
    for (const cell of best) {
      const h = standoff;
      const corners = [[cell.a, cell.b], [cell.a + pu, cell.b], [cell.a + pu, cell.b + pv], [cell.a, cell.b + pv]].map(([x, y]) => fromPlane(f, x, y, h));
      // CCW seen from above (x east, z south → screen y = -z)
      const area = corners.reduce((s, p, i) => { const q = corners[(i + 1) % 4]; return s + p[0] * -q[2] - q[0] * -p[2]; }, 0);
      if (area < 0) corners.reverse();
      const centre = fromPlane(f, cell.a + pu / 2, cell.b + pv / 2, h);
      const inset = 0.15;
      const samplePts = [[0.5, 0.5], [inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]].map(([x, y]) => fromPlane(f, cell.a + pu * x, cell.b + pv * y, h));
      const irr = annualAt(occ, samplePts, f.n, samples);
      const minEdge = Math.min(...[[cell.a, cell.b], [cell.a + pu, cell.b], [cell.a + pu, cell.b + pv], [cell.a, cell.b + pv]].map(([x, y]) => polyEdgeDist(x, y, poly)));
      const obstDist = obst.length ? Math.min(...obst.map(({ box }) => Math.max(box[0] - (cell.a + pu), cell.a - box[2], box[1] - (cell.b + pv), cell.b - box[3], 0) + keepout)) : null;
      candidates.push({ roof, f, cell, corners, centre, irr, minEdge, obstDist, obstKind: obst[0]?.o.kind });
    }
  }

  // rank by yield; trim to target
  const wp = panel.wattPeak;
  const area = W * L;
  for (const c of candidates) c.kwh = (wp / 1000) * c.irr.poa * pr;
  candidates.sort((a, b) => b.kwh - a.kwh);
  let keep = candidates.length;
  if (options.targetKwp) keep = Math.min(keep, Math.ceil((options.targetKwp * 1000) / wp - 1e-9));
  if (options.maxPanels) keep = Math.min(keep, options.maxPanels);
  const kept = candidates.slice(0, keep);
  const dropped = candidates.slice(keep);
  const bestPoa = Math.max(1, ...candidates.map((c) => c.irr.poa0));
  for (const d of dropped) rejected.push({ roofId: d.roof.id, kind: 'target', outline: d.corners.map((p) => add(p, scale(d.f.n, 0.05 - standoff))), why: `A module fits here, but the ${options.targetKwp} kWp target is already met by spots with more sun (this one would make ~${Math.round(d.kwh)} kWh/yr).` });

  // arrays per roof
  const arrays = [], panels = [];
  const byRoof = new Map();
  for (const c of kept) (byRoof.get(c.roof.id) || byRoof.set(c.roof.id, []).get(c.roof.id)).push(c);
  let ai = 0;
  for (const [roofId, cs] of byRoof) {
    const { f, roof } = cs[0];
    const minR = Math.min(...cs.map((c) => c.cell.r)), maxR = Math.max(...cs.map((c) => c.cell.r));
    const minC = Math.min(...cs.map((c) => c.cell.c)), maxC = Math.max(...cs.map((c) => c.cell.c));
    const a0 = Math.min(...cs.map((c) => c.cell.a)), b0 = Math.min(...cs.map((c) => c.cell.b));
    const a1 = Math.max(...cs.map((c) => c.cell.a + pu)), b1 = Math.max(...cs.map((c) => c.cell.b + pv));
    const id = `A${++ai}`;
    const rows = maxR - minR + 1, cols = maxC - minC + 1;
    const tilt = Math.acos(Math.min(1, f.n[1])) / RAD;
    const az = roof.azimuth ?? 0;
    const kWp = (cs.length * wp) / 1000;
    const annualKwh = cs.reduce((s, c) => s + c.kwh, 0);
    const mountKg = options.mountingKgPerPanel ?? 2.5;
    const weightKg = cs.length * (panel.weightKg + mountKg);
    const wM = a1 - a0, lM = b1 - b0;
    const shadeLossArr = cs.reduce((s, c) => s + (1 - c.irr.poa / c.irr.poa0), 0) / cs.length;
    arrays.push({
      id, roofId, rows, cols, orientation, widthM: wM, lengthM: lM,
      origin: fromPlane(f, a0, b0, standoff), axisU: f.u, axisV: f.v,
      rowPitchM: pv + gap, gapM: gap, setbackM: setback, tiltDeg: tilt, azimuthDeg: az + azOff,
      standoffM: standoff, weightKg, loadKgM2: weightKg / (wM * lM), kWp, annualKwh, panelCount: cs.length,
      reason: { headline: `${cs.length} modules on the ${compassName(az + azOff)}-facing slope (${roofId})`, bullets: [`Filled the area left after ${setback.toFixed(2)} m edge setbacks${roof.obstacles?.length ? ' and obstacle keep-outs' : ''}`, `${orientation === 'portrait' ? 'Portrait' : 'Landscape'} gave the most modules on this plane`, `Average shade loss ${(shadeLossArr * 100).toFixed(1)}%`] }
    });
    for (const c of cs) {
      const shadeLoss = Math.max(0, 1 - c.irr.poa / c.irr.poa0);
      const rel = c.irr.poa0 / bestPoa;
      const worst = Object.entries(c.irr.lostBySector).sort((x, y) => y[1] - x[1])[0];
      const azN = az + azOff;
      const bullets = [
        `Faces ${Math.round(((azN % 360) + 360) % 360)}° (${compassName(azN)}) at ${tilt.toFixed(0)}° tilt: ${Math.round(c.irr.poa)} kWh/m²/yr on the module plane${rel > 0.995 ? ', as good as anywhere on this house' : `, ${Math.round(rel * 100)}% of the sunniest roof spot`}.`,
        shadeLoss < 0.01 ? 'No measurable shading from the scanned surroundings over the year.' : `Shade loss ${(shadeLoss * 100).toFixed(1)}%, mostly in the ${worst[0]}${worst[0] === 'afternoon' ? ' (from the west)' : worst[0] === 'morning' ? ' (from the east)' : ''}.`,
        `${c.minEdge.toFixed(2)} m from the nearest roof edge (minimum ${setback.toFixed(2)} m).`,
        c.obstDist != null ? `${c.obstDist.toFixed(2)} m clear of the ${(c.obstKind || 'obstacle').toLowerCase()}.` : null,
        `About ${Math.round(c.irr.sunHours).toLocaleString()} hours of direct sun per year; ~${Math.round(c.kwh)} kWh/yr after a ${(pr * 100).toFixed(0)}% performance ratio.`
      ].filter(Boolean);
      const headline = shadeLoss < 0.02 ? `Open, unshaded spot on the ${compassName(azN)} slope` : shadeLoss < 0.08 ? `Good spot with light ${worst[0]} shade` : `Kept despite ${worst[0]} shade: still above the threshold`;
      panels.push({
        id: `${id}-r${c.cell.r - minR + 1}c${c.cell.c - minC + 1}`, roofId, arrayId: id, row: c.cell.r - minR + 1, col: c.cell.c - minC + 1,
        corners: c.corners, centre: c.centre, normal: c.f.n, tiltDeg: tilt, azimuthDeg: azN,
        annualKwh: c.kwh, poaKwhM2: c.irr.poa, shadeLoss, sunHoursYear: c.irr.sunHours,
        reason: { headline, bullets }
      });
    }
  }
  const kWp = (panels.length * wp) / 1000, annualKwh = panels.reduce((s, p) => s + p.annualKwh, 0);
  return {
    panels, arrays, rejected,
    summary: {
      panels: panels.length, kWp, annualKwh, specificYield: kWp ? annualKwh / kWp : 0,
      avgShadeLoss: panels.length ? panels.reduce((s, p) => s + p.shadeLoss, 0) / panels.length : 0,
      moduleAreaM2: panels.length * area,
      assumptions: [MOCK_CLIMATE.source, `Performance ratio ${(pr * 100).toFixed(0)}% (inverter, wiring, soiling, temperature)`, 'Shading from the scanned point cloud only (25 cm voxels); trees grow', 'Mock planner (fallback): the real algorithm module was not found']
    }
  };
}

// ---------------------------------------------------------------- mock scan
// A 10 × 8 m single-storey house with a 25° gable roof (ridge east-west), a
// chimney on the south slope, a vent on the north slope and a tree to the
// south-west that shades the slope in the late afternoon.
export function makeMockTwin() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += rnd(); return (s - 2) * 0.8; };
  const P = [], N = [];
  const push = (x, y, z, nx, ny, nz, noise = 0.012) => { P.push(x + gauss() * noise, y + gauss() * noise, z + gauss() * noise); N.push(nx, ny, nz); };
  const pitch = 25 * RAD, wall = 3, hx = 5, hz = 4, over = 0.45;
  const ridgeY = wall + hz * Math.tan(pitch);
  const eaveY = wall - over * Math.tan(pitch);
  // roof planes, tile corrugation along the slope
  const slopeLen = (hz + over) / Math.cos(pitch);
  for (const side of [1, -1]) {
    const n = [0, Math.cos(pitch), side * Math.sin(pitch)];
    const count = Math.round((2 * (hx + over)) * slopeLen * 650);
    for (let i = 0; i < count; i++) {
      const x = (rnd() * 2 - 1) * (hx + over), s = rnd() * slopeLen;
      const z = side * s * Math.cos(pitch), y = ridgeY - s * Math.sin(pitch);
      const ripple = 0.012 * Math.sin((s / 0.33) * Math.PI * 2) ** 2;
      push(x + 0, y + ripple, z, n[0], n[1], n[2], 0.008);
    }
  }
  // walls
  const wallPts = (count, fn) => { for (let i = 0; i < count; i++) fn(rnd(), rnd()); };
  wallPts(10 * 3 * 280, (a, b) => push(-hx + a * 2 * hx, b * wall, hz, 0, 0, 1));
  wallPts(10 * 3 * 280, (a, b) => push(-hx + a * 2 * hx, b * wall, -hz, 0, 0, -1));
  for (const sx of [1, -1]) {
    wallPts(8 * 3 * 280, (a, b) => push(sx * hx, b * wall, -hz + a * 2 * hz, sx, 0, 0));
    // gable triangle
    wallPts(Math.round(8 * (ridgeY - wall) * 0.5 * 280), (a, b) => {
      const z = -hz + a * 2 * hz, top = wall + (hz - Math.abs(z)) * Math.tan(pitch);
      push(sx * hx, wall + b * (top - wall), z, sx, 0, 0);
    });
  }
  // windows/door: darker recess is implied by small inset points (adds visual detail)
  for (const [x0, x1, y0, y1] of [[-3.5, -1.8, 1, 2.2], [1.8, 3.5, 1, 2.2], [-0.5, 0.5, 0, 2.1]]) {
    wallPts(Math.round((x1 - x0) * (y1 - y0) * 300), (a, b) => push(x0 + a * (x1 - x0), y0 + b * (y1 - y0), hz - 0.08, 0, 0, 1, 0.004));
  }
  // chimney on the south slope
  const chim = { x: 2.6, z: 1.6, w: 0.6, top: 0 };
  const roofYAt = (z) => ridgeY - Math.abs(z) * Math.tan(pitch);
  chim.top = roofYAt(chim.z - chim.w / 2) + 1.1;
  const chimBase = roofYAt(chim.z + chim.w / 2);
  for (let i = 0; i < 9000; i++) {
    const face = Math.floor(rnd() * 5), a = rnd() - 0.5, y = chimBase - 0.2 + rnd() * (chim.top - chimBase + 0.2);
    const cx = chim.x, cz = chim.z, w = chim.w;
    if (face === 0) push(cx + a * w, y, cz + w / 2, 0, 0, 1);
    else if (face === 1) push(cx + a * w, y, cz - w / 2, 0, 0, -1);
    else if (face === 2) push(cx + w / 2, y, cz + a * w, 1, 0, 0);
    else if (face === 3) push(cx - w / 2, y, cz + a * w, -1, 0, 0);
    else push(cx + a * w, chim.top, cz + (rnd() - 0.5) * w, 0, 1, 0);
  }
  // vent pipe on the north slope
  const vent = { x: -2.2, z: -2.0, r: 0.08, h: 0.6 };
  const ventBase = roofYAt(vent.z);
  for (let i = 0; i < 1500; i++) {
    const t = rnd() * Math.PI * 2;
    push(vent.x + Math.cos(t) * vent.r, ventBase + rnd() * vent.h, vent.z + Math.sin(t) * vent.r, Math.cos(t), 0, Math.sin(t), 0.004);
  }
  // tree to the south-west
  const tree = { x: -8.6, z: 3.8, r: 2.7, cy: 5.6 };
  for (let i = 0; i < 2600; i++) { const t = rnd() * Math.PI * 2; push(tree.x + Math.cos(t) * 0.22, rnd() * (tree.cy - 1), tree.z + Math.sin(t) * 0.22, Math.cos(t), 0, Math.sin(t)); }
  for (let i = 0; i < 32000; i++) {
    let x, y, z; do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1);
    const l = Math.hypot(x, y, z) || 1, rr = tree.r * (0.75 + 0.25 * Math.cbrt(rnd()));
    push(tree.x + (x / l) * rr, tree.cy + (y / l) * rr * 0.85, tree.z + (z / l) * rr, x / l, y / l, z / l, 0.06);
  }
  // ground, sparser away from the house; a low boundary wall to the north
  for (let i = 0; i < 52000; i++) {
    const x = (rnd() * 2 - 1) * 13, z = (rnd() * 2 - 1) * 12;
    if (Math.abs(x) < hx && Math.abs(z) < hz) continue;
    push(x, 0, z, 0, 1, 0, 0.01);
  }
  wallPts(26 * 1.2 * 120, (a, b) => push(-13 + a * 26, b * 1.2, -11.5, 0, 0, 1));
  const points = new Float32Array(P);
  const normals = new Int8Array(N.length);
  for (let i = 0; i < N.length; i++) normals[i] = Math.round(N[i] * 127);

  // occupancy grid
  const voxel = 0.25;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], points[i + k]); mx[k] = Math.max(mx[k], points[i + k]); }
  const origin = mn.map((v) => Math.floor(v / voxel) * voxel - voxel);
  const dims = [0, 1, 2].map((k) => Math.ceil((mx[k] - origin[k]) / voxel) + 2);
  const occ = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const setVox = (x, y, z) => {
    const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((y - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
    if (i >= 0 && j >= 0 && k >= 0 && i < dims[0] && j < dims[1] && k < dims[2]) occ[i + dims[0] * (j + dims[1] * k)] = 1;
  };
  for (let i = 0; i < points.length; i += 3) setVox(points[i], points[i + 1], points[i + 2]);
  // fill the canopy so leaf gaps don't leak unrealistic sun
  for (let x = -tree.r; x <= tree.r; x += voxel) for (let y = -tree.r; y <= tree.r; y += voxel) for (let z = -tree.r; z <= tree.r; z += voxel) {
    if (x * x + (y / 0.85) ** 2 + z * z < (tree.r * 0.9) ** 2) setVox(tree.x + x, tree.cy + y, tree.z + z);
  }

  const roofPlane = (side) => {
    const n = [0, Math.cos(pitch), side * Math.sin(pitch)];
    const zE = side * (hz + over);
    const outline = [[-hx - over, ridgeY, 0], [hx + over, ridgeY, 0], [hx + over, eaveY, zE], [-hx - over, eaveY, zE]];
    if (side < 0) outline.reverse();
    return {
      id: side > 0 ? 'R1' : 'R2', normal: n, point: [0, ridgeY, 0], tilt: 25, azimuth: side > 0 ? 180 : 0,
      outline, eaveDir: [1, 0, 0], upSlopeDir: [0, Math.sin(pitch), -side * Math.cos(pitch)], edges: (side > 0 ? ['ridge', 'verge', 'eave', 'verge'] : ['eave', 'verge', 'ridge', 'verge']).map((type) => ({ type })), area: 2 * (hx + over) * slopeLen,
      obstacles: side > 0
        ? [{ kind: 'Chimney', height: 1.1, outline: [[chim.x - 0.3, roofYAt(chim.z - 0.3), chim.z - 0.3], [chim.x + 0.3, roofYAt(chim.z - 0.3), chim.z - 0.3], [chim.x + 0.3, roofYAt(chim.z + 0.3), chim.z + 0.3], [chim.x - 0.3, roofYAt(chim.z + 0.3), chim.z + 0.3]] }]
        : [{ kind: 'Vent pipe', height: vent.h, outline: [[vent.x - 0.1, ventBase, vent.z - 0.1], [vent.x + 0.1, ventBase, vent.z - 0.1], [vent.x + 0.1, ventBase, vent.z + 0.1], [vent.x - 0.1, ventBase, vent.z + 0.1]] }]
    };
  };
  const twin = {
    id: 'mock-house', title: 'Demo house (synthetic stand-in)', source: 'Synthetic point cloud generated in the browser (src/twin-mock.js) because public/twins/friend-house/ was not found',
    pointCount: points.length / 3, bounds: { min: mn, max: mx },
    scale: { metresPerUnit: 1, method: 'Synthetic model, exact by construction', confidence: 'high' },
    northBearing: 0, location: { lat: 3.11, lon: 101.58, name: 'Ara Damansara (assumed)', timezone: 8 },
    ground: { y: 0 }, roofs: [roofPlane(1), roofPlane(-1)],
    occupancy: { origin, voxel, dims, file: null },
    mock: true
  };
  return { twin, points, normals, occupancy: makeOccupancy(twin.occupancy, occ) };
}
