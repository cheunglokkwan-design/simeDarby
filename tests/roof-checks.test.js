import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../src/osm.js';
import { buildSites, scoreSites, DEFAULT_ASSUMPTIONS } from '../src/solar.js';
import { roofCheck, roofStatus } from '../src/roof-checks.js';
import { validateSolarCheck } from '../src/evidence.js';

test('imported solar tags survive normalization and exclude an installed roof', () => {
  const geometry = [{ lon: 101, lat: 3 }, { lon: 101.001, lat: 3 }, { lon: 101.001, lat: 3.001 }, { lon: 101, lat: 3.001 }, { lon: 101, lat: 3 }];
  const raw = normalise({ elements: [{ type: 'way', id: 99, tags: { building: 'warehouse', 'generator:source': 'solar' }, geometry }] });
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].tags['generator:source'], 'solar');
  assert.equal(roofCheck(sites[0]).status, 'existing-solar');
  assert.equal(sites[0].excluded, true);
});

test('a roof recorded as partially covered by solar is excluded from new-site opportunities', () => {
  const raw = { buildings: [{ id: 'way/1230534983', tags: { building: 'commercial' }, polygon: [[101,3],[101.001,3],[101.001,3.001],[101,3.001],[101,3]] }], parking: [] };
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].roofCheck.status, 'partial-solar');
  assert.equal(sites[0].excluded, true);
});

test('a separately mapped rooftop generator is joined to its building without excluding a neighbouring roof', () => {
  const geometry = [{lon:101,lat:3},{lon:101.001,lat:3},{lon:101.001,lat:3.001},{lon:101,lat:3.001},{lon:101,lat:3}];
  const raw = normalise({ elements: [
    { type: 'way', id: 101, tags: { building: 'warehouse' }, geometry },
    { type: 'way', id: 102, tags: { building: 'warehouse' }, geometry: geometry.map(p => ({ ...p, lon: p.lon + .002 })) },
    { type: 'node', id: 1, lon: 101.0005, lat: 3.0005, tags: { power: 'generator', 'generator:source': 'solar', location: 'roof' } },
    { type: 'node', id: 2, lon: 101.0025, lat: 3.0005, tags: { power: 'generator', 'generator:source': 'solar', location: 'ground' } }
  ] });
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].excluded, true);
  assert.match(sites[0].roofCheck.note, /node\/1/);
  assert.equal(sites[1].excluded, false);
  assert.equal(roofStatus(sites[1]).status, 'unknown');
});

test('source-referenced user panel checks update exclusion but cannot clear known installed roofs', () => {
  assert.throws(() => validateSolarCheck({ solarStatus: 'existing-solar' }), /source/);
  assert.throws(() => validateSolarCheck({ solarStatus: 'unclear', solarSource: 'Image', solarDate: '2026-02-31' }), /valid review date/);
  const check = validateSolarCheck({ solarStatus: 'existing-solar', solarSource: 'QA source', solarDate: '2026-10-22' });
  const raw = { buildings: [{ id: 'way/1', tags: { building: 'commercial' }, polygon: [[101,3],[101.001,3],[101.001,3.001],[101,3.001],[101,3]] }], parking: [] };
  const { sites } = buildSites(raw);
  sites[0].evidence = check;
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].excluded, true);
  assert.equal(roofStatus(sites[0]).date, '2026-10-22');
  sites[0].id = 'way/780152646';
  sites[0].evidence.solarStatus = 'checked-clear';
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].excluded, true);
  assert.equal(sites[0].roofCheck.status, 'existing-solar');
});
