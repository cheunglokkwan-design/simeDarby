// Write each township's ranked shortlist (same as the app's "Export CSV").
// Usage: npm run rank [township-id ...]
import { writeFile } from 'node:fs/promises';
import { toCSV } from '../src/solar.js';
import { TOWNSHIPS, loadTownship, prepare, rank, townshipIds, outPath } from './lib/rank.mjs';

for (const id of townshipIds(process.argv.slice(2), TOWNSHIPS)) {
  const ranked = rank(prepare(await loadTownship(id)));
  await writeFile(outPath(id, 'app_ranking.csv'), toCSV(ranked) + '\n');
  console.log(`\n${TOWNSHIPS[id].name}: ${ranked.length} viable sites`);
  ranked.slice(0, 10).forEach((s, i) =>
    console.log(`${String(i + 1).padStart(3)}. ${s.score.toFixed(0).padStart(3)}  ${(s.name || s.categoryLabel).slice(0, 60)}  ${s.kwp.toFixed(0)} kWp`)
  );
}
