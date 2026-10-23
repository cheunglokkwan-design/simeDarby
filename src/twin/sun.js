// Sun position for the digital twin (NOAA Solar Calculator equations, after
// Meeus, "Astronomical Algorithms"). Accuracy ~0.01 deg in elevation for
// 1900-2100, which is far below anything else in the twin's error budget.
// Pure ES module, no DOM: runs in node, the browser and Web Workers.
//
// Conventions (docs/twin-contract.md):
//   azimuth  : degrees from true north, clockwise (90 = east)
//   elevation: degrees above the horizon, refraction-corrected
//   twin frame: x = east, y = up, z = south when northBearing = 0.
//   northBearing θ: the twin's true-north direction is (sin θ, 0, -cos θ)
//   (positive θ turns north clockwise seen from above; matches the viewer).

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Full NOAA solution. Returns degrees plus the intermediate terms that the
// irradiance model needs (declination, equation of time, solar time).
export function solarGeometry(date, lat, lon) {
  const jd = julianDay(date);
  const T = (jd - 2451545.0) / 36525; // Julian century
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360; // geom. mean longitude
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T); // mean anomaly
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T); // orbit eccentricity
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289; // equation of centre
  const trueLong = L0 + C;
  const trueAnom = M + C;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnom * RAD)); // AU
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD); // corrected obliquity
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const L0r = L0 * RAD;
  const eqTime = 4 * DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
    0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr)); // minutes
  const utcMin = ((date.getTime() / 60000) % 1440 + 1440) % 1440;
  const trueSolarMin = (((utcMin + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  let hourAngle = trueSolarMin / 4 - 180; // degrees, 0 at solar noon
  if (hourAngle < -180) hourAngle += 360;
  const latR = lat * RAD, decR = decl * RAD, haR = hourAngle * RAD;
  let cosZ = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  cosZ = Math.min(1, Math.max(-1, cosZ));
  const zenith = Math.acos(cosZ) * DEG;
  // azimuth from north, clockwise
  const sinZ = Math.sin(zenith * RAD);
  let azimuth;
  if (sinZ < 1e-9) azimuth = 180;
  else {
    const cosAz = (Math.sin(latR) * cosZ - Math.sin(decR)) / (Math.cos(latR) * sinZ);
    const a = Math.acos(Math.min(1, Math.max(-1, cosAz))) * DEG;
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  const elevGeo = 90 - zenith;
  const elevation = elevGeo + refraction(elevGeo);
  return { azimuth, elevation, zenith: 90 - elevation, elevationGeometric: elevGeo, declination: decl, eqTimeMin: eqTime,
    hourAngle, trueSolarMin, earthSunAU: R };
}

// NOAA atmospheric refraction (degrees) for a geometric elevation in degrees.
export function refraction(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let arcsec;
  if (elev > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) arcsec = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

// Contract API: sunPosition(date, lat, lon) -> { azimuth, elevation } in degrees.
export function sunPosition(date, lat, lon) {
  const g = solarGeometry(date, lat, lon);
  return { azimuth: g.azimuth, elevation: g.elevation, zenith: g.zenith, declination: g.declination, eqTimeMin: g.eqTimeMin, hourAngle: g.hourAngle };
}

// Unit vector toward the sun in the twin frame (x east, y up, z south),
// honouring the scan's northBearing (see header).
export function sunVectorTwin(azimuthDeg, elevationDeg, northBearingDeg = 0) {
  const a = (azimuthDeg + northBearingDeg) * RAD, e = elevationDeg * RAD;
  const h = Math.cos(e);
  return [h * Math.sin(a), Math.sin(e), -h * Math.cos(a)];
}

// Compass azimuth (deg from true north, clockwise) of a twin-frame direction.
export function compassAzimuthOf(v, northBearingDeg = 0) {
  const twinAz = Math.atan2(v[0], -v[2]) * DEG;
  return (((twinAz - northBearingDeg) % 360) + 360) % 360;
}

// Local civil time (UTC + tz hours) -> Date.
export function localDate(year, month1, day, hours, tz = 8) {
  return new Date(Date.UTC(year, month1 - 1, day, 0, 0, 0) + (hours - tz) * 3600e3);
}

export function dayOfYear(year, month1, day) {
  return Math.round((Date.UTC(year, month1 - 1, day) - Date.UTC(year, 0, 1)) / 86400e3) + 1;
}

// Extraterrestrial normal irradiance (W/m²), Spencer (1971).
export function extraterrestrialNormal(doy) {
  const b = (2 * Math.PI * (doy - 1)) / 365;
  return 1361 * (1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b) + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b));
}

// Klein (1977) "recommended average day" of each month: the day whose
// extraterrestrial irradiation is closest to the monthly mean.
export const REPRESENTATIVE_DAYS = [17, 16, 16, 15, 15, 11, 17, 16, 15, 15, 14, 10];
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// A typical year as weighted sun samples: one representative day per month,
// sampled at the midpoints of `stepMin` bins of local clock time. Each sample's
// `weightH` is the number of hours per year it stands for (bin length × days
// in the month), so Σ weightH·W/1000 = kWh/yr. Night samples are dropped.
export function typicalYearSamples(lat, lon, { tz = 8, stepMin = 30, year = 2026, minElevation = 0 } = {}) {
  const out = [];
  const stepH = stepMin / 60;
  for (let m = 0; m < 12; m++) {
    const day = REPRESENTATIVE_DAYS[m];
    const doy = dayOfYear(year, m + 1, day);
    for (let h = stepH / 2; h < 24; h += stepH) {
      const date = localDate(year, m + 1, day, h, tz);
      const g = solarGeometry(date, lat, lon);
      if (g.elevation <= minElevation) continue;
      out.push({
        month: m, day, doy, hour: h, date,
        azimuth: g.azimuth, elevation: g.elevation, zenith: g.zenith,
        solarHour: g.trueSolarMin / 60,
        stepH, weightH: stepH * DAYS_IN_MONTH[m],
      });
    }
  }
  return out;
}
