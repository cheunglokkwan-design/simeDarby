// Behind-the-meter battery siting. Candidates are commercial and industrial
// sites whose roofs exceed the ATAP cap or their daytime demand. Each is sized
// and valued from NREL PySAM dispatch runs (scripts/pysam_storage.py) on load
// archetypes, scaled to the site's peak kW.

const ARCHETYPE = { retail: 'retail', commercial: 'commercial', institutional: 'commercial', industrial: 'industrial' };
const MIN_PEAK_KW = 200;
const NFPA_INDOOR_KWH = 50; // NFPA 855: larger systems in shared buildings need separation / large-scale fire tests

const nearestKey = (obj, v) =>
  Object.keys(obj).reduce((best, k) => (Math.abs(+k - v) < Math.abs(+best - v) ? k : best));

export function planStorage(sites, a, storageData) {
  if (!storageData) return [];
  const out = [];
  for (const s of sites) {
    const kind = ARCHETYPE[s.category];
    if (!kind || s.flags.includes('Too small')) continue;
    const peakKw = s.demand / (8760 * a.loadFactor);
    if (peakKw < MIN_PEAK_KW) continue;
    const surplus = s.atapCapped || s.exported > 0.1 * s.kwh;
    if (!surplus) continue;

    const byPv = storageData.archetypes[kind];
    const runs = byPv[nearestKey(byPv, s.kwp / peakKw)];
    const tariff = s.category === 'industrial' ? a.tariffIndustrial : a.tariffCommercial;
    let best = null;
    for (const [ratio, r] of Object.entries(runs)) {
      const kw = +ratio * peakKw;
      const kwh = kw * storageData.durationH;
      const peakCutKw = r.peakCutKwPerKwPeak * peakKw;
      const demandValue = peakCutKw * (a.capacityCharge + a.networkCharge) * 12;
      const shiftValue = r.pvShiftedKwhPerKwPeak * peakKw * Math.max(0, tariff - a.exportSMP);
      const value = demandValue + shiftValue;
      const capex = kwh * a.batteryCapexPerKwh;
      const payback = value > 0 ? capex / value : Infinity;
      if (!best || payback < best.payback)
        best = { kw, kwh, peakCutKw, demandValue, shiftValue, value, capex, payback, cycles: r.cycles };
    }
    if (!best || best.peakCutKw <= 0) continue;

    const checks = {
      grid: s.gridDistM == null ? 'unknown (no substation mapped)' : s.gridDistM <= a.gridMaxM ? `ok (${Math.round(s.gridDistM)} m)` : `far (${Math.round(s.gridDistM)} m)`,
      flood: 'not checked: needs JPS flood-hazard map',
      fire: best.kwh > NFPA_INDOOR_KWH ? 'outdoor container; NFPA 855 / Bomba review' : 'indoor allowed with 3 ft clearance',
      space: 'car-park corner or plant area, not panel roof space'
    };
    out.push({ site: s, archetype: kind, peakKw, ...best, checks });
  }
  return out.sort((x, y) => y.value - x.value);
}
