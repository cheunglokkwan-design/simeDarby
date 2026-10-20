// Outside validation: compare our roof capacity with the Google Solar API for a
// sample of landed homes (Google covers Malaysian residential areas at BASE quality).
//
// Usage:  npm run google-check [township-id] [--n 30] [--dry-run]
// Needs:  GOOGLE_SOLAR_API_KEY in .env.local (a Google Cloud key with the Solar API
//         enabled and billing on). --dry-run lists the sample without calling Google.
//
// Google's terms limit storing Solar API results, so only aggregate statistics
// are written (docs/google-solar-check.md); per-building responses are discarded.
import { readFile, writeFile } from 'node:fs/promises';
import { TOWNSHIPS } from '../src/townships.js';
import { DEFAULT_ASSUMPTIONS, buildSites, scoreSites } from '../src/solar.js';
import { distanceM } from '../src/geo.js';

const ENDPOINT = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';
const MAX_MATCH_M = 15; // Google's building centre must be this close to ours
const INVERTER_EFF = 0.96; // our yields are AC, Google's are DC

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const township = args.find((a) => TOWNSHIPS[a]) || 'ara-damansara';
const n = +opt('--n', 30);
const dryRun = flag('--dry-run');

// Deterministic shuffle so reruns hit the same houses.
function sample(list, k, seed = 42) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

export function parseInsights(json) {
  const sp = json?.solarPotential;
  if (!sp?.maxArrayPanelsCount || !sp.panelCapacityWatts) return null;
  const configs = sp.solarPanelConfigs || [];
  const max = configs[configs.length - 1];
  return {
    kwp: (sp.maxArrayPanelsCount * sp.panelCapacityWatts) / 1000,
    dcKwh: max?.yearlyEnergyDcKwh ?? null,
    center: json.center ? [json.center.longitude, json.center.latitude] : null,
    quality: json.imageryQuality
  };
}

async function query(site, key) {
  const [lon, lat] = site.position;
  const url = `${ENDPOINT}?location.latitude=${lat.toFixed(6)}&location.longitude=${lon.toFixed(6)}&requiredQuality=BASE`;
  const res = await fetch(url, { headers: { 'X-Goog-Api-Key': key } });
  if (res.status === 404) return { error: 'not covered' };
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
  return parseInsights(await res.json()) || { error: 'no solar potential' };
}

const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function main() {
  const raw = JSON.parse(await readFile(new URL(`../public/data/${township}.json`, import.meta.url), 'utf8'));
  const yieldData = JSON.parse(await readFile(new URL(`../public/data/yield-${township}.json`, import.meta.url), 'utf8').catch(() => 'null'));
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS, yieldData);
  // Single houses only: OSM often maps a whole terrace row as one polygon,
  // while Google returns one house per lookup.
  const single = (s) => s.category === 'residential' && s.area >= 60 && s.area <= 400 && !s.flags.includes('Too small');
  const homes = sample(sites.filter(single), n);

  if (dryRun) {
    console.log(`Dry run: ${homes.length} homes in ${TOWNSHIPS[township].name} would be checked:`);
    for (const h of homes.slice(0, 5)) console.log(`  ${h.id} at ${h.position[1].toFixed(6)}, ${h.position[0].toFixed(6)}: ours ${(h.usable * DEFAULT_ASSUMPTIONS.panelDensity).toFixed(1)} kWp`);
    console.log(`  ... set GOOGLE_SOLAR_API_KEY in .env.local and rerun without --dry-run.`);
    return;
  }
  const key = process.env.GOOGLE_SOLAR_API_KEY;
  if (!key) throw new Error('GOOGLE_SOLAR_API_KEY is not set (add it to .env.local).');

  const ratios = [], yieldRatios = [], skipped = {};
  for (const h of homes) {
    const g = await query(h, key);
    if (g.error) { skipped[g.error] = (skipped[g.error] || 0) + 1; continue; }
    if (g.center && distanceM(g.center, h.position) > MAX_MATCH_M) { skipped['different building'] = (skipped['different building'] || 0) + 1; continue; }
    const oursKwp = h.usable * DEFAULT_ASSUMPTIONS.panelDensity; // physical capacity, before the ATAP cap
    ratios.push(oursKwp / g.kwp - 1);
    if (g.dcKwh) yieldRatios.push(h.specificYield / INVERTER_EFF / (g.dcKwh / g.kwp) - 1);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ratios.length) throw new Error(`No usable matches (skipped: ${JSON.stringify(skipped)})`);

  const meanAbs = ratios.reduce((t, r) => t + Math.abs(r), 0) / ratios.length;
  const lines = [
    `# Google Solar API check: ${TOWNSHIPS[township].name}`,
    '',
    `Run ${new Date().toISOString().slice(0, 10)} on ${ratios.length} of ${homes.length} sampled landed homes (BASE quality).`,
    `Skipped: ${Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.`,
    '',
    '| Measure | Ours vs Google |',
    '|---|---|',
    `| Roof capacity (kWp), median | ${pct(quantile(ratios, 0.5))} |`,
    `| Roof capacity, middle 80% of homes | ${pct(quantile(ratios, 0.1))} to ${pct(quantile(ratios, 0.9))} |`,
    `| Roof capacity, mean absolute difference | ${(meanAbs * 100).toFixed(0)}% |`,
    yieldRatios.length ? `| Yield per kWp (DC), median | ${pct(quantile(yieldRatios, 0.5))} |` : '| Yield per kWp | not returned |',
    '',
    `Deck line: "Our roof capacity is within ±${(meanAbs * 100).toFixed(0)}% of Google's Solar API on average, across ${ratios.length} homes."`,
    '',
    'Only aggregate statistics are kept, in line with the Solar API terms. Our capacity is the physical roof',
    'potential before the Solar ATAP 15 kW cap; Google reports its maximum panel array.'
  ];
  await writeFile(new URL('../docs/google-solar-check.md', import.meta.url), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

if (process.argv[1]?.endsWith('google-solar-check.mjs')) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
