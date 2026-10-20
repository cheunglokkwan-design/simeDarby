// Affordable-housing blocks as CREAM lease-income candidates (the brief's
// PEOPLE theme): the roof lease puts income into lower-income households.
//
// OSM rarely tags affordability, so detection is by scheme name on residential
// buildings, plus a hand-kept list for blocks known from site visits or SDP's
// own records (e.g. Pangsapuri Harmoni in Elmina once that township is added).

const SCHEME_NAMES =
  /pangsapuri|rumah pangsa|\bppr\b|program perumahan rakyat|rumah selangorku|mampu milik|kos rendah|kos sederhana|residensi wilayah|pr1ma|rumah idaman|\bharmoni\b/i;

// OSM ids ("way/123") of affordable blocks that are not named as such in OSM.
export const AFFORDABLE_IDS = new Set([]);

export function isAffordable(s) {
  if (s.category !== 'apartments' && s.category !== 'residential') return false;
  return AFFORDABLE_IDS.has(s.id) || SCHEME_NAMES.test(s.name || '');
}
