import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { AmbientLight, LightingEffect, _SunLight as SunLight } from '@deck.gl/core';
import { PolygonLayer, SolidPolygonLayer, ScatterplotLayer, ArcLayer } from '@deck.gl/layers';

import { TOWNSHIPS } from './townships.js';
import { fetchOverpass } from './osm.js';
import { CATEGORY_LABEL } from './heights.js';
import { DEFAULT_ASSUMPTIONS, GRID_FLAG, buildSites, scoreSites, microGridLinks, summarise, toCSV } from './solar.js';
import { supabase, loadAssumptionOverrides, saveShortlist } from './supabase.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const state = {
  township: 'ara-damansara',
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
  substations: true,
  satellite: false,
  selected: null,
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
  canopy: [150, 150, 160], carpark: [70, 220, 230], unknown: [170, 170, 180]
};
const SHADE_RAMP = (t) => [Math.round(30 + 225 * t), Math.round(60 + 190 * t), Math.round(140 + 100 * t)];

function fillColor(s) {
  if (state.selected === s) return [255, 255, 255];
  if (state.colorBy === 'category') return CATEGORY_COLOR[s.category];
  if (state.colorBy === 'shading') return SHADE_RAMP(s.shading ?? 1);
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
  const sun = new SunLight({ timestamp: sunTimestamp(), color: [255, 245, 225], intensity: 2.2, _shadow: state.shadows });
  const fx = new LightingEffect({ ambient, sun });
  fx.shadowColor = [0, 0, 0, 0.55];
  return fx;
}

// ---------- layers ----------
function render() {
  const t = TOWNSHIPS[state.township];
  const [s, w, n, e] = t.bbox;
  const pad = 0.01;
  const buildings = state.sites.filter((x) => x.category !== 'carpark');
  const carparks = state.carparks ? state.sites.filter((x) => x.category === 'carpark') : [];
  const trig = [state.colorBy, state.selected?.id, state.shadingReady, JSON.stringify(state.assumptions)];

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
      getFillColor: (d) => (state.selected === d ? [255, 255, 255, 230] : state.colorBy === 'category' ? [...CATEGORY_COLOR.carpark, 170] : [...fillColor(d), 170]),
      pickable: true,
      autoHighlight: true,
      updateTriggers: { getFillColor: trig }
    })
  ];

  if (state.microgrid && state.links.length) {
    layers.push(
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

  if (state.substations && state.raw.substations?.length) {
    layers.push(
      new ScatterplotLayer({
        id: 'substations',
        data: state.raw.substations,
        getPosition: (d) => [...d.position, 15],
        getRadius: 22,
        radiusMinPixels: 5,
        getFillColor: [190, 120, 255],
        getLineColor: [255, 255, 255],
        stroked: true,
        lineWidthMinPixels: 1.5,
        pickable: true
      })
    );
  }

  overlay.setProps({ layers, effects: [lightingEffect()], onClick });
}

function getTooltip({ object, layer }) {
  if (!object) return null;
  if (layer.id === 'community') return { text: `${object.name || 'Community facility'}\n${object.type}` };
  if (layer.id === 'substations') return { text: `Substation\n${object.name || object.id}` };
  if (layer.id === 'microgrid')
    return { text: `Micro-grid proposal\n${object.donor.name || object.donor.categoryLabel} → ${object.community.name || object.community.type}\n${(object.dist / 1000).toFixed(2)} km` };
  return {
    text: `${object.name || object.categoryLabel}\nScore ${object.score.toFixed(0)} · ${fmt(object.kwp, 0)} kWp · ${fmt(object.kwh / 1000, 0)} MWh/yr`
  };
}

function onClick({ object, layer }) {
  if (!object || !['buildings', 'carparks'].includes(layer?.id)) return;
  select(object, false);
}

// ---------- UI ----------
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');

function renderKPIs() {
  const k = summarise(state.sites);
  const homes = k.kwh / 3000; // ~250 kWh/month per household
  $('kpis').innerHTML = `
    <div class="kpi hero"><div class="v">${fmt(k.co2 / 1000, 1)} kt CO₂/yr</div><div class="l">Avoided emissions if every viable roof and car park goes solar</div></div>
    <div class="kpi"><div class="v">${fmt(k.kwp / 1000, 1)} MWp</div><div class="l">Solar potential (${fmt(k.count, 0)} sites)</div></div>
    <div class="kpi"><div class="v">${fmt(k.kwh / 1e6, 1)} GWh</div><div class="l">Generation per year</div></div>
    <div class="kpi"><div class="v">${fmt(homes, 0)}</div><div class="l">Homes' worth of electricity</div></div>
    <div class="kpi"><div class="v">${fmt(k.carparkKwp / 1000, 1)} MWp</div><div class="l">From car park canopies</div></div>`;
}

function renderRanking() {
  state.ranked = state.sites.filter((s) => !s.flags.includes('Too small')).sort((a, b) => b.score - a.score);
  $('ranking').innerHTML = state.ranked
    .slice(0, 25)
    .map(
      (s, i) => `<li data-i="${i}" class="${state.selected === s ? 'sel' : ''}"><span class="score">${s.score.toFixed(0)}</span>
      ${esc(s.name || s.categoryLabel)}<br><span class="meta">${fmt(s.kwp, 0)} kWp · ${fmt(s.payback, 1)} yr payback${s.flags.length ? ' · ⚠' : ''}</span></li>`
    )
    .join('');
}
$('ranking').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) select(state.ranked[+li.dataset.i], true);
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function select(site, fly) {
  state.selected = site;
  if (fly) map.flyTo({ center: site.position, zoom: 17.5, pitch: 60, duration: 1500 });
  renderDetail();
  renderRanking();
  render();
}

function renderDetail() {
  const s = state.selected;
  const el = $('detail');
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  const rows = [
    ['Building type', s.categoryLabel],
    ['Footprint', `${fmt(s.area, 0)} m²`],
    ['Height', `${fmt(s.height, 1)} m <small>(${s.heightSource})</small>`],
    ['Usable roof', `${fmt(s.usable, 0)} m²`],
    ['Unshaded fraction', s.shading == null ? 'computing…' : `${fmt(s.shading * 100, 0)} %`],
    ['System size', `${fmt(s.kwp, 1)} kWp${s.atapCapped ? ' <small>(ATAP cap)</small>' : ''}`],
    ['Nearest substation', s.gridDistM == null ? 'none mapped' : `${fmt(s.gridDistM, 0)} m <small>(${esc(s.nearestSubstation)})</small>`],
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
    <div>${s.flags.length ? s.flags.map((f) => `<span class="flag${f === GRID_FLAG ? ' info' : ''}" ${f === GRID_FLAG ? 'title="Not scored: OSM substation coverage is incomplete"' : ''}>${f}</span>`).join('') : '<span class="flag ok">Passes engineering checks</span>'}</div>
    <table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
    <div class="actions">
      <a class="small" href="/splat.html?site=${encodeURIComponent(s.name || s.id)}" target="_blank"><button class="small">Micro-verify in 3D (splat)</button></a>
      <a href="https://www.openstreetmap.org/${s.id}" target="_blank"><button class="small">View on OSM</button></a>
      <a href="https://www.google.com/maps/@${lat},${lon},120m/data=!3m1!1e3" target="_blank"><button class="small">Satellite</button></a>
    </div>`;
  el.querySelector('.close').onclick = () => { state.selected = null; renderDetail(); renderRanking(); render(); };
}

function renderAssumptions() {
  const labels = {
    specificYield: 'Specific yield (kWh/kWp/yr)', panelDensity: 'Panel density (kWp/m²)',
    emissionFactor: 'Grid factor (kg CO₂/kWh)', tariffResidential: 'Tariff residential (RM/kWh)',
    tariffCommercial: 'Tariff commercial (RM/kWh)', tariffIndustrial: 'Tariff industrial (RM/kWh)',
    exportSMP: 'ATAP export price, SMP (RM/kWh)', atapCapKw: 'ATAP cap, non-domestic (kW)',
    homeCapKw: 'ATAP cap, homes (kW)', loadFactor: 'Load factor (peak kW)',
    gridMaxM: 'Max. substation distance (m)', capexSmall: 'CAPEX <50 kWp (RM/kWp)',
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
  renderDetail();
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
      setStatus(`${state.sites.length.toLocaleString()} sites · shading raycast done in ${((performance.now() - t0) / 1000).toFixed(1)} s · OSM snapshot ${state.raw.fetchedAt.slice(0, 10)}`);
      recompute();
    }
  };
  worker.postMessage({ lat, lon, items });
}

// ---------- loading ----------
async function loadTownship(id, live = false) {
  state.township = id;
  state.selected = null;
  renderDetail();
  const t = TOWNSHIPS[id];
  setStatus(live ? 'Fetching live data from OpenStreetMap…' : 'Loading OSM snapshot…');
  state.raw = live
    ? await fetchOverpass(t.bbox)
    : await fetch(`${import.meta.env.BASE_URL}data/${id}.json`).then((r) => r.json());
  const { sites, origin } = buildSites(state.raw);
  state.sites = sites;
  state.origin = origin;
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

  for (const k of ['shadows', 'carparks', 'microgrid', 'substations']) $(k).onchange = (e) => { state[k] = e.target.checked; render(); };
  $('satellite').onchange = (e) => { state.satellite = e.target.checked; map.setStyle(state.satellite ? SATELLITE_STYLE : DARK_STYLE); };
  $('colorBy').onchange = (e) => { state.colorBy = e.target.value; renderLegend(); render(); };

  $('csv').onclick = () => {
    const blob = new Blob([toCSV(state.ranked)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `solar-shortlist-${state.township}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
