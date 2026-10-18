// Blind labelling sheet per township: our top 20 mixed with 20 random other viable sites,
// shuffled, with no scores shown. A teammate or SDP mentor labels each site; validate.mjs
// then measures how well the ranking agrees. Never overwrites a sheet unless --force.
// Usage: npm run validation-sheet [township-id ...] [-- --force]
import { access, writeFile } from 'node:fs/promises';
import { TOWNSHIPS, loadTownship, prepare, rank, rng, shuffle, toCsv, townshipIds, outPath } from './lib/rank.mjs';

const force = process.argv.includes('--force');
const ids = townshipIds(process.argv.slice(2).filter((a) => !a.startsWith('--')), TOWNSHIPS);
const TOP = 20, RANDOM = 20, SEED = 42;

for (const id of ids) {
  const sheetPath = outPath(id, 'validation_sheet.csv');
  if (!force && (await access(sheetPath).then(() => true, () => false))) {
    console.log(`${id}: validation_sheet.csv exists (pass --force to redraw)`);
    continue;
  }
  const ranked = rank(prepare(await loadTownship(id)));
  const random = rng(SEED);
  const top = ranked.slice(0, TOP).map((s, i) => ({ s, rank: i + 1, group: 'top' }));
  const others = shuffle(ranked.slice(TOP).map((s, i) => ({ s, rank: TOP + i + 1, group: 'random' })), random).slice(0, RANDOM);
  const sample = shuffle([...top, ...others], random).map((x, i) => ({ ...x, sample: i + 1 }));

  const sheet = sample.map(({ s, sample }) => {
    const [lon, lat] = s.position;
    return {
      sample, site_id: s.id, name: s.name || s.categoryLabel, type: s.categoryLabel,
      footprint_m2: s.area.toFixed(0), lat: lat.toFixed(6), lon: lon.toFixed(6),
      satellite_url: `https://www.google.com/maps/@${lat.toFixed(6)},${lon.toFixed(6)},90m/data=!3m1!1e3`,
      street_view_url: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`,
      label: '', labeller: '', notes: ''
    };
  });
  const key = sample.map(({ s, sample, rank, group }) => ({ sample, site_id: s.id, rank, group, score: s.score.toFixed(1) }));
  await writeFile(sheetPath, toCsv(Object.keys(sheet[0]), sheet));
  await writeFile(outPath(id, 'validation_key.csv'), toCsv(Object.keys(key[0]), key));
  console.log(`${id}: wrote validation_sheet.csv (${sheet.length} sites) and validation_key.csv`);
}
