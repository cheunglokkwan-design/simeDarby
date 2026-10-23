// Digital twin catalogue: real-world constants for panel placement and yield.
// Owner: research agent. Plain ES module, constants only, no dependencies.
// Rationale and full citations: docs/twin-research.md.
//
// Conventions: lengths in metres, mass in kg, temperatures in °C.
// widthM = short edge, lengthM = long edge (portrait = long edge up-slope).
// tempCoeff = Pmax temperature coefficient per °C (fraction, negative).
// vocTempCoeff = Voc temperature coefficient per °C (fraction, negative).
// Electrical values are STC (1000 W/m², 25 °C cell, AM1.5). Values marked
// "approx" in `note` come from reseller listings or family datasheets and
// should be checked against the maker's current datasheet before quoting.

export const PANELS = [
  {
    id: 'longi-hm6-430',
    name: 'LONGi Hi-MO 6 Explorer LR5-54HTH-430M',
    maker: 'LONGi',
    widthM: 1.134, lengthM: 1.722, depthM: 0.030,
    watt: 430, weightKg: 20.8, efficiency: 0.220,
    tempCoeff: -0.0029, vocTempCoeff: -0.0023, noctC: 45,
    vocV: 39.13, vmpV: 32.94, iscA: 13.98, cells: 108,
    residential: true,
    note: '108 half-cut HPBC, 3.2 mm glass, Al frame. Mainstream residential size.',
    source: 'https://configurator.sun.store/en/product/longi-lr5-54hth-430m-black-frame-1500v-hi-mo-6-explorer-lr5-54hth-420-440m-2116',
  },
  {
    id: 'ja-db4-440',
    name: 'JA Solar DeepBlue 4.0 Pro JAM54D40-440/GB',
    maker: 'JA Solar',
    widthM: 1.134, lengthM: 1.762, depthM: 0.030,
    watt: 440, weightKg: 24.0, efficiency: 0.220,
    tempCoeff: -0.0029, vocTempCoeff: -0.0025, noctC: 45,
    vocV: 39.4, vmpV: 32.7, iscA: 14.1, cells: 108,
    residential: true,
    note: 'n-type TOPCon, bifacial glass-glass (2+2 mm), heavier. Electrical approx.',
    source: 'https://www.jasolar.com/ (DeepBlue 4.0 Pro 54-cell family datasheet)',
  },
  {
    id: 'trina-vsplus-445',
    name: 'Trina Vertex S+ TSM-445NEG9R.28',
    maker: 'Trina Solar',
    widthM: 1.134, lengthM: 1.762, depthM: 0.030,
    watt: 445, weightKg: 21.0, efficiency: 0.223,
    tempCoeff: -0.0030, vocTempCoeff: -0.0025, noctC: 43,
    vocV: 52.6, vmpV: 44.3, iscA: 10.7, cells: 144,
    residential: true,
    note: 'n-type TOPCon glass-glass, 210R cells (low current, higher voltage). Voc/Isc approx.',
    source: 'https://www.solartraders.com/de/products/module/trina-solar-tsm-445neg9r-28-bfr-evo2',
  },
  {
    id: 'google-generic-400',
    name: 'Generic 400 W (Google Solar API default panel)',
    maker: 'generic',
    widthM: 1.045, lengthM: 1.879, depthM: 0.035,
    watt: 400, weightKg: 22.0, efficiency: 0.204,
    tempCoeff: -0.0035, vocTempCoeff: -0.0028, noctC: 45,
    vocV: 41.0, vmpV: 34.0, iscA: 12.4, cells: 120,
    residential: true,
    note: 'Size/power match Google Solar API default (since 29 Apr 2024); weight and electrical assumed (older PERC-class).',
    source: 'https://developers.google.com/maps/documentation/solar/release-notes',
  },
  {
    id: 'jinko-tn-580',
    name: 'Jinko Tiger Neo JKM580N-72HL4-V',
    maker: 'JinkoSolar',
    widthM: 1.134, lengthM: 2.278, depthM: 0.030,
    watt: 580, weightKg: 28.0, efficiency: 0.2245,
    tempCoeff: -0.0029, vocTempCoeff: -0.0025, noctC: 45,
    vocV: 51.3, vmpV: 42.5, iscA: 14.3, cells: 144,
    residential: true,
    note: 'Large-format 144-cell; fewer clamps per kWp but 2.3 m long, 2-person lift, fits fewer tile courses. Electrical approx.',
    source: 'https://fvcomponentes.com/en/product/solar-panel-jinko-585w-tiger-neo-72hl4-v',
  },
  {
    id: 'longi-hm7-620',
    name: 'LONGi Hi-MO 7 LR7-72HGD-620M',
    maker: 'LONGi',
    widthM: 1.134, lengthM: 2.382, depthM: 0.030,
    watt: 620, weightKg: 33.5, efficiency: 0.230,
    tempCoeff: -0.0028, vocTempCoeff: -0.0023, noctC: 45,
    vocV: 52.66, vmpV: 44.55, iscA: 14.81, cells: 144,
    residential: false,
    note: 'C&I / utility bifacial glass-glass. On homes only for large flat slabs.',
    source: 'https://solarproof.com.au/products/LR7-72HGD-620MHi-MO7.php',
  },
  {
    id: 'trina-vn-700',
    name: 'Trina Vertex N TSM-700NEG21C.20',
    maker: 'Trina Solar',
    widthM: 1.303, lengthM: 2.384, depthM: 0.033,
    watt: 700, weightKg: 38.3, efficiency: 0.2253,
    tempCoeff: -0.0029, vocTempCoeff: -0.0025, noctC: 43,
    vocV: 48.6, vmpV: 40.5, iscA: 18.32, cells: 132,
    residential: false,
    note: 'Utility 210 mm format. Isc 18.3 A exceeds typical residential MPPT inputs (12.5-16 A). Do not default on homes.',
    source: 'https://sun.store/el/product/trina-tsm-neg21c.20-700-675-700-1500v-silver-frame-ts4-3907',
  },
];

export const DEFAULT_PANEL_ID = 'longi-hm6-430';

export const MOUNTING = {
  // Rail-mounted parallel to the roof plane (tile hooks or metal-deck L-feet).
  flush: {
    standoffM: 0.12,        // roof surface to module top; tile 0.10-0.15, metal deck 0.08-0.10
    standoffRangeM: [0.08, 0.15],
    gapM: 0.02,             // mid-clamp gap between modules in a row (18-25 mm typical)
    rowGapM: 0.02,          // gap between rows when both rows share rails/clamps
    endClampMarginM: 0.03,  // rail overhang beyond the end clamp
    clampZone: { centreFracFromEnd: 0.25, tolM: 0.05 }, // clamps at L/4 ± 50 mm on long frame (LONGi IM)
    railsPerRow: 2,         // rail spacing ≈ L/2 so clamps sit in the L/4 zone
    rackingKgM2: 3.0,       // rails + hooks + clamps, ~2-4 kg/m²
    edgeSetbackM: 0.4,      // from verges/rakes and hips (wind local-pressure zone, tile access)
    ridgeClearM: 0.5,       // below ridge (ridge capping, ventilation, access)
    eaveClearM: 0.4,        // above eave/gutter line (gutter access, eave wind uplift)
    valleyClearM: 0.3,      // either side of valleys (water channel)
    obstacleClearM: 0.3,    // around vents, skylights, chimneys, dormers
    fireStrict: { ridgeClearM: 0.9, pathwayM: 0.9 }, // IFC 1205 reference values (not law in MY)
    maxAboveRoofM: 0.20,    // plausibility: module top never more than this above roof plane
  },
  // Tilted racks on flat RC slabs (roof tilt < flatRoofMaxDeg).
  tilted: {
    flatRoofMaxDeg: 5,      // treat roof planes flatter than this as "flat"
    minTiltFlatDeg: 5,      // below ~5° dust and water pond on glass; frames trap dirt
    defaultTiltFlatDeg: 10, // MY practice 10°: self-cleaning, ~1-2% below optimum at 3°N
    maxTiltFlatDeg: 15,     // above this, yield drops and wind load grows at 3°N
    lowEdgeClearM: 0.15,    // low edge above slab (drainage, cleaning)
    gapM: 0.02,
    shadeFreeWindow: { date: '12-21', fromHour: 9, toHour: 15 }, // solar time
    maxGcr: 0.80,           // keep at least a narrow maintenance gap
    walkwayM: 0.6,          // between array blocks for maintenance
    rackingKgM2: 6.0,       // mechanically fixed aluminium rack
    ballastKgM2: [30, 60],  // ballasted racks, total system load range
    edgeSetbackM: 1.0,      // from parapet/slab edge (wind corner zone + safe access)
    obstacleClearM: 0.5,
  },
};

export const LOSSES = {
  // Multiplicative derates applied after POA irradiance and temperature model.
  soiling: 0.02,            // tropical rain washes; 2-4% at low tilt
  shadingFromModel: true,   // near-shading computed from occupancy raycasts, not a constant
  mismatch: 0.02,
  dcWiring: 0.015,
  acWiring: 0.005,
  lid: 0.01,                // n-type ~0.5-1%, p-type PERC 1-2%
  lowIrradiance: 0.01,
  inverterEff: 0.97,        // weighted (Euro/CEC) efficiency of residential string inverter
  availability: 0.99,
  degradationPerYear: 0.004, // n-type warranty ~0.4%/yr; Google Solar API uses 0.5%/yr
  // Thermal model parameters (Faiman: Tc = Ta + G / (U0 + U1*ws)).
  thermal: {
    tilted: { U0: 25.0, U1: 6.84 }, // Faiman 2008 open-rack fit (pvlib default)
    flush:  { U0: 20.0, U1: 5.0 },  // close-to-roof, ~100-150 mm air gap (assumed, ~PVsyst semi-integrated)
  },
  targetPR: [0.75, 0.82],
};

// Ara Damansara / Klang Valley, 3.11 N 101.58 E. NASA POWER climatology
// (community RE, 2001-2020 style long-term means), fetched 2026-10-23:
// https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DIFF,T2M&community=RE&longitude=101.58&latitude=3.11&format=JSON
// POWER is a ~0.5° satellite/reanalysis product; ground stations in KL often read
// 5-10% lower GHI (~1,600 kWh/m²/yr). Treat as upper-middle estimate.
export const CLIMATE_KL = {
  lat: 3.11, lon: 101.58, timezone: 8,
  source: 'NASA POWER climatology (ALLSKY_SFC_SW_DWN, ALLSKY_SFC_SW_DIFF, T2M, T2M_MAX, T2M_MIN, WS2M)',
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ghiKwhM2Day:  [4.626, 5.174, 5.273, 5.158, 4.992, 4.876, 4.788, 4.841, 4.698, 4.580, 4.393, 4.215],
  dhiKwhM2Day:  [2.512, 2.636, 2.717, 2.718, 2.613, 2.605, 2.625, 2.654, 2.667, 2.656, 2.583, 2.503],
  diffuseFraction: [0.543, 0.510, 0.515, 0.527, 0.523, 0.534, 0.548, 0.548, 0.568, 0.580, 0.588, 0.594],
  clearSkyGhiKwhM2Day: [6.423, 6.703, 6.905, 6.862, 6.617, 6.395, 6.475, 6.633, 6.650, 6.578, 6.463, 6.284],
  meanAmbientC: [24.72, 25.03, 25.75, 26.24, 26.27, 25.77, 25.33, 25.38, 25.41, 25.46, 25.31, 24.84],
  maxAmbientC:  [31.63, 33.46, 33.37, 33.92, 34.40, 34.15, 32.42, 33.09, 32.43, 32.74, 32.96, 31.92],
  minAmbientC:  [17.95, 17.21, 18.07, 20.05, 21.30, 20.88, 20.87, 21.15, 20.21, 21.03, 20.01, 18.49],
  windMS2m:     [0.90, 0.89, 0.74, 0.65, 0.71, 0.75, 0.80, 0.81, 0.79, 0.76, 0.71, 0.82],
  annualGhiKwhM2: 1753,     // 4.799 kWh/m²/day × 365.25
  annualDiffuseFraction: 0.547,
  designMinCellC: 15,       // for cold Voc string limit (record lows ~17 °C, margin)
  designMaxCellC: 75,       // for hot Vmp string minimum (flush roof, midday)
  basicWindSpeedMS: 33.5,   // MS 1553:2002 Amd 1 Peninsular zone I (zone II 32.5), 50-yr
};

// Malaysia Solar ATAP (from 1 Jan 2026, replaces NEM 3.0), SEDA:
// https://www.seda.gov.my/reportal/atap/
export const GRID_RULES_MY = {
  programme: 'Solar ATAP',
  domesticSinglePhaseMaxKw: 5,   // above needs Connection Confirmation Check (RM1,000)
  domesticThreePhaseMaxKw: 15,
  maxOfMaxDemand: 1.0,           // up to 100% of maximum demand
  tenureYears: 10,
  typicalDcAcRatio: [1.0, 1.3],
};
