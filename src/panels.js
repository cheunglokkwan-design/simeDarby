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

// Capping the sunniest positions can leave small fragments cut off from the
// main blocks. Remove groups under minGroup panels, then top up with the next-best
// positions that touch at least two chosen panels, so the array grows as blocks.
function consolidate(chosen, candidates, cap, minGroup) {
  const key = (k) => `${k.r}:${k.col}`;
  const groups = (list) => {
    const at = new Map(list.map((k) => [key(k), k])), seen = new Map();
    for (const k of list) {
      if (seen.has(k)) continue;
      const members = [k], queue = [k];
      seen.set(k, members);
      while (queue.length) {
        const q = queue.pop();
        for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
          const n = at.get(`${q.r + dr}:${q.col + dc}`);
          if (n && !seen.has(n)) { seen.set(n, members); members.push(n); queue.push(n); }
        }
      }
    }
    return seen;
  };
  let g = groups(chosen);
  let picked = chosen.filter((k) => g.get(k).length >= minGroup);
  const inSet = new Set(picked.map(key));
  for (let pass = 0; pass < 6 && picked.length < cap; pass++) {
    for (const k of candidates) {
      if (picked.length >= cap) break;
      if (inSet.has(key(k))) continue;
      let touching = 0;
      for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) if ((dr || dc) && inSet.has(`${k.r + dr}:${k.col + dc}`)) touching++;
      if (touching >= 2) { picked.push(k); inSet.add(key(k)); }
    }
  }
  return picked;
}

// Candidate panel positions are packed on a grid aligned with the roof's longest
// edge, inside an edge setback, optionally broken into blocks by maintenance
// walkways. Each candidate can be scored for sun exposure (score(x, y) -> 0..1):
// positions under minScoreShare of the roof's best are dropped, and the system is
// filled from the sunniest positions first (ties go to the most central, so the
// array forms compact blocks instead of starting at one corner).
export function generatePanelLayout(footprint, options = {}) {
  const {
    width = 1.134, length = 2.278, gap = .12, setback = .6, watt = 550, maxPanels = 4000, exclusions = [],
    walkwayRows = 0, walkwayCols = 0, walkway = 1.0, score = null, minScoreShare = .8, minGroup = 12
  } = options;
  if (![width, length, watt].every((v) => Number.isFinite(v) && v > 0) ||
      ![gap, setback, maxPanels, walkway].every((v) => Number.isFinite(v) && v >= 0)) throw new Error('Invalid panel-layout dimensions.');
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
  // Grid positions along one axis: panels separated by `gap`, with a walkway after every `every` panels.
  const positions = (span, size, every) => {
    const out = [];
    for (let p = 0, n = 0; p + size <= span + 1e-9; n++) {
      out.push(p);
      p += size + ((every && (n + 1) % every === 0) ? walkway : gap);
    }
    return out;
  };
  let best = null;
  for (const turn of [0, Math.PI / 2]) {
    const angle = heading + turn, c = Math.cos(angle), sn = Math.sin(angle);
    const rotate = ([x, y]) => [x * c + y * sn, -x * sn + y * c];
    const restore = ([x, y]) => [x * c - y * sn, x * sn + y * c];
    const roof = ring.map(rotate);
    const blocked = exclusions.map((polygon) => polygon.map(rotate));
    const xs = roof.map(p => p[0]), ys = roof.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const colsAt = positions(maxX - minX - 2 * setback, width, walkwayCols);
    const rowsAt = positions(maxY - minY - 2 * setback, length, walkwayRows);
    if (!colsAt.length || !rowsAt.length || colsAt.length * rowsAt.length > 150000) continue;
    const usedX = colsAt.at(-1) + width, usedY = rowsAt.at(-1) + length;
    const offsetX = (maxX - minX - usedX) / 2, offsetY = (maxY - minY - usedY) / 2;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const candidates = [];
    for (const [r, py] of rowsAt.entries()) {
      for (const [col, px] of colsAt.entries()) {
        const x = minX + offsetX + px, y = minY + offsetY + py;
        const clearance = [[x - setback, y - setback], [x + width + setback, y - setback],
          [x + width + setback, y + length + setback], [x - setback, y + length + setback]];
        if (!fits(clearance, roof) || blocked.some(polygon => overlaps(clearance, polygon))) continue;
        const corners = [[x, y], [x + width, y], [x + width, y + length], [x, y + length]].map(restore);
        const [mx, my] = restore([x + width / 2, y + length / 2]);
        candidates.push({ corners, centre: [mx, my], dist: Math.hypot(x + width / 2 - cx, y + length / 2 - cy), r, col });
      }
    }
    if (!candidates.length) continue;
    if (score) {
      for (const k of candidates) k.sun = score(k.centre[0], k.centre[1]);
      const top = Math.max(...candidates.map((k) => k.sun));
      let kept = candidates.filter((k) => k.sun >= minScoreShare * top);
      // Drop stray positions in small sunny gaps: keep panels with at least 3 neighbours.
      const at = new Set(kept.map((k) => `${k.r}:${k.col}`));
      const neighbours = (k) => [-1, 0, 1].reduce((t, dr) => t + [-1, 0, 1].filter((dc) => (dr || dc) && at.has(`${k.r + dr}:${k.col + dc}`)).length, 0);
      kept = kept.filter((k) => neighbours(k) >= 3);
      // ...and drop small islands: connected groups of fewer than minGroup panels.
      const byKey = new Map(kept.map((k) => [`${k.r}:${k.col}`, k]));
      const group = new Map();
      for (const k of kept) {
        if (group.has(k)) continue;
        const members = [k], queue = [k];
        group.set(k, members);
        while (queue.length) {
          const q = queue.pop();
          for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
            const n = byKey.get(`${q.r + dr}:${q.col + dc}`);
            if (n && !group.has(n)) { group.set(n, members); members.push(n); queue.push(n); }
          }
        }
      }
      if (kept.length >= minGroup) kept = kept.filter((k) => group.get(k).length >= minGroup);
      kept.sort((a, b) => (b.sun - a.sun) || (a.dist - b.dist));
      candidates.length = 0; candidates.push(...kept);
    } else {
      candidates.sort((a, b) => a.dist - b.dist);
    }
    let chosen = candidates.slice(0, cap);
    if (score && chosen.length < candidates.length) chosen = consolidate(chosen, candidates, cap, Math.min(minGroup, cap)); // small systems are one small group
    const value = chosen.reduce((t, k) => t + (k.sun ?? 1), 0);
    if (!best || value > best.value) best = { chosen, value, shaded: (score ? candidates.length : 0) };
  }
  if (!best) return empty;
  const panels = best.chosen.map((k) => k.corners);
  const sun = score ? best.chosen.map((k) => k.sun) : null;
  return {
    ...empty, panels, count: panels.length, kwp: panels.length * watt / 1000, exclusions,
    ...(sun ? { sun, meanSun: sun.reduce((t, v) => t + v, 0) / sun.length, basis: 'mapped-footprint + sun raycast' } : {})
  };
}

// Business roofs keep a wider edge strip and maintenance walkways; small home roofs don't.
export function layoutOptionsFor(category) {
  const home = category === 'residential' || category === 'Residential (landed)';
  return home ? { setback: .6 } : { setback: 1.2, walkwayRows: 4, walkwayCols: 12, walkway: 1.0 };
}

export function panelLayoutForSite(site, watt = 550, extra = {}) {
  return generatePanelLayout(site.footprint, {
    watt, maxPanels: site.panels ?? Math.floor((site.kwp || 0) * 1000 / watt), exclusions: site.exclusions || [],
    ...layoutOptionsFor(site.categoryKey || site.category), ...extra
  });
}
