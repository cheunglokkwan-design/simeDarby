// One-page site feasibility brief: the handover document for an SDP engineer.
// Opens as a standalone page; the browser's "Save as PDF" makes the PDF.
import { siteProperties, GRID_FLAG } from './solar.js';
import { roofStatus } from './roof-checks.js';
import { studyChecks } from './shortlist.js';
import { studySummary, nextSiteCheck, CONTROL_LABELS, STAGE_LABELS } from './study.js';

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

// 3D twin row: level, link and the draft layout last planned in the twin (if any).
const twinText = (t) => !t ? 'Not opened' : `${esc(t.level)}${t.url ? ` · <a href="${esc(t.url)}">${esc(t.url)}</a>` : ''}${t.plan ? `<br>Twin draft layout: ${n(t.plan.panels)} panels · ${n(t.plan.kWp, 1)} kWp planned${Number.isFinite(t.plan.annualKwh) ? ` · ${n(t.plan.annualKwh / 1000, 1)} MWh/yr` : ''}${t.plan.mounting ? ` · ${esc(t.plan.mounting)}` : ''} (${esc(String(t.plan.at || '').slice(0, 10))})` : '<br>No twin layout saved yet'}`;

export function siteBriefHTML(s, { township, assumptions: a, battery, yieldSource, quotes = false, twin = null }) {
  const p = siteProperties(s, a);
  const [lon, lat] = s.position;
  const rows = [
    ['Building type', s.categoryLabel],
    ['Footprint / usable roof', `${n(s.area)} m² / ${n(s.usable)} m²`],
    ['Height', `${n(s.height, 1)} m (${esc(s.heightSource)})`],
    ['Panels', `${n(p.panels)} × ${a.panelWatt} W`],
    ['System size', `${n(s.kwp, 1)} kWp${s.atapCapped ? ' (capped by Solar ATAP: 1 MW or peak demand)' : ''}`],
    ...(twin ? [['3D twin', twinText(twin)]] : []),
    ['Unshaded share of sampled rays', `${n((s.energyShading ?? s.shading ?? 1) * 100)} %; four representative dates, estimated heights`],
    ['Specific yield (weather variability only)', `${n(s.specificYield)} kWh/kWp P50 · ${n(s.yieldP90)} P90`],
    ['Generation, year 1', `${n(s.kwh / 1000, 1)} MWh P50 · ${n(s.kwhP90 / 1000, 1)} MWh P90`],
    ['Generation, 25 years', `${n(s.lifetimeKwh / 1e6, 2)} GWh (0.5 %/yr degradation)`],
    ['Onsite use (annual demand proxy)', s.economicsReady === false ? 'Host demand required' : `${n(s.selfRatio * 100)} %; interval matching unverified`],
    ['CAPEX', `RM ${n(s.capex)}`],
    ['Illustrative annual bill reduction', s.economicsReady === false ? 'Withheld: link host demand and tariff first' : `RM ${n(s.savings)} (assumed export value ${a.exportSMP} RM/kWh)`],
    ['Assumed annual upkeep', `RM ${n(s.om || 0)}`],
    ['Simple payback (after assumed upkeep)', s.economicsReady === false ? 'Host data required' : `${n(s.payback, 1)} years`],
    ['Demand basis', `${esc(s.demandSource || 'Category estimate')} · ${n(s.demand)} kWh/yr`],
    ...(s.evidence?.source ? [['User-provided evidence', esc(s.evidence.source)]] : []),
    ['CO₂ avoided', `${n(s.co2, 1)} t/yr · ${n((s.lifetimeKwh * a.emissionFactor) / 1000, 0)} t over 25 years`],
    ['Nearest mapped substation', s.gridDistM == null ? 'none mapped' : `${n(s.gridDistM)} m`],
    ['Model priority (heuristic)', `${n(s.score)} / 100; close scores indicate similar priority`],
    ['Existing panels', `${esc(roofStatus(s).label)}. ${esc(roofStatus(s).note)}`],
    ['Panel-check source', esc(roofStatus(s).source)],
    ['Property control', esc(CONTROL_LABELS[s.studyReview?.control] || CONTROL_LABELS.unknown)],
    ['SDP asset / project ID', esc(s.studyReview?.assetId || 'Not recorded')],
    ['Study stage', esc(STAGE_LABELS[s.studyReview?.stage] || STAGE_LABELS.screening)],
    ['Responsible person', esc(s.studyReview?.responsible || 'Unassigned')],
    ['Next action', esc(s.studyReview?.nextAction || nextSiteCheck(s))],
    ['Selection rationale', esc(s.studyReview?.rationale || 'Not recorded')],
    ['Study reference', esc(s.studyReview?.reference || 'Not recorded')]
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
<h2>Checks before a feasibility study</h2><ul>${studyChecks(s).map(check => `<li>${esc(check)}</li>`).join('')}</ul>
<h2>Method and limits</h2>
<p class="note">Pre-feasibility only, not a bankable estimate: a bankable design needs a site survey, structural check and an independent engineer
(e.g. PVsyst or HelioScope from this site's exported outline). Footprint and type: © OpenStreetMap contributors (ODbL). Yield: ${esc(yieldSource || 'fallback assumption')}.
Shading: line-of-sight raycast against neighbouring buildings. Tariffs, SMP, CAPEX and per-kW charges are editable assumptions: verify against TNB, SEDA and Suruhanjaya Tenaga before use.</p>
</body></html>`;
}

export function studyBriefHTML(sites, { township, assumptions, osmSnapshot, yieldSource, twinFor = null }) {
  const summary = studySummary(sites);
  const title = 'Solar feasibility study shortlist';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
body{font:14px/1.55 system-ui,sans-serif;color:#20272b;max-width:1000px;margin:32px auto;padding:0 24px;background:white}h1{font-size:28px;letter-spacing:-.02em;margin:0}h2{font-size:19px;margin:28px 0 8px}h3{font-size:15px;margin:20px 0 8px}.note{color:#56616a;font-size:12px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #dce2e6;padding:10px 8px;vertical-align:top;overflow-wrap:anywhere}th{background:#f2f5f4}button{font:inherit;padding:10px 16px;cursor:pointer;margin-bottom:20px}section{break-inside:avoid;border-top:1px solid #b7c5bf;margin-top:24px}li{margin:6px 0}.summary{padding:16px 0;border-bottom:1px solid #dce2e6}.excluded{color:#8c3521}details{margin:24px 0}@media print{button,details{display:none}body{margin:0;max-width:none;font-size:11px}thead{display:table-header-group}table{font-size:10px}a{color:inherit;text-decoration:none}section{break-inside:auto}h2,h3{break-after:avoid}}@media(max-width:640px){body{padding:0 14px;margin:20px auto}.table-wrap{overflow:auto}}
</style></head><body><button onclick="print()">Save study brief as PDF / print</button><h1>${title}</h1><p>${esc(township)} · ${new Date().toISOString().slice(0, 10)}</p><p class="note">Screening handover, not an approved design or quotation. Saved selections may include sites that have since been excluded. Professional assessment and independent shortlist validation remain pending.</p>
<div class="summary"><b>${summary.active} active candidates · ${n(summary.kwp / 1000, 2)} MWp · ${n(summary.kwh / 1000)} MWh/year</b><p>Illustrative installation cost: RM ${n(summary.capex)} · modelled avoided emissions: ${n(summary.co2)} t/year.</p><p class="note">Totals omit ${summary.excluded} excluded and ${summary.onHold} on-hold sites. ${summary.unresolvedSolar} active sites need existing-panel checks; ${summary.unknownControl} need property-control confirmation; ${summary.unresolvedEconomics} need host-load data. Installation cost is not the study budget.</p></div>
<h2>Selected sites</h2><div class="table-wrap"><table><thead><tr><th>Site / priority</th><th>Modelled output</th><th>Evidence status</th><th>Next action</th></tr></thead><tbody>${sites.map(s => `<tr><td><b>${esc(s.name || s.categoryLabel)}</b><br>${esc(s.id)}<br>${n(s.score)}/100${s.excluded ? '<br><b class="excluded">Excluded from new-installation ranking</b>' : ''}</td><td>${n(s.kwp, 1)} kWp<br>${n(s.kwh / 1000)} MWh/year<br>${s.economicsReady === false ? 'Host financial data missing' : 'Financial inputs are illustrative'}</td><td>${esc(roofStatus(s).label)}<br>${esc(CONTROL_LABELS[s.studyReview?.control] || CONTROL_LABELS.unknown)}</td><td>${esc(s.studyReview?.nextAction || nextSiteCheck(s))}<br>${esc(s.studyReview?.responsible || 'Unassigned')} · ${esc(STAGE_LABELS[s.studyReview?.stage] || STAGE_LABELS.screening)}</td></tr>`).join('')}</tbody></table></div>
${sites.map(s => `<section><h2>${esc(s.name || s.categoryLabel)}</h2><p><a href="https://www.openstreetmap.org/${esc(s.id)}">${esc(s.id)}</a> · ${esc(s.categoryLabel)}</p><p><b>Existing panels:</b> ${esc(roofStatus(s).note)}<br><span class="note">${esc(roofStatus(s).source)}</span></p><p><b>Selection rationale:</b> ${esc(s.studyReview?.rationale || 'Not recorded')}<br><b>Next action:</b> ${esc(s.studyReview?.nextAction || nextSiteCheck(s))}<br><b>Reference:</b> ${esc(s.studyReview?.reference || 'Not recorded')}<br><b>Asset / project:</b> ${esc(s.studyReview?.assetId || 'Not recorded')}</p>${twinFor && !s.excluded ? `<p><b>3D twin:</b> ${twinText(twinFor(s))}</p>` : ''}${s.studyReview?.selectedAt ? `<p class="note">First selected ${esc(s.studyReview.selectedAt.slice(0,10))}: model priority ${n(s.studyReview.selectedScore,1)}, ${n(s.studyReview.selectedKwh / 1000)} MWh/year. Current values may differ after recalculation.</p>` : ''}<h3>Evidence and remaining checks</h3><ul>${studyChecks(s).map(check => `<li>${esc(check)}</li>`).join('')}</ul></section>`).join('')}
<h2>Model and data record</h2><p class="note">OSM snapshot: ${esc(osmSnapshot || 'Not recorded')}. Yield source: ${esc(yieldSource)}. Shadow exposure samples four dates against estimated buildings and is a screening proxy applied to yield, not measured annual irradiation. Actual roof planes, trees, equipment, interval demand, structure and permissions require site assessment. No completed independent expert comparison is claimed.</p><details><summary>All scenario assumptions</summary></details><table><thead><tr><th>Assumption</th><th>Value</th></tr></thead><tbody>${Object.entries(assumptions).map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`).join('')}</tbody></table></body></html>`;
}
