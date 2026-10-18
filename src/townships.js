// Sime Darby Property townships used in the demo. The app loads public/data/<id>.json,
// written by the solar-mapper pipeline (`solar-mapper run --township <id>`).
// bbox = [south, west, north, east] (Overpass order)
export const TOWNSHIPS = {
  elmina: {
    name: 'City of Elmina',
    bbox: [3.149, 101.487, 3.25, 101.53],
    view: { longitude: 101.513, latitude: 3.19, zoom: 14.4, pitch: 55, bearing: -20 }
  },
  'ara-damansara': {
    name: 'Ara Damansara',
    bbox: [3.095, 101.565, 3.125, 101.6],
    view: { longitude: 101.5825, latitude: 3.11, zoom: 15.2, pitch: 55, bearing: -20 }
  },
  'bandar-bukit-raja': {
    name: 'Bandar Bukit Raja',
    // Mapped "Bandar Bukit Raja" outline (pipeline/config/townships/bandar-bukit-raja.yaml).
    bbox: [3.075, 101.41, 3.112, 101.47],
    view: { longitude: 101.44, latitude: 3.094, zoom: 14.5, pitch: 55, bearing: -20 }
  }
};
