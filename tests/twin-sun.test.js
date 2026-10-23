import test from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, localDate, typicalYearSamples, sunVectorTwin, compassAzimuthOf, refraction } from '../src/twin/sun.js';
import { climateSamples, iamBeam, iamDiffuse, faimanCellTemp, systemDerate } from '../src/twin/irradiance.js';
import { CLIMATE_KL } from '../src/twin/catalogue.js';

const LAT = 3.11, LON = 101.58;

function solarNoon(y, m, d) {
  let best = null;
  for (let min = 12 * 60; min < 14.5 * 60; min++) {
    const p = sunPosition(localDate(y, m, d, min / 60, 8), LAT, LON);
    if (!best || p.elevation > best.elevation) best = { ...p, min };
  }
  return best;
}

test('KL equinox solar noon: sun ~87° high, due south, ~13:21 local', () => {
  const n = solarNoon(2026, 3, 20);
  assert.ok(n.elevation > 86.3 && n.elevation < 87.2, `elevation ${n.elevation}`);
  assert.ok(Math.abs(n.azimuth - 180) < 3, `azimuth ${n.azimuth}`);
  assert.ok(Math.abs(n.min - (13 * 60 + 21)) <= 2, `noon at ${n.min} min`);
});

test('June solstice noon sun is north of KL (decl 23.4° > lat 3.1°), December south', () => {
  const j = solarNoon(2026, 6, 21), d = solarNoon(2026, 12, 21);
  assert.ok(j.azimuth < 5 || j.azimuth > 355, `June azimuth ${j.azimuth}`);
  assert.ok(Math.abs(j.elevation - (90 - (23.44 - 3.11))) < 0.3, `June elevation ${j.elevation}`);
  assert.ok(Math.abs(d.azimuth - 180) < 5, `Dec azimuth ${d.azimuth}`);
  assert.ok(Math.abs(d.elevation - (90 - (23.44 + 3.11))) < 0.3, `Dec elevation ${d.elevation}`);
});

test('sunrise in KL is ~07:00-07:30 and the sun rises in the east', () => {
  let rise = null;
  for (let min = 6 * 60; min < 8 * 60; min++) {
    const p = sunPosition(localDate(2026, 3, 20, min / 60, 8), LAT, LON);
    if (p.elevation > -0.833) { rise = { min, az: p.azimuth }; break; }
  }
  assert.ok(rise.min >= 7 * 60 && rise.min <= 7 * 60 + 30, `sunrise ${rise.min}`);
  assert.ok(Math.abs(rise.az - 90) < 3, `sunrise azimuth ${rise.az}`);
});

test('refraction ~0.5° at the horizon and 0 near the zenith', () => {
  assert.ok(Math.abs(refraction(0) - 0.48) < 0.1);
  assert.equal(refraction(89), 0);
});

test('twin sun vector: x east, y up, z south; northBearing rotates north clockwise', () => {
  const e = sunVectorTwin(90, 0, 0);
  assert.ok(Math.abs(e[0] - 1) < 1e-9 && Math.abs(e[2]) < 1e-9);
  const s = sunVectorTwin(180, 0, 0);
  assert.ok(Math.abs(s[2] - 1) < 1e-9);
  const n90 = sunVectorTwin(0, 0, 90); // north now points to +x
  assert.ok(Math.abs(n90[0] - 1) < 1e-9);
  assert.ok(Math.abs(compassAzimuthOf([1, 0, 0], 90) - 0) < 1e-9);
  assert.ok(Math.abs(compassAzimuthOf([0, 0, 1], 0) - 180) < 1e-9);
});

test('typical year: ~4,450 daylight hours and model GHI matches NASA POWER annual total', () => {
  const ys = typicalYearSamples(LAT, LON);
  const hours = ys.reduce((a, s) => a + s.weightH, 0);
  assert.ok(hours > 4350 && hours < 4550, `daylight ${hours}`);
  const cs = climateSamples(ys);
  const ghi = cs.reduce((a, s) => a + s.ghi * s.weightH, 0) / 1000;
  const dhi = cs.reduce((a, s) => a + s.dhi * s.weightH, 0) / 1000;
  assert.ok(Math.abs(ghi - CLIMATE_KL.annualGhiKwhM2) / CLIMATE_KL.annualGhiKwhM2 < 0.01, `GHI ${ghi}`);
  assert.ok(Math.abs(dhi / ghi - CLIMATE_KL.annualDiffuseFraction) < 0.02, `diffuse fraction ${dhi / ghi}`);
  for (const s of cs) { assert.ok(s.dni >= 0 && s.dhi >= 0 && s.dhi <= s.ghi + 1e-9); assert.ok(s.dni < 1100); }
});

test('optics, temperature and loss chain are in physical ranges', () => {
  assert.ok(Math.abs(iamBeam(1) - 1) < 1e-12);
  assert.ok(iamBeam(Math.cos(60 * Math.PI / 180)) > 0.9 && iamBeam(Math.cos(80 * Math.PI / 180)) < 0.7);
  const d = iamDiffuse(20);
  assert.ok(d.sky > 0.9 && d.sky < 0.97 && d.ground > 0.5 && d.ground < 0.9);
  const tc = faimanCellTemp(900, 32, 0.8, 20, 5);
  assert.ok(tc > 60 && tc < 75, `Tc ${tc}`);
  const k = systemDerate();
  assert.ok(Math.abs(k - 0.886) < 0.01, `derate ${k}`);
});
