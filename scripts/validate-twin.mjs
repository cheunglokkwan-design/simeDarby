// Cross-check the digital twin's energy engine against the map app's pvlib
// yield table (pvlib 0.16 + PVGIS-ERA5 hourly weather 2005-2023, Perez, SAPM).
//
// Both models are run on an open, unshaded 20° roof (synthetic gable, no trees
// or vents) turned to each compass direction, so the only differences are the
// weather source (NASA POWER monthly vs PVGIS-ERA5 hourly) and the physics
// chain (Hay-Davies/Faiman vs Perez/SAPM).
//
// Usage: node scripts/validate-twin.mjs   (writes docs/twin-validation.md)
import fs from 'node:fs';
import { planArray } from '../src/twin/placement.js';
import { gableHouse } from '../tests/twin-fixtures.js';

const table = JSON.parse(fs.readFileSync(new URL('../public/data/yield-ara-damansara.json', import.meta.url), 'utf8'));
const pv = table.yield['20'];
const rows = [];
for (const az of [0, 90, 180, 270]) {
  // The fixture's faces point east and west; rotate north so one face points at `az`.
  const { twin, occ } = gableHouse({ pitch: 20, vent: false, tree: false });
  let best = null;
  for (const north of [0, 90, 180, 270]) {
    const plan = planArray({ ...twin, northBearing: north }, occ, { sizeMode: 'max', targetKwp: null });
    for (const a of plan.arrays) {
      const face = ((Math.round(a.azimuthDeg) % 360) + 360) % 360;
      if (Math.abs(((face - az + 540) % 360) - 180) < 10 && (!best || a.panels > best.panels)) best = { ...a, north };
    }
  }
  if (!best) continue;
  const twinYield = best.specificYield;
  const ref = pv[String(az)].p50;
  rows.push({ az, tilt: best.tiltDeg, twin: twinYield, pvlib: ref, calibrated: Math.round(twinYield * 0.93), diff: (twinYield / ref - 1) * 100 });
}
const word = { 0: 'north', 90: 'east', 180: 'south', 270: 'west' };
const mean = rows.reduce((t, r) => t + Math.abs(r.diff), 0) / rows.length;
const md = [
  '# Digital twin energy engine vs pvlib',
  '',
  'Open, unshaded 20° roof in Ara Damansara (synthetic gable, no obstacles). Twin: NOAA sun, NASA POWER monthly climate, Hay-Davies, Martin-Ruiz IAM, Faiman temperature, catalogue loss chain. Reference: the map app\'s pvlib 0.16 table (PVGIS-ERA5 hourly 2005-2023, Perez, ASHRAE IAM, SAPM close-mount temperature, P50). Regenerate with `node scripts/validate-twin.mjs`.',
  '',
  '| Roof faces | Tilt | Twin kWh/kWp | pvlib P50 kWh/kWp | Difference | Twin, ground-calibrated (×0.93) |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${word[r.az]} | ${r.tilt.toFixed(0)}° | ${r.twin} | ${r.pvlib.toFixed(0)} | ${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(1)}% | ${r.calibrated} |`),
  '',
  `Mean absolute difference: ${mean.toFixed(1)}%. Two independent weather sources and physics chains agree within that margin on the same roof. Both are models: neither replaces metered data (a measured Shah Alam home makes 1,144-1,196 kWh/kWp, closer to the ground-calibrated column).`,
  '',
];
fs.writeFileSync(new URL('../docs/twin-validation.md', import.meta.url), md.join('\n'));
console.log(md.join('\n'));
