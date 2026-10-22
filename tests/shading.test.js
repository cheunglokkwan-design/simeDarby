import test from 'node:test';
import assert from 'node:assert/strict';
import { computeShading, roofSamplePoints } from '../src/shading.js';
import { pointInPolygon, polygonCentroid, bboxOf } from '../src/geo.js';

test('concave-roof shading samples lie inside the roof even when its centroid does not', () => {
  const xy = [[0,0],[20,0],[20,3],[3,3],[3,20],[0,20],[0,0]];
  const centroid = polygonCentroid(xy);
  assert.equal(pointInPolygon(...centroid, xy), false);
  const points = roofSamplePoints({ xy, centroid, bbox: bboxOf(xy) });
  assert.ok(points.length > 0);
  assert.ok(points.every(p => pointInPolygon(...p, xy)));
});

test('a proposed canopy receives building-shadow rays without acting as an existing obstacle', () => {
  const item = (xy, height, occluder = true) => ({ xy, height, occluder, centroid: polygonCentroid(xy), bbox: bboxOf(xy) });
  const canopy = item([[0,0],[10,0],[10,10],[0,10],[0,0]], 4.5, false);
  const tower = item([[12,-40],[40,-40],[40,40],[12,40],[12,-40]], 100);
  assert.equal(computeShading(3.1, 101.6, [canopy])[0], 1);
  const shaded = computeShading(3.1, 101.6, [canopy, tower])[0];
  assert.ok(shaded < .95, `A nearby tower must affect canopy exposure, got ${shaded}`);
});
