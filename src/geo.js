// Small local-projection helpers (equirectangular around a reference point).
// Accurate to well under 1% over a township-sized area.

const R = 6371008.8;
const DEG = Math.PI / 180;

export function makeProjector(lon0, lat0) {
  const kx = R * Math.cos(lat0 * DEG) * DEG;
  const ky = R * DEG;
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky]
  };
}

export function polygonArea(xy) {
  let a = 0;
  for (let i = 0, n = xy.length - 1; i < n; i++) a += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
  return Math.abs(a) / 2;
}

export function polygonCentroid(xy) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = xy.length - 1; i < n; i++) {
    const f = xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
    a += f;
    cx += (xy[i][0] + xy[i + 1][0]) * f;
    cy += (xy[i][1] + xy[i + 1][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return xy[0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function bboxOf(xy) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of xy) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function pointInPolygon(x, y, xy) {
  let inside = false;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const [xi, yi] = xy[i], [xj, yj] = xy[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Convex hull (Andrew's monotone chain) of [lon, lat] points, as a closed ring.
export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return [...hull, hull[0]];
}

export function distanceM([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG;
  return Math.sqrt(x * x + y * y) * R;
}
