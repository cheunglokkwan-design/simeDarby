// Turn OSM features into candidate solar sites and score them.
import { makeProjector, polygonArea, polygonCentroid, bboxOf, distanceM } from './geo.js';
import { classify, estimateHeight, CATEGORY_LABEL } from './heights.js';

// Every number here is a demo assumption, editable in the UI and overridable
// from the Supabase `assumptions` table. Verify against TNB / SEDA / Suruhanjaya
// Tenaga sources before quoting them in the pitch.
export const DEFAULT_ASSUMPTIONS = {
  specificYield: 1350, // kWh per kWp per year, Klang Valley typical
  panelDensity: 0.18, // kWp per m2 of usable roof (incl. spacing)
  emissionFactor: 0.758, // kg CO2 per kWh, Peninsular Malaysia grid
  tariffResidential: 0.45, // RM/kWh avoided (effective)
  tariffCommercial: 0.5,
  tariffIndustrial: 0.42,
  exportSMP: 0.3, // RM/kWh: ATAP (from 1 Jan 2026) pays exports at System Marginal Price, vendors quote 25-35 sen
  atapCapKw: 1000, // ATAP cap per non-domestic system (1 MW)
  homeCapKw: 15, // ATAP cap for domestic systems (5-15 kW band)
  loadFactor: 0.4, // peak kW = annual kWh / (8760 h x load factor); turns demand into a peak
  capexSmall: 4000, // RM per kWp, systems < 50 kWp
  capexLarge: 2800, // RM per kWp, systems >= 50 kWp
  minKwp: 3
};

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
const DAYTIME_SHARE = {
  residential: 0.35, apartments: 0.35, retail: 0.7, commercial: 0.75,
  industrial: 0.75, institutional: 0.8, canopy: 0, carpark: 0, unknown: 0.5
};

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
  return { sites, origin: [lon0, lat0] };
}

const tariffFor = (cat, a) =>
  cat === 'industrial' ? a.tariffIndustrial
  : cat === 'residential' || cat === 'apartments' ? a.tariffResidential
  : a.tariffCommercial;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ATAP caps each system: homes at 15 kW; other systems at 1 MW or their peak
// demand, whichever is lower. Car parks and canopies have no load of their
// own, so only the 1 MW cap applies to them.
export function atapCapKw(s, demand, a) {
  if (s.category === 'residential') return a.homeCapKw;
  if (s.category === 'carpark' || s.category === 'canopy') return a.atapCapKw;
  const peakKw = demand / (8760 * a.loadFactor);
  return Math.min(a.atapCapKw, peakKw);
}

export function scoreSites(sites, a) {
  for (const s of sites) {
    const shading = s.shading ?? 1;
    const usable = s.area * USABLE_FRACTION[s.category];
    const floorArea = s.area * Math.max(1, s.levels);
    const demand = floorArea * DEMAND_INTENSITY[s.category];
    const uncappedKwp = usable * a.panelDensity;
    const kwp = Math.min(uncappedKwp, atapCapKw(s, demand, a));
    const atapCapped = kwp < uncappedKwp;
    const kwh = kwp * a.specificYield * shading;
    const selfUse = Math.min(kwh, demand * DAYTIME_SHARE[s.category]);
    const exported = kwh - selfUse;
    const capex = kwp * (kwp >= 50 ? a.capexLarge : a.capexSmall);
    const savings = selfUse * tariffFor(s.category, a) + exported * a.exportSMP;
    const payback = savings > 0 ? capex / savings : Infinity;
    const co2 = (kwh * a.emissionFactor) / 1000;

    const flags = [];
    if (kwp < a.minKwp) flags.push('Too small');
    if (shading < 0.75) flags.push('Heavy shading');
    if (s.tags.historic || /mosque|musalla|church|temple|religious/.test(s.tags.building || '') || s.tags.amenity === 'place_of_worship')
      flags.push('Zoning / heritage review');
    if (s.category === 'apartments') flags.push('Strata approval needed');

    const genScore = clamp01((Math.log10(Math.max(kwh, 1)) - 3) / 4); // 1 MWh/yr -> 0, 10 GWh/yr -> 1
    const selfScore = kwh > 0 ? selfUse / kwh : 0;
    const payScore = clamp01((14 - payback) / 10);
    const score =
      100 * (0.4 * genScore + 0.25 * selfScore + 0.2 * payScore + 0.15 * shading) *
      (flags.includes('Too small') ? 0.3 : flags.length ? 0.8 : 1);

    Object.assign(s, {
      usable, kwp, kwh, demand, selfUse, exported, capex, savings, payback, co2,
      atapCapped, selfRatio: selfScore, flags, score
    });
  }
  return sites;
}

// Link community buildings (schools, clinics) to the nearest high-surplus
// commercial/industrial sites to propose energy-sharing micro-grids.
export function microGridLinks(sites, community, maxDistM = 1500, perSite = 2) {
  const donors = sites
    .filter((s) => s.exported > 20000 && !s.flags.includes('Too small'))
    .sort((a, b) => b.exported - a.exported)
    .slice(0, 150);
  const links = [];
  for (const c of community) {
    const near = donors
      .map((d) => ({ d, dist: distanceM(c.position, d.position) }))
      .filter((x) => x.dist <= maxDistM)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, perSite);
    for (const { d, dist } of near) links.push({ from: d.position, to: c.position, donor: d, community: c, dist });
  }
  return links;
}

export function summarise(sites) {
  const ok = sites.filter((s) => !s.flags.includes('Too small'));
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

export function toCSV(sites) {
  const cols = [
    ['rank', (s, i) => i + 1], ['osm_id', (s) => s.id], ['name', (s) => s.name || ''],
    ['category', (s) => s.categoryLabel], ['longitude', (s) => s.position[0].toFixed(6)],
    ['latitude', (s) => s.position[1].toFixed(6)], ['footprint_m2', (s) => s.area.toFixed(0)],
    ['height_m', (s) => s.height.toFixed(1)], ['height_source', (s) => s.heightSource],
    ['unshaded_fraction', (s) => (s.shading ?? 1).toFixed(2)], ['system_kwp', (s) => s.kwp.toFixed(1)],
    ['annual_kwh', (s) => s.kwh.toFixed(0)], ['self_consumption', (s) => s.selfRatio.toFixed(2)],
    ['capex_rm', (s) => s.capex.toFixed(0)], ['annual_savings_rm', (s) => s.savings.toFixed(0)],
    ['payback_years', (s) => (Number.isFinite(s.payback) ? s.payback.toFixed(1) : '')],
    ['co2_tonnes_per_year', (s) => s.co2.toFixed(1)], ['score', (s) => s.score.toFixed(0)],
    ['flags', (s) => s.flags.join('; ')]
  ];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [cols.map((c) => c[0]).join(','), ...sites.map((s, i) => cols.map(([, f]) => esc(f(s, i))).join(','))].join('\n');
}
