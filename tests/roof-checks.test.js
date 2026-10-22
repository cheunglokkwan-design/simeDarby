import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../src/osm.js';
import { buildSites, scoreSites, DEFAULT_ASSUMPTIONS } from '../src/solar.js';
import { roofCheck } from '../src/roof-checks.js';

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
