import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePanelLayout } from '../src/panels.js';
import { pointInPolygon } from '../src/geo.js';

test('packs actual-size panels within the edge setback and the capacity cap', () => {
  const roof = [[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]];
  const result = generatePanelLayout(roof, { maxPanels: 25 });
  assert.equal(result.count, 25);
  assert.equal(result.kwp, 13.75);
  for (const panel of result.panels) {
    for (const [x, y] of panel) {
      assert.ok(x >= .6 - 1e-8 && x <= 19.4 + 1e-8);
      assert.ok(y >= .6 - 1e-8 && y <= 14.4 + 1e-8);
    }
    const width = Math.hypot(panel[1][0] - panel[0][0], panel[1][1] - panel[0][1]);
    const length = Math.hypot(panel[2][0] - panel[1][0], panel[2][1] - panel[1][1]);
    assert.ok(Math.abs(width - 1.134) < 1e-8);
    assert.ok(Math.abs(length - 2.278) < 1e-8);
  }
});

test('concave roofs do not get panels across the missing section', () => {
  const roof = [[0, 0], [12, 0], [12, 5], [5, 5], [5, 12], [0, 12], [0, 0]];
  const result = generatePanelLayout(roof);
  assert.ok(result.count > 0);
  for (const panel of result.panels) {
    for (let i = 0; i < 4; i++) {
      assert.ok(pointInPolygon(...panel[i], roof));
      const next = panel[(i + 1) % 4];
      assert.ok(pointInPolygon((panel[i][0] + next[0]) / 2, (panel[i][1] + next[1]) / 2, roof));
    }
  }
});

test('packing is independent of the rotation of the capture and handles small roofs', () => {
  const roof = [[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]];
  const rotated = roof.map(([x, y]) => [x * Math.cos(.7) - y * Math.sin(.7), x * Math.sin(.7) + y * Math.cos(.7)]);
  assert.equal(generatePanelLayout(roof).count, generatePanelLayout(rotated).count);
  assert.equal(generatePanelLayout([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]).count, 0);
  assert.equal(generatePanelLayout(roof, { maxPanels: 0 }).count, 0);
});

test('marked obstructions remove panels and can make the roof unusable', () => {
  const roof = [[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]];
  const normal = generatePanelLayout(roof);
  const blocked = generatePanelLayout(roof, { exclusions: [[[0, 0], [10, 0], [10, 15], [0, 15]]] });
  assert.ok(blocked.count < normal.count);
  assert.ok(blocked.count > 0);
  for (const panel of blocked.panels) for (const [x] of panel) assert.ok(x >= 10.6 - 1e-8);
  assert.equal(generatePanelLayout(roof, { exclusions: [roof.slice(0, -1)] }).count, 0);
});

test('sun scoring skips shaded positions and fills the sunniest first', () => {
  const roof = [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]];
  const score = (x) => (x < 20 ? 0.3 : 1); // left half in shadow
  const result = generatePanelLayout(roof, { maxPanels: 40, score });
  assert.equal(result.count, 40);
  assert.ok(result.panels.every((p) => p.every(([x]) => x >= 20 - 1e-6)), 'no panel in the shaded half');
  assert.ok(result.meanSun > .99);
});

test('walkways split the array into blocks', () => {
  const roof = [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]];
  const plain = generatePanelLayout(roof);
  const aisles = generatePanelLayout(roof, { walkwayRows: 4, walkwayCols: 12, walkway: 1 });
  assert.ok(aisles.count > 0 && aisles.count < plain.count, 'walkways take some space');
});

test('capped sunny layouts form solid blocks without stray panels', () => {
  const roof = [[0, 0], [60, 0], [60, 40], [0, 40], [0, 0]];
  const score = (x, y) => (Math.hypot(x - 30, y - 20) < 8 ? 0.2 : 0.9 + 0.1 * Math.sin(x) * Math.cos(y)); // shaded centre, noisy sun
  const result = generatePanelLayout(roof, { maxPanels: 300, score, setback: 1.2, walkwayRows: 4, walkwayCols: 12 });
  const c = result.panels.map((p) => [(p[0][0] + p[2][0]) / 2, (p[0][1] + p[2][1]) / 2]);
  const seen = new Array(c.length).fill(false);
  let smallest = Infinity;
  for (let i = 0; i < c.length; i++) {
    if (seen[i]) continue;
    let n = 0; const queue = [i]; seen[i] = true;
    while (queue.length) {
      const a = queue.pop(); n++;
      for (let j = 0; j < c.length; j++) if (!seen[j] && Math.hypot(c[a][0] - c[j][0], c[a][1] - c[j][1]) < 3.6) { seen[j] = true; queue.push(j); }
    }
    smallest = Math.min(smallest, n);
  }
  assert.equal(result.count, 300);
  assert.ok(smallest >= 12, `smallest group has ${smallest} panels`);
});
