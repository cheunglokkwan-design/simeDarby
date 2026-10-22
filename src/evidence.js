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
  const hostSiteId = String(values.hostSiteId || '').trim().slice(0, 100);
  if (hostSiteId) result.hostSiteId = hostSiteId;
  for (const [key, maximum] of [['daytimeShare', 1], ['hostTariff', 10]]) {
    if (values[key] === '' || values[key] == null) continue;
    const number = Number(values[key]);
    if (!Number.isFinite(number) || number <= 0 || number > maximum) throw new Error(key === 'daytimeShare' ? 'Enter the host daytime demand fraction above 0 and at most 1.' : 'Enter a host energy tariff above 0 and at most RM 10/kWh.');
    result[key] = number;
  }
  if (hostSiteId || result.daytimeShare || result.hostTariff) {
    if (!hostSiteId || !result.annualKwh || !result.daytimeShare || !result.hostTariff) throw new Error('Link a host using its site ID, annual electricity use, daytime share and energy tariff together.');
  }
  result.source = String(values.source || '').trim().slice(0, 300);
  if (Object.keys(result).length > 1 && !result.source) throw new Error('Describe the bill, survey or inspection these corrections come from.');
  return result;
}

export function validateSolarCheck(values) {
  const status = String(values.solarStatus || '');
  if (!['', 'checked-clear', 'unclear', 'existing-solar', 'partial-solar', 'not-buildable'].includes(status)) throw new Error('Choose a recognised roof inspection status.');
  if (!status) return { solarStatus: '', solarSource: '', solarDate: '' };
  const source = String(values.solarSource || '').trim().slice(0, 300);
  const date = String(values.solarDate || '');
  if (!source || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Add the inspection source and a valid review date.');
  return { solarStatus: status, solarSource: source, solarDate: date };
}
