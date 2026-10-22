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
