import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStudyReviews, persistStudyReviews, validateStudyReview, studySummary, studyKey } from '../src/study.js';
import { shortlistCSV } from '../src/shortlist.js';
import { studyBriefHTML } from '../src/brief.js';
import { DEFAULT_ASSUMPTIONS } from '../src/solar.js';

test('study actions persist by township and tolerate corrupt browser storage', () => {
  const review = validateStudyReview({ control: 'made-up', stage: 'approved', nextAction: '  Get bills  ', responsible: 'A' });
  assert.equal(review.control, 'unknown');
  assert.equal(review.stage, 'screening');
  assert.equal(review.nextAction, 'Get bills');
  let raw;
  const storage = { setItem: (_k, value) => { raw = value; }, getItem: () => raw };
  persistStudyReviews({ [studyKey('ara','way/1')]: review }, storage);
  assert.equal(loadStudyReviews(storage)['ara:way/1'].responsible, 'A');
  assert.deepEqual(loadStudyReviews({ getItem: () => '{bad' }), {});
  assert.throws(() => persistStudyReviews({}, { setItem() { throw Error('full'); } }), /could not be saved/);
});

test('portfolio totals omit excluded and on-hold entries but exports retain their warnings', () => {
  const make = id => ({ id, name: '<script>test</script>', category: 'retail', categoryLabel: 'Retail', score: 80, area: 1000, usable: 600, shading: .9, kwp: 100, kwh: 120000, demand: 200000, payback: 8, flags: [], capex: 300000, co2: 90 });
  const active = make('way/1');
  const excluded = { ...make('way/2'), excluded: true, roofCheck: { status: 'existing-solar', note: 'Panels visible', source: 'Review <A>', date: '2026-10-22' } };
  const onHold = { ...make('way/3'), studyReview: { stage: 'on-hold' } };
  const summary = studySummary([active, excluded, onHold]);
  assert.equal(summary.active, 1);
  assert.equal(summary.kwp, 100);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.onHold, 1);
  const csv = shortlistCSV([excluded], [active], 'ara');
  assert.match(csv, /existing_solar_status/);
  assert.match(csv, /existing-solar,Panels visible,Review <A>,2026-10-22,true/);
  const html = studyBriefHTML([active, excluded, onHold], { township: 'Test', assumptions: DEFAULT_ASSUMPTIONS });
  assert.match(html, /Excluded from new-installation ranking/);
  assert.match(html, /&lt;script&gt;test&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>test</script>'));
});
