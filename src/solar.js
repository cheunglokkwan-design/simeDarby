// Turn OSM features into candidate solar sites and score them.
import { makeProjector, polygonArea, polygonCentroid, bboxOf, distanceM, pointInPolygon } from './geo.js';
import { classify, estimateHeight, CATEGORY_LABEL } from './heights.js';
import { isAffordable } from './affordable.js';
import { roofCheck, ROOF_FLAGS, EXCLUDING_FLAGS } from './roof-checks.js';

// Every number here is a demo assumption, editable in the UI and overridable
// from the Supabase `assumptions` table. Verify against TNB / SEDA / Suruhanjaya
// Tenaga sources before quoting them in the pitch.
export const DEFAULT_ASSUMPTIONS = {
  specificYield: 1350, // kWh/kWp/yr fallback, used only if the pvlib yield file is missing
  panelDensity: 0.18, // kWp per m2 of usable roof (incl. spacing)
  panelWatt: 550, // W per module, for panel counts in exports and site briefs
  emissionFactor: 0.758, // kg CO2 per kWh, Peninsular Malaysia grid
  tariffResidential: 0.45, // RM/kWh avoided (effective, flat home tariff)
  // Businesses on medium-voltage tariffs also pay per-kW capacity and network
  // charges, which rooftop solar can't reliably cut (they are valued for batteries
  // instead). So business solar is credited at the energy charge only.
  tariffCommercial: 0.35, // RM/kWh energy charge (placeholder)
  tariffIndustrial: 0.3, // RM/kWh energy charge (placeholder)
  exportSMP: 0.3, // RM/kWh: ATAP (from 1 Jan 2026) pays exports at System Marginal Price, vendors quote 25-35 sen
  atapCapKw: 1000, // ATAP cap per non-domestic system (1 MW)
  homeCapKw: 15, // ATAP cap for domestic systems (5-15 kW band)
  loadFactor: 0.4, // peak kW = annual kWh / (8760 h x load factor); turns demand into a peak
  gridMaxM: 1000, // flag sites further than this from a mapped substation
  // CREAM (community renewable energy aggregation)
  accessCharge: 0.09, // RM/kWh TNB network access charge (cut from 15 to 9 sen, Sept 2025)
  creamDiscount: 0.1, // buyers pay the aggregator their grid tariff minus this share
  leasePerRoof: 300, // RM/yr paid to each homeowner (placeholder, not a quoted rate)
  creamRadiusKm: 5, // geographic screening radius only; CREAM uses connecting substation distance
  creamMinHomes: 15, // smallest cluster worth aggregating
  creamCapexPerKwp: 3000, // RM per kWp when one aggregator installs hundreds of roofs at once (placeholder)
  // Battery storage (verify charges against TNB's schedule before quoting)
  capacityCharge: 29.43, // RM per kW per month, medium voltage (secondary source)
  networkCharge: 59.84, // RM per kW per month, medium voltage (secondary source)
  batteryCapexPerKwh: 1800, // RM per kWh installed, LFP containerised (placeholder)
  capexSmall: 4000, // RM per kWp at 10 kWp and below (homes)
  capexLarge: 2800, // RM per kWp at 100 kWp and above; linear in between
  capexCarport: 4000, // RM per kWp for car-park canopies, including the steel structure
  omPctCapex: 0.012, // operation and maintenance per year, as a share of capex
  minKwp: 3,
  // Homes
  homeKwhMonth: 500, // household use per landed home (placeholder: check against real TNB bills)
  homeFootprintM2: 130, // typical terrace footprint, to count homes in row polygons
  exportCreditCap: 1, // 1 = export credits can't exceed the import bill (conservative until ATAP rule is confirmed)
  mortgageRate: 0.04, // for the "add solar to the mortgage" option
  mortgageYears: 25, // no longer than the panels' 25-year life
  paybackTarget: 7 // years: the "pays back fast" line in the headline funnel
};

// OSM often maps a whole terrace row as one polygon: count the homes in it.
export const homesIn = (s, a) => (s.category !== 'residential' ? 0 : s.area <= 400 ? 1 : Math.max(1, Math.round(s.area / a.homeFootprintM2)));

// Fraction of footprint usable for panels (setbacks, plant, pitch, orientation).
const USABLE_FRACTION = {
  residential: 0.45, apartments: 0.4, retail: 0.65, commercial: 0.6,
  industrial: 0.75, institutional: 0.55, canopy: 0.8, carpark: 0.55, unknown: 0.5
};
// Base-load intensity proxy (kWh per m2 of floor area per year).
const DEMAND_INTENSITY = {
  residential: 45, apartments: 50, retail: 280, commercial: 220,
  industrial: 250, institutional: 100, canopy: 0, carpark: 0, unknown: 80
};
// Share of demand that happens in daylight (can be met directly by PV).
export const DAYTIME_SHARE = {
  residential: 0.35, apartments: 0.35, retail: 0.7, commercial: 0.75,
  industrial: 0.75, institutional: 0.8, canopy: 0, carpark: 0, unknown: 0.5
};
// Most of the PV output a business can use itself, even when its annual
// daytime demand exceeds generation: panels also run on weekends and holidays
// when offices, schools and some factories are closed (base load ~30%), and
// midday output can overshoot load. Office: 5/7 working days + 2/7 x 0.3 ~ 0.8;
// factory, 6 days ~ 0.9; malls open daily ~ 0.95. Screening ceilings, not interval data.
export const ONSITE_CEILING = {
  residential: 1, apartments: 1, retail: 0.95, commercial: 0.8,
  industrial: 0.9, institutional: 0.75, canopy: 1, carpark: 1, unknown: 0.8
};
export const BUSINESS_CATEGORIES = ['retail', 'commercial', 'industrial', 'institutional'];

// Azimuths (deg from north) of the two roof faces perpendicular to the
// footprint's longest edge: a gable roof's two pitches, or east-west style
// racking on a flat roof aligned with the building.
function longEdgeNormals(xy) {
  let best = 0, bearing = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const dx = xy[i + 1][0] - xy[i][0], dy = xy[i + 1][1] - xy[i][1];
    const len = dx * dx + dy * dy;
    if (len > best) { best = len; bearing = (Math.atan2(dx, dy) * 180) / Math.PI; }
  }
  const n = (((bearing + 90) % 360) + 360) % 360;
  return [n, (n + 180) % 360];
}

function interpAzimuth(table, az, key) {
  const steps = Object.keys(table).map(Number).sort((x, y) => x - y);
  const step = 360 / steps.length;
  const i = Math.floor(az / step) % steps.length, f = (az - i * step) / step;
  const v0 = table[String(steps[i])][key], v1 = table[String(steps[(i + 1) % steps.length])][key];
  return v0 + (v1 - v0) * f;
}

// Specific yield for a roof from the pvlib table: 20 deg flush mount for
// pitched home roofs, 10 deg racking for everything else, averaged over both faces.
export function siteYield(s, yieldData, a) {
  if (!yieldData) return { p50: a.specificYield, p90: a.specificYield * 0.95, tilt: null };
  const tilt = s.category === 'residential' ? '20' : '10';
  const t = yieldData.yield[tilt];
  const [n1, n2] = s.roofNormals;
  const avg = (k) => (interpAzimuth(t, n1, k) + interpAzimuth(t, n2, k)) / 2;
  return { p50: avg('p50'), p90: avg('p90'), tilt: +tilt };
}

export function buildSites(raw) {
  const all = [...raw.buildings, ...raw.parking];
  const lon0 = all.reduce((s, b) => s + b.polygon[0][0], 0) / all.length;
  const lat0 = all.reduce((s, b) => s + b.polygon[0][1], 0) / all.length;
  const proj = makeProjector(lon0, lat0);

  const make = (f, isCarpark) => {
    const xy = f.polygon.map(proj.toXY);
    const area = polygonArea(xy);
    const category = isCarpark ? 'carpark' : classify(f.tags, area);
    const h = isCarpark
      ? { height: 4.5, levels: 0, heightSource: 'Proposed solar canopy' }
      : estimateHeight(f.tags, category, area);
    const c = polygonCentroid(xy);
    return {
      roofNormals: longEdgeNormals(xy),
      id: f.id,
      name: f.tags.name || null,
      tags: f.tags,
      polygon: f.polygon,
      xy, bbox: bboxOf(xy), centroid: c,
      position: proj.toLonLat(c),
      area, category, categoryLabel: CATEGORY_LABEL[category],
      ...h,
      shading: null
    };
  };
  const sites = [
    ...raw.buildings.map((b) => make(b, false)).filter((s) => s.area >= 15),
    ...raw.parking.map((p) => make(p, true)).filter((s) => s.area >= 200)
  ];

  // Grid check: straight-line distance to the nearest OSM-mapped substation.
  // With only a handful mapped (Bandar Bukit Raja has 2), distances say more
  // about missing OSM data than about the grid, so skip the check there.
  const mapped = raw.substations || [];
  const subs = mapped.length >= 5 ? mapped : [];
  for (const s of sites) {
    // Join separately mapped rooftop generators as well as tags on buildings.
    // Untagged point generators are not assumed to be rooftop installations.
    s.mappedSolar = (raw.solar || []).filter(generator => {
      if (generator.id === s.id || s.category === 'carpark') return false;
      const rooftop = /roof/.test(`${generator.tags?.location || ''} ${generator.tags?.['generator:place'] || ''}`);
      return pointInPolygon(...generator.position, s.polygon) && (rooftop || generator.polygon?.every(p => pointInPolygon(...p, s.polygon)));
    }).map(generator => generator.id);
    let best = null, bestD = Infinity;
    for (const sub of subs) {
      const d = distanceM(s.position, sub.position);
      if (d < bestD) { bestD = d; best = sub; }
    }
    s.gridDistM = best ? bestD : null;
    s.nearestSubstation = best ? best.name || best.id : null;
    s.affordable = isAffordable(s);
    s.roofCheck = roofCheck(s);
  }
  return { sites, origin: [lon0, lat0] };
}

// Installed cost per kWp: linear from capexSmall at 10 kWp to capexLarge at 100 kWp,
// so there is no price cliff; car-park canopies carry the cost of their structure.
export function capexPerKwp(s, kwp, a) {
  if (s.category === 'carpark') return a.capexCarport;
  const t = Math.max(0, Math.min(1, (kwp - 10) / 90));
  return a.capexSmall + (a.capexLarge - a.capexSmall) * t;
}

export const tariffFor = (cat, a) =>
  cat === 'industrial' ? a.tariffIndustrial
  : cat === 'residential' || cat === 'apartments' ? a.tariffResidential
  : a.tariffCommercial;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const GRID_FLAG = 'Far from mapped substation';

// ATAP caps each system: homes at 15 kW; other systems at 1 MW or their peak
// demand, whichever is lower. Car parks and canopies have no load of their
// own, so only the 1 MW cap applies to them.
export function atapCapKw(s, demand, a) {
  if (s.category === 'residential') return a.homeCapKw;
  if ((s.category === 'carpark' || s.category === 'canopy') && !s.evidence?.hostSiteId) return a.atapCapKw;
  const peakKw = s.evidence?.peakKw ?? demand / (8760 * a.loadFactor);
  return Math.min(a.atapCapKw, peakKw);
}

export function priorityBreakdown({ kwh, selfUse, payback, shading = 1, energyShading, flags = [] }) {
  shading = Number.isFinite(energyShading) ? energyShading : Number.isFinite(shading) ? shading : 1;
  const generation = clamp01((Math.log10(Math.max(kwh, 1)) - 3) / 4);
  const selfRatio = kwh > 0 ? selfUse / kwh : 0;
  const pay = clamp01((14 - payback) / 10);
  const scored = flags.filter(flag => flag !== GRID_FLAG);
  const multiplier = scored.some((f) => EXCLUDING_FLAGS.includes(f)) ? 0.3 : scored.length ? 0.8 : 1;
  const parts = [
    { label: 'Annual generation', points: 40 * generation, maximum: 40 },
    { label: 'Share used on site', points: 25 * selfRatio, maximum: 25 },
    { label: 'Modelled payback', points: 20 * pay, maximum: 20 },
    { label: 'Modelled sun exposure', points: 15 * shading, maximum: 15 }
  ];
  return { parts, multiplier, selfRatio, score: 100 * (0.4 * generation + 0.25 * selfRatio + 0.2 * pay + 0.15 * shading) * multiplier };
}

export function scoreSites(sites, a, yieldData = null) {
  const lifeYears = yieldData?.model.lifetimeYears ?? 25;
  const lifeFactor = yieldData?.lifetimeFactor ?? 0.94; // 0.5 %/yr degradation
  for (const s of sites) {
    const shading = Number.isFinite(s.layoutSun) ? s.layoutSun : Number.isFinite(s.shading) ? s.shading : 1;
    const evidence = s.evidence || {};
    const mappedCheck = roofCheck(s);
    const knownExcluded = mappedCheck && ['existing-solar', 'partial-solar', 'not-buildable'].includes(mappedCheck.status);
    // Unverified user notes cannot clear a known installed/unavailable roof.
    s.roofCheck = evidence.solarStatus && !knownExcluded ? { status: evidence.solarStatus, note: 'User-reported roof inspection; independent confirmation required', source: evidence.solarSource || 'User-provided inspection', date: evidence.solarDate || '' } : mappedCheck;
    const usable = (Math.min(s.area, evidence.usableM2 ?? s.area * USABLE_FRACTION[s.category])) * (s.roofCheck?.status === 'partial-solar' ? 0.5 : 1); // part of the roof already carries panels
    const homes = homesIn(s, a);
    // Homes: real household use, not floor area. Others: floor-area demand proxy.
    const occupiedStoreys = evidence.occupiedStoreys ?? Math.max(1, s.levels);
    const demand = evidence.annualKwh ?? (homes ? homes * a.homeKwhMonth * 12 : s.area * occupiedStoreys * DEMAND_INTENSITY[s.category]);
    const demandSource = evidence.annualKwh ? 'User-entered electricity use; source not independently verified' : s.category === 'carpark' || s.category === 'canopy' ? 'No host load linked; demand not established' : 'Category-based demand estimate';
    const y = siteYield(s, yieldData, a);
    const uncappedKwp = usable * a.panelDensity;
    // Homes are sized to cover their own yearly use, within ATAP's 15 kW per home.
    const homeSize = homes ? Math.min(a.homeCapKw * homes, demand / Math.max(1, y.p50 * shading)) : Infinity;
    const policyCap = atapCapKw(s, demand, a) * (homes || 1);
    // A generated draft has already been sized against the default home demand.
    // Use its actual module capacity when its improved exposure changes yield;
    // otherwise the financial system size could disagree with the drawn panels.
    const kwp = Math.min(uncappedKwp, policyCap, s.layoutKwCap != null ? Infinity : homeSize, s.layoutKwCap ?? Infinity);
    // A draft layout packed up to the cap lands within one module of it.
    const atapCapped = !homes && policyCap < uncappedKwp && kwp > policyCap - a.panelWatt / 1000 - 1e-6;
    // Which ATAP limit binds: the 1 MW system cap, or the building's modelled peak demand.
    const capKind = atapCapped ? (policyCap >= a.atapCapKw - 1e-6 ? 'system' : 'peak-demand') : null;
    const kwh = kwp * y.p50 * shading;
    const kwhP90 = kwp * y.p90 * shading;
    // A CREAM lease uses the whole roof (within ATAP's per-home cap), not just the household's own use.
    const roofKwp = homes ? Math.min(uncappedKwp, a.homeCapKw * homes) : kwp;
    const roofKwh = roofKwp * y.p50 * shading;
    const lifetimeKwh = kwh * lifeYears * lifeFactor;
    const hostRequired = s.category === 'carpark' || s.category === 'canopy';
    const hostLinked = hostRequired && !!evidence.hostSiteId && evidence.annualKwh > 0 && evidence.daytimeShare > 0 && evidence.hostTariff > 0;
    const economicsReady = !hostRequired || hostLinked;
    // Annual daytime demand alone would let a big building "use" 100% of its
    // output; the category ceiling keeps weekend and holiday generation as export.
    const onsiteCeiling = ONSITE_CEILING[s.category] ?? 1;
    const daytimeDemand = demand * (hostRequired ? (hostLinked ? evidence.daytimeShare : 0) : DAYTIME_SHARE[s.category]);
    const selfUse = Math.min(kwh * onsiteCeiling, daytimeDemand);
    const onsiteAtCeiling = onsiteCeiling < 1 && kwh > 0 && daytimeDemand >= kwh * onsiteCeiling;
    const exported = kwh - selfUse;
    const capex = kwp * capexPerKwp(s, kwp, a);
    const om = capex * a.omPctCapex;
    const tariff = hostLinked ? evidence.hostTariff : tariffFor(s.category, a);
    let exportValue = exported * a.exportSMP;
    // Conservative: export credits only offset the remaining bill (car parks feed their host building).
    if (a.exportCreditCap && demand > 0) exportValue = Math.min(exportValue, Math.max(0, demand - selfUse) * tariff);
    // An unlinked canopy is a physical screening candidate, not an export-only
    // investment recommendation. Keep energy/costs, withhold financial benefit.
    const savings = economicsReady ? selfUse * tariff + exportValue : null;
    const payback = savings > om ? capex / (savings - om) : Infinity;
    const co2 = (kwh * a.emissionFactor) / 1000;

    const flags = [];
    if (kwp < a.minKwp) flags.push('Too small');
    if (s.roofCheck && ROOF_FLAGS[s.roofCheck.status]) flags.push(ROOF_FLAGS[s.roofCheck.status]);
    if (shading < 0.75) flags.push('Heavy shading');
    if (s.tags.historic || /mosque|musalla|church|temple|religious/.test(s.tags.building || '') || s.tags.amenity === 'place_of_worship')
      flags.push('Zoning / heritage review');
    if (s.category === 'apartments') flags.push('Strata approval needed');
    // Shown but not scored: OSM substation coverage is patchy, so a missing
    // substation is often a data gap rather than a real grid constraint.
    if (s.gridDistM != null && s.gridDistM > a.gridMaxM) flags.push(GRID_FLAG);

    const { score, selfRatio: selfScore } = priorityBreakdown({ kwh, selfUse, payback, shading, flags });

    const excluded = flags.some((f) => EXCLUDING_FLAGS.includes(f));
    Object.assign(s, {
      usable, homes, roofKwp, roofKwh, kwp, kwh, demand, selfUse, exported, capex, om, savings, payback, co2,
      atapCapped, capKind, uncappedKwp, onsiteCeiling, onsiteAtCeiling, kwhP90, lifetimeKwh, specificYield: y.p50, yieldP90: y.p90, yieldTilt: y.tilt, economicsReady, hostLinked, energyShading: shading,
      selfRatio: selfScore, flags, score, excluded, occupiedStoreys, demandSource
    });
  }
  return sites;
}

// Ranking order. Scores compare at 0.1-point resolution. Roofs held to the
// same ATAP cap model near-identical output, so ties are broken by modelled
// sun exposure, then onsite share, then spare roof beyond the capped system
// (room to avoid obstacles and shade), not by footprint size or OSM id alone.
export function compareSites(a, b) {
  const r = (v, k) => Math.round((Number.isFinite(v) ? v : 0) * k);
  const headroom = (s) => (s.kwp > 0 && Number.isFinite(s.uncappedKwp) ? s.uncappedKwp / s.kwp : 1);
  return r(b.score, 10) - r(a.score, 10)
    || r(b.energyShading ?? b.shading ?? 1, 1000) - r(a.energyShading ?? a.shading ?? 1, 1000)
    || r(b.selfRatio, 1000) - r(a.selfRatio, 1000)
    || r(headroom(b), 100) - r(headroom(a), 100)
    || String(a.id).localeCompare(String(b.id));
}

export const rankSites = (sites) => sites.filter((s) => !s.excluded).sort(compareSites);

// The brief's test: compare our top N with the naive shortlist of the N largest
// business roofs by mapped footprint. Counts only what the roof checks recorded;
// unchecked roofs are reported as such, not assumed clear.
const UNAVAILABLE = ['existing-solar', 'partial-solar', 'not-buildable'];
export function largestRoofBaseline(sites, ranked, n = 10) {
  const biggest = sites.filter((s) => BUSINESS_CATEGORIES.includes(s.category))
    .sort((a, b) => b.area - a.area || String(a.id).localeCompare(String(b.id))).slice(0, n);
  const ours = ranked.slice(0, n);
  const ourIds = new Set(ours.map((s) => s.id));
  const excluded = biggest.filter((s) => UNAVAILABLE.includes(s.roofCheck?.status));
  return {
    n: biggest.length,
    biggest, ours, excluded,
    hasSolar: excluded.filter((s) => s.roofCheck.status !== 'not-buildable'),
    notBuildable: excluded.filter((s) => s.roofCheck.status === 'not-buildable'),
    overlap: biggest.filter((s) => ourIds.has(s.id)),
    unclear: biggest.filter((s) => s.roofCheck?.status === 'unclear'),
    unchecked: biggest.filter((s) => !s.roofCheck),
    imageryOnly: excluded.every((s) => /imagery/i.test(s.roofCheck.source || '')),
    examples: excluded.filter((s) => s.name).slice(0, 2)
  };
}

// Screening headline: viable roofs -> those with no mapped review flags
// -> those that pay back within the target. Impact figures use the last set.
const NEEDS_APPROVAL = ['Zoning / heritage review', 'Strata approval needed'];
export function funnel(sites, a) {
  const all = sites.filter((s) => !s.excluded);
  const noApproval = all.filter((s) => !s.flags.some((f) => NEEDS_APPROVAL.includes(f)));
  const fast = noApproval.filter((s) => s.payback <= a.paybackTarget && s.category !== 'unknown');
  const kwp = (list) => list.reduce((t, s) => t + s.kwp, 0);
  return { all: kwp(all), noApproval: kwp(noApproval), fast: kwp(fast), fastSites: fast, counts: [all.length, noApproval.length, fast.length] };
}

// Monthly repayment on a loan (annuity formula).
export const monthlyPayment = (principal, rate, years) => {
  const r = rate / 12, n = years * 12;
  return r ? (principal * r) / (1 - (1 + r) ** -n) : principal / n;
};

export function summarise(sites) {
  const ok = sites.filter((s) => !s.excluded);
  const sum = (k, list = ok) => list.reduce((t, s) => t + s[k], 0);
  const carparks = ok.filter((s) => s.category === 'carpark');
  return {
    count: ok.length,
    kwp: sum('kwp'),
    kwh: sum('kwh'),
    co2: sum('co2'),
    capex: sum('capex'),
    savings: sum('savings'),
    carparkKwp: sum('kwp', carparks)
  };
}

// Flat attribute record per site, shared by the GeoJSON, KML and registry exports.
export function siteProperties(s, a, rank = null) {
  const r = (v, d = 0) => (Number.isFinite(v) ? +v.toFixed(d) : null);
  return {
    ...(rank != null ? { rank } : {}),
    osm_id: s.id,
    name: s.name,
    category: s.categoryLabel,
    footprint_m2: r(s.area),
    height_m: r(s.height, 1),
    height_source: s.heightSource,
    usable_roof_m2: r(s.usable),
    unshaded_fraction: r(s.shading ?? 1, 2),
    energy_shadow_factor: r(s.energyShading ?? s.shading ?? 1, 2),
    system_kwp: r(s.kwp, 1),
    panels: Math.floor((s.kwp * 1000) / a.panelWatt),
    atap_capped: s.atapCapped,
    yield_p50_kwh_per_kwp: r(s.specificYield),
    yield_p90_kwh_per_kwp: r(s.yieldP90),
    annual_kwh_p50: r(s.kwh),
    annual_kwh_p90: r(s.kwhP90),
    lifetime_kwh_25yr: r(s.lifetimeKwh),
    self_consumption: r(s.selfRatio, 2),
    capex_rm: r(s.capex),
    annual_savings_rm: r(s.savings),
    payback_years: r(s.payback, 1),
    co2_tonnes_per_year: r(s.co2, 1),
    substation_distance_m: r(s.gridDistM),
    affordable_housing: !!s.affordable,
    score: r(s.score),
    flags: s.flags.join('; '),
    existing_solar_status: s.roofCheck?.status || 'unknown',
    existing_solar_note: s.roofCheck?.note || 'Not checked',
    existing_solar_source: s.roofCheck?.source || '',
    economics_status: s.economicsReady === false ? 'Host load and tariff required' : 'Illustrative scenario; inputs unverified',
    control_status: s.studyReview?.control || 'unknown',
    asset_id: s.studyReview?.assetId || '',
    study_stage: s.studyReview?.stage || 'screening',
    next_action: s.studyReview?.nextAction || '',
    responsible: s.studyReview?.responsible || '',
    study_reference: s.studyReview?.reference || ''
  };
}

export function toGeoJSON(sites, a) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: sites.map((s, i) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [s.polygon] },
      properties: siteProperties(s, a, i + 1)
    }))
  });
}

// KML with extruded footprints, so the shortlist opens in 3D in Google Earth.
export function toKML(sites, a, title = 'Solar shortlist') {
  const x = (v) => String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
  const marks = sites.map((s, i) => {
    const p = siteProperties(s, a, i + 1);
    const coords = s.polygon.map(([lon, lat]) => `${lon},${lat},${s.height.toFixed(1)}`).join(' ');
    const data = Object.entries(p).map(([k, v]) => `<Data name="${x(k)}"><value>${x(v)}</value></Data>`).join('');
    return `<Placemark><name>${x(`${i + 1}. ${s.name || s.categoryLabel}`)}</name><styleUrl>#site</styleUrl>
<description>${x(`${p.system_kwp} kWp, ${p.annual_kwh_p50} kWh/yr, payback ${p.payback_years} yr, score ${p.score}`)}</description>
<ExtendedData>${data}</ExtendedData>
<Polygon><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(title)}</name>
<Style id="site"><LineStyle><color>ff4ac9ff</color><width>1.5</width></LineStyle><PolyStyle><color>a04ac9ff</color></PolyStyle></Style>
${marks.join('\n')}
</Document></kml>`;
}

export function toCSV(sites) {
  const cols = [
    ['rank', (s, i) => i + 1], ['osm_id', (s) => s.id], ['name', (s) => s.name || ''],
    ['category', (s) => s.categoryLabel], ['longitude', (s) => s.position[0].toFixed(6)],
    ['latitude', (s) => s.position[1].toFixed(6)], ['footprint_m2', (s) => s.area.toFixed(0)],
    ['height_m', (s) => s.height.toFixed(1)], ['height_source', (s) => s.heightSource],
    ['unshaded_fraction', (s) => (s.shading ?? 1).toFixed(2)], ['system_kwp', (s) => s.kwp.toFixed(1)],
    ['atap_capped', (s) => (s.atapCapped ? 'yes' : 'no')],
    ['substation_distance_m', (s) => (s.gridDistM == null ? '' : s.gridDistM.toFixed(0))],
    ['nearest_substation', (s) => s.nearestSubstation || ''],
    ['specific_yield_p50', (s) => s.specificYield.toFixed(0)], ['specific_yield_p90', (s) => s.yieldP90.toFixed(0)],
    ['annual_kwh_p50', (s) => s.kwh.toFixed(0)], ['annual_kwh_p90', (s) => s.kwhP90.toFixed(0)],
    ['lifetime_kwh_25yr', (s) => s.lifetimeKwh.toFixed(0)], ['self_consumption', (s) => s.selfRatio.toFixed(2)],
    ['capex_rm', (s) => s.capex.toFixed(0)], ['annual_savings_rm', (s) => Number.isFinite(s.savings) ? s.savings.toFixed(0) : ''],
    ['payback_years', (s) => (Number.isFinite(s.payback) ? s.payback.toFixed(1) : '')],
    ['co2_tonnes_per_year', (s) => s.co2.toFixed(1)], ['score', (s) => s.score.toFixed(0)],
    ['flags', (s) => s.flags.join('; ')],
    ['existing_solar_status', s => s.roofCheck?.status || 'unknown'],
    ['existing_solar_note', s => s.roofCheck?.note || 'Not checked'],
    ['existing_solar_source', s => s.roofCheck?.source || ''],
    ['economics_status', s => s.economicsReady === false ? 'Host load and tariff required' : 'Illustrative scenario'],
    ['energy_shadow_factor', s => (s.energyShading ?? s.shading ?? 1).toFixed(2)]
  ];
  // Quote values with commas or quotes; neutralise text starting with = + - @ so OSM names can't run as spreadsheet formulas.
  const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) && Number.isNaN(Number(v)) ? `'${v}` : v);
  const esc = (v) => { v = safe(v); return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v; };
  return [cols.map((c) => c[0]).join(','), ...sites.map((s, i) => cols.map(([, f]) => esc(f(s, i))).join(','))].join('\n');
}
