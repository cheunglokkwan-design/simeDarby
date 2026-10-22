// Preliminary packing against the mapped footprint, in local metres.
// This does not infer roof planes, obstructions or structural suitability from video.
import { pointInPolygon } from './geo.js';

function inside(point, polygon) {
  return pointInPolygon(point[0], point[1], polygon);
}
function crosses(a, b, c, d) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < -1e-9 && side(c, d, a) * side(c, d, b) < -1e-9;
}
function overlaps(a, b) {
  const ac = [...a, a[0]], bc = [...b, b[0]];
  if (a.some(p => inside(p, bc)) || b.some(p => inside(p, ac))) return true;
  return a.some((p, i) => b.some((q, j) => crosses(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}
function fits(quad, roof) {
  if (!quad.every((point) => inside(point, roof))) return false;
  for (let i = 0; i < roof.length - 1; i++) {
    for (let j = 0; j < 4; j++) {
      if (crosses(roof[i], roof[i + 1], quad[j], quad[(j + 1) % 4])) return false;
    }
  }
  // Reject rectangles that bridge an inward corner of a concave roof.
  return !roof.slice(0, -1).some((point) => inside(point, [...quad, quad[0]]));
}

export function generatePanelLayout(footprint, options = {}) {
  const { width = 1.134, length = 2.278, gap = .12, setback = .6, watt = 550, maxPanels = 4000, exclusions = [] } = options;
  if (![width, length, watt].every((v) => Number.isFinite(v) && v > 0) ||
      ![gap, setback, maxPanels].every((v) => Number.isFinite(v) && v >= 0)) throw new Error('Invalid panel-layout dimensions.');
  const empty = { panels: [], count: 0, kwp: 0, width, length, gap, setback, watt, basis: 'mapped-footprint', reviewRequired: true };
  if (!footprint || footprint.length < 4 || !footprint.every((p) => p.length >= 2 && p.every(Number.isFinite))) return empty;
  const ring = [...footprint];
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
  let longest = 0, heading = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1][0] - ring[i][0], dy = ring[i + 1][1] - ring[i][1];
    if (dx * dx + dy * dy > longest) { longest = dx * dx + dy * dy; heading = Math.atan2(dy, dx); }
  }
  const cap = Math.min(4000, Math.floor(maxPanels));
  if (!cap) return empty;
  let best = [];
  for (const turn of [0, Math.PI / 2]) {
    const angle = heading + turn, c = Math.cos(angle), s = Math.sin(angle);
    const rotate = ([x, y]) => [x * c + y * s, -x * s + y * c];
    const restore = ([x, y]) => [x * c - y * s, x * s + y * c];
    const roof = ring.map(rotate);
    const blocked = exclusions.map((polygon) => polygon.map(rotate));
    const xs = roof.map(p => p[0]), ys = roof.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const columns = Math.floor((maxX - minX - 2 * setback + gap) / (width + gap));
    const rows = Math.floor((maxY - minY - 2 * setback + gap) / (length + gap));
    if (columns <= 0 || rows <= 0 || rows * columns > 150000) continue;
    const offsetX = (maxX - minX - columns * width - (columns - 1) * gap) / 2;
    const offsetY = (maxY - minY - rows * length - (rows - 1) * gap) / 2;
    const panels = [];
    for (let row = 0; row < rows && panels.length < cap; row++) {
      for (let column = 0; column < columns && panels.length < cap; column++) {
        const x = minX + offsetX + column * (width + gap), y = minY + offsetY + row * (length + gap);
        const clearance = [[x - setback, y - setback], [x + width + setback, y - setback],
          [x + width + setback, y + length + setback], [x - setback, y + length + setback]];
        if (fits(clearance, roof) && !blocked.some(polygon => overlaps(clearance, polygon))) panels.push([[x, y], [x + width, y], [x + width, y + length], [x, y + length]].map(restore));
      }
    }
    if (panels.length > best.length) best = panels;
  }
  return { ...empty, panels: best, count: best.length, kwp: best.length * watt / 1000, exclusions };
}

export function panelLayoutForSite(site, watt = 550) {
  return generatePanelLayout(site.footprint, { watt, maxPanels: site.panels ?? Math.floor((site.kwp || 0) * 1000 / watt), exclusions: site.exclusions || [] });
}
