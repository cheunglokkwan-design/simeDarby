// Score the filled-in labelling sheets: how many of our top picks did the labeller rate good?
// label: good = 1, maybe = 0.5, poor = 0 (blank rows are ignored).
// Usage: npm run validate [township-id ...]
import { readFile, writeFile } from 'node:fs/promises';
import { TOWNSHIPS, parseCsv, townshipIds, outPath } from './lib/rank.mjs';

const VALUE = { good: 1, yes: 1, maybe: 0.5, poor: 0, no: 0 };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)} %`);

for (const id of townshipIds(process.argv.slice(2), TOWNSHIPS)) {
  let sheet, key;
  try {
    sheet = parseCsv(await readFile(outPath(id, 'validation_sheet.csv'), 'utf8'));
    key = parseCsv(await readFile(outPath(id, 'validation_key.csv'), 'utf8'));
  } catch {
    console.log(`${id}: no sheet yet (npm run validation-sheet)`);
    continue;
  }
  const byId = Object.fromEntries(key.map((k) => [k.sample, k]));
  const rows = sheet
    .map((r) => ({ ...byId[r.sample], value: VALUE[r.label.trim().toLowerCase()] }))
    .filter((r) => r.value != null);
  if (!rows.length) {
    console.log(`${TOWNSHIPS[id].name}: no labels yet (fill the label column in validation_sheet.csv)`);
    continue;
  }
  const top = rows.filter((r) => r.group === 'top');
  const at = (k) => mean(top.filter((r) => +r.rank <= k).map((r) => r.value));
  const result = {
    township: TOWNSHIPS[id].name,
    labelled: rows.length,
    precision_at_10: at(10),
    precision_at_20: at(20),
    random_sample_good_rate: mean(rows.filter((r) => r.group === 'random').map((r) => r.value))
  };
  result.lift = result.precision_at_20 && result.random_sample_good_rate ? result.precision_at_20 / result.random_sample_good_rate : null;
  await writeFile(outPath(id, 'validation_result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    `${result.township}: ${result.labelled} labelled · top-10 rated good ${pct(result.precision_at_10)} · ` +
      `top-20 ${pct(result.precision_at_20)} · random sites ${pct(result.random_sample_good_rate)}` +
      (result.lift ? ` · ${result.lift.toFixed(1)}× better than random` : '')
  );
}
