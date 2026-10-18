import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { AmbientLight, LightingEffect, _SunLight as SunLight } from '@deck.gl/core';
import { PolygonLayer, SolidPolygonLayer, ScatterplotLayer, ArcLayer } from '@deck.gl/layers';

import { TOWNSHIPS } from './townships.js';
import { makeProjector, pointInPolygon } from './geo.js';
import { fetchOverpass } from './osm.js';
import { CATEGORY_LABEL } from './heights.js';
import {
  DEFAULT_ASSUMPTIONS, HOUSEHOLD_KWH_YR, SDP_EXISTING_KWP, buildSites, scoreSites, microGridLinks, summarise, toCSV, isViable
} from './solar.js';
import { supabase, loadAssumptionOverrides, saveShortlist } from './supabase.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const state = {
  township: 'elmina',
  raw: null,
  sites: [],
  ranked: [],
  links: [],
  assumptions: { ...DEFAULT_ASSUMPTIONS },
  colorBy: 'score',
  month: 2,
  hour: 15,
  shadows: true,
  carparks: true,
  microgrid: true,
  satellite: false,
  selection: new Set(), // sites picked by click, Shift+click, Shift+drag or "Select top 10"
  selVersion: 0, // bumped on every change so deck.gl re-evaluates colours
  shadingReady: false
};

// ---------- basemaps ----------
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

const map = new maplibregl.Map({
  container: 'map',
  style: DARK_STYLE,
  center: [TOWNSHIPS[state.township].view.longitude, TOWNSHIPS[state.township].view.latitude],
  zoom: TOWNSHIPS[state.township].view.zoom,
  pitch: TOWNSHIPS[state.township].view.pitch,
  bearing: TOWNSHIPS[state.township].view.bearing,
  maxPitch: 75,
  attributionControl: { compact: true }
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

const overlay = new MapboxOverlay({ interleaved: false, layers: [], getTooltip });
map.addControl(overlay);
// Arcs and markers get their own overlay without the lighting effect: with the shadow
// LightingEffect active, deck.gl 9.4 does not draw ArcLayer at all (nor answer picking).
const annotations = new MapboxOverlay({ interleaved: false, layers: [], getTooltip: (info) => (info.object ? getTooltip(info) : null) });
map.addControl(annotations);

// ---------- colours ----------
const RAMP = [[45, 30, 80], [130, 40, 110], [220, 80, 70], [250, 160, 50], [255, 230, 110]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f));
}
const CATEGORY_COLOR = {
  residential: [120, 170, 255], apartments: [80, 120, 230], retail: [255, 150, 70],
  commercial: [255, 210, 80], industrial: [230, 90, 90], institutional: [110, 220, 160],
  canopy: [150, 150, 160], carpark: [70, 220, 230], utility: [105, 105, 115], unknown: [170, 170, 180]
};
const SHADE_RAMP = (t) => [Math.round(30 + 225 * t), Math.round(60 + 190 * t), Math.round(140 + 100 * t)];
// Data confidence: red (guessed) -> amber -> green (mapped).
const CONF_STOPS = [[220, 70, 70], [245, 180, 60], [80, 210, 120]];
function confColor(t) {
  t = Math.max(0, Math.min(1, (t - 0.2) / 0.7)) * 2;
  const i = Math.min(1, Math.floor(t)), f = t - i;
  return CONF_STOPS[i].map((c, k) => Math.round(c + (CONF_STOPS[i + 1][k] - c) * f));
}
const SOURCE_COLOR = {
  OpenStreetMap: [120, 170, 255], 'Google Open Buildings': [255, 190, 70], 'Microsoft ML Buildings': [190, 120, 255],
  'AI-detected from imagery': [80, 230, 200]
};
const SOURCE_LABEL = {
  OpenStreetMap: 'OpenStreetMap (mapped by people)', 'Google Open Buildings': 'Google Open Buildings (AI-traced)',
  'Microsoft ML Buildings': 'Microsoft ML Buildings (AI-traced)', 'AI-detected from imagery': 'Car park found by AI vehicle detection'
};

function fillColor(s) {
  if (state.selection.has(s)) return [255, 255, 255];
  if (state.colorBy === 'category') return CATEGORY_COLOR[s.category];
  if (state.colorBy === 'shading') return SHADE_RAMP(s.shading ?? 1);
  if (state.colorBy === 'confidence') return confColor(s.heightConfidence ?? 0.3);
  if (state.colorBy === 'source') return SOURCE_COLOR[s.footprintSource] ?? [170, 170, 180];
  if (s.flags.includes('Too small')) return [70, 72, 85];
  if (state.colorBy === 'kwh') return ramp(Math.log10(Math.max(s.kwh, 1)) / 6);
  return ramp(s.score / 85);
}

function renderLegend() {
  const el = $('legend');
  const bar = (stops, a, b) =>
    `<div class="bar" style="background:linear-gradient(90deg,${stops.map((c) => `rgb(${c})`).join(',')})"></div><div class="ends"><span>${a}</span><span>${b}</span></div>`;
  if (state.colorBy === 'category')
    el.innerHTML = Object.entries(CATEGORY_COLOR)
      .map(([k, c]) => `<span class="sw"><i style="background:rgb(${c})"></i>${CATEGORY_LABEL[k]}</span>`)
      .join('');
  else if (state.colorBy === 'shading') el.innerHTML = bar([0, 0.5, 1].map(SHADE_RAMP), 'Heavily shaded', 'Full sun');
  else if (state.colorBy === 'confidence') el.innerHTML = bar(CONF_STOPS, 'Height & type guessed', 'Mapped');
  else if (state.colorBy === 'source')
    el.innerHTML = Object.entries(SOURCE_COLOR)
      .map(([k, c]) => `<span class="sw"><i style="background:rgb(${c})"></i>${SOURCE_LABEL[k]}</span>`)
      .join('');
  else if (state.colorBy === 'kwh') el.innerHTML = bar(RAMP, '1 MWh/yr', '1 GWh/yr');
  else el.innerHTML = bar(RAMP, 'Low opportunity', 'High opportunity') + '<div class="ends"><span>Grey = too small</span></div>';
}

// ---------- lighting ----------
function sunTimestamp() {
  // Malaysia is UTC+8, no DST.
  const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60);
  return Date.UTC(2026, state.month, 21, h - 8, m);
}
function lightingEffect() {
  const ambient = new AmbientLight({ color: [255, 255, 255], intensity: 1.0 });
  // Keep the shadow pass on and hide shadows by making them transparent: switching
  // `_shadow` off rebuilds shaders without the shadow-map bindings and blanks the scene.
  const sun = new SunLight({ timestamp: sunTimestamp(), color: [255, 245, 225], intensity: 2.2, _shadow: true });
  const fx = new LightingEffect({ ambient, sun });
  fx.shadowColor = [0, 0, 0, state.shadows ? 0.55 : 0];
  return fx;
}

// ---------- layers ----------
function render() {
  const t = TOWNSHIPS[state.township];
  const [s, w, n, e] = t.bbox;
  const pad = 0.01;
  const buildings = state.sites.filter((x) => x.category !== 'carpark');
  const carparks = state.carparks ? state.sites.filter((x) => x.category === 'carpark') : [];
  const trig = [state.colorBy, state.selVersion, state.shadingReady, JSON.stringify(state.assumptions)];

  const layers = [
    // Invisible ground plane that receives shadows.
    new SolidPolygonLayer({
      id: 'ground',
      data: [[[w - pad, s - pad], [e + pad, s - pad], [e + pad, n + pad], [w - pad, n + pad]]],
      getPolygon: (d) => d,
      getFillColor: [0, 0, 0, 0],
      shadowEnabled: true
    }),
    new PolygonLayer({
      id: 'buildings',
      data: buildings,
      extruded: true,
      wireframe: false,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => d.height,
      getFillColor: fillColor,
      material: { ambient: 0.35, diffuse: 0.6, shininess: 24, specularColor: [60, 64, 70] },
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
      updateTriggers: { getFillColor: trig }
    }),
    new PolygonLayer({
      id: 'carparks',
      data: carparks,
      extruded: true,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => d.height,
      getFillColor: (d) => (state.selection.has(d) ? [255, 255, 255, 230] : state.colorBy === 'category' ? [...CATEGORY_COLOR.carpark, 170] : [...fillColor(d), 170]),
      pickable: true,
      autoHighlight: true,
      updateTriggers: { getFillColor: trig }
    })
  ];

  const annotationLayers = [];
  // Vehicles the pipeline detected in aerial imagery: the evidence behind AI-detected car parks.
  if (state.carparks && state.raw.vehicles?.length) {
    annotationLayers.push(
      new ScatterplotLayer({
        id: 'vehicles',
        data: state.raw.vehicles,
        getPosition: (d) => [d[0], d[1], 0.5],
        getRadius: 1.4,
        radiusMinPixels: 1,
        getFillColor: [235, 240, 255, 210]
      })
    );
  }
  if (state.microgrid && state.links.length) {
    annotationLayers.push(
      new ArcLayer({
        id: 'microgrid',
        data: state.links,
        getSourcePosition: (d) => [...d.from, d.donor.height + 2],
        getTargetPosition: (d) => [...d.to, 10],
        getSourceColor: [255, 210, 80, 220],
        getTargetColor: [80, 240, 170, 220],
        getWidth: 2.5,
        getHeight: 0.6,
        pickable: true
      }),
      new ScatterplotLayer({
        id: 'community',
        data: state.raw.community,
        getPosition: (d) => [...d.position, 12],
        getRadius: 14,
        radiusMinPixels: 4,
        getFillColor: [80, 240, 170],
        getLineColor: [10, 40, 30],
        stroked: true,
        lineWidthMinPixels: 1,
        pickable: true
      })
    );
  }

  overlay.setProps({ layers, effects: [lightingEffect()], onClick });
  annotations.setProps({ layers: annotationLayers });
}

// deck.gl's GPU picking returns nothing while the shadow LightingEffect is on (deck.gl 9.4:
// luma.gl reports missing shadow-map bindings in the picking pass), so clicks, tooltips and
// box selection fall back to geometry. For a click we follow the camera ray through the
// cursor and take the highest roof it passes through (roofs of tall blocks appear offset
// from their footprints when the map is tilted).
function siteAt({ viewport, x, y }) {
  if (!state.proj || !viewport || x == null) return null;
  const H = 100; // reference height (m) for the ray's second point
  const [ax, ay] = state.proj.toXY(viewport.unproject([x, y], { targetZ: 0 }));
  const [bx, by] = state.proj.toXY(viewport.unproject([x, y], { targetZ: H }));
  let best = null;
  for (const s of state.sites) {
    if (s.category === 'carpark' && !state.carparks) continue;
    const t = s.height / H;
    const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
    const [x0, y0, x1, y1] = s.bbox;
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    if (pointInPolygon(px, py, s.xy) && (!best || s.height > best.height)) best = s;
  }
  return best;
}

function sitesInScreenRect({ x, y, width, height }) {
  const quad = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map((p) =>
    state.proj.toXY(map.unproject(p).toArray())
  );
  return state.sites.filter(
    (s) => isViable(s) && (s.category !== 'carpark' || state.carparks) && pointInPolygon(s.centroid[0], s.centroid[1], quad)
  );
}

const siteTooltip = (s) => ({
  text: `${s.name || s.categoryLabel}\nScore ${s.score.toFixed(0)} · ${fmt(s.kwp, 0)} kWp · ${fmt(s.kwh / 1000, 0)} MWh/yr · ${fmt(s.co2, 0)} t CO₂/yr`
});

function getTooltip(info) {
  const { object, layer } = info;
  if (!object) {
    const s = siteAt(info);
    return s ? siteTooltip(s) : null;
  }
  if (layer.id === 'community') return { text: `${object.name || 'Community facility'}\n${object.type}` };
  if (layer.id === 'microgrid')
    return { text: `Micro-grid proposal\n${object.donor.name || object.donor.categoryLabel} → ${object.community.name || object.community.type}\n${(object.dist / 1000).toFixed(2)} km` };
  return siteTooltip(object);
}

// Shift, Ctrl or Cmd adds to / removes from the selection instead of replacing it.
const isMulti = (e) => !!(e && (e.shiftKey || e.ctrlKey || e.metaKey));

function onClick(info, event) {
  const site = ['buildings', 'carparks'].includes(info.layer?.id) ? info.object : siteAt(info);
  // MapboxOverlay passes MapLibre's MapMouseEvent as srcEvent; the DOM event is inside it.
  const dom = event?.srcEvent?.originalEvent ?? event?.srcEvent;
  if (site) select(site, { additive: isMulti(dom) });
}

// ---------- UI ----------
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');

function renderKPIs() {
  const k = summarise(state.sites);
  const homes = k.kwh / HOUSEHOLD_KWH_YR;
  $('kpis').innerHTML = `
    <div class="kpi hero"><div class="v">${fmt(k.co2 / 1000, 1)} kt CO₂/yr</div><div class="l">Avoided emissions if every viable roof and car park goes solar</div></div>
    <div class="kpi"><div class="v">${fmt(k.kwp / 1000, 1)} MWp</div><div class="l">Solar potential (${fmt(k.count, 0)} sites)</div></div>
    <div class="kpi"><div class="v">${fmt(k.kwh / 1e6, 1)} GWh</div><div class="l">Generation per year</div></div>
    <div class="kpi"><div class="v">${fmt(homes, 0)}</div><div class="l">Homes' worth of electricity</div></div>
    <div class="kpi"><div class="v">${fmt(k.carparkKwp / 1000, 1)} MWp</div><div class="l">From car park canopies</div></div>`;
}

function renderRanking() {
  state.ranked = state.sites.filter(isViable).sort((a, b) => b.score - a.score);
  $('ranking').innerHTML = state.ranked
    .slice(0, 25)
    .map(
      (s, i) => `<li data-i="${i}" class="${state.selection.has(s) ? 'sel' : ''}"><span class="score">${s.score.toFixed(0)}</span>
      ${esc(s.name || s.categoryLabel)}<br><span class="meta">${fmt(s.kwp, 0)} kWp · ${fmt(s.payback, 1)} yr payback${s.flags.length ? ' · ⚠' : ''}</span></li>`
    )
    .join('');
}
$('ranking').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) select(state.ranked[+li.dataset.i], { fly: !isMulti(e), additive: isMulti(e) });
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- selection ----------
function selectionChanged() {
  state.selVersion++;
  renderSelection();
  renderRanking();
  render();
}

function select(site, { fly = false, additive = false } = {}) {
  if (!additive) state.selection = new Set([site]);
  else if (state.selection.has(site)) state.selection.delete(site);
  else state.selection.add(site);
  if (fly && state.selection.size === 1) map.flyTo({ center: site.position, zoom: 17.5, pitch: 60, duration: 1500 });
  selectionChanged();
}

function selectMany(sites, additive = true) {
  if (!additive) state.selection = new Set();
  for (const s of sites) state.selection.add(s);
  selectionChanged();
}

function clearSelection() {
  state.selection = new Set();
  selectionChanged();
}

// One site: its detail card. Several: their combined impact.
function renderSelection() {
  if (state.selection.size > 1) renderSelectionSummary();
  else renderDetail();
}

function renderSelectionSummary() {
  const el = $('detail');
  el.hidden = false;
  const sites = [...state.selection].sort((a, b) => b.co2 - a.co2);
  const k = summarise(sites);
  const town = summarise(state.sites);
  const left = sites.length - k.count;
  const payback = k.savings > 0 ? k.capex / k.savings : Infinity;
  const rows = [
    ['Solar potential', `${fmt(k.kwp, 0)} kWp`],
    ['Generation', `${fmt(k.kwh / 1000, 0)} MWh/yr`],
    ["Homes' worth of electricity", fmt(k.kwh / HOUSEHOLD_KWH_YR, 0)],
    ['Self-consumed on site', `${fmt(k.kwh ? (k.selfUse / k.kwh) * 100 : 0, 0)} %`],
    ['CAPEX', `RM ${fmt(k.capex, 0)}`],
    ['Annual savings', `RM ${fmt(k.savings, 0)}`],
    ['Payback (combined)', `${fmt(payback, 1)} years`],
    ['Share of township potential', `${fmt(town.co2 ? (k.co2 / town.co2) * 100 : 0, 1)} %`],
    ["vs SDP's 603 kWp rooftop PV today", `${fmt(k.kwp / SDP_EXISTING_KWP, 1)}×`]
  ];
  el.innerHTML = `<button class="close" aria-label="Clear selection">×</button>
    <h3>${sites.length} sites selected</h3>
    <div class="sub">${left ? `${left} too small or utility-owned, left out of the totals · ` : ''}Shift+click to add or remove</div>
    <div class="co2hero">${fmt(k.co2, 0)} t CO₂/yr</div>
    <div class="sub">avoided if these ${k.count} sites go solar</div>
    <table class="totals">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
    <ol class="sellist">${sites
      .map((s, i) => `<li data-i="${i}" title="Click to remove"><span class="n">${esc(s.name || s.categoryLabel)}</span><span>${fmt(s.co2, 0)} t</span></li>`)
      .join('')}</ol>
    <div class="actions">
      <button class="small" id="selCsv">Export selection CSV</button>
      <button class="small" id="selClear">Clear selection</button>
    </div>`;
  el.querySelector('.close').onclick = clearSelection;
  el.querySelector('#selClear').onclick = clearSelection;
  el.querySelector('#selCsv').onclick = () => download(toCSV(sites), `solar-selection-${state.township}.csv`);
  el.querySelector('.sellist').onclick = (e) => {
    const li = e.target.closest('li');
    if (li) select(sites[+li.dataset.i], { additive: true });
  };
}

function download(text, filename) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Shift+drag on the map draws a box and adds every viable building and car park whose
// footprint centre lies on the ground inside it (including ones hidden behind taller blocks).
function enableBoxSelect() {
  map.boxZoom.disable(); // MapLibre uses Shift+drag for box zoom by default
  const container = map.getCanvasContainer();
  let start = null;
  let boxEl = null;
  const point = (e) => {
    const r = container.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  container.addEventListener('mousedown', (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    map.dragPan.disable();
    start = point(e);
    boxEl = Object.assign(document.createElement('div'), { id: 'selbox' });
    container.appendChild(boxEl);
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!start) return;
    const [x, y] = point(e);
    Object.assign(boxEl.style, {
      left: `${Math.min(x, start[0])}px`, top: `${Math.min(y, start[1])}px`,
      width: `${Math.abs(x - start[0])}px`, height: `${Math.abs(y - start[1])}px`
    });
  });
  window.addEventListener('mouseup', (e) => {
    if (!start) return;
    const [x, y] = point(e);
    const rect = { x: Math.min(x, start[0]), y: Math.min(y, start[1]), width: Math.abs(x - start[0]), height: Math.abs(y - start[1]) };
    start = null;
    boxEl.remove();
    map.dragPan.enable();
    if (rect.width < 4 || rect.height < 4) return; // a Shift+click, handled by onClick
    const sites = sitesInScreenRect(rect);
    if (sites.length) selectMany(sites);
    setStatus(`Box selected ${sites.length} viable sites (${state.selection.size} in selection).`);
  });
}

function renderDetail() {
  const el = $('detail');
  if (state.selection.size !== 1) { el.hidden = true; return; }
  const [s] = state.selection;
  el.hidden = false;
  const rows = [
    ['Building type', s.categoryLabel],
    ['Footprint', `${fmt(s.area, 0)} m²`],
    ['Height', `${fmt(s.height, 1)} m <small>(${s.heightSource})</small>`],
    ['Data confidence', `${fmt((s.heightConfidence ?? 0) * 100, 0)} % <small>(type from ${esc(s.kindSource.replace(/_/g, ' '))})</small>`],
    ['Footprint from', esc(SOURCE_LABEL[s.footprintSource] ?? s.footprintSource)],
    ['Usable roof', `${fmt(s.usable, 0)} m²`],
    ['Unshaded fraction', s.shading == null ? 'computing…' : `${fmt(s.shading * 100, 0)} %`],
    ['System size', `${fmt(s.kwp, 1)} kWp`],
    ['Generation', `${fmt(s.kwh / 1000, 1)} MWh/yr`],
    ['Est. demand (proxy)', `${fmt(s.demand / 1000, 0)} MWh/yr`],
    ['Self-consumed', `${fmt(s.selfRatio * 100, 0)} %`],
    ['CAPEX', `RM ${fmt(s.capex, 0)}`],
    ['Annual savings', `RM ${fmt(s.savings, 0)}`],
    ['Payback', `${fmt(s.payback, 1)} years`],
    ['CO₂ avoided', `${fmt(s.co2, 1)} t/yr`],
    ['Opportunity score', `<b>${s.score.toFixed(0)}</b> / 100`]
  ];
  const [lon, lat] = s.position;
  el.innerHTML = `<button class="close" aria-label="Close">×</button>
    <h3>${esc(s.name || s.categoryLabel)}</h3>
    <div class="sub">${s.id} · ${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
    <div class="co2hero">${fmt(s.co2, 1)} t CO₂/yr</div>
    <div class="sub">avoided · ${fmt(s.kwp, 0)} kWp · ${fmt(s.kwh / 1000, 0)} MWh/yr · Shift+click more sites to combine</div>
    <div>${s.flags.length ? s.flags.map((f) => `<span class="flag">${f}</span>`).join('') : '<span class="flag ok">Passes engineering checks</span>'}</div>
    ${s.dataFlags.length ? `<div>${s.dataFlags.map((f) => `<span class="flag data" title="Data quality">${DATA_FLAG_LABEL[f] ?? f}</span>`).join('')}</div>` : ''}
    <table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
    <div class="actions">
      <a class="small" href="/splat.html?site=${encodeURIComponent(s.name || s.id)}" target="_blank"><button class="small">Micro-verify in 3D (splat)</button></a>
      ${/^(way|node|relation)\//.test(s.id) ? `<a href="https://www.openstreetmap.org/${s.id}" target="_blank"><button class="small">View on OSM</button></a>` : ''}
      <a href="https://www.google.com/maps/@${lat},${lon},120m/data=!3m1!1e3" target="_blank"><button class="small">Satellite</button></a>
    </div>`;
  el.querySelector('.close').onclick = clearSelection;
}

const DATA_FLAG_LABEL = {
  height_estimated: 'Height estimated', type_inferred: 'Type inferred', type_unknown: 'Type unknown',
  tag_overridden: 'Map tag overridden', ml_footprint: 'AI-traced outline', construction_zone: 'Construction zone',
  below_min_system: 'Below 3 kWp', detected_carpark: 'AI-detected car park (verify on site)'
};

function renderAssumptions() {
  const labels = {
    specificYield: 'Specific yield (kWh/kWp/yr)', panelDensity: 'Panel density (kWp/m²)',
    emissionFactor: 'Grid factor (kg CO₂/kWh)', tariffResidential: 'Tariff residential (RM/kWh)',
    tariffCommercial: 'Tariff commercial (RM/kWh)', tariffIndustrial: 'Tariff industrial (RM/kWh)',
    exportRate: 'Export credit (RM/kWh)', capexSmall: 'CAPEX <50 kWp (RM/kWp)',
    capexLarge: 'CAPEX ≥50 kWp (RM/kWp)', minKwp: 'Min. viable system (kWp)'
  };
  $('assumptions').innerHTML = Object.entries(labels)
    .map(([k, l]) => `<label class="row">${l}<input type="number" step="any" data-k="${k}" value="${state.assumptions[k]}" style="width:90px"></label>`)
    .join('');
}
$('assumptions').addEventListener('change', (e) => {
  const k = e.target.dataset.k;
  const v = parseFloat(e.target.value);
  if (k && Number.isFinite(v)) { state.assumptions[k] = v; recompute(); }
});

function recompute() {
  scoreSites(state.sites, state.assumptions);
  state.links = microGridLinks(state.sites, state.raw.community);
  renderKPIs();
  renderRanking();
  renderSelection();
  render();
}

function setStatus(t) { $('status').textContent = t; }

// ---------- shading worker ----------
let worker;
function runShading() {
  worker?.terminate();
  state.shadingReady = false;
  worker = new Worker(new URL('./shading.worker.js', import.meta.url), { type: 'module' });
  const t0 = performance.now();
  const items = state.sites.map((s) => ({ xy: s.xy, bbox: s.bbox, height: s.height, centroid: s.centroid, skip: s.category === 'carpark' }));
  const [lon, lat] = state.origin;
  worker.onmessage = ({ data }) => {
    if (data.progress != null) setStatus(`Raycasting roof shading… ${Math.round(data.progress * 100)}%`);
    if (data.done) {
      data.result.forEach((v, i) => (state.sites[i].shading = state.sites[i].category === 'carpark' ? 0.95 : v));
      state.shadingReady = true;
      const src = state.raw.pipeline ? 'Overture' : 'OSM snapshot';
      setStatus(`${state.sites.length.toLocaleString()} sites · shading raycast done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${src} ${state.raw.fetchedAt.slice(0, 10)}`);
      recompute();
    }
  };
  worker.postMessage({ lat, lon, items });
}

// ---------- loading ----------
async function loadTownship(id, live = false) {
  state.township = id;
  state.selection = new Set();
  state.selVersion++;
  renderSelection();
  const t = TOWNSHIPS[id];
  setStatus(live ? 'Fetching live data from OpenStreetMap…' : 'Loading township data…');
  state.raw = live
    ? await fetchOverpass(t.bbox)
    : await fetch(`${import.meta.env.BASE_URL}data/${id}.json`).then((r) => r.json());
  const { sites, origin } = buildSites(state.raw);
  state.sites = sites;
  state.origin = origin;
  state.proj = makeProjector(...origin); // same local projection buildSites used for s.xy
  recompute();
  map.flyTo({ center: [t.view.longitude, t.view.latitude], zoom: t.view.zoom, pitch: t.view.pitch, bearing: t.view.bearing, duration: 1200 });
  runShading();
}

// ---------- controls ----------
function bindControls() {
  $('township').innerHTML = Object.entries(TOWNSHIPS).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');
  $('township').value = state.township;
  $('township').onchange = (e) => loadTownship(e.target.value);

  const syncSun = () => {
    $('monthLabel').textContent = `21 ${MONTHS[state.month]}`;
    const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60);
    $('hourLabel').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  $('month').value = state.month;
  $('hour').value = state.hour;
  $('month').oninput = (e) => { state.month = +e.target.value; syncSun(); render(); };
  $('hour').oninput = (e) => { state.hour = +e.target.value; syncSun(); render(); };
  syncSun();

  let anim;
  $('animate').onchange = (e) => {
    cancelAnimationFrame(anim);
    if (!e.target.checked) return;
    const tick = () => {
      state.hour = state.hour >= 19 ? 7 : state.hour + 0.03;
      $('hour').value = state.hour;
      syncSun();
      render();
      anim = requestAnimationFrame(tick);
    };
    tick();
  };

  for (const k of ['shadows', 'carparks', 'microgrid']) $(k).onchange = (e) => { state[k] = e.target.checked; render(); };
  $('satellite').onchange = (e) => { state.satellite = e.target.checked; map.setStyle(state.satellite ? SATELLITE_STYLE : DARK_STYLE); };
  $('colorBy').onchange = (e) => { state.colorBy = e.target.value; renderLegend(); render(); };

  $('csv').onclick = () => download(toCSV(state.ranked), `solar-shortlist-${state.township}.csv`);
  $('top10').onclick = () => selectMany(state.ranked.slice(0, 10), false);
  enableBoxSelect();

  $('refresh').onclick = () => loadTownship(state.township, true).catch((err) => setStatus(`Live fetch failed: ${err.message}`));

  if (supabase) {
    $('save').hidden = false;
    $('save').onclick = async () => {
      try {
        await saveShortlist(state.township, state.ranked.slice(0, 50));
        setStatus('Top 50 sites saved to Supabase.');
      } catch (err) {
        setStatus(`Supabase save failed: ${err.message}`);
      }
    };
  }
}

async function init() {
  bindControls();
  renderLegend();
  renderAssumptions();
  if (supabase) {
    try {
      const o = await loadAssumptionOverrides();
      if (o && Object.keys(o).length) Object.assign(state.assumptions, o);
      $('db').textContent = ' · Assumptions from Supabase';
      renderAssumptions();
    } catch {
      $('db').textContent = ' · Supabase connected (no assumptions table yet)';
    }
  }
  await loadTownship(state.township);
}

init().catch((err) => setStatus(`Error: ${err.message}`));
