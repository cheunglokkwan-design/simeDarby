const KEY = 'solar-site-evidence-v1';
export function loadEvidence() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function persistEvidence(evidence) {
  try { localStorage.setItem(KEY, JSON.stringify(evidence)); }
  catch { throw new Error('The corrections could not be saved. Allow browser storage or free some space and retry.'); }
}
export function validateEvidence(values, footprintArea) {
  const result = {};
  const fields = { occupiedStoreys: [1, 200], annualKwh: [1, 1e12], peakKw: [.01, 500000], usableM2: [.01, footprintArea] };
  for (const [key, [minimum, maximum]] of Object.entries(fields)) {
    if (values[key] === '' || values[key] == null) continue;
    const number = Number(values[key]);
    if (!Number.isFinite(number) || number < minimum || number > maximum || (key === 'occupiedStoreys' && !Number.isInteger(number))) {
      throw new Error(key === 'usableM2' ? 'Usable roof area must be positive and no larger than the mapped footprint.' : `Enter a valid ${key === 'annualKwh' ? 'annual electricity use' : key === 'peakKw' ? 'metered peak demand' : 'occupied floor count'}.`);
    }
    result[key] = number;
  }
  result.source = String(values.source || '').trim().slice(0, 300);
  if (Object.keys(result).length > 1 && !result.source) throw new Error('Describe the bill, survey or inspection these corrections come from.');
  return result;
}
