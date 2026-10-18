// Turn OSM features into candidate solar sites and score them.
import { makeProjector, polygonArea, polygonCentroid, bboxOf, distanceM } from './geo.js';
import { classify, estimateHeight, CATEGORY_LABEL } from './heights.js';

// Every number here is a demo assumption, editable in the UI and overridable
// from the Supabase `assumptions` table. Verify against TNB / SEDA / Suruhanjaya
// Tenaga sources before quoting them in the pitch.
export const DEFAULT_ASSUMPTIONS = {
  specificYield: 1350, // kWh per kWp per year, Klang Valley typical
  panelDensity: 0.18, // kWp per m2 of usable roof (incl. spacing)
  emissionFactor: 0.74, // kg CO2 per kWh: Suruhanjaya Tenaga GEF 2024, Peninsular Malaysia (provisional, Feb 2026)
  tariffResidential: 0.45, // RM/kWh avoided (effective)
  tariffCommercial: 0.5,
  tariffIndustrial: 0.42,
  exportRate: 0.2, // RM/kWh credited for exported energy
  capexSmall: 4000, // RM per kWp, systems < 50 kWp
  capexLarge: 2800, // RM per kWp, systems >= 50 kWp
  minKwp: 3,
  // Opportunity-score weights (relative, normalised to 100 %); the "Score weights" sliders.
  wGeneration: 40, // annual kWh (log scale)
  wSelfUse: 25, // share of the generation the building can use itself
  wPayback: 20, // simple payback
  wShading: 15 // unshaded fraction from the raycast
};

// Context figures for impact comparisons.
export const HOUSEHOLD_KWH_YR = 3000; // ~250 kWh/month per household
export const SDP_EXISTING_KWP = 603; // SDP's installed rooftop PV (2024 Sustainability Highlights)
// SDP's FY2021 Scope 1 + 2 footprint, the baseline of its 40 % cut by 2030: 25,150 t (Scope 1)
// + 15,957 t (Scope 2) = 41,107 tCO2e, externally assured (Sustainability Report FY2021).
// An Invest Malaysia 2023 deck quotes 14,743 tCO2e "operational carbon" for FY2021 on a
// narrower boundary; we use the assured Scope 1 + 2 total.
export const SDP_BASELINE_TCO2E = 41107;
export const SDP_TARGET_CUT = 0.4;

// Fraction of footprint usable for panels (setbacks, plant, pitch, orientation).
const USABLE_FRACTION = {
  residential: 0.45, apartments: 0.4, retail: 0.65, commercial: 0.6,
  industrial: 0.75, institutional: 0.55, canopy: 0.8, carpark: 0.55, utility: 0.5, unknown: 0.5
};
// Base-load intensity proxy (kWh per m2 of floor area per year). Malaysian sources where we
// found them; the rest are flagged assumptions (see docs/validation.md):
// - commercial 220: Pusat Tenaga Malaysia audit, most Malaysian offices at 200-250 (MS 1525
//   efficient benchmark 135)
// - residential 30 / apartments 40: ~350 kWh/month per household (TNB worked example; ~80 % of
//   households use < 600 kWh/month) over ~150 m2 landed / ~100 m2 apartment floor area
// - retail 280: assumption, above the 262 average of a 41-mall Nordic study given tropical cooling
// - industrial 250, institutional 100 (campus BEI < 135 per Energy Commission), unknown 80: assumptions
const DEMAND_INTENSITY = {
  residential: 30, apartments: 40, retail: 280, commercial: 220,
  industrial: 250, institutional: 100, canopy: 0, carpark: 0, utility: 0, unknown: 80
};
// Share of demand that happens in daylight (can be met directly by PV).
const DAYTIME_SHARE = {
  residential: 0.35, apartments: 0.35, retail: 0.7, commercial: 0.75,
  industrial: 0.75, institutional: 0.8, canopy: 0, carpark: 0, utility: 0, unknown: 0.5
};

export function buildSites(raw) {
  const all = [...raw.buildings, ...raw.parking];
  const lon0 = all.reduce((s, b) => s + b.polygon[0][0], 0) / all.length;
  const lat0 = all.reduce((s, b) => s + b.polygon[0][1], 0) / all.length;
  const proj = makeProjector(lon0, lat0);

  // Features from the solar-mapper pipeline (public/data/*.json with `pipeline: true`) arrive
  // already classified, with a modelled height and provenance; raw OSM features are
  // classified here from their tags.
  const make = (f, isCarpark) => {
    const xy = f.polygon.map(proj.toXY);
    const area = f.footprintM2 ?? polygonArea(xy);
    const category = isCarpark ? 'carpark' : f.category ?? classify(f.tags, area);
    const h = isCarpark
      ? { height: 4.5, levels: 0, heightSource: 'Proposed solar canopy', heightConfidence: 1 }
      : f.height != null
        ? { height: f.height, levels: f.levels, heightSource: f.heightSource, heightConfidence: f.heightConfidence }
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
      kind: f.kind ?? null,
      kindSource: f.kindSource ?? (f.tags.building && f.tags.building !== 'yes' ? 'OSM building tag' : 'OSM tags / size'),
      // Car parks found by the pipeline's vehicle detector carry tags.source = 'detected'.
      footprintSource: f.footprintSource ?? (f.tags.source === 'detected' ? 'AI-detected from imagery' : 'OpenStreetMap'),
      dataFlags: f.dataFlags ?? (f.tags.source === 'detected' ? ['detected_carpark'] : []),
      sdpAsset: !!f.sdpAsset, // owned and operated by SDP: counts toward its own Scope 2
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

// Sites that belong in rankings and totals: big enough, and not a utility's asset.
export const isViable = (s) => !s.flags.includes('Too small') && s.category !== 'utility';

export function scoreSites(sites, a) {
  for (const s of sites) {
    const shading = s.shading ?? 1;
    const usable = s.area * USABLE_FRACTION[s.category];
    const kwp = usable * a.panelDensity;
    const kwh = kwp * a.specificYield * shading;
    const floorArea = s.area * Math.max(1, s.levels);
    const demand = floorArea * DEMAND_INTENSITY[s.category];
    const selfUse = Math.min(kwh, demand * DAYTIME_SHARE[s.category]);
    const exported = kwh - selfUse;
    const capex = kwp * (kwp >= 50 ? a.capexLarge : a.capexSmall);
    const savings = selfUse * tariffFor(s.category, a) + exported * a.exportRate;
    const payback = savings > 0 ? capex / savings : Infinity;
    const co2 = (kwh * a.emissionFactor) / 1000;

    const flags = [];
    if (kwp < a.minKwp) flags.push('Too small');
    if (shading < 0.75) flags.push('Heavy shading');
    if (s.tags.historic || /mosque|musalla|church|temple|religious/.test(s.tags.building || '') || s.tags.amenity === 'place_of_worship' || s.kind === 'religious')
      flags.push('Zoning / heritage review');
    if (s.category === 'apartments') flags.push('Strata approval needed');
    if (s.category === 'utility') flags.push('Utility asset (not SDP)');

    const genScore = clamp01((Math.log10(Math.max(kwh, 1)) - 3) / 4); // 1 MWh/yr -> 0, 10 GWh/yr -> 1
    const selfScore = kwh > 0 ? selfUse / kwh : 0;
    const payScore = clamp01((14 - payback) / 10);
    const wSum = a.wGeneration + a.wSelfUse + a.wPayback + a.wShading || 1;
    const score =
      (100 * (a.wGeneration * genScore + a.wSelfUse * selfScore + a.wPayback * payScore + a.wShading * shading)) / wSum *
      (flags.includes('Too small') || s.category === 'utility' ? 0.3 : flags.length ? 0.8 : 1);

    Object.assign(s, {
      usable, kwp, kwh, demand, selfUse, exported, capex, savings, payback, co2,
      selfRatio: selfScore, flags, score
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
  const ok = sites.filter(isViable);
  const sum = (k, list = ok) => list.reduce((t, s) => t + s[k], 0);
  const carparks = ok.filter((s) => s.category === 'carpark');
  return {
    count: ok.length,
    kwp: sum('kwp'),
    kwh: sum('kwh'),
    co2: sum('co2'),
    capex: sum('capex'),
    savings: sum('savings'),
    selfUse: sum('selfUse'),
    carparkKwp: sum('kwp', carparks)
  };
}

export function toCSV(sites) {
  const cols = [
    ['rank', (s, i) => i + 1], ['osm_id', (s) => s.id], ['name', (s) => s.name || ''],
    ['category', (s) => s.categoryLabel], ['longitude', (s) => s.position[0].toFixed(6)],
    ['latitude', (s) => s.position[1].toFixed(6)], ['footprint_m2', (s) => s.area.toFixed(0)],
    ['height_m', (s) => s.height.toFixed(1)], ['height_source', (s) => s.heightSource],
    ['height_confidence', (s) => (s.heightConfidence ?? '').toString()], ['footprint_source', (s) => s.footprintSource],
    ['unshaded_fraction', (s) => (s.shading ?? 1).toFixed(2)], ['system_kwp', (s) => s.kwp.toFixed(1)],
    ['annual_kwh', (s) => s.kwh.toFixed(0)], ['self_consumption', (s) => s.selfRatio.toFixed(2)],
    ['capex_rm', (s) => s.capex.toFixed(0)], ['annual_savings_rm', (s) => s.savings.toFixed(0)],
    ['payback_years', (s) => (Number.isFinite(s.payback) ? s.payback.toFixed(1) : '')],
    ['co2_tonnes_per_year', (s) => s.co2.toFixed(1)], ['score', (s) => s.score.toFixed(0)],
    ['flags', (s) => s.flags.join('; ')], ['data_flags', (s) => s.dataFlags.join('; ')],
    ['sdp_asset', (s) => (s.sdpAsset ? 'yes' : '')]
  ];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [cols.map((c) => c[0]).join(','), ...sites.map((s, i) => cols.map(([, f]) => esc(f(s, i))).join(','))].join('\n');
}
