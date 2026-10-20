// Build the open roof registry: every roof and surface car park in each
// township with its solar attributes, as GeoJSON under ODbL (same licence as
// the OpenStreetMap data it is derived from).
// Usage: npm run registry [township-id ...]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { TOWNSHIPS } from '../src/townships.js';
import { DEFAULT_ASSUMPTIONS, buildSites, scoreSites, siteProperties } from '../src/solar.js';
import { computeShading } from '../src/shading.js';

const data = (name) => new URL(`../public/data/${name}.json`, import.meta.url);
const readJSON = async (url) => JSON.parse(await readFile(url, 'utf8'));
const readOptional = (url) => readJSON(url).catch(() => null);

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TOWNSHIPS);
const outDir = new URL('../registry/', import.meta.url);
await mkdir(outDir, { recursive: true });
const pkg = await readJSON(new URL('../package.json', import.meta.url));

for (const id of ids) {
  const raw = await readJSON(data(id));
  const yieldData = await readOptional(data(`yield-${id}`));
  const { sites, origin } = buildSites(raw);
  const t0 = Date.now();
  const items = sites.map((s) => ({ xy: s.xy, bbox: s.bbox, height: s.height, centroid: s.centroid, skip: s.category === 'carpark' }));
  const shade = computeShading(origin[1], origin[0], items);
  sites.forEach((s, i) => (s.shading = s.category === 'carpark' ? 0.95 : shade[i]));
  scoreSites(sites, DEFAULT_ASSUMPTIONS, yieldData);

  const fc = {
    type: 'FeatureCollection',
    name: `${TOWNSHIPS[id].name} open roof registry`,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors; solar attributes: Solar Opportunity Mapper',
    generated: new Date().toISOString(),
    osm_snapshot: raw.fetchedAt,
    yield_source: yieldData?.source ?? 'fallback assumption',
    version: pkg.version,
    features: sites.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [s.polygon] },
      properties: siteProperties(s, DEFAULT_ASSUMPTIONS)
    }))
  };
  await writeFile(new URL(`${id}.geojson`, outDir), JSON.stringify(fc));
  console.log(`${TOWNSHIPS[id].name}: ${fc.features.length} roofs (shading ${((Date.now() - t0) / 1000).toFixed(1)} s) -> registry/${id}.geojson`);
}
