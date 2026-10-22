import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { AmbientLight, LightingEffect, _SunLight as SunLight } from '@deck.gl/core';
import { PolygonLayer, SolidPolygonLayer, ScatterplotLayer, ArcLayer, TextLayer } from '@deck.gl/layers';

import { TOWNSHIPS } from './townships.js';
import { fetchOverpass } from './osm.js';
import { convexHull } from './geo.js';
import { DEFAULT_ASSUMPTIONS, GRID_FLAG, buildSites, scoreSites, summarise, funnel, monthlyPayment, toCSV, toGeoJSON, toKML } from './solar.js';
import { siteBriefHTML } from './brief.js';
import { planCream } from './cream.js';
import { planStorage } from './storage.js';
import { supabase, loadAssumptionOverrides, saveShortlist } from './supabase.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL; // '/' locally; a sub-path when hosted, e.g. on GitHub Pages
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TABS = ['find', 'share', 'store'];
const BUSINESS = new Set(['retail', 'commercial', 'industrial', 'institutional']);
const HOMES = new Set(['residential', 'apartments']);

const state = {
  township: 'ara-damansara',
  tab: 'share', // lead with SDP's community solar
  findFilter: 'business', // homes are tab 1's story; Find leads with businesses
  colorBy: 'score',
  raw: null,
  sites: [],
  ranked: [],
  cream: null,
  storage: [],
  zoneOf: new Map(),
  batteryOf: new Map(),
  buyerSet: new Set(),
  yieldData: null,
  storageData: null,
  scans: {}, // drone scans by OSM id, from public/splats/scans.json
  assumptions: { ...DEFAULT_ASSUMPTIONS },
  overrides: {},
  month: 2,
  hour: 15,
  shadows: true,
  satellite: false,
  selected: null,
  selectedZone: null,
  shadingReady: false,
  version: 0
};

// ---------- formatting ----------
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
const rm = (v) => (!Number.isFinite(v) ? '—' : v >= 1e6 ? `RM ${fmt(v / 1e6, 1)}M` : v >= 1e3 ? `RM ${fmt(v / 1e3, 0)}k` : `RM ${fmt(v, 0)}`);
const power = (kw) => (kw >= 1000 ? `${fmt(kw / 1000, 1)} MW` : `${fmt(kw, 0)} kW`);
const years = (y) => (Number.isFinite(y) ? `${fmt(y, 1)} yrs` : 'no payback');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const label = (s) => s.name || s.categoryLabel;
const zoneName = (c) => `Zone ${c.id.slice(1)}`;
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

// ---------- map ----------
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SATELLITE_STYLE = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
    }
  },
  layers: [{ id: 'esri', type: 'raster', source: 'esri' }]
};
const v0 = TOWNSHIPS[state.township].view;
const map = new maplibregl.Map({
  container: 'map',
  style: DARK_STYLE,
  center: [v0.longitude, v0.latitude],
  zoom: v0.zoom,
  pitch: v0.pitch,
  bearing: v0.bearing,
  maxPitch: 75,
  attributionControl: { compact: true }
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
const overlay = new MapboxOverlay({ interleaved: false, layers: [], getTooltip });
map.addControl(overlay);
let mapErrorShown = false;
map.on('error', (e) => {
  if (mapErrorShown) return;
  mapErrorShown = true;
  console.warn('Map error', e.error);
  setLoading('Some basemap tiles could not load (offline or blocked). The 3D buildings still work.');
  setTimeout(() => setLoading(null), 6000);
});

// ---------- colours ----------
const RAMP = [[60, 45, 95], [140, 50, 110], [220, 85, 70], [250, 165, 50], [255, 232, 115]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f));
}
const SUN_RAMP = (t) => [Math.round(40 + 215 * t), Math.round(70 + 180 * t), Math.round(150 + 90 * t)];
const NEUTRAL = [86, 92, 106];
const TOO_SMALL = [66, 68, 80];
const ZONE = [43, 159, 220];
const ZONE_SEL = [125, 205, 250];
const BUYER = [245, 245, 245];
const BATTERY = [255, 122, 60];
const SUBSTATION = [150, 110, 240];
const SELECTED = [255, 255, 255];
const rgb = (c) => `rgb(${c.join(',')})`;

function buildingColor(s) {
  if (state.selected === s) return SELECTED;
  if (state.tab === 'find') {
    if (!FILTERS[state.findFilter][1](s)) return NEUTRAL; // outside the chosen filter: dimmed
    if (s.flags.includes('Too small')) return TOO_SMALL;
    return state.colorBy === 'sun' ? SUN_RAMP(s.shading ?? 1) : ramp(s.score / 85);
  }
  if (state.tab === 'share') {
    const z = state.zoneOf.get(s);
    if (z) return z === state.selectedZone ? ZONE_SEL : ZONE;
    if (state.buyerSet.has(s)) return BUYER;
    return NEUTRAL;
  }
  return state.batteryOf.has(s) ? BATTERY : NEUTRAL;
}

// ---------- lighting ----------
function sunTimestamp() {
  const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60);
  return Date.UTC(2026, state.month, 21, h - 8, m); // Malaysia is UTC+8
}
// One lighting effect for the app's lifetime, updated in place: re-creating it
// (and its shadow passes) on every render made the sun animation stutter.
// Keep the shadow pass on: toggling deck.gl's experimental _shadow flag after
// the first render blanks every layer. Hide shadows with a transparent colour.
const sunLight = new SunLight({ timestamp: Date.now(), color: [255, 245, 225], intensity: 2.2, _shadow: true });
const lighting = new LightingEffect({ ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.0 }), sun: sunLight });
function lightingEffect() {
  sunLight.timestamp = sunTimestamp();
  lighting.shadowColor = [0, 0, 0, state.shadows && state.tab === 'find' ? 0.5 : 0];
  return lighting;
}

// ---------- layers: each tab shows only its own story ----------
const textDefaults = {
  characterSet: 'auto', fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600, sizeUnits: 'pixels', getSize: 12,
  getColor: [255, 255, 255], background: true, backgroundPadding: [6, 3], getTextAnchor: 'middle', getAlignmentBaseline: 'center', billboard: true,
  parameters: { depthCompare: 'always', depthWriteEnabled: false } // labels always on top of 3D buildings
};
const ON_TOP = { depthCompare: 'always', depthWriteEnabled: false };

function render() {
  if (!state.raw) return;
  const [s, w, n, e] = TOWNSHIPS[state.township].bbox;
  const pad = 0.01;
  const trig = [state.tab, state.colorBy, state.findFilter, state.selected?.id, state.selectedZone?.id, state.shadingReady, state.version];
  const buildings = state.sites.filter((x) => x.category !== 'carpark');

  const layers = [
    new SolidPolygonLayer({
      id: 'ground',
      data: [[[w - pad, s - pad], [e + pad, s - pad], [e + pad, n + pad], [w - pad, n + pad]]],
      getPolygon: (d) => d,
      getFillColor: [0, 0, 0, 0]
    }),
    new PolygonLayer({
      id: 'buildings',
      data: buildings,
      // Satellite view: flat outlines over the imagery so the real roof shows.
      extruded: !state.satellite,
      stroked: state.satellite,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => d.height,
      getFillColor: (d) => (state.satellite ? [...buildingColor(d), d === state.selected ? 0 : 60] : buildingColor(d)),
      getLineColor: (d) => (d === state.selected ? [255, 210, 0] : [255, 255, 255, 110]),
      getLineWidth: (d) => (d === state.selected ? 3 : 1),
      lineWidthUnits: 'pixels',
      material: { ambient: 0.35, diffuse: 0.6, shininess: 24, specularColor: [60, 64, 70] },
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 80],
      updateTriggers: { getFillColor: [...trig, state.satellite], getLineColor: trig, getLineWidth: trig }
    })
  ];

  if (state.tab === 'find') {
    layers.push(new PolygonLayer({
      id: 'carparks',
      data: state.sites.filter((x) => x.category === 'carpark'),
      extruded: !state.satellite,
      opacity: state.satellite ? 0.4 : 1,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => d.height,
      getFillColor: (d) => (state.selected === d ? [...SELECTED, 230] : [70, 210, 225, 170]),
      pickable: true,
      autoHighlight: true,
      updateTriggers: { getFillColor: trig }
    }));
  }

  if (state.tab === 'share' && state.cream) {
    // The blue homes already show the zones; only the selected zone gets an outline,
    // and only the biggest zones get labels, so the map stays readable.
    const zones = state.cream.clusters;
    const labelled = [...zones].sort((x, y) => y.homeCount - x.homeCount).slice(0, 8);
    if (state.selectedZone && !labelled.includes(state.selectedZone)) labelled.push(state.selectedZone);
    layers.push(
      new PolygonLayer({
        id: 'zones',
        data: state.selectedZone ? [state.selectedZone] : [],
        getPolygon: (c) => c.hull,
        filled: true,
        stroked: true,
        getFillColor: [...ZONE, 40],
        getLineColor: ZONE_SEL,
        lineWidthMinPixels: 2,
        pickable: true,
        updateTriggers: { getFillColor: trig, getLineColor: trig }
      }),
      new TextLayer({
        ...textDefaults,
        id: 'zone-labels',
        data: labelled,
        getPosition: (c) => [...c.position, 30],
        getText: (c) => `${zoneName(c)} · ${fmt(c.homeCount)} homes`,
        getBackgroundColor: (c) => (c === state.selectedZone ? [21, 94, 134, 240] : [21, 70, 100, 210]),
        updateTriggers: { getBackgroundColor: trig }
      })
    );
    if (state.selectedZone) {
      const buyers = state.selectedZone.buyers.slice(0, 8);
      layers.push(
        new ArcLayer({
          id: 'zone-buyers',
          data: buyers,
          getSourcePosition: () => [...state.selectedZone.position, 10],
          getTargetPosition: (b) => [...b.site.position, b.site.height + 2],
          getSourceColor: [...ZONE_SEL, 230],
          getTargetColor: [255, 255, 255, 230],
          getWidth: 3,
          getHeight: 0.35
        }),
        new TextLayer({
          ...textDefaults,
          id: 'buyer-labels',
          data: buyers.filter((b) => b.site.name).slice(0, 3), // named buyers only, to avoid clutter
          getPosition: (b) => [...b.site.position, b.site.height + 12],
          getText: (b) => `Buys power: ${label(b.site)}`,
          getSize: 11,
          getBackgroundColor: [30, 34, 44, 220]
        })
      );
    }
  }

  if (state.tab === 'store') {
    const pins = state.storage;
    layers.push(
      new ScatterplotLayer({
        id: 'substations',
        data: state.raw.substations || [],
        getPosition: (d) => [...d.position, 6],
        getRadius: 10,
        radiusMinPixels: 4,
        getFillColor: SUBSTATION,
        getLineColor: [255, 255, 255],
        stroked: true,
        lineWidthMinPixels: 1,
        pickable: true,
        parameters: ON_TOP
      }),
      new ScatterplotLayer({
        id: 'batteries',
        data: pins,
        getPosition: (b) => [...b.site.position, b.site.height + 4],
        getRadius: 16,
        radiusMinPixels: 7,
        getFillColor: (b) => (state.selected === b.site ? SELECTED : BATTERY),
        getLineColor: [255, 255, 255],
        stroked: true,
        lineWidthMinPixels: 2,
        pickable: true,
        parameters: ON_TOP,
        updateTriggers: { getFillColor: trig }
      }),
      new TextLayer({
        ...textDefaults,
        id: 'battery-labels',
        data: pins.slice(0, 8),
        getPosition: (b) => [...b.site.position, b.site.height + 18],
        getText: (b) => `${label(b.site)} · ${power(b.kw)} battery`,
        getBackgroundColor: [140, 55, 15, 225]
      })
    );
  }

  overlay.setProps({ layers, effects: [lightingEffect()], onClick });
}

function getTooltip({ object, layer }) {
  if (!object || !layer) return null;
  switch (layer.id) {
    case 'zones':
      return { text: `${zoneName(object)}: community solar\n${fmt(object.homeCount)} homes · ${power(object.kwp)} of solar\nClick for details` };
    case 'batteries':
      return { text: `${label(object.site)}\n${power(object.kw)} battery · cuts peak by ${power(object.peakCutKw)}\nSaves ${rm(object.value)}/yr` };
    case 'substations':
      return { text: `Electricity substation\n${object.name || 'unnamed'}` };
    case 'buildings':
    case 'carparks': {
      const s = object;
      if (state.tab === 'share') {
        const z = state.zoneOf.get(s);
        if (z) return { text: `Home in ${zoneName(z)} (community solar)` };
        if (state.buyerSet.has(s)) return { text: `${label(s)}\nBuys community solar from ${zoneName(state.selectedZone)}` };
        return null;
      }
      if (state.tab === 'store') {
        const b = state.batteryOf.get(s);
        return b ? { text: `${label(s)}\nBattery site · ${power(b.kw)}` } : null;
      }
      if (s.flags.includes('Too small')) return { text: `${label(s)}\nRoof too small for solar` };
      return { text: `${label(s)}\nScore ${fmt(s.score)}/100 · ${power(s.kwp)} · saves ${rm(s.savings)}/yr` };
    }
    default:
      return null;
  }
}

function onClick({ object, layer }) {
  if (!object || !layer) return;
  if (layer.id === 'zones') return selectZone(object, false);
  if (layer.id === 'batteries') return select(object.site, false);
  if (layer.id === 'buildings' || layer.id === 'carparks') {
    if (object.flags.includes('Too small')) return;
    // Share tab: a home opens its "your house" card and keeps its zone highlighted.
    if (state.tab === 'share' && state.zoneOf.get(object)) return select(object, false, state.zoneOf.get(object));
    select(object, false);
  }
}

// ---------- selection ----------
function select(site, fly, zone = null) {
  state.selected = site;
  state.selectedZone = zone;
  state.buyerSet = new Set(zone ? zone.buyers.map((b) => b.site) : []);
  if (fly) map.flyTo({ center: site.position, zoom: 17.3, pitch: 58, duration: 1400 });
  refreshUI();
}
function selectZone(zone, fly) {
  state.selectedZone = zone;
  state.selected = null;
  state.buyerSet = new Set(zone.buyers.map((b) => b.site));
  if (fly) map.flyTo({ center: zone.position, zoom: 15.6, pitch: 50, duration: 1400 });
  refreshUI();
}
function clearSelection() {
  state.selected = null;
  state.selectedZone = null;
  state.buyerSet = new Set();
  refreshUI();
}
function refreshUI() {
  renderPanel();
  renderCard();
  render();
}

// ---------- impact bar ----------
// Honest headline: figures are for the roofs that need no special approval and
// pay back within the target, not for every roof in the township.
function renderImpact() {
  const a = state.assumptions;
  const f = (state.funnel = funnel(state.sites, a));
  const k = summarise(f.fastSites);
  $('impact').innerHTML = `
    <div class="metric funnel" title="${fmt(f.all / 1000)} MWp on all viable roofs → ${fmt(f.noApproval / 1000)} MWp needing no special approval → ${fmt(f.fast / 1000)} MWp paying back within ${a.paybackTarget} years">
      <b>${fmt(f.fast / 1000)} MWp</b><span>ready to build: pays back ≤ ${a.paybackTarget} yrs, no special approval <span class="steps">(of ${fmt(f.all / 1000)} MWp possible)</span></span></div>
    <div class="metric"><b>${fmt(k.kwh / 1e6, 0)} GWh</b><span>clean power / yr</span></div>
    <div class="metric hero"><b>${fmt(k.co2 / 1000, 0)} kt CO₂</b><span>avoided / yr</span></div>
    <div class="metric"><b>${rm(k.savings)}</b><span>bill savings / yr</span></div>`;
}

// ---------- tab panels ----------
const FILTERS = {
  business: ['Businesses', (s) => BUSINESS.has(s.category)],
  carparks: ['Car parks', (s) => s.category === 'carpark'],
  homes: ['Homes', (s) => HOMES.has(s.category)],
  all: ['All', () => true]
};

function renderPanel() {
  if (!state.raw) return;
  const el = $('panel');
  if (state.tab === 'find') el.innerHTML = findPanel();
  else if (state.tab === 'share') el.innerHTML = sharePanel();
  else el.innerHTML = storePanel();
}

function findPanel() {
  const [, test] = FILTERS[state.findFilter];
  const list = state.ranked.filter(test).slice(0, 10);
  const viable = state.ranked.length;
  return `
    <h2>Best rooftops &amp; car parks</h2>
    <p class="lede">Every roof in ${esc(TOWNSHIPS[state.township].name)} scored on sun, size, how much power the building uses itself, and payback. ${fmt(viable)} roofs and car parks are big enough for solar.</p>
    <div class="chips" role="group" aria-label="Filter">${Object.entries(FILTERS)
      .map(([k, [name]]) => `<button class="chip" data-filter="${k}" aria-pressed="${k === state.findFilter}">${name}</button>`).join('')}</div>
    <ol class="list" data-list="sites">${list.map((s) => `
      <li tabindex="0" role="button" data-id="${esc(s.id)}" class="${state.selected === s ? 'sel' : ''}">
        <div><div class="t">${esc(label(s))}</div><div class="m">${power(s.kwp)}${s.atapCapped ? ' <abbr title="Capped by Solar ATAP at 1 MW or the building\'s peak demand">(ATAP cap)</abbr>' : ''} · saves ${rm(s.savings)}/yr · ${years(s.payback)}</div></div>
        <span class="pill" title="Opportunity score out of 100">${fmt(s.score)}</span>
      </li>`).join('')}</ol>
    <details class="more"><summary>More detail</summary><div class="body">
      <p><b>Colour roofs by</b></p>
      <div class="seg seg-inline" role="group">
        <button data-color="score" aria-pressed="${state.colorBy === 'score'}">Opportunity</button>
        <button data-color="sun" aria-pressed="${state.colorBy === 'sun'}">Sun exposure</button>
      </div>
      <p><b>How the score works:</b> 40% annual generation, 25% share used on site, 20% payback, 15% sun exposure (from a 3D shading simulation against neighbouring buildings). Sites needing zoning, heritage or strata approval are scored down by 20%.</p>
      <p><b>Policy built in:</b> systems are capped at 1 MW or the building's peak demand (15 kW for homes), and exported power is paid at the System Marginal Price under Solar ATAP (2026).</p>
      <p><b>Energy model:</b> pvlib with 19 years of hourly satellite weather data (PVGIS-ERA5). "Expected" is a typical year; "low-sun year" is the 1-in-10 dull year.</p>
    </div></details>`;
}

function sharePanel() {
  const { clusters, affordable, totals: t } = state.cream;
  const perHome = state.assumptions.leasePerRoof;
  const margin = clusters.reduce((s, c) => s + c.net, 0);
  const invest = clusters.reduce((s, c) => s + c.capex, 0);
  return `
    <h2>Community solar in SDP's own townships</h2>
    <p class="lede">SDP builds the homes, so it can make them solar homes: bundled into the mortgage for new buyers, or, for homes already sold, leased under CREAM with the power sold to businesses nearby over TNB's network. Click a zone, or any blue home, to see what one household gets.</p>
    <div class="stats">
      <div class="stat"><b>${fmt(t.homes)}</b><span>homes in ${t.clusters} zones</span></div>
      <div class="stat"><b>${rm(t.leaseIncome)}</b><span>to homeowners / yr</span></div>
      <div class="stat"><b>${years(margin > 0 ? invest / margin : Infinity)}</b><span>CREAM payback on ${rm(invest)}</span></div>
    </div>
    ${clusters.length ? `<ol class="list" data-list="zones">${clusters.slice(0, 10).map((c) => `
      <li tabindex="0" role="button" data-zone="${c.id}" class="${state.selectedZone === c ? 'sel' : ''}">
        <div><div class="t">${zoneName(c)} · ${fmt(c.homeCount)} homes</div><div class="m">${power(c.kwp)} · sells to ${plural(c.buyers.length, "business", "businesses")} nearby</div></div>
        <span class="pill zone">${power(c.kwp)}</span>
      </li>`).join('')}</ol>` : '<p class="empty">No housing estates large enough for a community-solar zone here.</p>'}
    <details class="more"><summary>More detail</summary><div class="body">
      <p><b>Affordable housing:</b> ${affordable.length
        ? `${affordable.length} affordable block(s) can earn ${rm(affordable.reduce((s, x) => s + x.leaseIncome, 0))}/yr in roof leases.`
        : 'no affordable-housing blocks are named in OpenStreetMap for this township. Known blocks can be added to the list in <code>src/affordable.js</code>.'}</p>
      <p><b>How a zone is formed:</b> landed homes grouped into ~550 m areas of at least ${state.assumptions.creamMinHomes} homes. Their power goes to businesses within ${state.assumptions.creamRadiusKm} km, using only the daytime demand those businesses can't cover from their own roofs.</p>
      <p><b>The money:</b> buyers pay ${fmt(state.assumptions.creamDiscount * 100)}% below their grid tariff; SDP (as aggregator) pays TNB's ${fmt(state.assumptions.accessCharge * 100)} sen/kWh access charge and RM ${fmt(perHome)}/yr per roof to each homeowner (placeholder lease). The SDP margin is after those costs, before paying back the panels.</p>
      <p><b>Still to confirm:</b> the SDP and GSPARX Elmina pilot details, and a real lease rate.</p>
    </div></details>`;
}

function storePanel() {
  const list = state.storage;
  if (!state.storageData) return '<h2>Battery storage</h2><p class="empty">No battery model results for this township yet.</p>';
  const kwh = list.reduce((t, b) => t + b.kwh, 0), cut = list.reduce((t, b) => t + b.peakCutKw, 0), value = list.reduce((t, b) => t + b.value, 0);
  // When do batteries pay? Median payback per building type, and the battery
  // price at which it would pay back within its ~10-year life.
  const KIND = { retail: 'Malls & shops', commercial: 'Offices & public', industrial: 'Factories' };
  const LIFE = 10;
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const byKind = Object.entries(KIND).map(([k, name]) => {
    const g = list.filter((b) => b.archetype === k);
    return g.length ? { name, n: g.length, payback: med(g.map((b) => b.payback)), breakEven: med(g.map((b) => (b.value * LIFE) / b.kwh)) } : null;
  }).filter(Boolean);
  const payTable = byKind.length ? `<table class="kv"><tr><td><b>Building type</b></td><td><b>Payback now · pays within ${LIFE} yrs below</b></td></tr>${byKind
    .map((r) => `<tr><td>${r.name} (${r.n})</td><td>${years(r.payback)} · RM ${fmt(r.breakEven)}/kWh</td></tr>`).join('')}</table>
    <p class="note">At today's assumed RM ${fmt(state.assumptions.batteryCapexPerKwh)}/kWh. Home batteries aren't modelled: on a flat home tariff there is no peak charge to save.</p>` : '';
  return `
    <h2>Battery storage</h2>
    <p class="lede">Batteries at malls, offices and factories cut the monthly peak demand that drives TNB's per-kW capacity and network charges.</p>
    <div class="stats">
      <div class="stat"><b>${list.length}</b><span>battery sites</span></div>
      <div class="stat"><b>${fmt(kwh / 1000, 1)} MWh</b><span>storage</span></div>
      <div class="stat"><b>${rm(value)}</b><span>savings / yr</span></div>
    </div>
    ${payTable ? `<details class="more" open><summary>When do batteries pay?</summary><div class="body">${payTable}</div></details>` : ''}
    ${list.length ? `<ol class="list" data-list="batteries">${list.slice(0, 10).map((b) => `
      <li tabindex="0" role="button" data-id="${esc(b.site.id)}" class="${state.selected === b.site ? 'sel' : ''}">
        <div><div class="t">${esc(label(b.site))}</div><div class="m">cuts peak by ${power(b.peakCutKw)} · saves ${rm(b.value)}/yr · ${years(b.payback)}</div></div>
        <span class="pill bat">${power(b.kw)}</span>
      </li>`).join('')}</ol>` : '<p class="empty">No sites with surplus solar and a large enough peak.</p>'}
    <details class="more"><summary>More detail</summary><div class="body">
      <p><b>Which sites:</b> businesses whose roofs exceed the Solar ATAP cap or their daytime demand, with a peak above 200 kW. Together they cut ${power(cut)} of monthly peaks.</p>
      <p><b>Sizing:</b> 4-hour lithium (LFP) batteries, dispatched for peak shaving with NREL's PySAM model on typical mall, office and factory load profiles; the size with the fastest payback is shown.</p>
      <p><b>Siting checks:</b> close to a substation; outdoor container with fire separation (NFPA 855 / Bomba); flood-prone ground and basements excluded (flood map still to add); placed in car-park corners or plant areas, never on panel roof space.</p>
      <p><b>Read as a scenario:</b> peak shaving alone pays slowly at today's assumed costs. Check TNB's per-kW charges before quoting.</p>
    </div></details>`;
}

$('panel').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (chip) { state.findFilter = chip.dataset.filter; return renderPanel(); }
  const color = e.target.closest('[data-color]');
  if (color) { state.colorBy = color.dataset.color; renderPanel(); renderLegend(); return render(); }
  const li = e.target.closest('li');
  if (!li) return;
  if (li.dataset.zone) return selectZone(state.cream.clusters.find((c) => c.id === li.dataset.zone), true);
  const site = state.sites.find((s) => s.id === li.dataset.id);
  if (site) select(site, true);
});

// List items are keyboard-operable: Enter or Space acts like a click.
$('panel').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li[role=button]')) { e.preventDefault(); e.target.click(); }
});

// ---------- site / zone card ----------
function fitBadge(s) {
  const scored = s.flags.filter((f) => f !== GRID_FLAG);
  if (scored.length) return `<span class="badge review">Needs review: ${esc(scored.join(', '))}</span>`;
  if (s.score >= 60) return '<span class="badge good">Good fit</span>';
  return '<span class="badge weak">Weaker fit</span>';
}
const kv = (rows) => `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;

function renderCard() {
  const el = $('card');
  document.body.classList.toggle('no-card', !state.selected && !state.selectedZone);
  if (!state.selected && !state.selectedZone) { el.hidden = true; return; }
  el.hidden = false;
  const s = state.selected;
  el.innerHTML = !s ? zoneCard(state.selectedZone) : s.homes ? houseCard(s) : siteCard(s);
  bindCard();
}

// "Your house": what one household gets from buying, financing or leasing.
function houseCard(s) {
  const a = state.assumptions;
  const n = s.homes || 1;
  const kwp = s.kwp / n, capex = s.capex / n, perMonth = s.savings / n / 12;
  const kwhMonth = s.kwh / n / 12;
  const loan = monthlyPayment(capex, a.mortgageRate, a.mortgageYears);
  const omMonth = (s.om || 0) / n / 12;
  const net = perMonth - omMonth - loan; // after the loan and maintenance
  const lease = a.leasePerRoof / 12;
  const zone = state.zoneOf.get(s);
  // SDP as CREAM aggregator, per leased roof: investment, yearly net after rent,
  // TNB access charges and O&M, and the install price that would give a 10-year payback.
  const sdp = zone && zone.homeCount ? zone.net / zone.homeCount : null;
  const sdpCapex = zone && zone.homeCount ? zone.capex / zone.homeCount : null;
  const life = state.yieldData?.lifetimeFactor ?? 0.94;
  const buy25 = (perMonth * 12 * life - omMonth * 12) * 25 - capex; // savings after upkeep, over 25 years
  return `
    <button class="x" data-act="close" aria-label="Close">×</button>
    <h3>Your house: solar options</h3>
    <div class="sub">${esc(s.categoryLabel)}${n > 1 ? ` · one of ${n} homes in this row` : ''} · ${esc(TOWNSHIPS[state.township].name)}${zone ? ` · ${zoneName(zone)}` : ''}</div>
    <p class="lede" style="margin:6px 0 10px">A ${fmt(kwp, 1)} kW system (${fmt((kwp * 1000) / a.panelWatt)} panels) makes about <b>${fmt(kwhMonth)} kWh a month</b>, sized to a home using ${fmt(a.homeKwhMonth)} kWh.</p>
    <div class="options">
      <div class="opt"><h4>Buy outright</h4>
        <b>${rm(perMonth)}</b><span>saved per month</span>
        <ul><li>${rm(capex)} upfront</li><li>Pays back in ${years(s.payback)}</li><li>${rm(buy25)} better off over 25 yrs</li></ul></div>
      <div class="opt best"><h4>Add to mortgage</h4>
        <b>${net >= 0 ? '+' : '−'}${rm(Math.abs(net))}</b><span>${net >= 0 ? 'better off' : 'worse off'} every month</span>
        <ul><li>RM 0 upfront; best for new SDP homes</li><li>+${rm(loan)}/mo on the loan (${fmt(a.mortgageRate * 100, 1)}%, ${a.mortgageYears} yrs) and ${rm(omMonth)}/mo upkeep</li><li>−${rm(perMonth)}/mo on the TNB bill</li></ul></div>
      <div class="opt"><h4>Lease the roof</h4>
        <b>${rm(lease)}</b><span>rent per month</span>
        <ul><li>RM 0 upfront, no maintenance</li><li>Bill unchanged</li><li>${zone ? `Power sold to ${plural(zone.buyers.length, "business", "businesses")} nearby` : 'Needs a community-solar zone nearby'}</li></ul></div>
    </div>
    ${sdp != null ? `<details><summary>What SDP gains</summary>${kv([
      ['New homes', 'sell them solar-ready: buyers are better off from day one'],
      ['Leasing existing roofs (CREAM)', `${rm(sdpCapex)} per roof, earns ${rm(sdp)}/yr after rent, TNB charges and upkeep`],
      ['CREAM payback', years(sdp > 0 ? sdpCapex / sdp : Infinity)],
      ['Pays back in 10 yrs if installed at', `≤ RM ${fmt(zone.targetPerKwp)}/kWp (assumed RM ${fmt(a.creamCapexPerKwp)})`]
    ])}<p class="note">Leasing pays slowly at these placeholder prices: the last row is the bulk price to negotiate with an aggregator. The RM ${fmt(a.leasePerRoof)}/yr rent is also a placeholder.</p></details>` : ''}
    <details><summary>Assumptions</summary><div class="body">
      <p>Household use ${fmt(a.homeKwhMonth)} kWh/month, home tariff ${fmt(a.tariffResidential * 100)} sen/kWh, ${fmt(a.capexSmall)} RM/kWp installed, exports paid at ATAP SMP ${fmt(a.exportSMP * 100)} sen/kWh${a.exportCreditCap ? ' and capped at the bill' : ''}, lease RM ${fmt(a.leasePerRoof)}/yr. All editable in ⚙ Settings; check against real TNB bills and installer quotes.</p>
    </div></details>
    <div class="actions">
      <button class="btn primary" data-act="quotes">Request installer quotes</button>
      <button class="btn" data-act="sat">Satellite view</button>
    </div>`;
}

function siteCard(s) {
  const b = state.batteryOf.get(s);
  const a = state.assumptions;
  const panels = Math.floor((s.kwp * 1000) / a.panelWatt);
  const openBattery = state.tab === 'store' && b;
  const scan = state.scans[s.id];
  return `
    <button class="x" data-act="close" aria-label="Close">×</button>
    <h3>${esc(label(s))}</h3>
    <div class="sub">${esc(s.categoryLabel)} · ${esc(TOWNSHIPS[state.township].name)}</div>
    ${fitBadge(s)}${scan ? '<span class="badge info">Drone-verified</span>' : ''}${s.affordable ? '<span class="badge info">Affordable housing</span>' : ''}${s.gridDistM != null && s.gridDistM > a.gridMaxM ? '<span class="badge weak" title="OSM substation coverage is incomplete">Substation not mapped nearby</span>' : ''}
    <div class="big4">
      <div><b>${power(s.kwp)}</b><span>system size · ${fmt(panels)} panels</span></div>
      <div><b>${rm(s.savings)}</b><span>saved per year</span></div>
      <div><b>${years(s.payback)}</b><span>payback</span></div>
      <div><b>${fmt(s.co2, 0)} t</b><span>CO₂ avoided per year</span></div>
    </div>
    <details ${openBattery ? '' : 'open'}><summary>Energy</summary>${kv([
      ['Expected output', `${fmt(s.kwh / 1000, 0)} MWh/yr`],
      ['<abbr title="A 1-in-10 dull year (P90)">Low-sun year</abbr>', `${fmt(s.kwhP90 / 1000, 0)} MWh/yr`],
      ['Over 25 years', `${fmt(s.lifetimeKwh / 1e6, 1)} GWh`],
      ['Sun exposure', `${fmt((s.shading ?? 1) * 100)}% <small>(3D shading)</small>`],
      ['Used on site', `${fmt(s.selfRatio * 100)}%`],
      ['Usable roof', `${fmt(s.usable)} m² of ${fmt(s.area)} m²`],
      ['Height', `${fmt(s.height, 0)} m <small>(${esc(s.heightSource.toLowerCase())})</small>`]
    ])}</details>
    <details><summary>Money</summary>${kv([
      ['Installation cost', rm(s.capex)],
      ['Savings per year', rm(s.savings)],
      ['Operation & maintenance', `${rm(s.om)}/yr`],
      ['Payback', years(s.payback)],
      ['Export price', `${fmt(a.exportSMP * 100)} sen/kWh <small>(ATAP SMP)</small>`],
      ...(s.atapCapped ? [['Size limit', 'capped by Solar ATAP (1 MW or peak demand)']] : [])
    ])}</details>
    <details><summary>Grid &amp; checks</summary>${kv([
      ['Nearest substation', s.gridDistM == null ? 'none mapped' : `${fmt(s.gridDistM)} m`],
      ['Engineering flags', s.flags.length ? esc(s.flags.join(', ')) : 'none'],
      ['Opportunity score', `${fmt(s.score)} / 100`]
    ])}</details>
    ${b ? `<details ${openBattery ? 'open' : ''}><summary>Battery option</summary>${kv([
      ['Battery', `${power(b.kw)} / ${fmt(b.kwh / 1000, 1)} MWh`],
      ['Cuts monthly peak by', `${power(b.peakCutKw)} of ${power(b.peakKw)}`],
      ['Saves', `${rm(b.value)}/yr`],
      ['Payback', years(b.payback)],
      ['Grid', esc(b.checks.grid)],
      ['Fire', esc(b.checks.fire)],
      ['Flood', esc(b.checks.flood)],
      ['Space', esc(b.checks.space)]
    ])}</details>` : ''}
    ${droneSection(s, scan)}
    <details><summary>Data sources</summary><div class="body">
      <p>Outline and type: <a href="https://www.openstreetmap.org/${esc(s.id)}" target="_blank" rel="noopener">OpenStreetMap ${esc(s.id)}</a>. Yield: ${esc(state.yieldData?.source || 'fallback assumption')}. Pre-feasibility only, not a bankable design.</p>
    </div></details>
    <div class="actions">
      <button class="btn primary" data-act="brief">Site brief (PDF)</button>
      <button class="btn" data-act="quotes">Request quotes</button>
      <button class="btn" data-act="sat">Satellite view</button>
      ${scan ? '<button class="btn" data-act="scan">View drone scan (3D)</button>' : ''}
    </div>`;
}

// Drone check: what a flight would confirm, or what a completed scan found.
const FINDING_LABELS = {
  roofType: 'Roof type', obstructions: 'Rooftop equipment', existingPanels: 'Existing solar panels',
  condition: 'Roof condition', heightCheck: 'Height vs our estimate', areaCheck: 'Usable area vs our estimate', notes: 'Notes'
};
function droneSection(s, scan) {
  if (scan) {
    const f = scan.findings || {};
    const rows = Object.entries(FINDING_LABELS).filter(([k]) => f[k] != null && f[k] !== '').map(([k, l]) => [l, esc(String(f[k]))]);
    return `<details open><summary>Drone check</summary>${kv([
      ['Scanned', esc([scan.captured, scan.source].filter(Boolean).join(' · ') || 'yes')],
      ...(rows.length ? rows : [['Findings', 'not recorded yet: use the viewer\'s Findings tab']])
    ])}</details>`;
  }
  if (!BUSINESS.has(s.category)) return '';
  const rank = state.ranked.indexOf(s) + 1;
  const near = TOWNSHIPS[state.township].nearAirport;
  return `<details><summary>Drone check</summary><div class="body">
    <p>${rank > 0 && rank <= 20 ? `<b>On the shortlist (#${rank}).</b> ` : ''}A 10-minute drone flight would confirm what this estimate assumes: roof pitch and height, water tanks and AC units, existing panels, and roof condition. The same photos give a measured 3D model (photogrammetry) and a 3D scan to show the owner.</p>
    <p><b>Before flying:</b> get the building owner's permission${near ? `, and a CAAM permit: ${esc(TOWNSHIPS[state.township].name)} is next to ${esc(near)}` : ' and check CAAM rules for the area'}.</p>
  </div></details>`;
}

function scanPayload(s) {
  const [cx, cy] = s.centroid;
  return {
    id: s.id, name: label(s), category: s.categoryLabel,
    footprint: s.xy.map(([x, y]) => [x - cx, y - cy]),
    height: s.height, heightSource: s.heightSource, area: s.area, usable: s.usable,
    kwp: s.kwp, panels: Math.floor((s.kwp * 1000) / state.assumptions.panelWatt),
    flags: s.flags, scan: state.scans[s.id]
  };
}
function openScan(s) {
  state.pendingScan = scanPayload(s);
  openModal(`Drone scan: ${label(s)}`, { src: `${BASE}splat.html?site=${encodeURIComponent(s.id)}` });
}
// The viewer asks for its site once it has loaded, so there is no race with page load.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== $('modalFrame').contentWindow || e.data?.type !== 'ready') return;
  e.source.postMessage({ type: 'site', site: state.pendingScan }, location.origin);
});

function zoneCard(c) {
  const a = state.assumptions;
  const sold = c.kwh ? c.matchedKwh / c.kwh : 0;
  return `
    <button class="x" data-act="close" aria-label="Close">×</button>
    <h3>${zoneName(c)}: community solar</h3>
    <div class="sub">${fmt(c.homeCount)} landed homes · ${esc(TOWNSHIPS[state.township].name)}</div>
    <span class="badge good">Buyers within ${a.creamRadiusKm} km</span>
    <div class="big4">
      <div><b>${power(c.kwp)}</b><span>rooftop solar</span></div>
      <div><b>${rm(c.leaseCost)}</b><span>to homeowners / yr</span></div>
      <div><b>${fmt(sold * 100)}%</b><span>sold to local businesses</span></div>
      <div><b>${fmt(c.co2, 0)} t</b><span>CO₂ avoided per year</span></div>
    </div>
    <details open><summary>Who buys the power</summary>${kv(c.buyers.slice(0, 6).map((b) => [esc(label(b.site)), `${fmt(b.kwh / 1000)} MWh/yr · ${fmt(b.dist / 1000, 1)} km`]))}</details>
    <details><summary>Money</summary>${kv([
      ['Energy sales (incl. surplus to grid)', rm(c.revenue)],
      ['Operation & maintenance', rm(c.om)],
      ['TNB access charge', rm(c.accessCost)],
      ['Homeowner leases', rm(c.leaseCost)],
      ['Installation cost', rm(c.capex)],
      ['Aggregator payback', years(c.payback)]
    ])}</details>
    <div class="actions"><button class="btn primary" data-act="home">See one home's options</button><button class="btn" data-act="sat-zone">Satellite view</button></div>`;
}

function bindCard() {
  $('card').querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'close') return clearSelection();
      if (act === 'brief') return openBrief(state.selected);
      if (act === 'sat') { setBasemap(true); return map.flyTo({ center: state.selected.position, zoom: 17.6, pitch: 0, bearing: 0, duration: 1400 }); }
      if (act === 'sat-zone') { setBasemap(true); return map.flyTo({ center: state.selectedZone.position, zoom: 16.2, pitch: 0, bearing: 0, duration: 1400 }); }
      if (act === 'scan') return openScan(state.selected);
      if (act === 'quotes') return openBrief(state.selected, true);
      if (act === 'home') {
        const z = state.selectedZone;
        return select(typicalHome(z), true, z);
      }
    };
  });
}

// A representative single home in a zone: the median-sized one.
function typicalHome(zone) {
  const singles = zone.homes.filter((h) => h.homes === 1);
  const pool = (singles.length ? singles : zone.homes).slice().sort((x, y) => x.kwp - y.kwp);
  return pool[Math.floor(pool.length / 2)];
}

// ---------- modal (site brief, 3D inspection) ----------
function openModal(title, { src, html }) {
  $('modalTitle').textContent = title;
  const f = $('modalFrame');
  if (html) { f.removeAttribute('src'); f.srcdoc = html; } else { f.removeAttribute('srcdoc'); f.src = src; }
  $('modal').hidden = false;
}
function closeModal() {
  $('modal').hidden = true;
  state.pendingScan = null;
  $('modalFrame').src = 'about:blank';
}
$('modalClose').onclick = closeModal;
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

function openBrief(s, quotes = false) {
  if (!s) return;
  openModal(`${quotes ? 'Request quotes' : 'Site brief'}: ${label(s)}`, {
    html: siteBriefHTML(s, {
      township: TOWNSHIPS[state.township].name,
      assumptions: state.assumptions,
      battery: state.batteryOf.get(s),
      yieldSource: state.yieldData?.source,
      quotes
    })
  });
}

// ---------- legend & basemap ----------
function renderLegend() {
  const sw = (c, text, dot = false) => `<div class="sw"><i class="${dot ? 'dot' : ''}" style="background:${rgb(c)}"></i>${text}</div>`;
  let html;
  if (state.tab === 'find') {
    html = state.colorBy === 'sun'
      ? `<b>Sun exposure</b><div class="bar" style="background:linear-gradient(90deg,${[0, 0.5, 1].map((t) => rgb(SUN_RAMP(t))).join(',')})"></div><div class="ends"><span>Shaded</span><span>Full sun</span></div>`
      : `<b>Solar opportunity</b><div class="bar" style="background:linear-gradient(90deg,${RAMP.map(rgb).join(',')})"></div><div class="ends"><span>Weaker roof</span><span>Best roof</span></div>`;
    html += sw([70, 210, 225], 'Car park (solar canopy)') + sw(TOO_SMALL, 'Too small for solar');
  } else if (state.tab === 'share') {
    html = '<b>Community solar</b>' + sw(ZONE, 'Homes in a solar zone') + sw(BUYER, 'Business buying the power (selected zone)') + sw(NEUTRAL, 'Other buildings');
  } else {
    html = '<b>Battery storage</b>' + sw(BATTERY, 'Recommended battery site', true) + sw(SUBSTATION, 'Electricity substation', true) + sw(NEUTRAL, 'Other buildings');
  }
  $('legend').innerHTML = html;
}

function setBasemap(sat) {
  if (state.satellite === sat) return;
  state.satellite = sat;
  map.setStyle(sat ? SATELLITE_STYLE : DARK_STYLE);
  $('basemap').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.b === 'sat') === sat)));
  render();
}
$('basemap').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setBasemap(b.dataset.b === 'sat');
});

// ---------- tabs ----------
function setTab(tab) {
  state.tab = tab;
  state.selectedZone = null;
  state.buyerSet = new Set();
  if (state.selected && tab === 'store' && !state.batteryOf.has(state.selected)) state.selected = null;
  if (state.selected && tab === 'share') state.selected = null;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('sun').hidden = tab !== 'find';
  if (tab !== 'find') stopAnim();
  renderLegend();
  refreshUI();
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// ---------- settings drawer ----------
const SETTINGS = [
  ['Tariffs & policy', {
    tariffResidential: 'Home tariff (RM/kWh)', tariffCommercial: 'Business energy charge (RM/kWh)', tariffIndustrial: 'Industrial energy charge (RM/kWh)',
    exportSMP: 'Export price, ATAP SMP (RM/kWh)', atapCapKw: 'ATAP cap, businesses (kW)', homeCapKw: 'ATAP cap, homes (kW)',
    emissionFactor: 'Grid emissions (kg CO₂/kWh)'
  }],
  ['Solar costs & technology', {
    capexSmall: 'Cost at 10 kWp and below (RM/kWp)', capexLarge: 'Cost at 100 kWp and above (RM/kWp)', capexCarport: 'Car-park canopy cost (RM/kWp)',
    omPctCapex: 'O&M per year (share of cost)', panelDensity: 'Panel density (kWp/m²)',
    panelWatt: 'Panel rating (W)', minKwp: 'Smallest viable system (kWp)', loadFactor: 'Load factor (for peak kW)',
    specificYield: 'Fallback yield (kWh/kWp/yr)'
  }],
  ['Homes', {
    homeKwhMonth: 'Household use (kWh/month)', homeFootprintM2: 'Typical terrace footprint (m²)',
    exportCreditCap: 'Cap export credits at the bill (1 = yes)', mortgageRate: 'Mortgage rate (share, 0.04 = 4%)',
    mortgageYears: 'Mortgage term (years)', paybackTarget: 'Headline payback target (years)'
  }],
  ['Community solar (CREAM)', {
    accessCharge: 'TNB access charge (RM/kWh)', creamDiscount: 'Buyer discount (share)', leasePerRoof: 'Lease per home (RM/yr)',
    creamRadiusKm: 'Buyer radius (km)', creamMinHomes: 'Homes per zone, minimum', creamCapexPerKwp: 'Bulk install cost (RM/kWp)'
  }],
  ['Storage & grid', {
    capacityCharge: 'Capacity charge (RM/kW/month)', networkCharge: 'Network charge (RM/kW/month)',
    batteryCapexPerKwh: 'Battery cost (RM/kWh)', gridMaxM: 'Max. distance to substation (m)'
  }]
];
function renderSettings() {
  $('assumptions').innerHTML = SETTINGS.map(([group, fields]) => `<fieldset><legend>${group}</legend>${Object.entries(fields)
    .map(([k, l]) => `<label>${l}<input type="number" step="any" data-k="${k}" value="${state.assumptions[k]}"></label>`).join('')}</fieldset>`).join('');
}
$('assumptions').addEventListener('change', (e) => {
  const k = e.target.dataset.k, v = parseFloat(e.target.value);
  if (k && Number.isFinite(v)) { state.assumptions[k] = v; recompute(); }
});
$('reset').onclick = () => { state.assumptions = { ...DEFAULT_ASSUMPTIONS, ...state.overrides }; renderSettings(); recompute(); };
const toggleSettings = (open) => { $('settings').hidden = !open; };
$('settingsBtn').onclick = () => toggleSettings($('settings').hidden);
$('settingsClose').onclick = () => toggleSettings(false);

// ---------- export menu ----------
function download(ext, type, text) {
  const blob = new Blob([text], { type });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `solar-shortlist-${state.township}.${ext}` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const SHORTLIST = 100;
const toggleExport = (open) => { $('exportMenu').hidden = !open; $('exportBtn').setAttribute('aria-expanded', String(open)); };
$('exportBtn').onclick = (e) => { e.stopPropagation(); toggleExport($('exportMenu').hidden); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) toggleExport(false); });
$('exportMenu').addEventListener('click', async (e) => {
  const kind = e.target.closest('[data-export]')?.dataset.export;
  if (!kind) return;
  toggleExport(false);
  const top = state.ranked.slice(0, SHORTLIST);
  if (kind === 'csv') download('csv', 'text/csv', toCSV(state.ranked));
  if (kind === 'geojson') download('geojson', 'application/geo+json', toGeoJSON(top, state.assumptions));
  if (kind === 'kml') download('kml', 'application/vnd.google-earth.kml+xml', toKML(top, state.assumptions, `${TOWNSHIPS[state.township].name}: top ${SHORTLIST} solar sites`));
  if (kind === 'supabase') {
    try { await saveShortlist(state.township, state.ranked.slice(0, 50)); setStatus('Top 50 sites saved to Supabase.'); }
    catch (err) { setStatus(`Supabase save failed: ${err.message}`); }
  }
});

// ---------- sun controls (Find tab) ----------
function syncSun() {
  const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60);
  $('hourLabel').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  $('hour').value = state.hour;
  $('hour').style.setProperty('--p', `${((state.hour - 7) / 12) * 100}%`); // filled part of the track
}
$('month').innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
$('month').value = state.month;
$('month').onchange = (e) => { state.month = +e.target.value; render(); };
$('hour').oninput = (e) => { state.hour = +e.target.value; syncSun(); render(); };
$('shadows').onchange = (e) => { state.shadows = e.target.checked; render(); };
let anim = null;
function stopAnim() {
  if (!anim) return;
  cancelAnimationFrame(anim);
  anim = null;
  $('play').textContent = '▶';
}
$('play').onclick = () => {
  if (anim) { cancelAnimationFrame(anim); anim = null; $('play').textContent = '▶'; return; }
  $('play').textContent = '❚❚';
  const tick = () => {
    state.hour = state.hour >= 19 ? 7 : state.hour + 0.03;
    syncSun();
    render();
    anim = requestAnimationFrame(tick);
  };
  tick();
};

// ---------- story-mode tour ----------
function tourSteps() {
  // One story: residents and SDP both gain from solar homes.
  const t = TOWNSHIPS[state.township];
  const a = state.assumptions;
  const f = state.funnel || funnel(state.sites, a);
  const k = summarise(f.fastSites);
  const top = state.ranked.find((s) => !s.homes);
  const zone = state.cream?.clusters[0];
  const home = zone && typicalHome(zone);
  const bat = state.storage[0];
  const overview = () => map.flyTo({ center: [t.view.longitude, t.view.latitude], zoom: t.view.zoom, pitch: t.view.pitch, bearing: t.view.bearing, duration: 1800 });
  const steps = [];
  if (zone) steps.push({ text: `SDP builds the homes, so it can sell them as solar homes. In ${t.name}, ${fmt(state.cream.totals.homes)} landed homes in ${state.cream.totals.clusters} neighbourhood zones could carry ${power(state.cream.totals.kwp)} of rooftop solar.`, go: () => { setTab('share'); clearSelection(); overview(); } });
  if (home) {
    const n = home.homes || 1, save = home.savings / n / 12, om = (home.om || 0) / n / 12, loan = monthlyPayment(home.capex / n, a.mortgageRate, a.mortgageYears), net = save - om - loan;
    steps.push({ text: `One home: a ${fmt(home.kwp / n, 1)} kW system costs ${rm(home.capex / n)}. Bundled into the mortgage, the owner is ${rm(Math.abs(net))} a month ${net >= 0 ? 'better' : 'worse'} off from day one, after the loan and upkeep. Bought outright, it pays back in ${years(home.payback)}.`, go: () => { setTab('share'); select(home, true, zone); } });
  }
  if (zone) steps.push({ text: `For homes already sold, SDP can lease the roofs under CREAM. ${zoneName(zone)}'s ${fmt(zone.homeCount)} homes would sell their power to ${plural(zone.buyers.length, 'business', 'businesses')} within ${a.creamRadiusKm} km. At today's placeholder prices that pays back in ${years(zone.net > 0 ? zone.capex / zone.net : Infinity)}; installing at RM ${fmt(zone.targetPerKwp)}/kWp would bring it to 10 years.`, go: () => { setTab('share'); selectZone(zone, true); } });
  if (top) steps.push({ text: `Businesses too: ${label(top)} can host ${power(top.kwp)} of solar, saving ${rm(top.savings)} a year and paying back in ${years(top.payback)}.`, go: () => { setTab('find'); select(top, true); } });
  if (bat) steps.push({ text: `Batteries pay slowly today: at ${label(bat.site)}, a ${power(bat.kw)} battery cuts the monthly peak by ${power(bat.peakCutKw)} and pays back in ${years(bat.payback)}.`, go: () => { setTab('store'); select(bat.site, true); } });
  steps.push({ text: `The honest total for ${t.name}: ${fmt(f.fast / 1000)} MWp of business roofs ready to build now (paying back within ${a.paybackTarget} years, no special approval), avoiding ${fmt(k.co2 / 1000)} kt of CO₂ a year, plus ${power(state.cream?.totals.kwp || 0)} on solar homes. ${fmt(f.all / 1000)} MWp is possible on every viable roof.`, go: () => { setTab('share'); clearSelection(); overview(); } });
  return steps;
}
let tour = null;
function showTourStep(i) {
  tour.steps = tourSteps(); // fresh objects: shading may have finished since the tour started
  const steps = tour.steps;
  tour.i = i;
  steps[i].go();
  const el = $('tour');
  el.hidden = false;
  el.innerHTML = `<div class="step">Tour · ${i + 1} of ${steps.length}</div><p>${esc(steps[i].text)}</p>
    <div class="row"><button class="btn" data-t="exit">Exit</button>${i > 0 ? '<button class="btn" data-t="back">Back</button>' : ''}
    <button class="btn primary" data-t="next">${i === steps.length - 1 ? 'Finish' : 'Next'}</button></div>`;
}
function endTour() { tour = null; $('tour').hidden = true; }
$('tourBtn').onclick = () => { if (!state.raw) return; tour = { steps: tourSteps(), i: 0 }; showTourStep(0); };
$('tour').addEventListener('click', (e) => {
  const t = e.target.closest('[data-t]')?.dataset.t;
  if (!t || !tour) return;
  if (t === 'exit') return endTour();
  if (t === 'back') return showTourStep(Math.max(0, tour.i - 1));
  if (tour.i >= tour.steps.length - 1) return endTour();
  showTourStep(tour.i + 1);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('exportMenu').hidden) return toggleExport(false);
  if (!$('modal').hidden) return closeModal();
  if (!$('settings').hidden) return toggleSettings(false);
  if (tour) return endTour();
  if (state.selected || state.selectedZone) clearSelection();
});

// ---------- model ----------
function recompute() {
  scoreSites(state.sites, state.assumptions, state.yieldData);
  state.ranked = state.sites.filter((s) => !s.flags.includes('Too small')).sort((a, b) => b.score - a.score);
  state.cream = planCream(state.sites, state.assumptions);
  for (const c of state.cream.clusters) c.hull = convexHull(c.homes.flatMap((h) => h.polygon));
  state.zoneOf = new Map(state.cream.clusters.flatMap((c) => c.homes.map((h) => [h, c])));
  state.storage = planStorage(state.sites, state.assumptions, state.storageData);
  state.batteryOf = new Map(state.storage.map((b) => [b.site, b]));
  // Re-link the selection to the recomputed zone with the same id.
  if (state.selectedZone) {
    state.selectedZone = state.cream.clusters.find((c) => c.id === state.selectedZone.id) || null;
    state.buyerSet = new Set(state.selectedZone?.buyers.map((b) => b.site) || []);
  }
  state.version++;
  renderImpact();
  refreshUI();
}

function setStatus(t) { $('status').textContent = t; }
function loadFailed(err) {
  setLoading(`Could not load the township data (${err.message}). Check the connection and reload.`);
  setStatus(`Load failed: ${err.message}`);
}
function setLoading(t) { $('loading').hidden = !t; $('loading').textContent = t || ''; }

let worker;
function runShading() {
  worker?.terminate();
  state.shadingReady = false;
  setLoading('Simulating sun and shade on every roof…');
  worker = new Worker(new URL('./shading.worker.js', import.meta.url), { type: 'module' });
  const t0 = performance.now();
  const items = state.sites.map((s) => ({ xy: s.xy, bbox: s.bbox, height: s.height, centroid: s.centroid, skip: s.category === 'carpark' }));
  const [lon, lat] = state.origin;
  worker.onmessage = ({ data }) => {
    if (data.progress != null) setLoading(`Simulating sun and shade on every roof… ${Math.round(data.progress * 100)}%`);
    if (!data.done) return;
    data.result.forEach((v, i) => (state.sites[i].shading = state.sites[i].category === 'carpark' ? 0.95 : v));
    state.shadingReady = true;
    setLoading(null);
    setStatus(`${state.sites.length.toLocaleString()} sites · shading raycast ${((performance.now() - t0) / 1000).toFixed(1)} s · OSM snapshot ${state.raw.fetchedAt.slice(0, 10)} · ` +
      (state.yieldData ? `yield: ${state.yieldData.source}` : 'yield: fallback assumption'));
    recompute();
  };
  worker.onerror = (e) => { setLoading(null); setStatus(`Shading simulation failed: ${e.message}`); };
  worker.postMessage({ lat, lon, items });
}

let loadSeq = 0;
async function loadTownship(id, live = false) {
  const tok = ++loadSeq;
  stopAnim();
  state.township = id;
  state.selected = null;
  state.selectedZone = null;
  state.buyerSet = new Set();
  endTour();
  renderCard();
  const t = TOWNSHIPS[id];
  setLoading(live ? 'Fetching live data from OpenStreetMap…' : 'Loading township…');
  const optional = (name) => fetch(`${import.meta.env.BASE_URL}data/${name}-${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [raw, yieldData, storageData] = await Promise.all([
    live ? fetchOverpass(t.bbox) : fetch(`${import.meta.env.BASE_URL}data/${id}.json`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    optional('yield'),
    optional('storage')
  ]);
  if (tok !== loadSeq) return; // a newer township load started meanwhile
  Object.assign(state, { raw, yieldData, storageData });
  const { sites, origin } = buildSites(state.raw);
  state.sites = sites;
  state.origin = origin;
  recompute();
  map.flyTo({ center: [t.view.longitude, t.view.latitude], zoom: t.view.zoom, pitch: t.view.pitch, bearing: t.view.bearing, duration: 1200 });
  runShading();
}

async function init() {
  $('township').innerHTML = Object.entries(TOWNSHIPS).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');
  $('township').value = state.township;
  $('township').onchange = (e) => loadTownship(e.target.value).catch(loadFailed);
  $('refresh').onclick = () => loadTownship(state.township, true).catch(loadFailed);
  $('basemap').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.b === 'map')));
  syncSun();
  setTab(state.tab);
  renderSettings();
  state.scans = await fetch(`${import.meta.env.BASE_URL}splats/scans.json`).then((r) => (r.ok ? r.json() : {})).then((j) => j.scans || {}).catch(() => ({}));
  $('sampleScan').onclick = () => { state.pendingScan = null; openModal('3D viewer: sample scene', { src: `${BASE}splat.html?sample=1` }); };
  if (supabase) {
    document.querySelector('[data-export="supabase"]').hidden = false;
    try {
      state.overrides = (await loadAssumptionOverrides()) || {};
      Object.assign(state.assumptions, state.overrides);
      $('db').textContent = ' Assumptions loaded from Supabase.';
      renderSettings();
    } catch {
      $('db').textContent = ' Supabase connected (no assumptions table yet).';
    }
  }
  await loadTownship(state.township);
}

init().catch((err) => { setLoading(null); setStatus(`Error: ${err.message}`); });

if (import.meta.env.DEV) window.__app = { state, overlay, map }; // debugging hook, dev server only
