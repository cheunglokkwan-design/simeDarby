// Roofs checked against satellite imagery, so sites that already have solar,
// or that no longer exist, don't appear as new opportunities.
//
// OpenStreetMap barely records rooftop solar in Malaysia (none in Bandar Bukit
// Raja), so these come from a visual check of Esri World Imagery for the
// top-ranked business roofs. Add a site here after checking it.
export const ROOF_CHECK_DATE = '2026-10-22';
export const ROOF_CHECK_SOURCE = 'Esri World Imagery, visual check of the top-ranked business roofs';

export const ROOF_CHECKS = {
  // Ara Damansara
  'way/780152646': { status: 'existing-solar', note: 'Citta Mall: panel arrays on two roof sections' },
  'way/895155135': { status: 'existing-solar', note: "Lotus's: large array across most of the roof" },
  'way/822267144': { status: 'existing-solar', note: 'SD Guthrie Berhad: panels on several roof sections' },
  'way/895155121': { status: 'existing-solar', note: 'Industrial building: rows of panels on the main roof' },
  'way/1230534983': { status: 'partial-solar', note: 'Commercial block: panels on the northern section only' },
  'way/424883122': { status: 'unclear', note: 'Evolve Concept Mall: dark patches could be panels or skylights' },
  'way/150430869': { status: 'unclear', note: 'Kelana Mall: small dark rows could be panels or skylights' },
  'way/1133036255': { status: 'not-buildable', note: 'Construction site: towers being built, no finished roof' },
  'way/895155128': { status: 'not-buildable', note: 'Raya Complex: empty lot in imagery, the mapped building is gone' },
  // Bandar Bukit Raja
  'way/827024756': { status: 'existing-solar', note: 'Econsave: roof fully covered with panels' }
};

export const ROOF_FLAGS = {
  'existing-solar': 'Already has solar',
  'partial-solar': 'Partly covered by solar',
  'not-buildable': 'Not buildable (imagery check)'
};

// Flags that remove a site from the opportunity ranking and headline totals.
export const EXCLUDING_FLAGS = ['Too small', ROOF_FLAGS['existing-solar'], ROOF_FLAGS['partial-solar'], ROOF_FLAGS['not-buildable']];

export function roofCheck(s) {
  const checked = ROOF_CHECKS[s.id];
  if (checked) return { ...checked, source: `${ROOF_CHECK_SOURCE}, ${ROOF_CHECK_DATE}` };
  if (s.tags?.['roof:material'] === 'solar_panels' || s.tags?.['generator:source'] === 'solar')
    return { status: 'existing-solar', note: 'Tagged as solar in OpenStreetMap', source: 'OpenStreetMap' };
  return null;
}
