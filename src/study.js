import { roofStatus } from './roof-checks.js';

const KEY = 'solar-study-reviews-v1';
export const CONTROL_LABELS = { unknown: 'Control not confirmed', controlled: 'SDP-controlled · reported', managed: 'SDP-managed · reported', thirdparty: 'Third-party property · reported' };
export const STAGE_LABELS = { screening: 'Screening', 'evidence-needed': 'Gathering evidence', 'ready-for-review': 'Ready for professional review', 'on-hold': 'On hold' };
export function loadStudyReviews(storage = globalThis.localStorage) {
  try {
    const data = JSON.parse(storage.getItem(KEY) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
export function persistStudyReviews(reviews, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(reviews)); }
  catch { throw new Error('Study notes could not be saved. Allow browser storage or free space and retry.'); }
}
export const studyKey = (township, id) => `${township}:${id}`;
export function validateStudyReview(values) {
  return {
    control: Object.hasOwn(CONTROL_LABELS, values.control) ? values.control : 'unknown',
    stage: Object.hasOwn(STAGE_LABELS, values.stage) ? values.stage : 'screening',
    ...Object.fromEntries(['assetId', 'responsible', 'nextAction', 'reference', 'rationale'].map(key => [key, String(values[key] || '').trim().slice(0, key === 'assetId' || key === 'responsible' ? 100 : 500)])),
    updatedAt: new Date().toISOString()
  };
}
export function nextSiteCheck(site) {
  if (site.excluded) return 'Excluded from new-installation ranking; review saved selection';
  if (site.roofCheck?.status === 'unclear') return 'Resolve possible existing panels in imagery';
  if (site.economicsReady === false) return 'Link the host building, load and tariff';
  if (!site.roofCheck) return 'Check existing panels and roof condition';
  if (!site.evidence?.annualKwh) return 'Obtain bills and daytime load data';
  return 'Confirm access, structure and utility connection';
}
export function studySummary(sites) {
  const active = sites.filter(site => !site.excluded && site.studyReview?.stage !== 'on-hold');
  const sum = key => active.reduce((total, site) => total + (Number.isFinite(site[key]) ? site[key] : 0), 0);
  return { count: sites.length, active: active.length, excluded: sites.filter(s => s.excluded).length, onHold: sites.filter(s => !s.excluded && s.studyReview?.stage === 'on-hold').length, kwp: sum('kwp'), kwh: sum('kwh'), co2: sum('co2'), capex: sum('capex'), unresolvedSolar: active.filter(site => ['unknown', 'unclear'].includes(roofStatus(site).status)).length, unknownControl: active.filter(site => !site.studyReview?.control || site.studyReview.control === 'unknown').length, unresolvedEconomics: active.filter(site => site.economicsReady === false).length };
}
