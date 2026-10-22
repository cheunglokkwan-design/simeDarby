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
export function roofSamplePoints(it) {
  const [cx, cy] = it.centroid;
  const [x0, y0, x1, y1] = it.bbox;
  const candidates = [[cx, cy], [(cx + x0) / 2, (cy + y0) / 2], [(cx + x1) / 2, (cy + y1) / 2]];
  let points = candidates.filter(([x, y]) => pointInPolygon(x, y, it.xy));
  // A concave footprint's centroid may be outside. Use interior grid samples
  // instead of casting rays from a courtyard or a missing roof section.
  if (points.length < 3) {
    for (let iy = 1; iy < 8; iy++) for (let ix = 1; ix < 8; ix++) {
      const point = [x0 + (x1 - x0) * ix / 8, y0 + (y1 - y0) * iy / 8];
      if (pointInPolygon(...point, it.xy)) points.push(point);
    }
    points = points.filter((p, i, all) => all.findIndex(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < .001) === i);
    if (points.length > 5) points = [0, .25, .5, .75, 1].map(t => points[Math.round(t * (points.length - 1))]);
  }
  return points;
}

export function computeShading(lat, lon, items, onProgress = () => {}) {
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  items.forEach((it, idx) => {
    if (it.occluder === false) return;
    const [x0, y0, x1, y1] = it.bbox;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
      }
  });
  const maxH = items.reduce((m, it) => it.occluder === false ? m : Math.max(m, it.height), 0);
  const suns = sunSamples(lat, lon);
  const totalW = suns.reduce((s, p) => s + p.w, 0);

  const result = new Float32Array(items.length);
  items.forEach((it, idx) => {
    if (it.skip) { result[idx] = 1; return; }
    const pts = roofSamplePoints(it);
    if (!pts.length) { result[idx] = NaN; return; }
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

// Sun exposure at individual roof points, for placing panels where the sun
// actually falls. Same rays and weights as computeShading, but for any point:
// returns (x, y, z, selfIndex) => unshaded share of the year's direct sun (0-1).
export function makeExposure(lat, lon, items) {
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  items.forEach((it, idx) => {
    if (it.occluder === false) return;
    const [x0, y0, x1, y1] = it.bbox;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
      }
  });
  const maxH = items.reduce((m, it) => it.occluder === false ? m : Math.max(m, it.height), 0);
  const suns = sunSamples(lat, lon);
  const totalW = suns.reduce((s, p) => s + p.w, 0);
  return (px, py, z0, self = -1) => {
    let lit = 0;
    for (const s of suns) {
      const reach = Math.min(MAX_DIST, (maxH - z0) / s.tanAlt);
      let blocked = false;
      for (let d = STEP; d <= reach && !blocked; d += STEP) {
        const x = px + s.dx * d, y = py + s.dy * d, z = z0 + d * s.tanAlt;
        const cell = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
        if (!cell) continue;
        for (const o of cell) {
          if (o === self) continue;
          const ob = items[o];
          if (ob.height <= z) continue;
          const [bx0, by0, bx1, by1] = ob.bbox;
          if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
          if (pointInPolygon(x, y, ob.xy)) { blocked = true; break; }
        }
      }
      if (!blocked) lit += s.w;
    }
    return totalW ? lit / totalW : 1;
  };
}
