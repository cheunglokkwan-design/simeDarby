// CREAM planner: an aggregator leases landed-home roofs and sells the output to
// buyers within a set radius over TNB's network, paying a per-kWh access charge.
// Mirrors SDP and GSPARX's Elmina pilot (April 2025).
import { distanceM } from './geo.js';
import { DAYTIME_SHARE } from './solar.js';

const CELL_DEG = 0.005; // ~550 m clustering grid
const BUYER_CATEGORIES = new Set(['retail', 'commercial', 'industrial', 'institutional', 'apartments']);

export function planCream(sites, a) {
  const homes = sites.filter((s) => s.category === 'residential' && !s.flags.includes('Too small'));

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
  const clusters = [...cells.values()]
    .filter((hs) => count(hs) >= a.creamMinHomes)
    .map((hs) => {
      const position = [
        hs.reduce((t, h) => t + h.position[0], 0) / hs.length,
        hs.reduce((t, h) => t + h.position[1], 0) / hs.length
      ];
      // Leased roofs are sized to the roof, not to the household's own use.
      return { homes: hs, homeCount: count(hs), position, kwp: hs.reduce((t, h) => t + h.roofKwp, 0), kwh: hs.reduce((t, h) => t + h.roofKwh, 0) };
    })
    .sort((x, y) => y.kwh - x.kwh);

  // Greedy allocation: biggest clusters first, nearest buyers first, so no
  // buyer's demand is counted twice.
  const remaining = new Map(buyers.map((b) => [b, b.residual]));
  const radiusM = a.creamRadiusKm * 1000;
  const price = a.tariffCommercial * (1 - a.creamDiscount);

  clusters.forEach((c, i) => {
    c.id = `C${i + 1}`;
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
      c.buyers.push({ site: b.site, kwh: take, dist });
    }
    c.matchedKwh = c.kwh - need;
    c.unmatchedKwh = need;
    c.revenue = c.matchedKwh * price + c.unmatchedKwh * a.exportSMP;
    c.accessCost = c.matchedKwh * a.accessCharge;
    c.leaseCost = c.homeCount * a.leasePerRoof;
    c.net = c.revenue - c.accessCost - c.leaseCost;
    c.capex = c.kwp * a.capexSmall;
    c.payback = c.net > 0 ? c.capex / c.net : Infinity;
    c.co2 = (c.kwh * a.emissionFactor) / 1000;
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
      leaseIncome: sum('leaseCost'),
      co2: sum('co2')
    }
  };
}
