"""Hourly PV yield model per township with pvlib + PVGIS-ERA5 (2005-2023).

Writes public/data/yield-<township>.json with specific yield (kWh/kWp/yr) for a
grid of tilts and azimuths, as P50 and P90 across the 19 weather years, plus a
typical-year hourly profile used by the battery dispatch model.

Usage:  python scripts/pvlib_yield.py [township-id ...]
Needs:  pip install pvlib
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pvlib

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"

START, END = 2005, 2023
TILTS = {10: "open_rack_glass_polymer", 20: "close_mount_glass_glass"}  # flat-roof racking, pitched-roof flush mount
AZIMUTHS = list(range(0, 360, 45))  # pvlib convention: 0 = north, 90 = east, 180 = south
DC_AC_RATIO = 1.2
INVERTER_EFF = 0.96
GAMMA_PDC = -0.0035  # power temperature coefficient, 1/degC (mono PERC)
DEGRADATION = 0.005  # per year
LIFETIME_YEARS = 25
# System losses excluding shading (modelled separately by the app's raycaster).
LOSSES_PCT = pvlib.pvsystem.pvwatts_losses(
    soiling=3, shading=0, snow=0, mismatch=2, wiring=2, connections=0.5,
    lid=1.5, nameplate_rating=1, age=0, availability=1,
)


def township_centres():
    """Read township ids and centres from src/townships.js (single source of truth)."""
    src = (ROOT / "src" / "townships.js").read_text(encoding="utf-8")
    pat = re.compile(r"'([a-z-]+)':\s*\{\s*name:\s*'([^']+)'.*?longitude:\s*([\d.]+),\s*latitude:\s*([\d.]+)", re.S)
    return {m[0]: {"name": m[1], "lon": float(m[2]), "lat": float(m[3])} for m in pat.findall(src)}


def fetch_weather(lat, lon):
    res = pvlib.iotools.get_pvgis_hourly(
        lat, lon, start=START, end=END, raddatabase="PVGIS-ERA5", components=True,
        surface_tilt=0, surface_azimuth=180, usehorizon=True, timeout=180,
    )
    data = res[0]
    # With a horizontal plane, PVGIS "poa" components are GHI's beam and diffuse parts.
    ghi = data["poa_direct"] + data["poa_sky_diffuse"] + data["poa_ground_diffuse"]
    dhi = data["poa_sky_diffuse"]
    return data, ghi, dhi


def run(tid, t):
    print(f"{t['name']}: fetching PVGIS-ERA5 hourly {START}-{END}...", flush=True)
    data, ghi, dhi = fetch_weather(t["lat"], t["lon"])
    times = data.index
    loc = pvlib.location.Location(t["lat"], t["lon"])
    sp = loc.get_solarposition(times)
    zen = sp["apparent_zenith"]
    cosz = np.cos(np.radians(zen))
    dni = (data["poa_direct"] / cosz.where(zen < 87)).fillna(0).clip(0, 1100)
    dni_extra = pvlib.irradiance.get_extra_radiation(times)
    airmass = pvlib.atmosphere.get_relative_airmass(zen)

    pac0 = 1000 / DC_AC_RATIO  # W AC per kWp DC
    result = {}
    hourly = None
    for tilt, mount in TILTS.items():
        tparams = pvlib.temperature.TEMPERATURE_MODEL_PARAMETERS["sapm"][mount]
        result[tilt] = {}
        for az in AZIMUTHS:
            poa = pvlib.irradiance.get_total_irradiance(
                tilt, az, zen, sp["azimuth"], dni, ghi, dhi,
                dni_extra=dni_extra, airmass=airmass, model="perez", albedo=0.2,
            )
            aoi = pvlib.irradiance.aoi(tilt, az, zen, sp["azimuth"])
            iam = pvlib.iam.ashrae(aoi)
            eff = (poa["poa_direct"] * iam + poa["poa_diffuse"]).fillna(0)
            tcell = pvlib.temperature.sapm_cell(eff, data["temp_air"], data["wind_speed"], **tparams)
            dc = pvlib.pvsystem.pvwatts_dc(eff, tcell, pdc0=1000, gamma_pdc=GAMMA_PDC) * (1 - LOSSES_PCT / 100)
            ac = pvlib.inverter.pvwatts(dc, pdc0=pac0 / INVERTER_EFF, eta_inv_nom=INVERTER_EFF).clip(lower=0)
            annual = ac.groupby(ac.index.year).sum() / 1000  # kWh/kWp per weather year
            result[tilt][az] = {
                "p50": round(float(annual.median()), 1),
                "p90": round(float(annual.quantile(0.10)), 1),
                "clippingPct": round(float(100 * (1 - ac.sum() / (dc.clip(lower=0).sum() * INVERTER_EFF))), 2),
                "tempLossPct": round(float(100 * (1 - (dc.sum() / (eff.sum() * (1 - LOSSES_PCT / 100))))), 2),
            }
            if tilt == 10 and az == 180:
                hourly = (ac, annual)

    # Typical-year hourly profile (local time) from the weather year closest to P50.
    ac, annual = hourly
    candidates = annual.loc[START + 1:]
    year = int((candidates - candidates.median()).abs().idxmin())
    local = ac.tz_convert("Asia/Kuala_Lumpur")
    yr = local[local.index.year == year]
    yr = yr[~((yr.index.month == 2) & (yr.index.day == 29))]
    profile = [round(v / 1000, 4) for v in yr.values[:8760]]  # kWh per kWp per hour
    monthly = (yr.groupby(yr.index.month).sum() / 1000).round(1).tolist()

    lifetime_factor = float(np.mean([(1 - DEGRADATION) ** y for y in range(LIFETIME_YEARS)]))
    out = {
        "township": tid,
        "source": f"pvlib {pvlib.__version__} + PVGIS-ERA5 hourly {START}-{END} (JRC)",
        "model": {
            "transposition": "Perez", "iam": "ASHRAE", "temperature": "SAPM",
            "gammaPdc": GAMMA_PDC, "dcAcRatio": DC_AC_RATIO, "inverterEff": INVERTER_EFF,
            "systemLossesPct": round(float(LOSSES_PCT), 2),
            "degradationPerYear": DEGRADATION, "lifetimeYears": LIFETIME_YEARS,
            "p90Method": f"10th percentile of {END - START + 1} weather years (interannual variability only)",
        },
        "lifetimeFactor": round(lifetime_factor, 4),
        "yield": {str(k): {str(a): v for a, v in d.items()} for k, d in result.items()},
        "typicalYear": year,
        "monthly": monthly,
        "hourlyKwhPerKwp": profile,
    }
    (OUT / f"yield-{tid}.json").write_text(json.dumps(out), encoding="utf-8")
    best = max(result[10].items(), key=lambda kv: kv[1]["p50"])
    print(
        f"  tilt 10: P50 {result[10][180]['p50']} (S) .. {best[1]['p50']} (best az {best[0]}) kWh/kWp, "
        f"P90 {result[10][180]['p90']}; tilt 20 S: {result[20][180]['p50']}, N: {result[20][0]['p50']}; "
        f"clipping {result[10][180]['clippingPct']}%, temp loss {result[10][180]['tempLossPct']}%; typical year {year}",
        flush=True,
    )


if __name__ == "__main__":
    towns = township_centres()
    ids = sys.argv[1:] or list(towns)
    for tid in ids:
        run(tid, towns[tid])
