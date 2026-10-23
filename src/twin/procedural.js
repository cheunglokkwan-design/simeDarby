// "Level 1" digital twin generated from map data (OpenStreetMap footprint +
// estimated height), so every building on the township map can be drilled
// into with the same physics planner as the drone-scanned twin.
//
// buildSiteTwin(site, neighbours, options) -> { twin, occupancy, meshes, notes, planOptions }
//   site        one entry of buildSites(raw).sites (src/solar.js): xy in local
//               metres (x east, y NORTH), centroid, height, category, ...
//   neighbours  any list of sites (e.g. all of them); those whose centroid lies
//               within options.radius of the site are extruded for shading
//   options     { lat, lon, radius = 80, voxel (auto), roofType: 'flat'|'hip'|'gable',
//                 pitchDeg = 25, overhangM = 0.6, parapetM = 0.9, maxVoxels = 8e6 }
//
// Twin frame (docs/internal/twin-contract.md): metres, x east, y up, z south,
// origin on the ground under the site's centroid: X = x - cx, Z = -(y - cy).
// Occupancy: Uint8 (1 = solid), x fastest, then y, then z; layer 0 is a ground slab.
// Pure ES module, no DOM.

import { compassAzimuthOf } from './sun.js';

const RAD = Math.PI / 180;
const r3 = (p, k = 3) => p.map((x) => +x.toFixed(k));
const fmt1 = (x) => (Math.round(x * 10) / 10).toString();

export const PITCHED_CATEGORIES = ['residential'];
export const CANOPY_CATEGORIES = ['carpark'];
const SOURCE = 'Map-based twin (OpenStreetMap footprint + estimated height)';

// ----------------------------------------------------------------------------- 2D geometry (x, z)
function area2(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }

function cleanRing(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.05) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.05) out.pop();
  return out;
}

// Douglas-Peucker on a closed ring (tolerance in metres)
function simplifyRing(ring, tol) {
  if (ring.length <= 8 || tol <= 0) return ring;
  const dps = (pts) => {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const L = Math.hypot(bx - ax, by - ay) || 1e-9;
      let dm = 0, im = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
        if (d > dm) { dm = d; im = i; }
      }
      if (dm > tol && im > 0) { keep[im] = 1; st.push([a, im], [im, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  // split at the vertex farthest from vertex 0
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dps(ring.slice(0, far + 1)), b = dps([...ring.slice(far), ring[0]]);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 && Math.abs(area2(out)) > 0.9 * Math.abs(area2(ring)) ? out : ring;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// Oriented minimum-area bounding rectangle (rotating calipers over the hull).
// Returns { c:[x,z], a:[ax,az] (unit, long axis), b:[bx,bz] (unit, short axis), l (half long), w (half short) }
export function minRect(ring) {
  const h = convexHull(ring);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const r of h) { const s = r[0] * ux + r[1] * uz, t = -r[0] * uz + r[1] * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    const A = (s1 - s0) * (t1 - t0);
    if (!best || A < best.A - 1e-9) best = { A, ux, uz, s0, s1, t0, t1 };
  }
  if (!best) return { c: ring[0] || [0, 0], a: [1, 0], b: [0, 1], l: 0.5, w: 0.5 };
  const { ux, uz, s0, s1, t0, t1 } = best;
  const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2;
  const c = [sm * ux - tm * uz, sm * uz + tm * ux];
  let a = [ux, uz], b = [-uz, ux], l = (s1 - s0) / 2, w = (t1 - t0) / 2;
  if (w > l) { [a, b] = [b, [-a[0], -a[1]]]; [l, w] = [w, l]; }
  return { c, a, b, l, w };
}

// distance from a point to a polygon (0 inside), plan metres
function distToRing(px, py, ring) {
  let inside = false, d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xi - xj, dy = yi - yj, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - xj) * dx + (py - yj) * dy) / L2)) : 0;
    d = Math.min(d, Math.hypot(px - xj - t * dx, py - yj - t * dy));
  }
  return inside ? 0 : d;
}

// ----------------------------------------------------------------------------- roof shapes
// height of a pitched roof over its (expanded) rectangle; -Infinity outside
function pitchedSurface(R, type, eaveY, tanP) {
  return (x, z) => {
    const dx = x - R.c[0], dz = z - R.c[1];
    const s = Math.abs(dx * R.a[0] + dz * R.a[1]), t = Math.abs(dx * R.b[0] + dz * R.b[1]);
    if (s > R.l + 1e-9 || t > R.w + 1e-9) return -Infinity;
    const d = type === 'hip' ? Math.min(R.l - s, R.w - t) : R.w - t;
    return eaveY + tanP * d;
  };
}

// Roof planes of a hip / gable roof as contract roofs (outline CCW in the planner's u,v frame)
function pitchedPlanes(R, type, eaveY, pitchDeg, buildingId, idBase) {
  const tanP = Math.tan(pitchDeg * RAD), rise = R.w * tanP, ridgeY = eaveY + rise;
  const P = (s, t, y) => [R.c[0] + R.a[0] * s + R.b[0] * t, y, R.c[1] + R.a[1] * s + R.b[1] * t];
  const { l, w } = R;
  const k = type === 'hip' ? Math.max(0, l - w) : l; // ridge half-length
  const faces = [];
  // long sides (+b, -b): eave, [hip|verge], ridge, [hip|verge]
  for (const sg of [1, -1]) {
    const side = type === 'hip' ? 'hip' : 'verge';
    let verts = [P(-l, sg * w, eaveY), P(l, sg * w, eaveY), P(k, 0, ridgeY), P(-k, 0, ridgeY)];
    let edges = ['eave', side, 'ridge', side];
    if (k < 0.05) { verts = [verts[0], verts[1], P(0, 0, ridgeY)]; edges = ['eave', side, side]; }
    faces.push({ verts, edges, out: [R.b[0] * sg, R.b[1] * sg] });
  }
  if (type === 'hip') for (const sg of [1, -1]) {
    faces.push({ verts: [P(sg * l, -w, eaveY), P(sg * l, w, eaveY), P(sg * k, 0, ridgeY)], edges: ['eave', 'hip', 'hip'], out: [R.a[0] * sg, R.a[1] * sg] });
  }
  const cosP = Math.cos(pitchDeg * RAD), sinP = Math.sin(pitchDeg * RAD);
  return faces.map((f, i) => {
    const n = [f.out[0] * sinP, cosP, f.out[1] * sinP];
    // planner frame: u along the eave, v = n × u pointing up-slope
    let u = [f.out[1], 0, -f.out[0]];
    let v = cross(n, u);
    if (v[1] < 0) { u = [-u[0], 0, -u[2]]; v = cross(n, u); }
    let verts = f.verts, edges = f.edges;
    const uv = verts.map((p) => [p[0] * u[0] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]]);
    if (area2(uv) < 0) {
      // reverse the ring: edge i of the reversed ring is edge (n-2-i) of the original
      const m = verts.length;
      verts = verts.slice().reverse();
      edges = verts.map((_, j) => f.edges[((m - 2 - j) % m + m) % m]);
    }
    const pt = verts.reduce((a, p) => [a[0] + p[0] / verts.length, a[1] + p[1] / verts.length, a[2] + p[2] / verts.length], [0, 0, 0]);
    const planArea = Math.abs(area2(verts.map((p) => [p[0], p[2]])));
    return {
      id: `${idBase}${i + 1}`, building: buildingId, normal: r3(n, 5), point: r3(pt), tilt: +pitchDeg.toFixed(2),
      azimuth: +compassAzimuthOf([n[0], 0, n[2]], 0).toFixed(2), flat: false,
      outline: verts.map((p) => r3(p)),
      edges: edges.map((t, j) => { const a = verts[j], b = verts[(j + 1) % verts.length]; return { type: t, lengthM: +Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]).toFixed(2) }; }),
      eaveDir: r3(u, 5), upSlopeDir: r3([-f.out[0] * cosP, sinP, -f.out[1] * cosP], 5),
      area: +(planArea / cosP).toFixed(2), obstacles: [],
    };
  });
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

function flatRoof(ring, y, R, buildingId, id) {
  let pts = ring.slice();
  // CCW seen from above in the planner frame (u = long axis, v = n × u)
  const u = [R.a[0], 0, R.a[1]], v = cross([0, 1, 0], u);
  const uv = pts.map(([x, z]) => [x * u[0] + z * u[2], x * v[0] + z * v[2]]);
  if (area2(uv) < 0) pts = pts.reverse();
  const outline = pts.map(([x, z]) => r3([x, y, z]));
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  return {
    id, building: buildingId, normal: [0, 1, 0], point: r3([c[0], y, c[1]]), tilt: 0, azimuth: 180, flat: true,
    outline, edges: outline.map((a, j) => { const b = outline[(j + 1) % outline.length]; return { type: 'edge', lengthM: +Math.hypot(b[0] - a[0], b[2] - a[2]).toFixed(2) }; }),
    eaveDir: r3(u, 5), upSlopeDir: r3(v, 5), area: +Math.abs(area2(pts)).toFixed(2), obstacles: [],
  };
}

// ----------------------------------------------------------------------------- building model
function toTwinRing(xy, cx, cy) {
  return cleanRing(xy.map(([x, y]) => [x - cx, -(y - cy)]));
}

function roofKind(cat, ring, R, override) {
  if (CANOPY_CATEGORIES.includes(cat)) return 'canopy';
  if (override === 'flat' || override === 'hip' || override === 'gable') return override;
  if (!PITCHED_CATEGORIES.includes(cat)) return 'flat';
  return R.l / Math.max(0.1, R.w) >= 2.5 ? 'gable' : 'hip';
}

// One building (site or neighbour) as a solid model used for voxels and meshes.
function modelBuilding(s, cx, cy, opts, isSite) {
  let ring = toTwinRing(s.xy, cx, cy);
  if (ring.length < 3) return null;
  if (isSite) ring = simplifyRing(ring, 0.2);
  const R0 = minRect(ring);
  const cat = s.category;
  const kind = roofKind(cat, ring, R0, isSite ? opts.roofType : null);
  const H = Math.max(2.5, s.height || 4);
  const m = { id: s.id, name: s.name || null, isSite, category: cat, ring, R0, kind, height: H };
  if (kind === 'canopy') {
    m.top = H; m.bottom = H - 0.3; m.ridge = H; m.parapet = 0;
  } else if (kind === 'flat') {
    m.top = H; m.parapet = cat !== 'canopy' && (isSite || H > 6) ? opts.parapetM : 0; m.ridge = H;
  } else {
    const ov = opts.overhangM;
    const R = { ...R0, l: R0.l + ov, w: R0.w + ov };
    const tanP = Math.tan(opts.pitchDeg * RAD);
    const rise = R.w * tanP;
    const eave = Math.max(2.7, H - rise);
    m.R = R; m.eave = eave; m.ridge = eave + rise; m.top = m.ridge; m.parapet = 0;
    m.surface = pitchedSurface(R, kind === 'gable' ? 'gable' : 'hip', eave, tanP);
    m.wallTop = eave;
  }
  return m;
}

// ----------------------------------------------------------------------------- voxels
// scanline spans of a ring on row z (cell centres), returns [[x0,x1], ...]
function spans(ring, z) {
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z)) xs.push(xi + ((z - zi) * (xj - xi)) / (zj - zi));
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
  return out;
}

function chooseVoxel(ext, maxH, siteArea, opts) {
  if (Number.isFinite(opts.voxel) && opts.voxel > 0) return opts.voxel;
  const cands = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const min = siteArea > 2000 ? 0.5 : 0.25;
  for (const v of cands) {
    if (v < min) continue;
    const n = Math.ceil(ext[0] / v) * Math.ceil((maxH + 3) / v + 1) * Math.ceil(ext[1] / v);
    if (n <= opts.maxVoxels) return v;
  }
  return 2.0;
}

function voxelise(models, bounds, voxel) {
  const [x0, z0] = bounds.min, [x1, z1] = bounds.max;
  const nx = Math.max(1, Math.ceil((x1 - x0) / voxel)), nz = Math.max(1, Math.ceil((z1 - z0) / voxel));
  const ny = Math.max(2, Math.ceil((bounds.maxY + 1) / voxel) + 1);
  const origin = [x0, -voxel, z0];
  const data = new Uint8Array(nx * ny * nz);
  const nxy = nx * ny;
  // ground slab (layer 0)
  for (let k = 0; k < nz; k++) data.fill(1, nxy * k, nxy * k + nx);
  const fillCol = (i, k, yBot, yTop) => {
    if (i < 0 || k < 0 || i >= nx || k >= nz || !(yTop > yBot)) return;
    // voxels whose centre lies in [yBot, yTop)
    const j0 = Math.max(1, Math.ceil((yBot - origin[1]) / voxel - 0.5)), j1 = Math.min(ny - 1, Math.ceil((yTop - origin[1]) / voxel - 0.5) - 1);
    const base = i + nxy * k;
    for (let j = j0; j <= j1; j++) data[base + nx * j] = 1;
  };
  const cellX = (i) => x0 + (i + 0.5) * voxel, cellZ = (k) => z0 + (k + 0.5) * voxel;
  const rowRange = (zmin, zmax) => [Math.max(0, Math.floor((zmin - z0) / voxel)), Math.min(nz - 1, Math.ceil((zmax - z0) / voxel))];
  for (const m of models) {
    const zs = m.ring.map((p) => p[1]);
    if (m.kind === 'hip' || m.kind === 'gable') {
      // walls over the footprint up to the eave, roof over the expanded rectangle
      const rc = rectCorners(m.R);
      const [k0, k1] = rowRange(Math.min(...rc.map((p) => p[1])), Math.max(...rc.map((p) => p[1])));
      for (let k = k0; k <= k1; k++) {
        const z = cellZ(k);
        const inFoot = spans(m.ring, z), inRect = spans(rc, z);
        for (const [a, b] of inRect) {
          const i0 = Math.max(0, Math.ceil((a - x0) / voxel - 0.5)), i1 = Math.min(nx - 1, Math.floor((b - x0) / voxel - 0.5));
          for (let i = i0; i <= i1; i++) {
            const x = cellX(i), top = m.surface(x, z);
            if (!Number.isFinite(top)) continue;
            const inside = inFoot.some(([p, q]) => x >= p && x <= q);
            fillCol(i, k, inside ? 0 : m.eave - 0.3, top);
          }
        }
      }
      continue;
    }
    const [k0, k1] = rowRange(Math.min(...zs), Math.max(...zs));
    const mask = m.isSite && m.parapet > 0 ? new Map() : null;
    for (let k = k0; k <= k1; k++) {
      const z = cellZ(k);
      for (const [a, b] of spans(m.ring, z)) {
        const i0 = Math.max(0, Math.ceil((a - x0) / voxel - 0.5)), i1 = Math.min(nx - 1, Math.floor((b - x0) / voxel - 0.5));
        for (let i = i0; i <= i1; i++) {
          fillCol(i, k, m.kind === 'canopy' ? m.bottom : 0, m.top);
          if (mask) mask.set(i + nx * k, 1);
        }
      }
    }
    if (m.parapet > 0) {
      // parapet ring: footprint cells with a 4-neighbour outside the footprint
      const cells = mask || null;
      if (cells) {
        for (const key of cells.keys()) {
          const i = key % nx, k = (key - i) / nx;
          if (!cells.has(key - 1) || !cells.has(key + 1) || !cells.has(key - nx) || !cells.has(key + nx)) fillCol(i, k, m.top - voxel, m.top + m.parapet);
        }
      }
    }
  }
  return { origin: r3(origin, 4), voxel, dims: [nx, ny, nz], data };
}

function rectCorners(R) {
  const P = (s, t) => [R.c[0] + R.a[0] * s + R.b[0] * t, R.c[1] + R.a[1] * s + R.b[1] * t];
  return [P(-R.l, -R.w), P(R.l, -R.w), P(R.l, R.w), P(-R.l, R.w)];
}

// ----------------------------------------------------------------------------- planner hints
function planHints(kind, roofArea) {
  if (kind === 'hip' || kind === 'gable') {
    const big = roofArea > 600;
    return big ? { mounting: 'flush', fluxCell: 0.5, phaseStep: 0.2, centreStep: 0.05 } : { mounting: 'flush' };
  }
  const base = { mounting: kind === 'canopy' ? 'flush' : 'tilted', commercial: true };
  if (roofArea < 1500) return { ...base, fluxCell: 0.25, phaseStep: 0.1 };
  if (roofArea < 6000) return { ...base, fluxCell: 0.5, rayStride: 3, phaseStep: 0.25, centreStep: 0.1, centrePerimeterOnly: true };
  const huge = roofArea >= 15000;
  return { ...base, fluxCell: 1.0, stepMin: 60, rayStride: 4, shadeBlock: 2, phaseStep: huge ? 0.8 : 0.5, centreStep: 0.25, centrePerimeterOnly: true };
}

// ----------------------------------------------------------------------------- main API
export function buildSiteTwin(site, neighbours = [], options = {}) {
  const opts = { radius: 80, pitchDeg: 25, overhangM: 0.6, parapetM: 0.9, maxVoxels: 8e6, ...options };
  const notes = [];
  const [cx, cy] = site.centroid || [0, 0];
  const lon = opts.lon ?? site.position?.[0] ?? 101.58, lat = opts.lat ?? site.position?.[1] ?? 3.11;

  const siteModel = modelBuilding(site, cx, cy, opts, true);
  if (!siteModel) throw new Error(`Site ${site.id} has no usable footprint`);
  // neighbours: existing buildings with centroid within the radius (proposed car-park canopies are not shading anything yet)
  const near = [];
  for (const s of neighbours || []) {
    if (!s || s.id === site.id || !s.xy || !s.centroid || CANOPY_CATEGORIES.includes(s.category)) continue;
    const d = distToRing(s.centroid[0], s.centroid[1], site.xy);
    if (d <= opts.radius) { const m = modelBuilding(s, cx, cy, opts, false); if (m) { m.dist = d; near.push(m); } }
  }
  const models = [siteModel, ...near];

  // grid extent: the site plus the radius around it, neighbours clipped to it
  const sx = siteModel.ring.map((p) => p[0]), sz = siteModel.ring.map((p) => p[1]);
  const extra = siteModel.R ? rectCorners(siteModel.R) : [];
  const allX = [...sx, ...extra.map((p) => p[0])], allZ = [...sz, ...extra.map((p) => p[1])];
  let bx0 = Math.min(...allX), bx1 = Math.max(...allX), bz0 = Math.min(...allZ), bz1 = Math.max(...allZ);
  for (const m of near) for (const [x, z] of m.R ? rectCorners(m.R) : m.ring) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
  const lim = opts.radius + 2;
  const clipX0 = Math.min(...allX) - lim, clipX1 = Math.max(...allX) + lim, clipZ0 = Math.min(...allZ) - lim, clipZ1 = Math.max(...allZ) + lim;
  bx0 = Math.max(bx0, clipX0) - 2; bx1 = Math.min(bx1, clipX1) + 2; bz0 = Math.max(bz0, clipZ0) - 2; bz1 = Math.min(bz1, clipZ1) + 2;
  const maxY = Math.max(...models.map((m) => (m.top ?? m.height) + (m.parapet || 0)));
  const voxel = chooseVoxel([bx1 - bx0, bz1 - bz0], maxY, site.area || Math.abs(area2(siteModel.ring)), opts);
  const occ = voxelise(models, { min: [bx0, bz0], max: [bx1, bz1], maxY }, voxel);

  // roofs (site only)
  const kind = siteModel.kind;
  let roofs;
  if (kind === 'hip' || kind === 'gable') roofs = pitchedPlanes(siteModel.R, kind, siteModel.eave, opts.pitchDeg, 'B1', 'R');
  else roofs = [flatRoof(siteModel.ring, siteModel.top, siteModel.R0, 'B1', 'R1')];
  const roofArea = roofs.reduce((a, r) => a + r.area, 0);

  // notes: every assumption, in words
  const catWord = site.categoryLabel || site.category;
  if (kind === 'hip' || kind === 'gable') {
    notes.push(`Roof shape assumed ${kind} from category ${catWord}${opts.roofType ? ' (override)' : ''}: ${opts.pitchDeg}° pitch (typical Malaysian tile roof 20-30°), ${opts.overhangM} m eave overhang, ridge along the long axis.`);
    notes.push(`Roof built on the footprint's oriented minimum bounding rectangle (${fmt1(2 * siteModel.R0.l)} × ${fmt1(2 * siteModel.R0.w)} m, footprint ${Math.round(Math.abs(area2(siteModel.ring)))} m²); real roofs with wings, valleys or porches differ.`);
    notes.push(`Map height ${fmt1(siteModel.height)} m read as the ridge: eave ${fmt1(siteModel.eave)} m, ridge ${fmt1(siteModel.ridge)} m.`);
    if (kind === 'gable') notes.push('Gable (not hip) because the footprint is long and narrow (terrace-style row).');
    notes.push('Roof obstacles (vents, water tank, skylights, satellite dish) not mapped: verify with imagery or a drone scan.');
  } else if (kind === 'canopy') {
    notes.push('Car park: proposed solar canopy, a flat slab at ~4.5 m over the mapped footprint (no walls); modules flush on the canopy deck.');
    notes.push('Canopy columns, driving aisles and trees between bays not modelled: verify layout with the car park plan.');
  } else if (siteModel.parapet === 0) {
    notes.push(`Roof assumed flat from category ${catWord} (open canopy / outbuilding roof, no parapet); planner uses tilted racks with a 1.0 m edge setback.`);
    notes.push('Rooftop plant and roof structure not mapped: verify with imagery or a drone scan; light canopy roofs may not carry racked panels.');
  } else {
    notes.push(`Roof assumed flat (concrete slab) from category ${catWord}${opts.roofType ? ' (override)' : ''}, with a ${opts.parapetM} m parapet ring${voxel > 0.5 ? ` (parapet below the ${voxel} m shading-grid resolution, so its edge shade is approximate)` : ''}; planner uses tilted racks with a 1.0 m edge setback.`);
    notes.push('Rooftop plant (chillers, cooling towers, lift motor rooms, water tanks, skylights) not mapped: verify with imagery or a drone scan before quoting usable area.');
    if (site.category === 'industrial') notes.push('Many industrial sheds have low-pitch metal-deck roofs rather than slabs: check the roof type and its load capacity.');
  }
  notes.push(`Height ${fmt1(siteModel.height)} m: ${site.heightSource || 'estimated'}${site.levels ? ` (${site.levels} level${site.levels > 1 ? 's' : ''})` : ''}.`);
  if (/levels/i.test(site.heightSource || '')) notes.push('Height estimated from levels (3.2 m per storey + 1 m).');
  notes.push(`Neighbours within ${opts.radius} m used for shading: ${near.length} building${near.length === 1 ? '' : 's'} extruded to their map heights (flat tops; landed homes with hip tops), plus a ground slab. Trees are not mapped and not modelled.`);
  notes.push(`Shading grid ${occ.dims.join(' × ')} voxels of ${voxel} m.`);
  notes.push('Location from the map; north is true north (map-based twin, no compass uncertainty).');

  const title = site.name || site.label || `${catWord} ${site.id}`;
  const occMeta = { origin: occ.origin, voxel, dims: occ.dims };
  const planDefaults = planHints(kind, roofArea);
  const twin = {
    id: site.id, title, source: SOURCE, level: 1,
    scale: { metresPerUnit: 1, method: 'map metres', confidence: 'medium' },
    northBearing: 0, location: { lat, lon, name: title, timezone: 8 }, ground: { y: 0 },
    category: site.category, roofType: kind === 'canopy' ? 'flat' : kind,
    buildings: [
      { id: 'B1', primary: true, roofIds: roofs.map((r) => r.id), centre: [0, 0, 0], osmId: site.id, roofAreaM2: +roofArea.toFixed(1) },
      ...near.map((m, i) => ({ id: `N${i + 1}`, primary: false, roofIds: [], osmId: m.id, name: m.name, height: +m.top.toFixed(2), category: m.category,
        centre: r3([m.ring.reduce((a, p) => a + p[0], 0) / m.ring.length, 0, m.ring.reduce((a, p) => a + p[1], 0) / m.ring.length], 2) })),
    ],
    roofs,
    // named occluders so the planner's shade story can say which building casts the shade
    occluders: near.map((m) => {
      const c = [m.ring.reduce((a, p) => a + p[0], 0) / m.ring.length, m.ring.reduce((a, p) => a + p[1], 0) / m.ring.length];
      const radius = Math.max(...m.ring.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      return { id: m.name || m.id, kind: 'building', centre: r3([c[0], m.top, c[1]], 2), radius: +radius.toFixed(2), top: +(m.top + (m.parapet || 0)).toFixed(2) };
    }),
    occupancy: occMeta,
    bounds: { min: r3([occ.origin[0], 0, occ.origin[2]], 2), max: r3([occ.origin[0] + occ.dims[0] * voxel, maxY, occ.origin[2] + occ.dims[2] * voxel], 2) },
    planDefaults,
    notes,
  };

  const meshes = {
    buildings: models.map((m) => {
      const roof = { type: m.kind === 'canopy' ? 'flat' : m.kind, ridgeHeight: +m.ridge.toFixed(2), parapetM: m.parapet || 0 };
      if (m.kind === 'hip' || m.kind === 'gable') {
        roof.eaveHeight = +m.eave.toFixed(2);
        roof.rect = rectCorners(m.R).map((p) => r3(p, 2));
        roof.faces = (m.isSite ? roofs : pitchedPlanes(m.R, m.kind, m.eave, opts.pitchDeg, '', 'x')).map((r) => r.outline);
      }
      if (m.kind === 'canopy') { roof.canopy = true; roof.thicknessM = 0.3; }
      return { id: m.id, name: m.name, isSite: m.isSite, footprint: m.ring.map((p) => r3(p, 2)), height: +(m.kind === 'hip' || m.kind === 'gable' ? m.eave : m.top).toFixed(2), roof, category: m.category,
        base: m.kind === 'canopy' ? +m.bottom.toFixed(2) : 0 };
    }),
  };

  return { twin, occupancy: { ...occMeta, data: occ.data }, meshes, notes, planOptions: planDefaults };
}
