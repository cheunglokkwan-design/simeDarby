import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSites } from '../src/search.js';

test('finds named and unnamed buildings by mapped address and stable ID', () => {
  const sites = [{ id: 'way/123', name: 'Citta Mall', tags: {} }, { id: 'way/456', categoryLabel: 'Residential', tags: { 'addr:housenumber': '18', 'addr:street': 'Jalan PJU', 'addr:postcode': '47301' } }];
  assert.equal(searchSites(sites, 'CITTA')[0].id, 'way/123');
  assert.equal(searchSites(sites, '18 jalan')[0].id, 'way/456');
  assert.equal(searchSites(sites, 'way/456')[0].id, 'way/456');
  assert.equal(searchSites(sites, '47301')[0].id, 'way/456');
  assert.equal(searchSites(sites, 'unknown property').length, 0);
  assert.equal(searchSites(sites, '').length, 2);
});
