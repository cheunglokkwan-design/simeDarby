// Classify OSM buildings and estimate heights for 3D extrusion.
//
// Height priority: explicit `height` tag -> `building:levels` x storey height
// -> default by building type -> inference from footprint size for untyped
// (`building=yes`) buildings. Every estimate records its source so the UI can
// show how confident it is.

export const STOREY_HEIGHT_M = 3.2;

const TYPE_MAP = {
  residential: ['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'bungalow', 'dormitory'],
  apartments: ['apartments', 'condominium'],
  retail: ['retail', 'supermarket', 'kiosk', 'mall'],
  commercial: ['commercial', 'office', 'hotel'],
  industrial: ['industrial', 'warehouse', 'factory', 'manufacture', 'service'],
  institutional: [
    'school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'civic', 'public', 'government',
    'train_station', 'transportation', 'mosque', 'musalla', 'church', 'temple', 'religious', 'community_centre'
  ],
  canopy: ['roof', 'carport', 'garage', 'garages', 'shed', 'hut']
};
const TYPE_LOOKUP = Object.fromEntries(Object.entries(TYPE_MAP).flatMap(([cat, ts]) => ts.map((t) => [t, cat])));

export const CATEGORY_LABEL = {
  residential: 'Residential (landed)',
  apartments: 'Residential (high-rise)',
  retail: 'Retail',
  commercial: 'Commercial / office',
  industrial: 'Industrial',
  institutional: 'Public / institutional',
  canopy: 'Canopy / outbuilding',
  carpark: 'Car park (canopy)',
  unknown: 'Unclassified'
};

// Default heights (m) when OSM has no height or levels.
const DEFAULT_HEIGHT = {
  residential: 7.5,
  apartments: 36,
  retail: 10,
  commercial: 14,
  industrial: 11,
  institutional: 11,
  canopy: 4,
  unknown: 8
};

export function classify(tags, areaM2) {
  const b = tags.building;
  if (TYPE_LOOKUP[b]) return TYPE_LOOKUP[b];
  if (tags.shop) return 'retail';
  if (tags.office) return 'commercial';
  if (tags.amenity) return 'institutional';
  if (tags.industrial || tags.landuse === 'industrial') return 'industrial';
  // building=yes: infer from footprint. Large footprints in Klang Valley
  // townships are almost always factories, warehouses or malls.
  if (areaM2 > 4000) return 'industrial';
  if (areaM2 > 0 && areaM2 < 250) return 'residential';
  return 'unknown';
}

const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function estimateHeight(tags, category, areaM2) {
  const h = num(tags.height);
  const lv = num(tags['building:levels']);
  // Occupied floors determine load; visual roof height must never invent floors.
  const floors = { levels: lv ? Math.max(1, Math.round(lv)) : 1,
    levelsSource: lv ? 'OSM building:levels tag' : 'One occupied storey assumed; floor count unknown' };
  if (h) return { height: h, ...floors, heightSource: 'OSM height tag' };
  if (lv) return { height: lv * STOREY_HEIGHT_M + 1, ...floors, heightSource: 'OSM levels tag' };
  let height = DEFAULT_HEIGHT[category] ?? DEFAULT_HEIGHT.unknown;
  // Big-box industrial/retail sheds get a little taller with size.
  if ((category === 'industrial' || category === 'retail') && areaM2 > 8000) height += 3;
  return { height, ...floors, heightSource: 'Estimated from building type' };
}
