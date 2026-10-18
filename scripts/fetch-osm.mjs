// Snapshot raw OSM data for each township into public/data/osm/<id>.json, for comparison
// with (or as a fallback for) the pipeline exports in public/data/<id>.json that the app loads.
// Usage: npm run fetch-osm [township-id]
import { writeFile, mkdir } from 'node:fs/promises';
import { TOWNSHIPS } from '../src/townships.js';
import { fetchOverpass } from '../src/osm.js';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TOWNSHIPS);
const withUA = (url, opts) =>
  fetch(url, { ...opts, headers: { ...opts.headers, 'User-Agent': 'SolarOpportunityMapper/0.1 (hackathon demo)' } });

await mkdir(new URL('../public/data/osm/', import.meta.url), { recursive: true });
for (const id of ids) {
  const t = TOWNSHIPS[id];
  if (!t) throw new Error(`Unknown township ${id}`);
  process.stdout.write(`Fetching ${t.name}... `);
  const data = await fetchOverpass(t.bbox, withUA);
  await writeFile(new URL(`../public/data/osm/${id}.json`, import.meta.url), JSON.stringify({ id, ...data }));
  console.log(`${data.buildings.length} buildings, ${data.parking.length} car parks, ${data.community.length} community sites`);
}
