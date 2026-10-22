export function siteAddress(site) {
  const tags = site.tags || {};
  return [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'], tags['addr:city']].filter(Boolean).join(' ');
}
export function searchSites(sites, query) {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return sites;
  return sites.filter((site) => {
    const text = [site.name, site.id, site.categoryLabel, siteAddress(site), site.tags?.['addr:postcode']].filter(Boolean).join(' ').toLocaleLowerCase();
    return tokens.every((token) => text.includes(token));
  });
}
