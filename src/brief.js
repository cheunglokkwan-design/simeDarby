// One-page site feasibility brief: the handover document for an SDP engineer.
// Opens as a standalone page; the browser's "Save as PDF" makes the PDF.
import { siteProperties, GRID_FLAG } from './solar.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const n = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-MY', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');

// Footprint plan drawn to scale, north up, with a scale bar.
function footprintSVG(s, w = 300, h = 200, pad = 16) {
  const [x0, y0, x1, y1] = s.bbox;
  const k = Math.min((w - 2 * pad) / Math.max(x1 - x0, 1), (h - 2 * pad - 20) / Math.max(y1 - y0, 1));
  const pts = s.xy.map(([x, y]) => `${(pad + (x - x0) * k).toFixed(1)},${(pad + (y1 - y) * k).toFixed(1)}`).join(' ');
  const nice = [5, 10, 20, 25, 50, 100, 200, 500].find((m) => m * k > 50) || 500;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Footprint plan">
    <polygon points="${pts}" fill="#ffe7a3" stroke="#b07a00" stroke-width="1.5"/>
    <g transform="translate(${w - 22},${pad + 4})"><path d="M0,14 L6,0 L12,14 L6,10 Z" fill="#333"/><text x="6" y="26" font-size="10" text-anchor="middle">N</text></g>
    <g transform="translate(${pad},${h - 12})"><rect width="${nice * k}" height="4" fill="#333"/><text x="${nice * k + 6}" y="5" font-size="10">${nice} m</text></g>
  </svg>`;
}

export function siteBriefHTML(s, { township, assumptions: a, battery, yieldSource, quotes = false }) {
  const p = siteProperties(s, a);
  const [lon, lat] = s.position;
  const rows = [
    ['Building type', s.categoryLabel],
    ['Footprint / usable roof', `${n(s.area)} m² / ${n(s.usable)} m²`],
    ['Height', `${n(s.height, 1)} m (${esc(s.heightSource)})`],
    ['Panels', `${n(p.panels)} × ${a.panelWatt} W`],
    ['System size', `${n(s.kwp, 1)} kWp${s.atapCapped ? ' (capped by Solar ATAP: 1 MW or peak demand)' : ''}`],
    ['Sun exposure (3D shading)', `${n((s.shading ?? 1) * 100)} %`],
    ['Specific yield (weather variability only)', `${n(s.specificYield)} kWh/kWp P50 · ${n(s.yieldP90)} P90`],
    ['Generation, year 1', `${n(s.kwh / 1000, 1)} MWh P50 · ${n(s.kwhP90 / 1000, 1)} MWh P90`],
    ['Generation, 25 years', `${n(s.lifetimeKwh / 1e6, 2)} GWh (0.5 %/yr degradation)`],
    ['Self-consumed on site', `${n(s.selfRatio * 100)} %`],
    ['CAPEX', `RM ${n(s.capex)}`],
    ['Annual savings', `RM ${n(s.savings)} (exports at ATAP SMP ${a.exportSMP} RM/kWh)`],
    ['Assumed annual upkeep', `RM ${n(s.om || 0)}`],
    ['Simple payback (after assumed upkeep)', `${n(s.payback, 1)} years`],
    ['Demand basis', `${esc(s.demandSource || 'Category estimate')} · ${n(s.demand)} kWh/yr`],
    ...(s.evidence?.source ? [['User-provided evidence', esc(s.evidence.source)]] : []),
    ['CO₂ avoided', `${n(s.co2, 1)} t/yr · ${n((s.lifetimeKwh * a.emissionFactor) / 1000, 0)} t over 25 years`],
    ['Nearest mapped substation', s.gridDistM == null ? 'none mapped' : `${n(s.gridDistM)} m`],
    ['Opportunity score', `${n(s.score)} / 100`]
  ];
  const bat = battery
    ? `<h2>Battery option (NREL PySAM, peak shaving)</h2><table>
        <tr><td>Size</td><td>${n(battery.kw)} kW / ${n(battery.kwh)} kWh (4 h)</td></tr>
        <tr><td>Monthly peak cut</td><td>${n(battery.peakCutKw)} kW of ${n(battery.peakKw)} kW</td></tr>
        <tr><td>Indicative gross benefit</td><td>RM ${n(battery.value)}/yr · indicative payback ${n(battery.payback, 1)} years, before full charging-loss and ongoing costs</td></tr>
        <tr><td>Siting checks</td><td>Grid: ${esc(battery.checks.grid)}<br>Flood: ${esc(battery.checks.flood)}<br>Fire: ${esc(battery.checks.fire)}<br>Space: ${esc(battery.checks.space)}</td></tr>
      </table>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Site brief: ${esc(s.name || s.categoryLabel)}</title>
<style>
  body { font: 13px/1.45 system-ui, 'Segoe UI', sans-serif; color: #1b1f27; max-width: 760px; margin: 24px auto; padding: 0 16px; background: #fff; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 2px solid #ffc94a; padding-bottom: 2px; }
  .sub { color: #5b6475; margin: 2px 0 12px; } .grid { display: grid; grid-template-columns: 1fr 300px; gap: 16px; align-items: start; }
  table { width: 100%; border-collapse: collapse; } td { padding: 4px 6px; border-bottom: 1px solid #e3e6ec; vertical-align: top; }
  td:first-child { color: #5b6475; width: 42%; } .flag { display: inline-block; background: #fff1e8; color: #b34a12; border-radius: 4px; padding: 1px 6px; margin: 0 4px 4px 0; }
  .note { color: #5b6475; font-size: 11px; } button { margin: 8px 0; padding: 6px 12px; }
  .quote { background: #fff8e6; border: 1px solid #f2d48a; border-radius: 8px; padding: 10px 12px; margin: 8px 0 12px; }
  .quote ol { margin: 6px 0 0; padding-left: 18px; }
  @media print { button, .quote { display: none; } body { margin: 0; } }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style></head><body>
${quotes ? `<div class="quote"><b>Requesting installer quotes</b><ol>
  <li>Save this brief as a PDF with the button below.</li>
  <li>Send it to two or three installers on SEDA Malaysia's register of PV service providers (<a href="https://www.seda.gov.my" target="_blank" rel="noopener">seda.gov.my</a>). Only use registered installers.</li>
  <li>Ask each to confirm roof condition and structure, the TNB connection, and a price per kWp. Compare against the RM ${n(s.capex / s.kwp)}/kWp assumed here.</li>
</ol></div>` : ''}
<button onclick="print()">Save as PDF / print</button>
<h1>${esc(s.name || s.categoryLabel)}</h1>
<p class="sub">${esc(township)} · ${lat.toFixed(5)}, ${lon.toFixed(5)} · <a href="https://www.openstreetmap.org/${esc(s.id)}">${esc(s.id)}</a> · ${new Date().toISOString().slice(0, 10)}</p>
${s.affordable ? '<div><span class="flag" style="background:#e9f9ef;color:#1d7a42">Affordable housing: CREAM lease-income candidate</span></div>' : ''}
<div>${s.flags.length ? s.flags.map((f) => `<span class="flag">${esc(f)}${f === GRID_FLAG ? ' (not scored: OSM substation coverage is incomplete)' : ''}</span>`).join('') : '<span class="flag">No mapped review flags; engineering assessment pending</span>'}</div>
<div class="grid"><div><h2>Pre-feasibility summary</h2><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></div>
<div><h2>Footprint</h2>${footprintSVG(s)}</div></div>
${bat}
<h2>Method and limits</h2>
<p class="note">Pre-feasibility only, not a bankable estimate: a bankable design needs a site survey, structural check and an independent engineer
(e.g. PVsyst or HelioScope from this site's exported outline). Footprint and type: © OpenStreetMap contributors (ODbL). Yield: ${esc(yieldSource || 'fallback assumption')}.
Shading: line-of-sight raycast against neighbouring buildings. Tariffs, SMP, CAPEX and per-kW charges are editable assumptions: verify against TNB, SEDA and Suruhanjaya Tenaga before use.</p>
</body></html>`;
}
