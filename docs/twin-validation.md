# Digital twin energy engine vs pvlib

Open, unshaded 20° roof in Ara Damansara (synthetic gable, no obstacles). Twin: NOAA sun, NASA POWER monthly climate, Hay-Davies, Martin-Ruiz IAM, Faiman temperature, catalogue loss chain. Reference: the map app's pvlib 0.16 table (PVGIS-ERA5 hourly 2005-2023, Perez, ASHRAE IAM, SAPM close-mount temperature, P50). Regenerate with `node scripts/validate-twin.mjs`.

| Roof faces | Tilt | Twin kWh/kWp | pvlib P50 kWh/kWp | Difference | Twin, ground-calibrated (×0.93) |
|---|---|---|---|---|---|
| north | 20° | 1316 | 1318 | -0.1% | 1224 |
| east | 20° | 1344 | 1363 | -1.4% | 1250 |
| south | 20° | 1338 | 1350 | -0.9% | 1244 |
| west | 20° | 1331 | 1322 | +0.7% | 1238 |

Mean absolute difference: 0.8%. Two independent weather sources and physics chains agree within that margin on the same roof. Both are models: neither replaces metered data (a measured Shah Alam home makes 1,144-1,196 kWh/kWp, closer to the ground-calibrated column).
