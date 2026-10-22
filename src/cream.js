// CREAM planner: an aggregator leases landed-home roofs and sells the output to
// Preliminary geographic screening, not approved CREAM plants or feeder zones.
// Actual eligibility needs confirmed connecting substations, feeders and titles.
import { distanceM } from './geo.js';
import { DAYTIME_SHARE } from './solar.js';

const CELL_DEG = 0.005; // ~550 m clustering grid
const BUYER_CATEGORIES = new Set(['retail', 'commercial', 'industrial', 'institutional', 'apartments']);

export function planCream(sites, a) {
  const homes = sites.filter((s) => s.category === 'residential' && !s.flags.includes('Too small') &&
    !['dormitory', 'townhouse', 'apartments'].includes(s.tags?.building));

  // Each buyer can absorb the daytime demand its own rooftop solar leaves unmet.
  const buyers = sites
    .filter((s) => BUYER_CATEGORIES.has(s.category))
    .map((s) => ({ site: s, residual: Math.max(0, s.demand * DAYTIME_SHARE[s.category] - s.selfUse) }))
    .filter((b) => b.residual > 50000); // > 50 MWh/yr of spare daytime demand

  const cells = new Map();
  for (const h of homes) {
    const k = `${Math.floor(h.position[0] / CELL_DEG)}:${Math.floor(h.position[1] / CELL_DEG)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(h);
  }

  const count = (hs) => hs.reduce((t, h) => t + (h.homes || 1), 0); // terrace rows hold several homes
  const clusters = [...cells.entries()].sort(([a], [b]) => a.localeCompare(b))
    .filter(([, hs]) => count(hs) >= a.creamMinHomes)
    .map(([cell, hs], i) => {
      const position = [
        hs.reduce((t, h) => t + h.position[0], 0) / hs.length,
        hs.reduce((t, h) => t + h.position[1], 0) / hs.length
      ];
      // Leased roofs are sized to the roof, not to the household's own use.
      return { id: `C${cell.replace(':', '-')}`, number: i + 1, cell,
        homes: hs, homeCount: count(hs), position, kwp: hs.reduce((t, h) => t + h.roofKwp, 0), kwh: hs.reduce((t, h) => t + h.roofKwh, 0) };
    })
    .sort((x, y) => y.kwh - x.kwh);

  // Greedy allocation: biggest clusters first, nearest buyers first, so no
  // buyer's demand is counted twice.
  const remaining = new Map(buyers.map((b) => [b, b.residual]));
  const radiusM = a.creamRadiusKm * 1000;

  clusters.forEach((c) => {
    let need = c.kwh;
    c.buyers = [];
    const near = buyers
      .map((b) => ({ b, dist: distanceM(c.position, b.site.position) }))
      .filter((x) => x.dist <= radiusM)
      .sort((x, y) => x.dist - y.dist);
    for (const { b, dist } of near) {
      if (need <= 0) break;
      const take = Math.min(need, remaining.get(b));
      if (take <= 0) continue;
      remaining.set(b, remaining.get(b) - take);
      need -= take;
      const tariff = b.site.category === 'industrial' ? a.tariffIndustrial : b.site.category === 'apartments' ? a.tariffResidential : a.tariffCommercial;
      c.buyers.push({ site: b.site, kwh: take, dist, price: tariff * (1 - a.creamDiscount) });
    }
    c.matchedKwh = c.kwh - need;
    c.unmatchedKwh = need;
    // No revenue assumed for uncontracted surplus. CREAM is not Solar ATAP;
    // NEDA compensation is conditional, and ordinary imbalance may be unpaid.
    c.revenue = c.buyers.reduce((sum, b) => sum + b.kwh * b.price, 0);
    c.accessCost = c.matchedKwh * a.accessCharge;
    c.leaseCost = c.homeCount * a.leasePerRoof;
    c.net = c.revenue - c.accessCost - c.leaseCost;
    c.capex = c.kwp * a.capexSmall;
    c.payback = c.net > 0 ? c.capex / c.net : Infinity;
    c.co2 = (c.kwh * a.emissionFactor) / 1000;
    c.checks = ['Grid connections and 5 km substation rule unverified', 'Ownership and landed-house eligibility unverified'];
    if (c.kwp < 100) c.checks.push('Below the 100 kWp minimum plant size');
    if (c.kwp > 2000) c.checks.push('Exceeds 2 MWp; feeder allocation and plant split required');
    else c.checks.push('2 MWp cumulative feeder limit unverified');
    if (c.unmatchedKwh > 1) c.checks.push(`${Math.round(c.unmatchedKwh / c.kwh * 100)}% of generation has no matched buyer`);
  });

  // Affordable-housing blocks: lease income at the same rate per kWp as landed homes.
  const homeKwp = homes.length ? homes.reduce((t, h) => t + h.roofKwp, 0) / count(homes) : 10;
  const leasePerKwp = a.leasePerRoof / homeKwp;
  const affordable = sites
    .filter((s) => s.affordable && !s.flags.includes('Too small'))
    .map((s) => ({ site: s, kwp: s.kwp, kwh: s.kwh, leaseIncome: s.kwp * leasePerKwp }))
    .sort((x, y) => y.leaseIncome - x.leaseIncome);

  const sum = (k) => clusters.reduce((t, c) => t + c[k], 0);
  return {
    clusters,
    affordable,
    totals: {
      clusters: clusters.length,
      homes: clusters.reduce((t, c) => t + c.homeCount, 0),
      kwp: sum('kwp'),
      kwh: sum('kwh'),
      matchedKwh: sum('matchedKwh'),
      unmatchedKwh: sum('unmatchedKwh'),
      leaseIncome: sum('leaseCost'),
      co2: sum('co2')
    }
  };
}
