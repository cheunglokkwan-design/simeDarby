# Community-solar zoning audit

Audited 22 October 2026. The map contains proposed geographic groups, not legal,
cadastral, ownership or electricity-feeder boundaries.

## Corrected

- Zone IDs now use grid-cell identity, so changing generation ranking does not
  move an existing selection onto another group.
- Buyer demand is allocated once across groups. Buyer prices use the buyer's
  category tariff rather than a single commercial tariff.
- Unmatched generation earns no assumed revenue; the Solar ATAP export-price
  assumption is no longer reused for community-solar surplus.
- Groups show capacity and grid checks. Known dormitory, townhouse and apartment
  building tags are excluded as generating roofs.
- Zone fills sit beneath building interaction layers; zone labels remain
  selectable and individual roofs can open household options.

## Remaining limits

The roughly 550 m grid and convex outlines can cross roads and estates. Counts
can be inferred from terrace-row area, and generic building classification does
not establish landed-house eligibility or ownership. Neither SDP ownership nor
homeowner participation is known from these snapshots.

Buyer distance is a preliminary centre-to-building search. CREAM uses connecting
utility substations for the distance rule, and the capacity ceiling is cumulative
per feeder. These connections are unavailable, so no group is marked approved.
Groups above 2 MWp require verified feeder allocation and potential project
splits; splitting a map polygon alone would not prove compliance.

Annual matching is not an hourly dispatch, monthly settlement or signed contract.
Ordinary generation imbalance is not assigned export income. Further verification
needs utility connections, title/ownership data, metering and power-system studies.

Sources: [Energy Commission guidelines](https://www.st.gov.my/sites/default/files/2026-03/CREAM-GUIDELINE_FINAL.pdf),
[CREAM FAQ](https://www.st.gov.my/contents/2025/CREAM/CREAM%20FAQ_1%20_V2.pdf).

## Verification

`npm test` checks stable geographic identity, no buyer-demand double counting,
energy conservation, category pricing, no-buyer behaviour, and both township
snapshots. Without shading, the current data has 30 proposed groups in Ara
Damansara (10 above 2 MWp) and 35 in Bandar Bukit Raja (15 above 2 MWp). These
counts are screening results, not numbers of compliant CREAM plants.
