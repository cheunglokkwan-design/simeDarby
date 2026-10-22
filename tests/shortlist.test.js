import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShortlists, updateShortlist, persistShortlists, selectedSites, shortlistCSV, studyChecks } from '../src/shortlist.js';
import { scoreSites, priorityBreakdown, DEFAULT_ASSUMPTIONS } from '../src/solar.js';

const site = (id, score = 70) => ({ id, name: '=unsafe, name', category: 'retail', area: 1000, usable: 550, shading: .8, kwp: 99, kwh: 120000, demand: 280000, demandSource: 'Category estimate', selfUse: 100000, payback: 7, score, flags: [], tags: {}, levels: 1 });

test('study selections persist, deduplicate and remain isolated by township', () => {
  let saved = updateShortlist({}, 'ara', 'way/1', true);
  saved = updateShortlist(saved, 'ara', 'way/1', true);
  saved = updateShortlist(saved, 'bbr', 'way/2', true);
  let raw;
  const storage = { setItem: (_key, value) => { raw = value; }, getItem: () => raw };
  persistShortlists(saved, storage);
  const restored = loadShortlists(storage);
  assert.deepEqual(restored, { ara: ['way/1'], bbr: ['way/2'] });
  assert.deepEqual(selectedSites([site('way/1'), site('way/2', 95)], restored, 'ara').map(s => s.id), ['way/1']);
  assert.deepEqual(updateShortlist(restored, 'ara', 'way/1', false).bbr, ['way/2']);
  assert.deepEqual(loadShortlists({ getItem: () => '{bad json' }), {});
  assert.throws(() => persistShortlists(saved, { setItem() { throw Error('full'); } }), /could not be saved/);
});

test('expert export preserves global model rank and leaves assessment fields blank', () => {
  const a = site('way/1', 90), b = site('way/2', 70);
  const csv = shortlistCSV([b], [a, b], 'ara', true);
  assert.match(csv, /expert_rank,expert_suitability,expert_source_reference,expert_notes/);
  assert.match(csv, /ara,way\/2,"'=unsafe, name",retail,2,70\.0/);
  assert.ok(csv.endsWith(',,,,') && csv.includes('not approved or independently validated'));
  assert.ok(!csv.includes('way/1'), 'Unselected candidates must not appear in a shortlist export');
  assert.ok(studyChecks({ ...b, category: 'carpark' }).some(check => check.includes('Canopy structure')));
  assert.ok(studyChecks({ ...b, category: 'carpark' }).some(check => check.includes('No host load')));
});

test('visible score factors reproduce the actual priority, including review penalties', () => {
  for (const tags of [{}, { historic: 'yes' }]) {
    const s = site('way/1'); s.tags = tags;
    scoreSites([s], DEFAULT_ASSUMPTIONS);
    const result = priorityBreakdown(s);
    assert.equal(result.score, s.score);
    assert.ok(Math.abs(result.parts.reduce((sum, part) => sum + part.points, 0) * result.multiplier - s.score) < 1e-10);
    assert.equal(result.multiplier, tags.historic ? .8 : 1);
  }
});
