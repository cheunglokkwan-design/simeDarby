// Sanity checks for the roof-shading raycast (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShading, sunSamples } from '../src/shading.js';

const ELMINA = [3.19, 101.513];

// Axis-aligned building: x0..x1 east, y0..y1 north (metres), given height.
function building(x0, y0, x1, y1, height) {
  const xy = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  return { xy, bbox: [x0, y0, x1, y1], centroid: [(x0 + x1) / 2, (y0 + y1) / 2], height };
}
const shade = (items) => Array.from(computeShading(items, ...ELMINA));

test('sun samples cover all twelve months', () => {
  const n = sunSamples(...ELMINA).length;
  assert.ok(n >= 12 * 9, `only ${n} sun positions`);
});

test('an isolated roof is fully lit', () => {
  const [lit] = shade([building(0, 0, 10, 10, 6)]);
  assert.equal(lit, 1);
});

test('a low roof right next to a tower is shaded', () => {
  const tower = building(0, 0, 30, 30, 60);
  const west = building(-15, 10, -5, 20, 6); // 5 m west: loses the afternoon sun
  const north = building(10, 35, 20, 45, 6); // 5 m north: shaded when the sun is south (Oct-Feb)
  const [towerLit, westLit, northLit] = shade([tower, west, north]);
  assert.equal(towerLit, 1, 'nothing is taller than the tower');
  assert.ok(westLit < 0.85, `west roof unshaded fraction ${westLit.toFixed(2)}`);
  assert.ok(northLit < 0.97, `north roof unshaded fraction ${northLit.toFixed(2)}`);
});

test('shading fades with distance from the tower', () => {
  const tower = building(0, 0, 30, 30, 60);
  const near = building(-15, 10, -5, 20, 6);
  const far = building(-125, 10, -115, 20, 6);
  const [, nearLit, farLit] = shade([tower, near, far]);
  assert.ok(farLit > nearLit, `far ${farLit.toFixed(2)} should beat near ${nearLit.toFixed(2)}`);
});

test('car parks (skip) are not raycast', () => {
  const tower = building(0, 0, 30, 30, 60);
  const lot = { ...building(-40, 0, -5, 30, 4.5), skip: true };
  assert.equal(shade([tower, lot])[1], 1);
});
