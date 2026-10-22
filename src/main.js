import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { AmbientLight, LightingEffect, _SunLight as SunLight } from '@deck.gl/core';
import { PolygonLayer, SolidPolygonLayer, ScatterplotLayer, ArcLayer, TextLayer } from '@deck.gl/layers';

import { TOWNSHIPS } from './townships.js';
import { fetchOverpass } from './osm.js';
import { convexHull, makeProjector } from './geo.js';
import { DEFAULT_ASSUMPTIONS, GRID_FLAG, buildSites, scoreSites, summarise, funnel, monthlyPayment, toCSV, toGeoJSON, toKML } from './solar.js';
import { siteBriefHTML } from './brief.js';
import { planCream } from './cream.js';
import { planStorage } from './storage.js';
import { supabase, loadAssumptionOverrides, saveShortlist } from './supabase.js';
import { localScanMetadata, getLocalScan, saveLocalScan, removeLocalScan, validateSplat } from './scans.js';
import { panelLayoutForSite } from './panels.js';
import { VIDEO_EXTENSIONS, droneHealth, uploadDroneVideo, droneJob, downloadDroneScan } from './drone.js';
import { siteAddress, searchSites } from './search.js';
import { loadEvidence, persistEvidence, validateEvidence } from './evidence.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL; // '/' locally; a sub-path when hosted, e.g. on GitHub Pages
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TABS = ['share', 'find', 'store'];
const BUSINESS = new Set(['retail', 'commercial', 'industrial', 'institutional']);
const HOMES = new Set(['residential', 'apartments']);

const state = {
  township: 'ara-damansara',
  tab: 'share',
  findFilter: 'business',
  query: '',
  findLimit: 8,
  siteView: 'potential',
  zoneLimit: 10,
  batteryLimit: 10,
  cardCollapsed: false,
  siteEvidence: loadEvidence(),
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
  scans: {},
  publishedScans: {},
  layouts: {},
  droneProcessor: null,
  droneJobs: loadPendingJobs(),
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
const label = (s) => s.name || siteAddress(s) || `${s.categoryLabel} · ${s.id}`;
const zoneName = (c) => `Zone ${c.number}`;
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
const RAMP = [[12, 105, 105], [0, 153, 123], [40, 201, 142], [104, 231, 159], [191, 255, 163]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f));
}
const SUN_RAMP = (t) => [Math.round(20 + 171 * t), Math.round(105 + 150 * t), Math.round(140 + 23 * t)];
const NEUTRAL = [86, 92, 106];
const TOO_SMALL = [66, 68, 80];
const ZONE = [43, 159, 220];
const ZONE_SEL = [125, 205, 250];
const BUYER = [245, 245, 245];
const BATTERY = [255, 122, 60];
const SUBSTATION = [150, 110, 240];
const SELECTED = [255, 83, 172];
const CARPARK = [76, 155, 255];
const rgb = (c) => `rgb(${c.join(',')})`;

function buildingColor(s) {
  if (state.selected === s) return SELECTED;
  if (state.tab === 'find') {
    if (!FILTERS[state.findFilter][1](s)) return NEUTRAL; // outside the chosen filter: dimmed
    if (s.flags.includes('Too small')) return TOO_SMALL;
    return state.colorBy === 'sun' ? SUN_RAMP(s.shading ?? 1) : ramp(s.score / 100);
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
  const trig = [state.tab, state.colorBy, state.findFilter, state.satellite, state.selected?.id, state.selectedZone?.id, state.shadingReady, state.version];
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
      getFillColor: (d) => (state.satellite ? [...buildingColor(d), d === state.selected ? 145 : 105] : buildingColor(d)),
      getLineColor: (d) => [...buildingColor(d), 235],
      getLineWidth: (d) => (d === state.selected ? 3 : 1),
      lineWidthUnits: 'pixels',
      material: { ambient: 0.35, diffuse: 0.6, shininess: 24, specularColor: [60, 64, 70] },
      pickable: true,
      autoHighlight: true,
      highlightColor: [...SELECTED, 130],
      updateTriggers: { getFillColor: [...trig, state.satellite], getLineColor: trig, getLineWidth: trig }
    })
  ];

  if (state.tab === 'find') {
    // A separate unlit roof surface stays legible over satellite imagery and
    // above the 3D massing, independently of the experimental shadow pass.
    const [, filter] = FILTERS[state.findFilter];
    layers.push(new PolygonLayer({
      id: 'roof-highlights',
      data: buildings.filter((site) => !site.flags.includes('Too small') && filter(site)),
      getPolygon: (d) => d.polygon.map(([lon, lat]) => [lon, lat, state.satellite ? 0.5 : d.height + 0.25]),
      getFillColor: (d) => [...buildingColor(d), state.satellite ? 140 : 210],
      getLineColor: (d) => [...buildingColor(d), 255],
      getLineWidth: (d) => d === state.selected ? 3 : 1.5,
      lineWidthUnits: 'pixels',
      stroked: true, filled: true, extruded: false,
      material: false, shadowEnabled: false, parameters: ON_TOP,
      pickable: true, autoHighlight: true, highlightColor: [...SELECTED, 130],
      updateTriggers: { getPolygon: [state.satellite], getFillColor: trig, getLineColor: trig, getLineWidth: trig }
    }));
    layers.push(new PolygonLayer({
      id: 'carparks',
      data: state.sites.filter((x) => x.category === 'carpark' && filter(x)),
      extruded: !state.satellite,
      stroked: true,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => d.height,
      getFillColor: (d) => [...(state.selected === d ? SELECTED : CARPARK), state.satellite ? 145 : 210],
      getLineColor: (d) => state.selected === d ? SELECTED : CARPARK,
      lineWidthMinPixels: 2,
      material: false, shadowEnabled: false,
      pickable: true,
      autoHighlight: true,
      highlightColor: [...SELECTED, 130],
      updateTriggers: { getFillColor: trig, getLineColor: trig }
    }));
  }

  if (state.tab === 'share' && state.cream) {
    // The blue homes already show the zones; only the selected zone gets an outline,
    // and only the biggest zones get labels, so the map stays readable.
    const zones = state.cream.clusters;
    const labelled = [...zones].sort((x, y) => y.homeCount - x.homeCount).slice(0, 8);
    if (state.selectedZone && !labelled.includes(state.selectedZone)) labelled.push(state.selectedZone);
    layers.splice(1, 0,
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
      })
    );
    layers.push(
      new TextLayer({
        ...textDefaults,
        id: 'zone-labels',
        data: labelled,
        getPosition: (c) => [...c.position, 30],
        getText: (c) => `${zoneName(c)} · ${fmt(c.homeCount)} homes`,
        getBackgroundColor: (c) => (c === state.selectedZone ? [21, 94, 134, 240] : [21, 70, 100, 210]),
        pickable: true,
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

  const layout = state.selected && (state.layouts[state.selected.id] || state.scans[state.selected.id]?.layout);
  if (layout?.panels?.length && state.tab === 'find') {
    const projection = makeProjector(...state.origin);
    const [cx, cy] = state.selected.centroid;
    const height = state.satellite ? .8 : state.selected.height + .5;
    layers.push(new PolygonLayer({
      id: 'solar-panel-layout', data: layout.panels,
      getPolygon: (panel) => panel.map(([x, y]) => [...projection.toLonLat([x + cx, y + cy]), height]),
      getFillColor: [24, 48, 91, 245], getLineColor: [174, 219, 255, 255],
      stroked: true, lineWidthMinPixels: .7, material: false, shadowEnabled: false, parameters: ON_TOP
    }));
  }
  overlay.setProps({ layers, effects: [lightingEffect()], onClick });
}

function getTooltip({ object, layer }) {
  if (!object || !layer) return null;
  switch (layer.id) {
    case 'zones':
    case 'zone-labels':
      return { text: `${zoneName(object)}: community solar\n${fmt(object.homeCount)} homes · ${power(object.kwp)} of solar\nClick for details` };
    case 'batteries':
      return { text: `${label(object.site)}\n${power(object.kw)} battery · cuts peak by ${power(object.peakCutKw)}\nSaves ${rm(object.value)}/yr` };
    case 'substations':
      return { text: `Electricity substation\n${object.name || 'unnamed'}` };
    case 'buildings':
    case 'roof-highlights':
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
  if (layer.id === 'zones' || layer.id === 'zone-labels') return selectZone(object, false);
  if (layer.id === 'batteries') return select(object.site, false);
  if (layer.id === 'buildings' || layer.id === 'roof-highlights' || layer.id === 'carparks') {
    // Share tab: a home opens its "your house" card and keeps its zone highlighted.
    if (state.tab === 'share' && state.zoneOf.get(object)) return select(object, false, state.zoneOf.get(object));
    select(object, false);
  }
}

// ---------- selection ----------
function select(site, fly, zone = null) {
  if (!site) return;
  state.siteView = 'potential';
  state.cardCollapsed = false;
  state.selected = site;
  state.selectedZone = zone;
  state.buyerSet = new Set(zone ? zone.buyers.map((b) => b.site) : []);
  if (fly) map.flyTo({ center: site.position, zoom: 17.3, pitch: 58, duration: 1400 });
  refreshUI();
  $('card').scrollTop = 0;
  $('card').querySelector('[aria-current="step"]')?.focus({ preventScroll: true });
}
function selectZone(zone, fly) {
  if (!zone) return;
  state.cardCollapsed = false;
  state.selectedZone = zone;
  state.selected = null;
  state.buyerSet = new Set(zone.buyers.map((b) => b.site));
  if (fly) map.flyTo({ center: zone.position, zoom: 15.6, pitch: 50, duration: 1400 });
  refreshUI();
  $('card').scrollTop = 0;
  $('card').querySelector('[data-act="close"]')?.focus({ preventScroll: true });
}
function clearSelection() {
  state.selected = null;
  state.selectedZone = null;
  state.buyerSet = new Set();
  refreshUI();
  $('panel').querySelector('.result-button')?.focus({ preventScroll: true });
}
function refreshUI() {
  renderPanel();
  renderCard();
  map.resize();
  render();
}

// ---------- impact bar ----------
// Screening headline: mapped flags do not establish ownership or permission.
// pay back within the target, not for every roof in the township.
function renderImpact() {
  const a = state.assumptions;
  const f = (state.funnel = funnel(state.sites, a));
  const k = summarise(f.fastSites);
  $('impact').innerHTML = `
    <details class="township-summary"><summary>Modelled mapped capacity <strong>${fmt(f.all / 1000, 1)} MWp</strong></summary><div class="impact-body"><p class="note">Current scenario, not surveyed capacity. Tariffs, demand and installation costs are assumptions. Field accuracy has not been measured.</p>
    <div class="metric"><b>${fmt(f.all / 1000, 1)} MWp</b><span>all mapped viable roofs</span></div>
    <div class="metric"><b>${fmt(f.noApproval / 1000, 1)} MWp</b><span>without mapped heritage / strata flags</span></div>
    <div class="metric"><b>${fmt(f.fast / 1000, 1)} MWp</b><span>subset with payback ≤ ${a.paybackTarget} years</span></div>
    <div class="metric"><b>${rm(k.savings)}</b><span>annual bill reduction for that subset</span></div>
    <p class="note">Mapped flags do not establish permission. Current values depend on the active assumptions and shading model.</p></div></details>`;
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
  const matches = searchSites(state.query.trim() ? [...state.sites].sort((a, b) => b.score - a.score) : state.ranked, state.query).filter(test);
  const list = matches.slice(0, state.findLimit);
  const viable = matches.length;
  return `
    <div class="panel-intro"><h2>Find a roof</h2><p class="lede">Search your property or start with a recommendation.</p></div>
    <label class="search-label sr-only" for="property-search">Find your property</label>
    <input id="property-search" type="search" value="${esc(state.query)}" placeholder="Search a building or street" aria-describedby="search-help" />
    <p class="note" id="search-help">You can also select a roof on the map.</p>
    <div class="chips" role="group" aria-label="Property type">${['all', 'business', 'homes', 'carparks'].map(k => `<button class="chip" data-filter="${k}" aria-pressed="${k === state.findFilter}">${FILTERS[k][0]}</button>`).join('')}</div>
    ${!state.query.trim() ? `<button class="btn primary start-button" data-start ${list.length ? '' : 'disabled'}>Open top recommendation <span aria-hidden="true">→</span></button>` : ''}
    <h3 class="list-heading">${state.query.trim() ? 'Search results' : 'Recommended properties'} <span>${fmt(viable)} ${state.query.trim() ? 'matches' : 'candidates'}</span></h3>
    <ol class="list" data-list="sites">${list.map((s) => `
      <li class="${state.selected === s ? 'sel' : ''}"><button type="button" class="result-button" data-id="${esc(s.id)}" aria-pressed="${state.selected === s}">
        <div><div class="t">${esc(label(s))}</div><div class="m">${power(s.kwp)}${s.atapCapped ? ' <abbr title="Capped by Solar ATAP at 1 MW or the building\'s peak demand">(ATAP cap)</abbr>' : ''} · saves ${rm(s.savings)}/yr · ${years(s.payback)}</div></div>
        <span class="pill" title="Opportunity score out of 100">${fmt(s.score)}</span>
      </button></li>`).join('')}</ol>
    ${!list.length ? '<p class="empty">No mapped properties match. Try part of a name, a street or the OSM ID, or choose another township.</p>' : ''}
    ${matches.length > list.length ? `<button class="btn more-results" data-more-results>More properties (${fmt(matches.length - list.length)} remaining)</button>` : ''}
    <details class="more"><summary>More detail</summary><div class="body">
      <p><b>Payback subset:</b> roofs with no mapped heritage or strata review flags and simple payback within ${state.assumptions.paybackTarget} years. Ownership, structure and utility permissions remain unchecked. Figures are screening estimates, not installer quotes.</p>
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

function exampleHome() {
  const homes = state.sites.filter(site => site.homes === 1 && !site.flags.includes('Too small')).sort((a, b) => a.area - b.area || a.id.localeCompare(b.id));
  return homes[Math.floor(homes.length / 2)];
}

function homeMonthly(s) {
  const n = s.homes || 1, a = state.assumptions;
  const bill = s.savings / n / 12;
  const loan = monthlyPayment(s.capex / n, a.mortgageRate, a.mortgageYears);
  const upkeep = (s.om || 0) / n / 12;
  return { bill, loan, upkeep, net: bill - loan - upkeep };
}

function homeCashflow(s) {
  const m = homeMonthly(s), a = state.assumptions;
  return `<div class="home-outcome ${m.net < 0 ? 'negative' : ''}"><strong>${m.net < 0 ? '−' : '+'}${rm(Math.abs(m.net))}<small>/ month</small></strong><p>${m.net >= 0 ? 'Modelled monthly benefit' : 'Modelled monthly shortfall'} after the solar loan and upkeep</p></div>
    <dl class="brief-summary"><div><dt>Bill reduction</dt><dd>+${rm(m.bill)}/mo</dd></div><div><dt>Added loan payment</dt><dd>−${rm(m.loan)}/mo</dd></div><div><dt>Assumed upkeep</dt><dd>−${rm(m.upkeep)}/mo</dd></div></dl>
    <p class="note">Illustrative full financing: ${fmt(a.mortgageRate * 100, 1)}% for ${a.mortgageYears} years. Demand, tariff and installation cost are assumptions, not a customer quote. Loan eligibility is unverified.</p>`;
}

function sharePanel() {
  const home = exampleHome();
  return `<div class="panel-intro"><h2>Solar-ready homes</h2><p class="lede">Include solar in a new-home purchase. See what the homeowner pays and saves each month.</p></div>
    ${home ? `${homeCashflow(home)}<button class="btn primary full-width" data-home-example>Explore this home <span aria-hidden="true">→</span></button><p class="note">Median-size mapped single-home example in ${esc(TOWNSHIPS[state.township].name)}. Ownership and SDP affiliation are unverified.</p>` : '<p class="empty">No mapped single-home example is available in this township.</p>'}
    <details class="more"><summary>Evidence &amp; current limits</summary><div class="body"><p>These are screening scenarios. No customer bill, installer quote or surveyed roof has validated this case. Current map coverage: Ara Damansara and Bandar Bukit Raja; Elmina is not included.</p><p>Drone reconstruction is optional and has not been demonstrated on a real hosted GPU run.</p></div></details>
    <details class="more" id="cream-support"><summary>Explore existing-roof leasing (CREAM)</summary><div class="body">${creamPanel()}</div></details>`;
}

function creamPanel() {
  const { clusters, affordable, totals: t } = state.cream;
  const perHome = state.assumptions.leasePerRoof;
  const margin = clusters.reduce((s, c) => s + c.net, 0);
  const invest = clusters.reduce((s, c) => s + c.capex, 0);
  return `
    <div class="panel-intro"><h2>Share power locally</h2><p class="lede">Group home roofs to supply nearby businesses.</p></div>
    <details class="zone-explainer"><summary>How do solar groups work?</summary><div class="body"><p>Blue roofs form a proposed group. Homeowners could earn roof rent; nearby businesses could buy the electricity.</p><p>Choose a group below to see buyers, costs and checks. Boundaries and grid connections still need approval.</p></div></details>
    <div class="stats">
      <div class="stat"><b>${fmt(t.homes)}</b><span>estimated homes · ${t.clusters} groups</span></div>
      <div class="stat"><b>${rm(t.leaseIncome)}</b><span>potential roof rent / yr</span></div>
      <div class="stat"><b>${years(margin > 0 ? invest / margin : Infinity)}</b><span>CREAM payback on ${rm(invest)}</span></div>
    </div>
    <h3 class="list-heading">Choose a proposed group <span>${clusters.length} groups</span></h3>
    ${clusters.length ? `<ol class="list" data-list="zones">${clusters.slice(0, state.zoneLimit).map((c) => `
      <li class="${state.selectedZone === c ? 'sel' : ''}"><button type="button" class="result-button" data-zone="${c.id}" aria-pressed="${state.selectedZone === c}">
        <div><div class="t">${zoneName(c)} · ~${fmt(c.homeCount)} homes</div><div class="m">${plural(c.buyers.length, 'potential buyer', 'potential buyers')} · ${fmt(c.kwh ? c.matchedKwh / c.kwh * 100 : 0)}% output matched</div></div>
        <span class="pill zone">${power(c.kwp)}</span>
      </button></li>`).join('')}</ol>` : '<p class="empty">No housing estates large enough for a community-solar zone here.</p>'}
    ${clusters.length > state.zoneLimit ? '<button class="btn more-results" data-more-zones>Show 10 more proposed groups</button>' : ''}
    <details class="more"><summary>More detail</summary><div class="body">
      <p><b>Affordable housing:</b> ${affordable.length
        ? `${affordable.length} affordable block(s) can earn ${rm(affordable.reduce((s, x) => s + x.leaseIncome, 0))}/yr in roof leases.`
        : 'no affordable-housing blocks are identified in the current mapped data.'}</p>
      <p><b>Grouping:</b> a roughly 550 m grid groups inferred home roofs, with at least ${state.assumptions.creamMinHomes} estimated homes per group. Boundaries may cross roads or estates and are not cadastral or feeder boundaries. Home counts can be estimated from terrace-row footprint area.</p>
      <p><b>Buyer matching:</b> a ${state.assumptions.creamRadiusKm} km straight-line search from each group centre screens potential buyers. Actual CREAM distance is between connecting utility substations, which this dataset does not establish. Lines show possible energy matches, not cable routes.</p>
      <p><b>Capacity:</b> CREAM plant and cumulative feeder limits require confirmed electrical connections. The model flags groups below 100 kWp or above 2 MWp; it cannot approve feeder capacity.</p>
      <p><b>The money:</b> buyers pay an assumed ${fmt(state.assumptions.creamDiscount * 100)}% below their category's tariff. Model costs include ${fmt(state.assumptions.accessCharge * 100)} sen/kWh access on matched power and RM ${fmt(perHome)}/yr rent per estimated home. Unmatched generation earns no assumed revenue. Annual matching does not establish hourly supply or settlement.</p>
      <p><b>Combined scenario:</b> ${years(margin > 0 ? invest / margin : Infinity)} payback on ${rm(invest)}. Ownership, landed-house eligibility, metering, power-system studies and contracts remain unverified.</p>
      <a href="https://www.st.gov.my/contents/2025/CREAM/CREAM%20FAQ_1%20_V2.pdf" target="_blank" rel="noopener">Energy Commission CREAM guidance</a>
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
    <div class="panel-intro"><h2>Reduce peak demand</h2><p class="lede">Compare battery scenarios for businesses.</p></div>
    <p class="note">Indicative gross benefits. Charging losses and ongoing costs are not fully included.</p>
    <div class="stats">
      <div class="stat"><b>${list.length}</b><span>battery sites</span></div>
      <div class="stat"><b>${fmt(kwh / 1000, 1)} MWh</b><span>storage</span></div>
      <div class="stat"><b>${rm(value)}</b><span>gross modelled benefit / yr</span></div>
    </div>
    ${payTable ? `<details class="more"><summary>When do batteries pay?</summary><div class="body">${payTable}</div></details>` : ''}
    ${list.length ? `<ol class="list" data-list="batteries">${list.slice(0, state.batteryLimit).map((b) => `
      <li class="${state.selected === b.site ? 'sel' : ''}"><button type="button" class="result-button" data-id="${esc(b.site.id)}" aria-pressed="${state.selected === b.site}">
        <div><div class="t">${esc(label(b.site))}</div><div class="m">cuts peak by ${power(b.peakCutKw)} · gross benefit ${rm(b.value)}/yr · indicative ${years(b.payback)}</div></div>
        <span class="pill bat">${power(b.kw)}</span>
      </button></li>`).join('')}</ol>` : '<p class="empty">No sites with surplus solar and a large enough peak.</p>'}
    ${list.length > state.batteryLimit ? '<button class="btn more-results" data-more-batteries>Show 10 more battery scenarios</button>' : ''}
    <details class="more"><summary>More detail</summary><div class="body">
      <p><b>Which sites:</b> businesses whose roofs exceed the Solar ATAP cap or their daytime demand, with a peak above 200 kW. Together they cut ${power(cut)} of monthly peaks.</p>
      <p><b>Sizing:</b> 4-hour lithium (LFP) batteries, dispatched for peak shaving with NREL's PySAM model on typical mall, office and factory load profiles; the size with the fastest payback is shown.</p>
      <p><b>Siting checks pending:</b> no flood, basement, fire-separation or usable-space assessment has been performed. Mapped substation distance is a location clue, not a confirmed electrical connection.</p>
      <p><b>Read as a scenario:</b> peak shaving alone pays slowly at today's assumed costs. Check TNB's per-kW charges before quoting.</p>
    </div></details>`;
}

$('panel').addEventListener('click', (e) => {
  if (e.target.closest('[data-home-example]')) return select(exampleHome(), true);
  for (const [selector, key, increment] of [['[data-more-results]', 'findLimit', 20], ['[data-more-zones]', 'zoneLimit', 10], ['[data-more-batteries]', 'batteryLimit', 10]]) {
    if (e.target.closest(selector)) {
      const scroll = $('panel').scrollTop, firstNew = state[key];
      state[key] += increment; renderPanel(); $('panel').scrollTop = scroll;
      $('panel').querySelectorAll('.result-button')[firstNew]?.focus({ preventScroll: true });
      return;
    }
  }
  if (e.target.closest('[data-start]')) {
    const [, test] = FILTERS[state.findFilter];
    const first = searchSites(state.query.trim() ? [...state.sites].sort((a, b) => b.score - a.score) : state.ranked, state.query).find(test);
    if (first) select(first, true);
    return;
  }
  const chip = e.target.closest('[data-filter]');
  if (chip) { state.findFilter = chip.dataset.filter; state.findLimit = 8; renderPanel(); return render(); }
  const color = e.target.closest('[data-color]');
  if (color) { state.colorBy = color.dataset.color; renderPanel(); renderLegend(); return render(); }
  const li = e.target.closest('[data-id], [data-zone]');
  if (!li) return;
  if (li.dataset.zone) return selectZone(state.cream.clusters.find((c) => c.id === li.dataset.zone), true);
  const site = state.sites.find((s) => s.id === li.dataset.id);
  if (site) select(site, true);
});
$('panel').addEventListener('input', (e) => {
  if (e.target.id !== 'property-search') return;
  const position = e.target.selectionStart;
  state.query = e.target.value;
  state.findLimit = 8;
  renderPanel();
  $('property-search').focus();
  $('property-search').setSelectionRange(position, position);
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
  const selected = state.selected || state.selectedZone;
  document.body.classList.toggle('no-card', !selected);
  document.body.classList.toggle('card-collapsed', !!selected && state.cardCollapsed);
  if (!selected) { el.hidden = true; return; }
  el.hidden = false;
  const s = state.selected;
  const title = s ? label(s) : `${zoneName(state.selectedZone)} · proposed group`;
  el.innerHTML = `<header class="selection-header"><button class="back-link" data-act="close">← ${state.tab === 'share' ? 'Solar homes' : state.tab === 'store' ? 'Battery sites' : 'All properties'}</button><button class="btn mobile-collapse" data-act="collapse-card" aria-expanded="${!state.cardCollapsed}" aria-controls="selection-body">${state.cardCollapsed ? 'Show details' : 'Minimise'}</button><div><b>${esc(title)}</b><small>${s ? esc(s.categoryLabel) : 'Ownership and grid checks pending'} · ${esc(TOWNSHIPS[state.township].name)}</small></div></header>
    <div id="selection-body" ${state.cardCollapsed ? 'hidden' : ''}>
      ${s ? `<nav class="project-steps" aria-label="Property workflow">${[['potential', 'Potential'], ['roof', 'Roof & panels'], ['brief', 'Brief']].map(([key, text], i) => `<button data-view="${key}" ${state.siteView === key ? 'aria-current="step"' : ''}><span>${i + 1}</span>${text}</button>`).join('')}</nav>
      ${state.siteView === 'roof' ? droneSection(s, state.scans[s.id]) : state.siteView === 'brief' ? briefStep(s) : siteCard(s)}` : zoneCard(state.selectedZone)}
    </div>`;
  el.querySelectorAll('[data-view]').forEach(button => button.onclick = () => setSiteView(button.dataset.view));
  bindCard();
}

function setSiteView(view) {
  state.siteView = view;
  state.cardCollapsed = false;
  renderCard();
  $('card').scrollTop = 0;
  $('card').querySelector('[aria-current="step"]')?.focus({ preventScroll: true });
}

function briefStep(s) {
  const layout = state.layouts[s.id] || state.scans[s.id]?.layout;
  return `<section class="workflow-section"><h3>Your solar brief</h3><p class="lede">Take this property estimate to an installer.</p>
    <dl class="brief-summary"><div><dt>Proposed system</dt><dd>${power(s.kwp)}</dd></div><div><dt>Estimated installation</dt><dd>${rm(s.capex)}</dd></div><div><dt>Bill reduction</dt><dd>${rm(s.savings)}/yr</dd></div><div><dt>Panel layout</dt><dd>${layout ? `${layout.count} panels · draft` : 'Not generated'}</dd></div></dl>
    <p class="note">Includes output, assumptions and mapped review flags. Roof structure, permissions and connection still need professional checks.</p>
    <button class="btn primary full-width" data-act="brief">Open printable brief</button><p class="note">Choose Save as PDF in the print window.</p>
    <div class="actions"><button class="btn" data-act="quotes">Prepare installer request</button>${layout ? '<button class="btn" data-act="export-layout">Download panel layout</button>' : '<button class="btn" data-act="add-scan">Plan panels first</button>'}</div>
  </section>`;
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
    <h4>Per-home options</h4>
    <div class="sub">${esc(s.categoryLabel)}${n > 1 ? ` · one of ${n} homes in this row` : ''} · ${esc(TOWNSHIPS[state.township].name)}${zone ? ` · ${zoneName(zone)}` : ''}</div>
    <p class="lede" style="margin:6px 0 10px">A ${fmt(kwp, 1)} kW system (${fmt((kwp * 1000) / a.panelWatt)} panels) makes about <b>${fmt(kwhMonth)} kWh a month</b>, sized to a home using ${fmt(a.homeKwhMonth)} kWh.</p>
    <div class="options">
      <div class="opt"><h4>Buy outright</h4>
        <b>${rm(perMonth)}</b><span>modelled bill reduction / month</span>
        <ul><li>${rm(capex)} upfront</li><li>Pays back in ${years(s.payback)}</li><li>${rm(buy25)} modelled balance over 25 yrs, after assumed upkeep</li></ul></div>
      <div class="opt"><h4>Finance: illustrative scenario</h4>
        <b>${net >= 0 ? '+' : '−'}${rm(Math.abs(net))}</b><span>${net >= 0 ? 'better off' : 'worse off'} every month</span>
        <ul><li>Assumes full financing</li><li>+${rm(loan)}/mo on the loan (${fmt(a.mortgageRate * 100, 1)}%, ${a.mortgageYears} yrs) and ${rm(omMonth)}/mo upkeep</li><li>−${rm(perMonth)}/mo on the TNB bill</li></ul></div>
      <div class="opt"><h4>Lease the roof</h4>
        <b>${rm(lease)}</b><span>rent per month</span>
        <ul><li>RM 0 upfront, no maintenance</li><li>Bill unchanged</li><li>${zone ? `Power sold to ${plural(zone.buyers.length, "business", "businesses")} nearby` : 'Needs a community-solar zone nearby'}</li></ul></div>
    </div>
    ${sdp != null ? `<details><summary>What SDP gains</summary>${kv([
      ['New homes', 'compare the loan, bill reduction and upkeep together'],
      ['Leasing existing roofs (CREAM)', `${rm(sdpCapex)} per roof, earns ${rm(sdp)}/yr after rent, TNB charges and upkeep`],
      ['CREAM payback', years(sdp > 0 ? sdpCapex / sdp : Infinity)],
      ['Pays back in 10 yrs if installed at', `≤ RM ${fmt(zone.targetPerKwp)}/kWp (assumed RM ${fmt(a.creamCapexPerKwp)})`]
    ])}<p class="note">Leasing pays slowly at these placeholder prices: the last row is the bulk price to negotiate with an aggregator. The RM ${fmt(a.leasePerRoof)}/yr rent is also a placeholder.</p></details>` : ''}
    <details><summary>Assumptions</summary><div class="body">
      <p>Household use ${fmt(a.homeKwhMonth)} kWh/month, home tariff ${fmt(a.tariffResidential * 100)} sen/kWh, ${fmt(a.capexSmall)} RM/kWp installed, exports paid at ATAP SMP ${fmt(a.exportSMP * 100)} sen/kWh${a.exportCreditCap ? ' and capped at the bill' : ''}, lease RM ${fmt(a.leasePerRoof)}/yr. All editable in ⚙ Settings; check against real TNB bills and installer quotes.</p>
    </div></details>
    `;
}

function siteCard(s) {
  const b = state.batteryOf.get(s), a = state.assumptions;
  const n = s.homes || 1;
  if (s.homes) return `<section class="workflow-section"><h3>The homeowner's monthly outcome</h3>${homeCashflow(s)}
    <button class="btn primary full-width" data-act="add-scan">Review roof &amp; plan panels <span aria-hidden="true">→</span></button>
    <details><summary>System &amp; installation</summary>${kv([['System per home', power(s.kwp / n)], ['Installation per home', rm(s.capex / n)], ['Mapped footprint', `${fmt(s.area)} m²`], ['Homes in this footprint', fmt(n)], ['Mapped property', esc(s.id)]])}<p class="note">Ownership, structure, permissions and grid connection remain unchecked.</p></details>
    <details><summary>Compare buying, financing &amp; leasing</summary>${houseCard(s)}</details>${evidenceSection(s)}</section>`;
  return `<section class="workflow-section"><h3>Solar potential</h3><p class="lede">${s.homes ? `Per home${n > 1 ? ` · ${n} estimated homes in this footprint` : ''}.` : 'An initial estimate for this property.'}</p>
    ${fitBadge(s)}
    <div class="big4">
      <div><b>${power(s.kwp / n)}</b><span>system ${s.homes ? '/ home' : 'size'}</span></div>
      <div><b>${rm(s.savings / n)}</b><span>bill reduction / year</span></div>
      <div><b>${rm(s.capex / n)}</b><span>estimated installation</span></div>
      <div><b>${years(s.payback)}</b><span>payback after assumed upkeep</span></div>
    </div>
    <button class="btn primary full-width" data-act="add-scan">Continue to roof &amp; panels <span aria-hidden="true">→</span></button>
    <p class="note">Based on mapped geometry and model assumptions. Inspect the roof to refine the proposal.</p>
    ${s.homes ? `<details><summary>Compare buying, financing &amp; leasing</summary>${houseCard(s)}</details>` : ''}
    ${b ? `<details ${state.tab === 'store' ? 'open' : ''}><summary>Battery scenario</summary>${kv([['Battery', `${power(b.kw)} / ${fmt(b.kwh / 1000, 1)} MWh`], ['Monthly peak reduction', power(b.peakCutKw)], ['Indicative gross benefit', `${rm(b.value)}/yr`], ['Indicative payback', years(b.payback)], ...Object.entries(b.checks).map(([k,v]) => [esc(k), esc(v)])])}<p class="note">Charging losses and ongoing costs are not fully included.</p></details>` : ''}
    <details><summary>Energy, costs &amp; checks</summary>${kv([
      ['Expected output', `${fmt(s.kwh / 1000)} MWh/yr`],
      ['P90 · weather variability only', `${fmt(s.kwhP90 / 1000)} MWh/yr`],
      ['CO₂ avoided', `${fmt(s.co2)} t/yr`],
      ['Annual upkeep', rm(s.om)],
      ['Demand estimate', `${fmt(s.demand)} kWh/yr`],
      ['Demand basis', esc(s.demandSource)],
      ['Occupied storeys', `${s.occupiedStoreys} · ${esc(s.levelsSource || 'assumed')}`],
      ['Usable roof', `${fmt(s.usable)} m² / ${fmt(s.area)} m²`],
      ['Height', `${fmt(s.height)} m · ${esc(s.heightSource)}`],
      ['Nearest mapped substation', s.gridDistM == null ? 'Not mapped' : `${fmt(s.gridDistM)} m`],
      ['Mapped flags', s.flags.length ? esc(s.flags.join(', ')) : 'None; engineering checks pending'],
      ['ATAP size limit', s.atapCapped ? 'System capped at 1 MW or peak demand' : 'Not currently limiting'],
      ['Export price assumption', `${fmt(a.exportSMP * 100)} sen/kWh`],
      ['Opportunity score', `${fmt(s.score)} / 100`]
    ])}<p class="note">Outline: <a href="https://www.openstreetmap.org/${esc(s.id)}" target="_blank" rel="noopener">${esc(s.id)}</a>. Yield: ${esc(state.yieldData?.source || 'fallback assumption')}. Survey, ownership and utility permissions remain unchecked.</p></details>
    ${evidenceSection(s)}
  </section>`;
}

// Drone check: what a flight would confirm, or what a completed scan found.
const FINDING_LABELS = {
  roofType: 'Roof type', obstructions: 'Rooftop equipment', existingPanels: 'Existing solar panels',
  condition: 'Roof condition', heightCheck: 'Height vs our estimate', areaCheck: 'Usable area vs our estimate', notes: 'Notes'
};
function droneSection(s, scan) {
  const job = state.droneJobs[s.id];
  const busy = job && !['failed', 'connection_lost'].includes(job.stage);
  const layout = state.layouts[s.id] || scan?.layout;
  const ready = state.droneProcessor?.ready;
  const ring = scanPayload(s).footprint;
  const xs = ring.map(point => point[0]), ys = ring.map(point => -point[1]);
  const roofOutline = `<svg aria-hidden="true" viewBox="${Math.min(...xs) - 3} ${Math.min(...ys) - 3} ${Math.max(...xs) - Math.min(...xs) + 6} ${Math.max(...ys) - Math.min(...ys) + 6}"><polygon points="${ring.map(([x, y]) => `${x},${-y}`).join(' ')}" fill="#dce9e3" stroke="currentColor" stroke-width=".4"/></svg>`;
  const findings = Object.entries(FINDING_LABELS).filter(([key]) => scan?.findings?.[key]).map(([key, title]) => [title, esc(scan.findings[key])]);
  return `<section id="drone-check" class="workflow-section"><h3>Plan this roof</h3><p class="lede">${layout ? 'Review the draft and mark areas to keep clear.' : 'Start with the mapped roof. Add a 3D scan to review it.'}</p>
    ${layout ? layoutPreview(s, layout) : `<div class="layout-empty">${roofOutline}<p>Turn this mapped footprint into a draft panel layout.</p><button class="btn primary full-width" type="button" data-act="layout">Generate draft layout</button><p class="note">Roof pitch, obstacles and dimensions need review.</p></div>`}
    ${layout ? '<button class="btn primary full-width" data-view="brief">Continue to brief <span aria-hidden="true">→</span></button>' : ''}
    ${job ? `<p class="job-state" role="status"><b>${esc(({ queued: 'Queued', camera_alignment: 'Reconstructing cameras', training: 'Building 3D scan', exporting: 'Preparing result', failed: 'Processing failed', connection_lost: 'Connection interrupted', downloading: 'Saving result' })[job.stage] || 'Processing')}</b><br>${esc(job.message || '')}</p>${job.stage === 'connection_lost' ? '<button class="btn" data-act="retry-job" type="button">Check job again</button>' : ''}` : ''}
    <details id="scan-upload" ${busy || scan ? 'open' : ''}><summary>${scan ? '3D scan & review' : ready ? 'Add drone footage or a 3D scan' : 'Add a finished 3D scan'}</summary><div class="body">
      ${scan ? `<p><b>${scan.reviewed ? 'Scan reviewed' : 'Scan ready for review'}</b> · ${esc(scan.filename || scan.source || 'Published scan')}</p><button class="btn" type="button" data-act="scan">Open roof in 3D</button>${kv(findings)}${scan.local ? '<button class="btn" type="button" data-act="remove-scan">Remove local scan</button>' : ''}` : ''}
      <p class="processor-note">${ready ? 'Footage is reconstructed on the connected GPU worker. Panel placement currently uses the mapped footprint.' : 'Video processing needs a connected GPU worker. Finished 3D scans can be imported now.'}</p>
      <form id="scan-import" class="scan-form">
        <label for="scan-file">${ready ? 'Drone video or Gaussian splat' : 'Gaussian splat file'}</label>
        <input id="scan-file" name="file" type="file" accept="${ready ? '.mp4,.mov,.m4v,.webm,' : ''}.ply,.splat,.ksplat" required aria-describedby="scan-file-help" ${busy ? 'disabled' : ''} />
        <p id="scan-file-help" class="note">${ready ? 'Video: up to 1 GB / 10 minutes. ' : ''}PLY, SPLAT or KSPLAT: up to 200 MB.</p>
        <details class="capture-details"><summary>Capture details (optional)</summary><div class="scan-fields"><div><label for="scan-date">Capture date</label><input id="scan-date" name="captured" type="date" /></div><div><label for="scan-source">Source</label><input id="scan-source" name="source" type="text" maxlength="160" placeholder="Drone or survey provider" /></div></div></details>
        <button class="btn" type="submit" ${busy ? 'disabled' : ''}>${ready ? 'Process footage / import scan' : 'Import finished scan'}</button>
        <p class="scan-status note" id="scan-status" role="status" aria-live="polite"></p>
      </form><p class="note">Saved on this device. Keep your original files.</p>
    </div></details>
    ${evidenceSection(s)}
    <details class="processing-help"><summary>What needs checking?</summary><div class="body"><p>The draft uses a flat mapped boundary, 0.6 m edge setback and assumed 1.134 × 2.278 m panels. It does not automatically extract roof planes or obstacles from footage.</p><p>Check scale, pitch, equipment, access and structure before installation. For reconstruction, record sharp, steady footage with overlapping views around the roof.</p></div></details>
    <button class="back-link" type="button" data-act="sat">Inspect satellite imagery</button>
  </section>`;
}

function layoutPreview(s, layout) {
  const ring = scanPayload(s).footprint;
  const xs = ring.map(p => p[0]), ys = ring.map(p => -p[1]);
  const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  const points = (polygon) => polygon.map(([px, py]) => `${px},${-py}`).join(' ');
  return `<section class="layout-preview" aria-label="Draft solar panel layout"><div class="layout-result"><b>${layout.count} panels</b><span>${fmt(layout.kwp, 1)} kWp · draft</span></div>
    <svg id="layout-drawing" viewBox="${x - 2} ${y - 2} ${width + 4} ${height + 4}" role="img" aria-label="Proposed panels inside the mapped roof footprint"><polygon points="${points(ring)}" fill="#eaf1ef" stroke="#68847c" stroke-width=".25" />${layout.panels.map((panel) => `<polygon points="${points(panel)}" fill="#18305b" stroke="#b0dbff" stroke-width=".08" />`).join('')}${(s.evidence?.exclusions || []).map(polygon => `<polygon points="${points(polygon)}" fill="#d34848" fill-opacity=".6" stroke="#932a2a" stroke-width=".3" />`).join('')}</svg>
    <p class="note">${layout.count ? 'Panels are packed inside the mapped roof boundary.' : 'No panels fit. Review blocked areas, usable area and capacity assumptions.'}</p>
    <button class="btn" type="button" data-act="mark-obstacle" aria-pressed="false">Mark blocked area</button>
    ${(s.evidence?.exclusions || []).length ? '<button class="btn" type="button" data-act="undo-obstacle">Undo last blocked area</button>' : ''}
    <p class="note" id="obstacle-help" role="status">Mark equipment or keep-clear areas yourself. Panels and estimates will update; this does not automatically detect obstacles.</p>
    <div class="actions"><button class="btn" type="button" data-act="layout">Regenerate layout</button><button class="btn" type="button" data-act="export-layout">Download layout</button></div></section>`;
}

function evidenceSection(s) {
  const e = s.evidence || {};
  return `<details id="site-evidence"><summary>Improve estimate with site evidence</summary><div class="body">
    <p>Replace assumptions with bill or survey data. These are user-provided corrections, not an independently verified engineering assessment. Stored in this browser.</p>
    <p><b>Current basis:</b> ${esc(s.demandSource)}. ${s.occupiedStoreys} occupied storey/storeys; ${esc(s.levelsSource || 'floor count assumed')}.</p>
    <form id="evidence-form" class="scan-form">
      ${[['occupiedStoreys', 'Occupied storeys', 1, 200, 1], ['annualKwh', 'Annual electricity use (kWh, whole building)', 1, 1e12, 'any'], ['peakKw', 'Metered maximum demand (kW)', .01, 500000, 'any'], ['usableM2', 'Surveyed usable roof area (m², plan area)', .01, s.area, 'any']].map(([key, title, min, max, step]) => `<label for="ev-${key}">${title} <span>(optional)</span></label><input id="ev-${key}" name="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${e[key] ?? ''}" />`).join('')}
      <label for="ev-source">Source and date</label><input id="ev-source" name="source" maxlength="300" value="${esc(e.source || '')}" placeholder="e.g. utility bill, September 2026" />
      <p class="note">Leave a field blank to use its model assumption. Usable area and blocked regions can reduce the panel count and estimated savings.</p>
      <button class="btn primary" type="submit">Apply &amp; recalculate</button><button class="btn" type="button" data-act="clear-evidence">Reset site corrections</button>
      <p id="evidence-status" class="note" role="status"></p>
    </form></div></details>`;
}

async function applySiteEvidence(site, evidence) {
  const next = { ...state.siteEvidence, [site.id]: evidence };
  persistEvidence(next);
  state.siteEvidence = next;
  recompute();
  const previous = await getLocalScan(site.id) || state.scans[site.id];
  if (previous) {
    await saveLocalScan({ ...previous, id: site.id, reviewed: false, layout: state.layouts[site.id], siteMetrics: { ...scanPayload(site), scan: undefined } });
    await refreshScans();
    renderCard();
  }
}

function bindObstacleDrawing() {
  const svg = $('layout-drawing');
  if (!svg) return;
  let start = null, rectangle = null;
  const point = (event) => {
    const p = svg.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  svg.onpointerdown = (event) => {
    if (!svg.classList.contains('drawing')) return;
    event.preventDefault();
    start = point(event);
    svg.setPointerCapture(event.pointerId);
    rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rectangle.setAttribute('fill', '#d34848'); rectangle.setAttribute('opacity', '.6');
    svg.append(rectangle);
  };
  svg.onpointermove = (event) => {
    if (!start) return;
    const end = point(event);
    for (const [key, value] of Object.entries({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) })) rectangle.setAttribute(key, value);
  };
  svg.onpointercancel = () => { start = null; rectangle?.remove(); };
  svg.onpointerup = async (event) => {
    if (!start) return;
    const end = point(event), origin = start;
    start = null; rectangle?.remove();
    svg.releasePointerCapture(event.pointerId);
    if (Math.abs(end.x - origin.x) < .25 || Math.abs(end.y - origin.y) < .25) { $('obstacle-help').textContent = 'Drag a larger rectangle to mark a blocked area.'; return; }
    const s = state.selected;
    const existing = s.evidence?.exclusions || [];
    if (existing.length >= 20) { $('obstacle-help').textContent = 'Twenty blocked areas are already recorded. Undo an area before adding another.'; return; }
    const x0 = Math.min(origin.x, end.x), x1 = Math.max(origin.x, end.x), y0 = -Math.max(origin.y, end.y), y1 = -Math.min(origin.y, end.y);
    try {
      await applySiteEvidence(s, { ...s.evidence, exclusions: [...existing, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] });
      $('obstacle-help').textContent = 'Blocked area saved. Panels, capacity and estimated savings have been recalculated.';
    } catch (err) { $('obstacle-help').textContent = err.message; }
  };
}

function scanPayload(s) {
  const [cx, cy] = s.centroid;
  return {
    id: s.id, name: label(s), category: s.categoryLabel,
    footprint: s.xy.map(([x, y]) => [x - cx, y - cy]),
    height: s.height, heightSource: s.heightSource, area: s.area, usable: s.usable,
    kwp: s.kwp, panels: Math.floor((s.kwp * 1000) / state.assumptions.panelWatt),
    flags: s.flags, scan: state.scans[s.id], layout: state.layouts[s.id] || state.scans[s.id]?.layout, exclusions: s.evidence?.exclusions || []
  };
}
let scanSite = null;
function openScan(s) {
  scanSite = s;
  openModal(`Drone scan: ${label(s)}`, { src: `${BASE}splat.html?site=${encodeURIComponent(s.id)}` });
}

async function refreshScans() {
  state.scans = { ...state.publishedScans, ...await localScanMetadata() };
}

function loadPendingJobs() {
  try {
    const saved = JSON.parse(localStorage.getItem('solar-drone-jobs') || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  catch { return {}; }
}
function persistJobs() {
  try { localStorage.setItem('solar-drone-jobs', JSON.stringify(state.droneJobs)); }
  catch { setStatus('Processing can continue, but this browser could not save job tracking. Keep the page open.'); }
}
const watchedJobs = new Set();
async function watchDroneJob(siteId) {
  if (watchedJobs.has(siteId) || !state.droneJobs[siteId]) return;
  watchedJobs.add(siteId);
  const pending = state.droneJobs[siteId];
  let failures = 0;
  const check = async () => {
    let retry = false;
    try {
      const job = await droneJob(pending.id);
      if (job.siteId !== siteId) throw new Error('The processor returned a result for another building.');
      state.droneJobs[siteId] = { ...pending, ...job };
      persistJobs();
      if (job.stage === 'complete') {
        state.droneJobs[siteId].stage = 'downloading';
        const file = await downloadDroneScan(job.id);
        await validateSplat(file);
        const s = state.sites.find((site) => site.id === siteId);
        const layout = s ? panelLayoutForSite(scanPayload(s), state.assumptions.panelWatt) : pending.siteMetrics ? panelLayoutForSite(pending.siteMetrics) : undefined;
        await saveLocalScan({ id: siteId, file, filename: file.name, format: 'ply', title: s ? label(s) : 'Drone scan',
          source: pending.source || 'Drone footage · Nerfstudio', captured: pending.captured || '',
          cameraUp: job.cameraUp || [0, 0, 1], overlay: { position: [0, 0, 0], rotation: [90, 0, 0], scale: 1 },
          reviewed: false, layout, siteMetrics: pending.siteMetrics });
        if (layout) state.layouts[siteId] = layout;
        delete state.droneJobs[siteId];
        persistJobs();
        await refreshScans();
        if (state.selected?.id === siteId) { renderCard(); render(); openScan(state.selected); }
      } else if (job.stage !== 'failed') retry = true;
      if (state.selected?.id === siteId) renderCard();
      failures = 0; // Reset only after the status AND any result download/save succeed.
    } catch (err) {
      failures++;
      retry = failures < 3;
      if (!retry) {
        state.droneJobs[siteId] = { ...pending, stage: 'connection_lost', message: `${err.message} Check the job again to resume.` };
        persistJobs();
        if (state.selected?.id === siteId) renderCard();
      }
    } finally {
      if (retry) setTimeout(check, 5000);
      else watchedJobs.delete(siteId);
    }
  };
  await check();
}
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin || e.source !== $('modalFrame').contentWindow) return;
  if (e.data?.type === 'scan-ready' && scanSite) {
    e.source.postMessage({ type: 'site', site: scanPayload(scanSite) }, location.origin);
  }
  if (e.data?.type === 'scan-saved') {
    try { await refreshScans(); renderCard(); }
    catch (err) { setStatus(err.message); }
  }
});

function zoneCard(c) {
  const a = state.assumptions;
  const sold = c.kwh ? c.matchedKwh / c.kwh : 0;
  return `
    <button class="x" data-act="close" aria-label="Close">×</button>
    <h3>${zoneName(c)}: community solar</h3>
    <div class="sub">${fmt(c.homeCount)} landed homes · ${esc(TOWNSHIPS[state.township].name)}</div>
    <span class="badge review">Proposed zone · grid checks pending</span>
    <p class="note">This outline groups nearby roofs for exploration. It does not confirm ownership, planning approval or a shared electricity feeder.</p>
    <div class="big4">
      <div><b>${power(c.kwp)}</b><span>rooftop solar</span></div>
      <div><b>${rm(c.leaseCost)}</b><span>to homeowners / yr</span></div>
      <div><b>${fmt(sold * 100)}%</b><span>output matched to potential buyers</span></div>
      <div><b>${fmt(c.co2, 0)} t</b><span>potential CO₂ avoided / year</span></div>
    </div>
    <details open><summary>Checks before proceeding</summary><ul class="zone-checks">${c.checks.map((check) => `<li>${esc(check)}</li>`).join('')}</ul></details>
    <details><summary>Potential buyers (${c.buyers.length})</summary>${c.buyers.length ? kv(c.buyers.map((b) => [esc(label(b.site)), `${fmt(b.kwh / 1000)} MWh/yr · ${fmt(b.dist / 1000, 1)} km`])) : '<p class="note">No buyer demand matched. This group has no modelled sales revenue.</p>'}<p class="note">Distances are from the group centre, not confirmed utility substations. ${fmt(c.unmatchedKwh / 1000)} MWh/yr remains unmatched.</p></details>
    <details><summary>Money</summary>${kv([
      ['Sales to matched buyers', rm(c.revenue)],
      ['Operation & maintenance', rm(c.om)],
      ['TNB access charge', rm(c.accessCost)],
      ['Homeowner leases', rm(c.leaseCost)],
      ['Installation cost', rm(c.capex)],
      ['Aggregator payback', years(c.payback)]
    ])}</details>
    <div class="actions"><button class="btn primary" data-act="home">See one home's options</button><button class="btn" data-act="sat-zone">Satellite view</button></div>`;
}

function bindCard() {
  const evidenceForm = $('evidence-form');
  if (evidenceForm) evidenceForm.onsubmit = async (event) => {
    event.preventDefault();
    const site = state.selected;
    try {
      const evidence = validateEvidence(Object.fromEntries(new FormData(evidenceForm)), site.area);
      evidence.exclusions = site.evidence?.exclusions || [];
      await applySiteEvidence(site, evidence);
      $('site-evidence').open = true;
      $('evidence-status').textContent = 'Corrections saved. Capacity, savings, ranking and any draft layout have been recalculated.';
    } catch (err) {
      const status = $('evidence-status'); if (status) { status.textContent = err.message; status.classList.add('error'); }
    }
  };
  bindObstacleDrawing();
  const form = $('scan-import');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const site = state.selected;
    const button = form.querySelector('[type="submit"]');
    const status = form.querySelector('#scan-status');
    button.disabled = true;
    status.textContent = 'Checking and saving scan…';
    status.classList.remove('error');
    try {
      const file = form.elements.file.files[0];
      const extension = file?.name.split('.').pop().toLowerCase();
      if (VIDEO_EXTENSIONS.includes(extension)) {
        if (!file.size || file.size > 1024 ** 3) throw new Error('Choose a non-empty drone video under 1 GB.');
        const health = await droneHealth();
        state.droneProcessor = health;
        if (!health.ready) throw new Error(health.message);
        status.textContent = 'Uploading footage…';
        const job = await uploadDroneVideo(file, site.id, (progress) => { status.textContent = `Uploading footage… ${progress}%`; });
        const { scan: previousScan, ...siteMetrics } = scanPayload(site);
        state.droneJobs[site.id] = { ...job, captured: form.elements.captured.value, source: form.elements.source.value.trim(), siteMetrics };
        persistJobs();
        renderCard();
        watchDroneJob(site.id);
        return;
      }
      const format = await validateSplat(file);
      const layout = panelLayoutForSite(scanPayload(site), state.assumptions.panelWatt);
      await saveLocalScan({ id: site.id, file, filename: file.name, format, title: label(site),
        captured: form.elements.captured.value, source: form.elements.source.value.trim(), reviewed: false,
        cameraUp: [0, 1, 0], layout, siteMetrics: { ...scanPayload(site), scan: undefined } });
      state.layouts[site.id] = layout;
      await refreshScans();
      renderCard();
      openScan(site);
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('error');
    } finally { button.disabled = false; }
  };
  $('card').querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      if (act === 'close') return clearSelection();
      if (act === 'collapse-card') { state.cardCollapsed = !state.cardCollapsed; renderCard(); map.resize(); $('card').querySelector('[data-act="collapse-card"]').focus(); return; }
      if (act === 'clear-evidence') {
        try { await applySiteEvidence(state.selected, {}); $('site-evidence').open = true; $('evidence-status').textContent = 'Site corrections cleared; model assumptions restored.'; }
        catch (err) { $('evidence-status').textContent = err.message; }
        return;
      }
      if (act === 'mark-obstacle') {
        const active = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(active));
        $('layout-drawing').classList.toggle('drawing', active);
        $('obstacle-help').textContent = active ? 'Drag a rectangle over equipment or an area to keep clear. Use site evidence fields if you need a keyboard-only correction.' : 'Blocked areas remain excluded from the layout.';
        return;
      }
      if (act === 'undo-obstacle') {
        try { const s = state.selected; await applySiteEvidence(s, { ...s.evidence, exclusions: (s.evidence?.exclusions || []).slice(0, -1) }); }
        catch (err) { $('obstacle-help').textContent = err.message; }
        return;
      }
      if (act === 'brief') return openBrief(state.selected);
      if (act === 'sat') { setBasemap(true); return map.flyTo({ center: state.selected.position, zoom: 17.6, pitch: 0, bearing: 0, duration: 1400 }); }
      if (act === 'sat-zone') { setBasemap(true); return map.flyTo({ center: state.selectedZone.position, zoom: 16.2, pitch: 0, bearing: 0, duration: 1400 }); }
      if (act === 'scan') return openScan(state.selected);
      if (act === 'layout') {
        const s = state.selected;
        const layout = panelLayoutForSite(scanPayload(s), state.assumptions.panelWatt);
        const next = { ...state.siteEvidence, [s.id]: { ...s.evidence, layoutPlanned: true } };
        try { persistEvidence(next); state.siteEvidence = next; }
        catch (err) { $('scan-status').textContent = err.message; return; }
        state.layouts[s.id] = layout;
        recompute();
        $('card').scrollTop = 0;
        $('card').querySelector('[aria-current="step"]')?.focus({ preventScroll: true });
        return;
      }
      if (act === 'export-layout') {
        const s = state.selected;
        const data = { siteId: s.id, ...scanPayload(s).layout, origin: s.position,
          coordinateSystem: 'Local metres, x east, y north, origin at mapped roof centroid', height: s.height };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `${s.id.replace('/', '-')}-draft-panels.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      if (act === 'retry-job') { watchDroneJob(state.selected.id); return; }
      if (act === 'add-scan') return setSiteView('roof');
      if (act === 'remove-scan') {
        btn.disabled = true;
        try { await removeLocalScan(state.selected.id); delete state.layouts[state.selected.id]; await refreshScans(); renderCard(); render(); }
        catch (err) { $('scan-status').textContent = err.message; btn.disabled = false; }
        return;
      }
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
let modalReturnFocus = null;
function openModal(title, { src, html }) {
  modalReturnFocus = document.activeElement;
  $('modalTitle').textContent = title;
  const f = $('modalFrame');
  if (html) { f.removeAttribute('src'); f.srcdoc = html; } else { f.removeAttribute('srcdoc'); f.src = src; }
  $('modal').hidden = false;
  if (!$('modal').open) $('modal').showModal();
  $('modalClose').focus();
}
function closeModal() {
  scanSite = null;
  $('modal').hidden = true;
  $('modal').close();
  $('modalFrame').onload = null;
  $('modalFrame').src = 'about:blank';
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  else $('card').querySelector('[data-act="add-scan"]')?.focus();
}
$('modalClose').onclick = closeModal;
$('modal').addEventListener('cancel', (e) => { e.preventDefault(); closeModal(); });
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
$('panelToggle').onclick = () => {
  const collapsed = document.body.classList.toggle('panel-collapsed');
  $('panelToggle').textContent = collapsed ? 'Show property results' : 'Show more map';
  $('panelToggle').setAttribute('aria-expanded', String(!collapsed));
  map.resize();
};

function openBrief(s, quotes = false) {
  if (!s) return;
  openModal(`${quotes ? 'Installer quote brief' : 'Site brief'}: ${label(s)}`, {
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
    html += sw(RAMP[3], 'Highlighted rooftop') + sw(CARPARK, 'Car park (solar canopy)') + sw(SELECTED, 'Selected site') + sw(TOO_SMALL, 'Too small for solar');
  } else if (state.tab === 'share') {
    html = '<b>Proposed solar groups</b>' + sw(ZONE, 'Home roofs in a proposed zone') + sw(BUYER, 'Potential buyer (selected zone)') + sw(SELECTED, 'Selected roof') + sw(NEUTRAL, 'Other buildings');
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
  state.siteView = 'potential';
  state.selected = null;
  state.selectedZone = null;
  state.buyerSet = new Set();
  if (state.selected && tab === 'store' && !state.batteryOf.has(state.selected)) state.selected = null;
  if (state.selected && tab === 'share') state.selected = null;
  document.querySelectorAll('#tabs button').forEach((b) => { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); b.tabIndex = b.dataset.tab === tab ? 0 : -1; });
  $('sun').hidden = tab !== 'find';
  if (tab !== 'find') stopAnim();
  renderLegend();
  refreshUI();
  $('panel').scrollTop = 0;
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});
$('tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const buttons = [...$('tabs').querySelectorAll('button')];
  const current = buttons.indexOf(document.activeElement);
  if (current < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  setTab(buttons[next].dataset.tab); buttons[next].focus();
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
    creamRadiusKm: 'Buyer search radius (km, screening)', creamMinHomes: 'Estimated homes per group, minimum', creamCapexPerKwp: 'Bulk install cost (RM/kWp)'
  }],
  ['Storage & grid', {
    capacityCharge: 'Capacity charge (RM/kW/month)', networkCharge: 'Network charge (RM/kW/month)',
    batteryCapexPerKwh: 'Battery cost (RM/kWh)', gridMaxM: 'Max. distance to substation (m)'
  }]
];
function renderSettings() {
  $('assumptions').innerHTML = SETTINGS.map(([group, fields], index) => `<details class="assumption-group" ${index === 0 ? 'open' : ''}><summary>${group}</summary><fieldset><legend class="sr-only">${group}</legend>${Object.entries(fields)
    .map(([k, l]) => `<label>${l}<input type="number" step="any" data-k="${k}" value="${state.assumptions[k]}"></label>`).join('')}</fieldset></details>`).join('');
}
$('assumptions').addEventListener('change', (e) => {
  const k = e.target.dataset.k, v = parseFloat(e.target.value);
  if (k && Number.isFinite(v)) { state.assumptions[k] = v; recompute(); }
});
$('reset').onclick = () => { state.assumptions = { ...DEFAULT_ASSUMPTIONS, ...state.overrides }; renderSettings(); recompute(); };
const toggleSettings = (open) => {
  const dialog = $('settings');
  dialog.hidden = !open;
  if (open) { if (!dialog.open) dialog.showModal(); $('settingsClose').focus(); }
  else { dialog.close(); $('settingsBtn').focus(); }
};
$('settingsBtn').onclick = () => toggleSettings($('settings').hidden);
$('settingsClose').onclick = () => toggleSettings(false);
$('settings').addEventListener('cancel', (event) => { event.preventDefault(); toggleSettings(false); });
$('settings-tabs').onclick = (event) => {
  const button = event.target.closest('[data-settings]');
  if (!button) return;
  $('settings-tabs').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  $('settings').querySelectorAll('[data-settings-panel]').forEach(panel => panel.hidden = panel.dataset.settingsPanel !== button.dataset.settings);
};
$('chooseScanRoof').onclick = () => { toggleSettings(false); setTab('find'); $('property-search')?.focus(); };

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
  const home = exampleHome();
  if (!home) return [{ text: 'Choose another township to explore a mapped home example.', go: () => setTab('share') }];
  const openHome = () => { setTab('share'); select(home, true); };
  return [
    { text: 'Solar-ready homes: include solar in the new-home purchase and show the homeowner the monthly loan, bill reduction and upkeep together. This is an illustrative scenario awaiting real bills and quotes.', go: () => setTab('share') },
    { text: 'Inspect one mapped home. Every monthly figure comes from visible, editable assumptions. A positive modelled benefit is not a guaranteed return or an approved mortgage offer.', go: openHome },
    { text: 'Review the mapped roof and generate a draft panel layout. Check obstacles and dimensions. A 3D scan is optional; hosted video reconstruction has not yet been demonstrated.', go: () => { openHome(); setSiteView('roof'); } },
    { text: 'Finish with a printable brief for installer review. Validate the real bill, roof dimensions, installed price and finance terms before making a customer promise.', go: () => { openHome(); setSiteView('brief'); } }
  ];
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
  for (const s of state.sites) { s.evidence = state.siteEvidence[s.id] || {}; delete s.layoutKwCap; }
  scoreSites(state.sites, state.assumptions, state.yieldData);
  let layoutChanged = false;
  for (const s of state.sites) {
    if (state.layouts[s.id] || state.scans[s.id]?.layout || s.evidence.layoutPlanned || s.evidence.exclusions?.length) {
      const layout = panelLayoutForSite(scanPayload(s), state.assumptions.panelWatt);
      state.layouts[s.id] = layout;
      s.layoutKwCap = layout.kwp;
      layoutChanged = true;
    }
  }
  if (layoutChanged) scoreSites(state.sites, state.assumptions, state.yieldData);
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
  state.query = ''; state.findLimit = 8;
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
  for (const siteId of Object.keys(state.droneJobs)) {
    if (state.sites.some((site) => site.id === siteId) && state.droneJobs[siteId].stage !== 'failed') watchDroneJob(siteId);
  }
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
  state.publishedScans = await fetch(`${import.meta.env.BASE_URL}splats/scans.json`).then((r) => (r.ok ? r.json() : {})).then((j) => j.scans || {}).catch(() => ({}));
  state.scans = { ...state.publishedScans };
  try { await refreshScans(); } catch (err) { setStatus(err.message); }
  $('sampleScan').onclick = () => openModal('3D viewer: sample scene', { src: `${BASE}splat.html?sample=1` });
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
  state.droneProcessor = await droneHealth().catch(() => ({ ready: false }));
  if (state.selected) renderCard();
}

init().catch((err) => { setLoading(null); setStatus(`Error: ${err.message}`); });

if (import.meta.env.DEV) window.__app = { state, overlay, map }; // debugging hook, dev server only
