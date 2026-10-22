import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateHeight } from '../src/heights.js';
import { buildSites, scoreSites, DEFAULT_ASSUMPTIONS, toCSV, priorityBreakdown } from '../src/solar.js';
import { validateEvidence } from '../src/evidence.js';

test('tall sheds do not acquire invented occupied floors', () => {
  const shed = estimateHeight({}, 'industrial', 21605);
  assert.equal(shed.height, 14);
  assert.equal(shed.levels, 1);
  assert.match(shed.levelsSource, /unknown/);
  const known = estimateHeight({ height: '20', 'building:levels': '2' }, 'industrial', 21605);
  assert.equal(known.height, 20);
  assert.equal(known.levels, 2);
});

test('bill and survey corrections change model outputs while leaving visual height separate', () => {
  const raw = { buildings: [{ id: 'way/1', tags: { building: 'warehouse' }, polygon: [[101, 3], [101.002, 3], [101.002, 3.002], [101, 3.002], [101, 3]] }], parking: [] };
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  const original = sites[0].kwp, height = sites[0].height;
  assert.equal(sites[0].occupiedStoreys, 1);
  sites[0].evidence = { occupiedStoreys: 2, annualKwh: 240000, peakKw: 50, usableM2: 100, source: 'Test bill and survey' };
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].demand, 240000);
  assert.equal(sites[0].occupiedStoreys, 2);
  assert.equal(sites[0].height, height);
  assert.equal(sites[0].usable, 100);
  assert.ok(sites[0].kwp <= 18 && sites[0].kwp < original);
  sites[0].layoutKwCap = 3.3;
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(sites[0].kwp, 3.3);
  assert.equal(sites[0].atapCapped, false, 'A physical layout limit must not be presented as an ATAP limit');
});

test('evidence requires a source and rejects impossible areas and floor counts', () => {
  assert.throws(() => validateEvidence({ annualKwh: 10000 }, 100), /Describe/);
  assert.throws(() => validateEvidence({ usableM2: 101, source: 'survey' }, 100), /mapped footprint/);
  assert.throws(() => validateEvidence({ occupiedStoreys: 1.5, source: 'survey' }, 100), /floor count/);
  assert.deepEqual(validateEvidence({ annualKwh: '24000', occupiedStoreys: '', source: 'Bill' }, 100), { annualKwh: 24000, source: 'Bill' });
});

test('canopy financial benefits are withheld until a complete host scenario is linked', () => {
  const raw = { buildings: [], parking: [{ id: 'way/77', tags: { amenity: 'parking' }, polygon: [[101,3],[101.001,3],[101.001,3.001],[101,3.001],[101,3]] }] };
  const { sites } = buildSites(raw);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  const s = sites[0];
  assert.equal(s.economicsReady, false);
  assert.equal(s.savings, null);
  assert.equal(s.payback, Infinity);
  assert.ok(s.kwh > 0);
  assert.doesNotThrow(() => toCSV(sites), 'Withheld financial fields must export as blanks');
  assert.match(toCSV(sites), /Host load and tariff required/);
  assert.throws(() => validateEvidence({ annualKwh: '100000', hostSiteId: 'meter/1', source: 'Bill' }, s.area), /daytime share/);
  s.evidence = validateEvidence({ annualKwh: '100000', peakKw: '20', hostSiteId: 'meter/1', daytimeShare: '.7', hostTariff: '.35', source: 'Test bill and tariff' }, s.area);
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(s.economicsReady, true);
  assert.ok(s.selfUse > 0 && s.savings > 0);
  assert.ok(s.kwp <= 20, 'Linked canopies respect the host peak-demand cap');
});

test('generated-array exposure replaces whole-roof loss instead of applying shading twice', () => {
  const raw = { buildings: [{ id: 'way/88', tags: { building: 'warehouse' }, polygon: [[101,3],[101.001,3],[101.001,3.001],[101,3.001],[101,3]] }], parking: [] };
  const { sites } = buildSites(raw);
  const s = sites[0]; s.shading = .5; s.layoutSun = .9; s.layoutKwCap = 5.5;
  scoreSites(sites, DEFAULT_ASSUMPTIONS);
  assert.equal(s.kwp, 5.5);
  assert.equal(s.kwh, 5.5 * DEFAULT_ASSUMPTIONS.specificYield * .9);
  assert.equal(priorityBreakdown(s).score, s.score);
});
