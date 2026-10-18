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
  utility: 'Utility asset (not SDP)',
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
  utility: 6.5,
  unknown: 8
};

// How far to trust each height source (same scale as the pipeline's height_confidence).
const CONFIDENCE = { tag: 0.9, levels: 0.7, estimated: 0.3 };

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
  if (h) return { height: h, levels: Math.max(1, Math.round(h / STOREY_HEIGHT_M)), heightSource: 'OSM height tag', heightConfidence: CONFIDENCE.tag };
  const lv = num(tags['building:levels']);
  if (lv) return { height: lv * STOREY_HEIGHT_M + 1, levels: Math.round(lv), heightSource: 'OSM levels tag', heightConfidence: CONFIDENCE.levels };
  let height = DEFAULT_HEIGHT[category] ?? DEFAULT_HEIGHT.unknown;
  // Big-box industrial/retail sheds get a little taller with size.
  if ((category === 'industrial' || category === 'retail') && areaM2 > 8000) height += 3;
  return { height, levels: Math.max(1, Math.round(height / STOREY_HEIGHT_M)), heightSource: 'Estimated from building type', heightConfidence: CONFIDENCE.estimated };
}
