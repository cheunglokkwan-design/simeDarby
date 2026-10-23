import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSites, scoreSites, rankSites, compareSites, largestRoofBaseline, DEFAULT_ASSUMPTIONS, ONSITE_CEILING } from '../src/solar.js';

// Square footprint of roughly `side` metres near Kuala Lumpur.
const square = (id, side, tags = { building: 'warehouse' }, lon = 101.6) => {
  const d = side / 111320;
  return { id, tags, polygon: [[lon, 3], [lon + d, 3], [lon + d, 3 + d], [lon, 3 + d], [lon, 3]] };
};

test('a large office is capped and cannot claim 100% onsite use', () => {
  const { sites } = buildSites({ buildings: [square('way/1', 120, { building: 'office', 'building:levels': '8' })], parking: [] });
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  const [s] = sites;
  assert.equal(s.atapCapped, true);
  assert.ok(s.uncappedKwp > s.kwp, 'records the roof potential beyond the cap');
  assert.ok(s.selfRatio <= ONSITE_CEILING.commercial + 1e-9);
  assert.ok(s.selfRatio < 1);
  assert.equal(s.onsiteAtCeiling, true);
});

test('roofs held to the 1 MWp cap tie-break on sun exposure, not footprint', () => {
  const raw = { buildings: [square('way/10', 200), square('way/11', 140, undefined, 101.61)], parking: [] };
  const { sites } = buildSites(raw);
  sites[0].shading = 0.9; // bigger roof, more shade
  sites[1].shading = 1;
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  for (const s of sites) { assert.equal(s.kwp, DEFAULT_ASSUMPTIONS.atapCapKw); assert.equal(s.capKind, 'system'); }
  const ranked = rankSites(sites);
  assert.equal(ranked[0].id, 'way/11');
  // Equal score and sun: more spare roof ranks first.
  const a = { id: 'a', score: 80, energyShading: 1, selfRatio: .9, kwp: 1000, uncappedKwp: 1200 };
  const b = { ...a, id: 'b', uncappedKwp: 1800 };
  assert.deepEqual([a, b].sort(compareSites).map(s => s.id), ['b', 'a']);
});

test('largest-roof baseline counts excluded big roofs and overlap with our top list', () => {
  const raw = { buildings: [
    square('way/780152646', 150, { building: 'retail', name: 'Citta Mall' }), // imagery: existing solar
    square('way/895155128', 160, { building: 'retail', name: 'Raya Complex' }, 101.61), // imagery: not buildable
    square('way/3', 100, { building: 'warehouse' }, 101.62),
    square('way/4', 20, { building: 'house' }, 101.63)
  ], parking: [] };
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  const ranked = rankSites(sites);
  const b = largestRoofBaseline(sites, ranked, 3);
  assert.equal(b.n, 3);
  assert.deepEqual(b.biggest.map(s => s.id), ['way/895155128', 'way/780152646', 'way/3']);
  assert.equal(b.excluded.length, 2);
  assert.equal(b.hasSolar.length, 1);
  assert.equal(b.notBuildable.length, 1);
  assert.deepEqual(b.overlap.map(s => s.id), ['way/3']);
  assert.equal(b.imageryOnly, true);
  assert.deepEqual(b.examples.map(s => s.name), ['Raya Complex', 'Citta Mall']);
  assert.ok(!b.biggest.some(s => s.category === 'residential'), 'homes are not business roofs');
});
