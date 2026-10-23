// Irradiance, transposition, optics, temperature and loss chain for the twin.
// Pure functions, no DOM. Units: W/m² for irradiance, °C, degrees for angles
// unless the name says Rad.
//
// Model chain (per sun sample of a typical year, see sun.js):
//   1. GHI(t): Haurwitz clear-sky shape scaled so each month's daily total
//      matches CLIMATE_KL (NASA POWER all-sky GHI).
//   2. DHI(t): Erbs (1982) diffuse fraction from the hourly clearness index,
//      rescaled so the month's DHI total matches CLIMATE_KL; DNI = (GHI-DHI)/cosZ.
//   3. POA: Hay-Davies (1980) transposition: beam + circumsolar (both follow
//      the beam's shading) + isotropic sky (scaled by the cell's sky-view
//      fraction) + ground reflection (albedo 0.2).
//   4. Optics: Martin & Ruiz (2001) incidence-angle modifier for beam and
//      their closed forms for sky and ground diffuse.
//   5. Cell temperature: Faiman (2008), U0/U1 from LOSSES.thermal.
//   6. DC: P = Pstc · G_eff/1000 · (1 + γ(Tc − 25)); then LOSSES derates.

import { CLIMATE_KL, LOSSES } from './catalogue.js';
import { extraterrestrialNormal, DAYS_IN_MONTH } from './sun.js';

const RAD = Math.PI / 180;

// Haurwitz (1945) clear-sky GHI, W/m².
export function haurwitzGhi(cosZ) {
  if (cosZ <= 0) return 0;
  return 1098 * cosZ * Math.exp(-0.057 / cosZ);
}

// Erbs et al. (1982) diffuse fraction from the clearness index kt.
export function erbsDiffuseFraction(kt) {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

// Ambient temperature at a local hour from the month's mean min/max:
// cosine with the minimum at 06:00 and maximum at 15:00 (two half-cosines).
export function ambientAt(month, hour, climate = CLIMATE_KL) {
  const tmin = climate.minAmbientC?.[month] ?? 22, tmax = climate.maxAmbientC?.[month] ?? 32;
  const h = ((hour % 24) + 24) % 24;
  let f;
  if (h >= 6 && h <= 15) f = 0.5 - 0.5 * Math.cos((Math.PI * (h - 6)) / 9);
  else {
    const d = h > 15 ? h - 15 : h + 9; // hours since 15:00
    f = 0.5 + 0.5 * Math.cos((Math.PI * d) / 15);
  }
  return tmin + (tmax - tmin) * f;
}

// Attach GHI/DNI/DHI/ambient/wind to every sun sample. Samples must come from
// typicalYearSamples (they carry month, weightH, stepH, zenith, doy).
export function climateSamples(samples, climate = CLIMATE_KL) {
  const byMonth = Array.from({ length: 12 }, () => []);
  for (const s of samples) byMonth[s.month].push(s);
  const out = [];
  for (let m = 0; m < 12; m++) {
    const list = byMonth[m];
    if (!list.length) continue;
    const daily = (climate.ghiKwhM2Day?.[m] ?? 4.8) * 1000; // Wh/m²/day
    const dailyD = (climate.dhiKwhM2Day?.[m] ?? daily / 1000 * 0.55) * 1000;
    let csSum = 0;
    for (const s of list) csSum += haurwitzGhi(Math.cos(s.zenith * RAD)) * s.stepH;
    const k = csSum > 0 ? daily / csSum : 0;
    const rows = list.map((s) => {
      const cosZ = Math.cos(s.zenith * RAD);
      const ghi = haurwitzGhi(cosZ) * k;
      const e0 = extraterrestrialNormal(s.doy);
      const kt = Math.min(1, ghi / Math.max(1, e0 * Math.max(cosZ, 0.0436)));
      return { s, cosZ, ghi, e0, fd: erbsDiffuseFraction(kt) };
    });
    let dSum = 0;
    for (const r of rows) dSum += r.ghi * r.fd * r.s.stepH;
    const kd = dSum > 0 ? dailyD / dSum : 1;
    const wind = climate.windMS2m?.[m] ?? 1;
    for (const r of rows) {
      const dhi = Math.min(r.ghi, r.ghi * r.fd * kd);
      const dni = r.cosZ > 0.0436 ? (r.ghi - dhi) / r.cosZ : 0;
      const ghi = dni > 0 ? r.ghi : dhi; // very low sun: all diffuse
      out.push({
        ...r.s, ghi, dhi, dni, e0: r.e0, cosZ: r.cosZ,
        ai: Math.min(1, dni / r.e0), // Hay-Davies anisotropy index
        tAmb: ambientAt(m, r.s.hour, climate), wind,
      });
    }
  }
  return out;
}

// Martin & Ruiz (2001) beam incidence-angle modifier.
export function iamBeam(cosTheta, ar = 0.16) {
  if (cosTheta <= 0) return 0;
  return (1 - Math.exp(-cosTheta / ar)) / (1 - Math.exp(-1 / ar));
}

// Martin & Ruiz closed forms for isotropic sky and ground diffuse IAM.
export function iamDiffuse(tiltDeg, ar = 0.16) {
  const b = Math.max(1e-4, tiltDeg * RAD);
  const c1 = 4 / (3 * Math.PI), c2 = 0.5 * ar - 0.154;
  const xs = Math.sin(b) + (Math.PI - b - Math.sin(b)) / (1 + Math.cos(b));
  const xg = Math.sin(b) + (b - Math.sin(b)) / Math.max(1e-6, 1 - Math.cos(b));
  const sky = 1 - Math.exp((-1 / ar) * (c1 * xs + c2 * xs * xs));
  const gnd = 1 - Math.exp((-1 / ar) * (c1 * xg + c2 * xg * xg));
  return { sky, ground: gnd };
}

// Faiman (2008) cell temperature.
export function faimanCellTemp(poa, tAmb, wind, U0 = 25, U1 = 6.84) {
  return tAmb + poa / (U0 + U1 * wind);
}

export function systemDerate(losses = LOSSES) {
  const l = losses || {};
  return (1 - (l.soiling ?? 0.02)) * (1 - (l.mismatch ?? 0.02)) * (1 - (l.dcWiring ?? 0.015)) * (1 - (l.acWiring ?? 0.005)) *
    (1 - (l.lid ?? 0.01)) * (1 - (l.lowIrradiance ?? 0.01)) * (l.inverterEff ?? 0.97) * (l.availability ?? 0.99);
}

export function thermalParams(mounting, losses = LOSSES) {
  const t = losses?.thermal?.[mounting === 'tilted' ? 'tilted' : 'flush'];
  return t ? { U0: t.U0, U1: t.U1 } : mounting === 'tilted' ? { U0: 25, U1: 6.84 } : { U0: 20, U1: 5 };
}

// Plane-of-array components for one sample on a plane with unit normal n
// (twin frame) given the unit sun vector sv. Fractions:
//   beamSunlit: 0..1 of the beam (and circumsolar) reaching the surface
//   skyFrac:    cosine-weighted fraction of the hemisphere that is open sky
//   gndFrac:    cosine-weighted fraction that sees ground / obstructions
// Returns W/m² before optics: { beam, circ, sky, ground, cosTheta, total }.
export function poaComponents(c, n, sv, beamSunlit, skyFrac, gndFrac, albedo = 0.2) {
  const cosT = n[0] * sv[0] + n[1] * sv[1] + n[2] * sv[2];
  const cosTp = Math.max(0, cosT);
  const rb = c.cosZ > 0.0436 ? cosTp / c.cosZ : 0;
  const beam = c.dni * cosTp * beamSunlit;
  const circ = c.dhi * c.ai * rb * beamSunlit;
  const skyIsoUnobstructed = c.dhi * (1 - c.ai);
  // isotropic part normalised so that an unobstructed plane gets (1+cosβ)/2
  const sky = skyIsoUnobstructed * skyFrac;
  const ground = c.ghi * albedo * gndFrac;
  return { beam, circ, sky, ground, cosTheta: cosT, total: beam + circ + sky + ground };
}

export const MONTH_DAYS = DAYS_IN_MONTH;
