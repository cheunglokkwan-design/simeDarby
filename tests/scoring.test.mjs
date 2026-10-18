// Opportunity score weights, viability and the CSV reader used by the validation scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ASSUMPTIONS, scoreSites, isViable } from '../src/solar.js';
import { parseCsv } from '../scripts/lib/rank.mjs';

const site = (category, area, shading = 1, extra = {}) => ({
  id: `${category}-${area}`, category, area, levels: 1, shading, tags: {}, kind: null, ...extra
});
const scores = (sites, a) => scoreSites(sites.map((s) => ({ ...s })), { ...DEFAULT_ASSUMPTIONS, ...a }).map((s) => s.score);

test('weights are relative: scaling all of them changes nothing', () => {
  const sites = [site('industrial', 5000), site('retail', 800, 0.7), site('residential', 120)];
  const base = scores(sites, {});
  const doubled = scores(sites, { wGeneration: 80, wSelfUse: 50, wPayback: 40, wShading: 30 });
  base.forEach((v, i) => assert.ok(Math.abs(v - doubled[i]) < 1e-9));
});

test('only sun exposure weighted: score follows the unshaded fraction', () => {
  const [lit, shaded] = scores([site('industrial', 5000, 1), site('industrial', 5000, 0.8)], {
    wGeneration: 0, wSelfUse: 0, wPayback: 0, wShading: 100
  });
  assert.equal(lit, 100);
  assert.ok(Math.abs(shaded - 80) < 1e-9);
});

test('generation weight favours the bigger roof', () => {
  const [big, small] = scores([site('industrial', 20000), site('industrial', 600)], {
    wGeneration: 100, wSelfUse: 0, wPayback: 0, wShading: 0
  });
  assert.ok(big > small);
});

test('utility assets and tiny roofs are not viable', () => {
  const sites = scoreSites([site('utility', 4000), site('residential', 10), site('commercial', 900)], DEFAULT_ASSUMPTIONS);
  assert.deepEqual(sites.map(isViable), [false, false, true]);
});

test('SDP-owned flag does not change the score', () => {
  const [plain, sdp] = scores([site('retail', 24000), site('retail', 24000, 1, { sdpAsset: true })], {});
  assert.equal(plain, sdp);
});

test('parseCsv reads quoted fields and filled labels', () => {
  const rows = parseCsv('sample,name,label\n1,"Mall, Elmina",good\r\n2,"Say ""hi""",\n');
  assert.deepEqual(rows, [
    { sample: '1', name: 'Mall, Elmina', label: 'good' },
    { sample: '2', name: 'Say "hi"', label: '' }
  ]);
});
