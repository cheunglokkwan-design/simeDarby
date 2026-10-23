// Shadow and sky-view raycasting through the twin's occupancy grid.
// Occupancy: { origin:[x,y,z], voxel, dims:[nx,ny,nz], data: Uint8Array }
// (1 = solid, x fastest, then y, then z) in the twin frame (x east, y up, z south).
// Pure ES module; no DOM.

const cache = new WeakMap();

// Accepts {origin, voxel, dims, data} or (meta, data) and returns a normalised
// grid with a few precomputed helpers (top solid layer, used for early exit).
export function makeGrid(occ, data) {
  if (!occ) return null;
  if (data) occ = { ...occ, data };
  if (occ.__grid) return occ;
  const hit = cache.get(occ);
  if (hit) return hit;
  const [nx, ny, nz] = occ.dims;
  const d = occ.data instanceof Uint8Array ? occ.data : new Uint8Array(occ.data);
  // macro cells of B×B×B voxels: 1 if any voxel inside is solid (empty-space skipping)
  const B = 4, mx = Math.ceil(nx / B), my = Math.ceil(ny / B), mz = Math.ceil(nz / B);
  const macro = new Uint8Array(mx * my * mz);
  let top = -1;
  for (let z = 0; z < nz; z++) {
    const zz = (z >> 2) * mx * my;
    for (let y = 0; y < ny; y++) {
      const base = nx * (y + ny * z), yy = (y >> 2) * mx + zz;
      for (let x = 0; x < nx; x++) if (d[base + x]) { macro[yy + (x >> 2)] = 1; if (y > top) top = y; }
    }
  }
  const g = { __grid: true, origin: occ.origin, voxel: occ.voxel, dims: occ.dims, nx, ny, nz, data: d, topY: top, macro, B, mx, my, mz };
  cache.set(occ, g);
  return g;
}

// First solid voxel along a ray (Amanatides & Woo 1987 DDA) with empty-space
// skipping over 4×4×4 macro cells.
// `ignore` (optional) = { n:[..], d, tol, tolBelow, min:[..], max:[..] }: voxels whose
// centre lies within (-tolBelow, tol) of the plane n·p = d and inside the box are
// skipped (the roof plane a ray starts from, so splat noise on its own surface
// does not self-shadow). Returns the hit distance in metres, or -1 if the ray escapes.
export function castRay(grid, ox, oy, oz, dx, dy, dz, maxDist = 200, ignore = null) {
  const { origin, voxel: vs, nx, ny, nz, data, topY, macro, mx, my } = grid;
  const px = (ox - origin[0]) / vs, py = (oy - origin[1]) / vs, pz = (oz - origin[2]) / vs;
  const tEnd = maxDist / vs;
  // clip to the grid box
  let t0 = 0, t1 = tEnd;
  {
    const o = [px, py, pz], dd = [dx, dy, dz], hi = [nx, ny, nz];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dd[k]) < 1e-12) { if (o[k] < 0 || o[k] >= hi[k]) return -1; continue; }
      let a = (0 - o[k]) / dd[k], b = (hi[k] - o[k]) / dd[k];
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
  }
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity, tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  const nxy = nx * ny, mxy = mx * my;
  let t = t0 + 1e-7;
  let ix, iy, iz, tmx, tmy, tmz;
  const enter = () => {
    const qx = px + dx * t, qy = py + dy * t, qz = pz + dz * t;
    ix = Math.min(nx - 1, Math.max(0, Math.floor(qx))); iy = Math.min(ny - 1, Math.max(0, Math.floor(qy))); iz = Math.min(nz - 1, Math.max(0, Math.floor(qz)));
    tmx = dx !== 0 ? t + (dx > 0 ? ix + 1 - qx : qx - ix) * tdx : Infinity;
    tmy = dy !== 0 ? t + (dy > 0 ? iy + 1 - qy : qy - iy) * tdy : Infinity;
    tmz = dz !== 0 ? t + (dz > 0 ? iz + 1 - qz : qz - iz) * tdz : Infinity;
  };
  enter();
  while (true) {
    if (sy > 0 && iy > topY) return -1; // above every solid voxel: escaped
    if (!macro[(ix >> 2) + mx * (iy >> 2) + mxy * (iz >> 2)]) {
      // jump to the exit of this empty macro cell
      const bx = (ix >> 2) << 2, by = (iy >> 2) << 2, bz = (iz >> 2) << 2;
      const ex = dx > 0 ? (bx + 4 - px) / dx : dx < 0 ? (bx - px) / dx : Infinity;
      const ey = dy > 0 ? (by + 4 - py) / dy : dy < 0 ? (by - py) / dy : Infinity;
      const ez = dz > 0 ? (bz + 4 - pz) / dz : dz < 0 ? (bz - pz) / dz : Infinity;
      t = Math.min(ex, ey, ez) + 1e-6;
      if (t >= t1) return -1;
      enter();
      continue;
    }
    if (data[ix + nx * iy + nxy * iz]) {
      let skip = false;
      if (ignore) {
        const cx = origin[0] + (ix + 0.5) * vs, cy = origin[1] + (iy + 0.5) * vs, cz = origin[2] + (iz + 0.5) * vs;
        const dist = ignore.n[0] * cx + ignore.n[1] * cy + ignore.n[2] * cz - ignore.d;
        skip = dist < ignore.tol && dist > -ignore.tolBelow &&
          cx >= ignore.min[0] && cx <= ignore.max[0] && cz >= ignore.min[2] && cz <= ignore.max[2] && cy >= ignore.min[1] && cy <= ignore.max[1];
      }
      if (!skip) return Math.max(0, t) * vs;
    }
    if (tmx < tmy) {
      if (tmx < tmz) { ix += sx; t = tmx; tmx += tdx; if (ix < 0 || ix >= nx) return -1; }
      else { iz += sz; t = tmz; tmz += tdz; if (iz < 0 || iz >= nz) return -1; }
    } else if (tmy < tmz) {
      iy += sy; t = tmy; tmy += tdy; if (iy < 0 || iy >= ny) return -1;
    } else {
      iz += sz; t = tmz; tmz += tdz; if (iz < 0 || iz >= nz) return -1;
    }
    if (t > t1) return -1;
  }
}

// Deterministic cosine-weighted hemisphere directions around +y (Fibonacci
// spiral on the unit disc, lifted: Malley's method). Returns Float64Array xyz.
export function cosineHemisphere(count = 48) {
  const out = new Float64Array(count * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const a = i * ga;
    const x = r * Math.cos(a), z = r * Math.sin(a);
    out[3 * i] = x; out[3 * i + 1] = Math.sqrt(Math.max(0, 1 - r * r)); out[3 * i + 2] = z;
  }
  return out;
}

// Orthonormal basis (t, b) for a unit normal n.
export function basisFor(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  let t = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
  const l = Math.hypot(...t); t = t.map((x) => x / l);
  const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return { t, b };
}

// Sky-view split for a point on a surface with unit normal n. Cosine-weighted
// sampling around n, so for an open plane skyFrac = (1+cosβ)/2 and
// gndFrac = (1−cosβ)/2. Obstructed directions count as "ground-like"
// reflectors (albedo applied by the caller). Returns { skyFrac, skyFrac0, gndFrac }.
export function skyView(grid, p, n, { dirs = cosineHemisphere(48), offset = 0.3, ignore = null, maxDist = 60 } = {}) {
  const { t, b } = basisFor(n);
  const m = dirs.length / 3;
  let sky = 0, sky0 = 0;
  const ox = p[0] + n[0] * offset, oy = p[1] + n[1] * offset, oz = p[2] + n[2] * offset;
  for (let i = 0; i < m; i++) {
    const lx = dirs[3 * i], ly = dirs[3 * i + 1], lz = dirs[3 * i + 2];
    const dx = t[0] * lx + n[0] * ly + b[0] * lz, dy = t[1] * lx + n[1] * ly + b[1] * lz, dz = t[2] * lx + n[2] * ly + b[2] * lz;
    if (dy <= 0) continue; // below the horizon: ground
    sky0++;
    if (!grid || castRay(grid, ox, oy, oz, dx, dy, dz, maxDist, ignore) < 0) sky++;
  }
  return { skyFrac: sky / m, skyFrac0: sky0 / m, gndFrac: 1 - sky / m };
}

// Contract helper: fraction of a small disc of points around `point` (radius r
// on the plane with normal n) that sees the sun along unit vector sunDir.
export function sunlitFraction(grid, point, sunDir, { normal = [0, 1, 0], radius = 0.3, samples = 9, offset = 0.3, ignore = null } = {}) {
  grid = makeGrid(grid);
  if (sunDir[1] <= 0) return 0;
  if (normal[0] * sunDir[0] + normal[1] * sunDir[1] + normal[2] * sunDir[2] <= 0) return 0;
  const { t, b } = basisFor(normal);
  const side = Math.max(1, Math.round(Math.sqrt(samples)));
  let lit = 0, tot = 0;
  for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) {
    const a = side === 1 ? 0 : (i / (side - 1) - 0.5) * 2 * radius, c = side === 1 ? 0 : (j / (side - 1) - 0.5) * 2 * radius;
    const x = point[0] + t[0] * a + b[0] * c + normal[0] * offset;
    const y = point[1] + t[1] * a + b[1] * c + normal[1] * offset;
    const z = point[2] + t[2] * a + b[2] * c + normal[2] * offset;
    tot++;
    if (castRay(grid, x, y, z, sunDir[0], sunDir[1], sunDir[2], 200, ignore) < 0) lit++;
  }
  return lit / tot;
}

// Contract helper: shadow map of the top surface. For each (x,z) column, 1 if
// the highest solid voxel is in shadow for this sun direction, 0 if lit,
// 255 if the column is empty. Uint8Array of nx*nz (x fastest).
export function shadowMask(grid, sunDir) {
  grid = makeGrid(grid);
  const { nx, ny, nz, data, origin, voxel: vs } = grid;
  const out = new Uint8Array(nx * nz).fill(255);
  if (sunDir[1] <= 0) { out.fill(1); return out; }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    for (let y = ny - 1; y >= 0; y--) {
      if (!data[x + nx * (y + ny * z)]) continue;
      const px = origin[0] + (x + 0.5) * vs, py = origin[1] + (y + 1.01) * vs, pz = origin[2] + (z + 0.5) * vs;
      out[x + nx * z] = castRay(grid, px + sunDir[0] * vs, py + sunDir[1] * vs, pz + sunDir[2] * vs, sunDir[0], sunDir[1], sunDir[2]) < 0 ? 0 : 1;
      break;
    }
  }
  return out;
}

// Count solid voxels in a vertical-ish column above a surface point: between
// `from` and `to` metres along the normal. Used to flag clutter that the roof
// segmentation did not outline (e.g. an unlisted water tank).
export function solidAlongNormal(grid, p, n, from = 0.45, to = 2.0) {
  const { origin, voxel: vs, nx, ny, nz, data } = grid;
  let hits = 0;
  for (let h = from; h <= to + 1e-9; h += vs * 0.5) {
    const x = Math.floor((p[0] + n[0] * h - origin[0]) / vs), y = Math.floor((p[1] + n[1] * h - origin[1]) / vs), z = Math.floor((p[2] + n[2] * h - origin[2]) / vs);
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
    if (data[x + nx * (y + ny * z)]) hits++;
  }
  return hits;
}
