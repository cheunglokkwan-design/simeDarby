import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planCream } from '../src/cream.js';
import { buildSites, scoreSites, DEFAULT_ASSUMPTIONS, DAYTIME_SHARE } from '../src/solar.js';

const assumptions = { ...DEFAULT_ASSUMPTIONS, creamMinHomes: 1 };
const home = (id, position, kwh = 100000) => ({ id, position, category: 'residential', tags: { building: 'house' }, flags: [], homes: 1, roofKwp: 12, roofKwh: kwh });
const buyer = (id, category = 'retail') => ({ id, position: [101.005, 3.005], category, demand: 200000, selfUse: 5000 });

test('zone identities remain attached to the same geography when ranking changes', () => {
  const sites = [home('a', [101, 3], 120000), home('b', [101.01, 3.01], 80000), buyer('buyer')];
  const before = planCream(sites, assumptions).clusters;
  sites[1].roofKwh = 200000;
  const after = planCream(sites, assumptions).clusters;
  assert.notEqual(before[0].id, after[0].id);
  for (const c of before) {
    const same = after.find((other) => other.homes[0].id === c.homes[0].id);
    assert.equal(same.id, c.id);
    assert.equal(same.number, c.number);
  }
});

test('shared buyers are never allocated twice and unmatched output earns no revenue', () => {
  const sites = [home('a', [101, 3]), home('b', [101.01, 3.01]), buyer('buyer', 'industrial')];
  const result = planCream(sites, assumptions);
  const residual = sites[2].demand * DAYTIME_SHARE.industrial - sites[2].selfUse;
  assert.equal(result.totals.matchedKwh, residual);
  assert.equal(result.totals.unmatchedKwh, 200000 - residual);
  const revenue = result.clusters.reduce((sum, c) => sum + c.revenue, 0);
  assert.equal(revenue, residual * assumptions.tariffIndustrial * (1 - assumptions.creamDiscount));
});

test('no buyers and excluded housing do not become approved revenue-generating projects', () => {
  const dorm = home('dorm', [101, 3]);
  dorm.tags.building = 'dormitory';
  assert.equal(planCream([dorm], assumptions).clusters.length, 0);
  const c = planCream([home('a', [101, 3])], assumptions).clusters[0];
  assert.equal(c.revenue, 0);
  assert.equal(c.matchedKwh, 0);
  assert.equal(c.payback, Infinity);
  assert.ok(c.checks.some((check) => check.includes('100 kWp')));
  assert.ok(c.checks.some((check) => check.includes('unverified')));
});

for (const township of ['ara-damansara', 'bandar-bukit-raja']) {
  test(`${township}: snapshot allocations conserve energy and respect buyer demand`, async () => {
    const raw = JSON.parse(await readFile(new URL(`../public/data/${township}.json`, import.meta.url)));
    const yieldData = JSON.parse(await readFile(new URL(`../public/data/yield-${township}.json`, import.meta.url)));
    const { sites } = buildSites(raw);
    scoreSites(sites, DEFAULT_ASSUMPTIONS, yieldData);
    const result = planCream(sites, DEFAULT_ASSUMPTIONS);
    const assigned = new Map();
    const homeIds = new Set();
    for (const c of result.clusters) {
      assert.ok(Math.abs(c.matchedKwh + c.unmatchedKwh - c.kwh) < .001);
      for (const h of c.homes) { assert.ok(!homeIds.has(h.id)); homeIds.add(h.id); }
      for (const b of c.buyers) {
        assert.ok(b.dist <= DEFAULT_ASSUMPTIONS.creamRadiusKm * 1000);
        assigned.set(b.site, (assigned.get(b.site) || 0) + b.kwh);
      }
    }
    for (const [s, kwh] of assigned) assert.ok(kwh <= Math.max(0, s.demand * DAYTIME_SHARE[s.category] - s.selfUse) + .001);
    console.log(`${township}: ${result.clusters.length} proposed groups; ${result.clusters.filter(c => c.kwp > 2000).length} above 2 MWp; ${Math.round(result.totals.unmatchedKwh / result.totals.kwh * 100)}% unmatched output`);
  });
}
