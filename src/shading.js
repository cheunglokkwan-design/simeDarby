// Line-of-sight raycasting for roof shading. Shared by the browser Web Worker
// (shading.worker.js) and the Node registry build (scripts/build-registry.mjs).
//
// For every roof we sample a few points and, for a set of sun positions across
// the year, march a ray toward the sun. If the ray passes inside the footprint
// of a neighbouring building that is taller than the ray at that point, the
// roof is shaded for that sun position. Each sample is weighted by
// sin(altitude) (a proxy for direct irradiance on a flat roof), giving an
// annual "unshaded fraction" between 0 and 1.
import { sunPosition } from './sun.js';
import { pointInPolygon } from './geo.js';

const CELL = 20; // spatial grid cell size (m)
const STEP = 3; // ray march step (m)
const MAX_DIST = 160; // ignore obstructions further than this (m)
const MIN_ALT = 8 * (Math.PI / 180); // ignore very low sun

function sunSamples(lat, lon) {
  // Equinox + both solstices, 07:30-18:30 Malaysia time (UTC+8), hourly.
  const days = [[2026, 2, 20], [2026, 5, 21], [2026, 8, 22], [2026, 11, 21]];
  const out = [];
  for (const [y, m, d] of days) {
    for (let h = 7.5; h <= 18.5; h += 1) {
      const date = new Date(Date.UTC(y, m, d, 0, 0) + (h - 8) * 3600e3);
      const { altitude, azimuth: az } = sunPosition(date, lat, lon);
      if (altitude < MIN_ALT) continue;
      out.push({ dx: Math.sin(az), dy: Math.cos(az), tanAlt: Math.tan(altitude), w: Math.sin(altitude) });
    }
  }
  return out;
}

// items: [{xy, bbox, height, centroid, skip}] in local metres.
// Returns a Float32Array of annual unshaded fractions (0-1).
export function computeShading(lat, lon, items, onProgress = () => {}) {
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  items.forEach((it, idx) => {
    const [x0, y0, x1, y1] = it.bbox;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
      }
  });
  const maxH = items.reduce((m, it) => Math.max(m, it.height), 0);
  const suns = sunSamples(lat, lon);
  const totalW = suns.reduce((s, p) => s + p.w, 0);

  const result = new Float32Array(items.length);
  items.forEach((it, idx) => {
    if (it.skip) { result[idx] = 1; return; }
    // Roof sample points: centroid + halfway toward two opposite bbox corners.
    const [cx, cy] = it.centroid;
    const [x0, y0, x1, y1] = it.bbox;
    const pts = [[cx, cy], [(cx + x0) / 2, (cy + y0) / 2], [(cx + x1) / 2, (cy + y1) / 2]].filter(
      ([x, y], i) => i === 0 || pointInPolygon(x, y, it.xy)
    );
    const z0 = it.height + 0.3;
    let lit = 0;
    for (const s of suns) {
      const reach = Math.min(MAX_DIST, (maxH - z0) / s.tanAlt);
      let unblocked = 0;
      for (const [px, py] of pts) {
        let blocked = false;
        for (let d = STEP; d <= reach && !blocked; d += STEP) {
          const x = px + s.dx * d, y = py + s.dy * d, z = z0 + d * s.tanAlt;
          const cell = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
          if (!cell) continue;
          for (const o of cell) {
            if (o === idx) continue;
            const ob = items[o];
            if (ob.height <= z) continue;
            const [bx0, by0, bx1, by1] = ob.bbox;
            if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
            if (pointInPolygon(x, y, ob.xy)) { blocked = true; break; }
          }
        }
        if (!blocked) unblocked++;
      }
      lit += s.w * (unblocked / pts.length);
    }
    result[idx] = totalW ? lit / totalW : 1;
    if (idx % 500 === 0) onProgress(idx / items.length);
  });
  return result;
}
