import { roofStatus } from './roof-checks.js';
import { nextSiteCheck } from './study.js';

const KEY = 'solar-study-shortlists-v1';

export function loadShortlists(storage = globalThis.localStorage) {
  try {
    const data = JSON.parse(storage.getItem(KEY) || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, ids]) => Array.isArray(ids))
      .map(([township, ids]) => [township, [...new Set(ids.filter(id => typeof id === 'string'))]]));
  } catch { return {}; }
}

export function updateShortlist(shortlists, township, id, include) {
  const ids = new Set(shortlists[township] || []);
  if (include) ids.add(id); else ids.delete(id);
  return { ...shortlists, [township]: [...ids] };
}

export function persistShortlists(shortlists, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(shortlists)); }
  catch { throw new Error('Shortlist could not be saved. Allow browser storage or free space and retry.'); }
}

export function selectedSites(sites, shortlists, township) {
  const ids = new Set(shortlists[township] || []);
  return sites.filter(site => ids.has(site.id)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function studyChecks(site) {
  return [
    ...(site.flags || []).filter(flag => flag !== 'Too small'),
    `Existing solar: ${roofStatus(site).label}. ${roofStatus(site).note} Source: ${roofStatus(site).source}`,
    site.category === 'carpark' ? 'Canopy structure, traffic clearance and host electricity demand need assessment' : 'Roof structure, condition, obstacles and access need assessment',
    site.evidence?.usableM2 ? 'User-reported usable area needs independent measurement' : 'Usable area is assumed from the mapped footprint; survey needed',
    site.evidence?.annualKwh ? 'User-reported consumption needs bill and interval-data verification' : site.category === 'carpark' || site.category === 'canopy' ? 'No host load is linked; verify host connection, bills and interval demand' : 'Demand uses a category proxy; bills and interval data needed',
    'Property control, permissions and utility connection need independent confirmation',
    'Shortlist has not been compared with an independent expert assessment'
  ];
}

export function shortlistCSV(sites, ranked, township, expertTemplate = false) {
  const ranks = new Map(ranked.map((site, index) => [site.id, index + 1]));
  const headings = ['township', 'site_id', 'name', 'category', 'model_rank', 'model_priority_100', 'footprint_m2', 'usable_m2', 'usable_area_basis', 'model_sun_exposure_pct', 'system_kwp', 'generation_kwh_year', 'demand_kwh_year', 'demand_basis', 'payback_years', 'checks_before_study', 'user_evidence_source', 'status'];
  headings.push('existing_solar_status', 'existing_solar_note', 'existing_solar_source', 'existing_solar_check_date', 'excluded_from_ranking', 'economics_status', 'asset_id', 'control_status', 'study_stage', 'responsible', 'next_action', 'selection_rationale', 'study_reference', 'review_updated_at', 'selected_at', 'priority_when_selected', 'generation_when_selected_kwh');
  if (expertTemplate) headings.push('expert_rank', 'expert_suitability', 'expert_source_reference', 'expert_notes');
  const rows = sites.map(site => {
    const review = site.studyReview || {}, check = roofStatus(site);
    return [township, site.id, site.name || '', site.category, ranks.get(site.id) || '', site.score.toFixed(1), site.area.toFixed(1), site.usable.toFixed(1), site.evidence?.usableM2 ? 'User-reported; unverified' : 'Category fraction of mapped footprint', ((site.energyShading ?? site.shading ?? 1) * 100).toFixed(1), site.kwp.toFixed(2), site.kwh.toFixed(0), site.demand.toFixed(0), site.demandSource || 'Category estimate', Number.isFinite(site.payback) ? site.payback.toFixed(1) : '', studyChecks(site).join('; '), site.evidence?.source || '', 'Screening shortlist; not approved or independently validated', check.status, check.note, check.source, check.date, !!site.excluded, site.economicsReady === false ? 'Host load and tariff required' : 'Illustrative scenario', review.assetId || '', review.control || 'unknown', review.stage || 'screening', review.responsible || '', review.nextAction || nextSiteCheck(site), review.rationale || '', review.reference || '', review.updatedAt || '', review.selectedAt || '', review.selectedScore ?? '', review.selectedKwh ?? '', ...(expertTemplate ? ['', '', '', ''] : [])];
  });
  const escape = value => {
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headings, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
}
