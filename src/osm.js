// Fetch and normalise OpenStreetMap data from the Overpass API.
// Shared by the browser (live refresh) and scripts/fetch-osm.mjs (cached snapshot).

// Main instance first, then public mirrors (the main one often returns 502/504 under load).
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const KEEP_TAGS = [
  'building', 'building:levels', 'height', 'roof:shape', 'roof:material', 'name',
  'amenity', 'shop', 'office', 'industrial', 'landuse', 'parking', 'healthcare', 'historic',
  'generator:source'
];

const COMMUNITY_RE = 'school|kindergarten|college|university|clinic|hospital|doctors|community_centre|library';

export function buildQuery([s, w, n, e]) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:120];
(
  way["building"](${bb});
  way["amenity"="parking"](${bb});
  nwr["amenity"~"^(${COMMUNITY_RE})$"](${bb});
  nwr["healthcare"](${bb});
  nwr["power"="substation"](${bb});
);
out tags geom;`;
}

export async function fetchOverpass(bbox, fetchImpl = fetch) {
  const errors = [];
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(buildQuery(bbox))
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return normalise(await res.json());
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error(`All Overpass servers failed (${errors.join('; ')})`);
}

function pickTags(tags = {}) {
  const out = {};
  for (const k of KEEP_TAGS) if (tags[k] != null) out[k] = tags[k];
  return out;
}

function ring(geometry) {
  if (!geometry || geometry.length < 4) return null;
  const coords = geometry.map((p) => [round(p.lon), round(p.lat)]);
  const [a, b] = [coords[0], coords[coords.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) coords.push(a);
  return coords;
}

function centroidOf(el) {
  if (el.type === 'node') return [el.lon, el.lat];
  const pts = el.geometry || (el.members || []).flatMap((m) => m.geometry || []);
  if (!pts.length) return null;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  return [round(lon), round(lat)];
}

const round = (v) => Math.round(v * 1e7) / 1e7;

export function normalise(json) {
  const buildings = [];
  const parking = [];
  const community = [];
  const substations = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    const isCommunity =
      (t.amenity && new RegExp(`^(${COMMUNITY_RE})$`).test(t.amenity)) || t.healthcare;
    if (isCommunity) {
      const c = centroidOf(el);
      if (c) community.push({ id: `${el.type}/${el.id}`, name: t.name || null, type: t.amenity || t.healthcare, position: c });
    }
    if (t.power === 'substation') {
      const c = centroidOf(el);
      if (c) substations.push({ id: `${el.type}/${el.id}`, name: t.name || null, position: c });
    }
    if (el.type !== 'way') continue;
    const polygon = ring(el.geometry);
    if (!polygon) continue;
    if (t.building) buildings.push({ id: `way/${el.id}`, tags: pickTags(t), polygon });
    else if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey')
      parking.push({ id: `way/${el.id}`, tags: pickTags(t), polygon });
  }
  return { fetchedAt: new Date().toISOString(), buildings, parking, community, substations };
}
