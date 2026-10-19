"""Behind-the-meter battery dispatch with NREL PySAM, on load archetypes.

For each township's typical-year PV profile (from pvlib_yield.py) and each
load archetype, runs PySAM's Battery model (peak shaving with look-ahead)
over a grid of PV size and battery size, both relative to the site's peak kW.
The app scales these normalised results to every candidate site.

Writes public/data/storage-<township>.json.

Usage:  python scripts/pysam_storage.py [township-id ...]
Needs:  pip install nrel-pysam  (and run pvlib_yield.py first)
"""
import json
import sys
from pathlib import Path

import numpy as np
import PySAM
import PySAM.Battery as Battery
from PySAM.BatteryTools import battery_model_sizing

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

PEAK_KW = 1000.0  # archetypes are simulated at 1 MW peak, results reported per kW of peak
PV_RATIOS = [0.25, 0.5, 1.0]  # kWp per kW of peak load
BESS_RATIOS = [0.1, 0.2, 0.3]  # battery kW per kW of peak load
DURATION_H = 4  # MyBeST-style 4-hour battery


def load_shape(kind, year=2026):
    """Synthetic hourly load (kW, peak = 1) for a typical Klang Valley site. Day 0 = Thursday 1 Jan 2026."""
    hours = np.arange(8760)
    hod = hours % 24
    dow = ((hours // 24) + 3) % 7  # 0 = Monday
    month = np.minimum(11, (hours // 24) // 30.42).astype(int)
    cooling = 1 + 0.05 * np.isin(month, [3, 4, 5])  # hotter Apr-Jun
    weekend = dow >= 5
    if kind == "retail":  # mall: 10:00-22:00, busier at weekends
        open_ = (hod >= 10) & (hod < 22)
        base = np.where(open_, 0.85 + 0.1 * np.sin(np.pi * (hod - 10) / 12), 0.3)
        base = base * np.where(weekend & open_, 1.08, 1.0)
    elif kind == "commercial":  # office: weekdays 08:00-18:00
        open_ = (hod >= 8) & (hod < 18) & ~weekend
        base = np.where(open_, 0.8 + 0.2 * np.sin(np.pi * (hod - 8) / 10), 0.25)
    else:  # industrial: two shifts 07:00-23:00, Sunday reduced
        on = (hod >= 7) & (hod < 23)
        base = np.where(on, 0.92, 0.5) * np.where(dow == 6, 0.6, 1.0)
    load = base * cooling
    return load / load.max()


def simulate(pv_kw, load_kw, bess_kw):
    b = Battery.default("CustomGenerationBatteryCommercial")
    b.Lifetime.system_use_lifetime_output = 0
    b.Lifetime.analysis_period = 1
    b.Load.load = load_kw.tolist()
    b.SystemOutput.gen = pv_kw.tolist()
    b.BatterySystem.batt_replacement_option = 0  # single-year run: no replacements
    b.BatterySystem.batt_meter_position = 0  # behind the meter
    b.BatteryDispatch.batt_dispatch_choice = 0  # peak shaving, look ahead
    # ATAP-capped PV rarely exceeds the site load, so the battery must be able to
    # charge off-peak from the grid as well as from surplus solar.
    b.BatteryDispatch.batt_dispatch_auto_can_charge = 1
    b.BatteryDispatch.batt_dispatch_auto_can_gridcharge = 1
    battery_model_sizing(b, bess_kw, bess_kw * DURATION_H, 500)
    b.execute(0)
    o = b.Outputs
    grid_to_load = np.array(o.grid_to_load)
    grid_to_batt = np.array(getattr(o, "grid_to_batt", np.zeros(8760)))
    system_to_batt = np.array(getattr(o, "system_to_batt", np.zeros(8760)))
    return grid_to_load + grid_to_batt, float(system_to_batt.sum()), float(o.batt_annual_discharge_energy[0])


def monthly_peaks(series):
    idx = np.minimum(11, (np.arange(8760) // 24) // 30.42).astype(int)
    return np.array([series[idx == m].max() for m in range(12)])


def run(tid):
    y = json.loads((DATA / f"yield-{tid}.json").read_text(encoding="utf-8"))
    pv_per_kwp = np.array(y["hourlyKwhPerKwp"])  # kWh/kWp in each hour == average kW per kWp
    out = {}
    for kind in ["retail", "commercial", "industrial"]:
        load = load_shape(kind) * PEAK_KW
        out[kind] = {}
        for pr in PV_RATIOS:
            pv = pv_per_kwp * pr * PEAK_KW
            before = monthly_peaks(np.maximum(load - pv, 0))
            out[kind][str(pr)] = {}
            for br in BESS_RATIOS:
                grid_import, pv_to_batt, discharged = simulate(pv, load, br * PEAK_KW)
                after = monthly_peaks(grid_import)
                cut = np.maximum(before - after, 0)
                out[kind][str(pr)][str(br)] = {
                    "peakCutKwPerKwPeak": round(float(cut.mean() / PEAK_KW), 4),  # avg monthly peak cut
                    "pvShiftedKwhPerKwPeak": round(pv_to_batt / PEAK_KW, 1),  # solar stored for later, kWh/yr
                    "cycles": round(discharged / (br * PEAK_KW * DURATION_H), 0),
                }
            best = max(out[kind][str(pr)].items(), key=lambda kv: kv[1]["peakCutKwPerKwPeak"] / float(kv[0]))
            print(f"  {kind:10s} PV {pr:>4} x peak: " + ", ".join(
                f"BESS {br}: cut {v['peakCutKwPerKwPeak'] * 100:.1f}% peak, shifted {v['pvShiftedKwhPerKwPeak']:.0f} kWh/kW, {v['cycles']:.0f} cyc"
                for br, v in out[kind][str(pr)].items()), flush=True)
    res = {
        "township": tid,
        "source": f"NREL PySAM {PySAM.__version__} Battery (CustomGenerationBatteryCommercial, peak shaving look-ahead), "
                  f"PV from {y['source']}, synthetic load archetypes",
        "durationH": DURATION_H,
        "pvRatios": PV_RATIOS,
        "bessRatios": BESS_RATIOS,
        "archetypes": out,
    }
    (DATA / f"storage-{tid}.json").write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    ids = sys.argv[1:] or sorted(p.stem.replace("yield-", "") for p in DATA.glob("yield-*.json"))
    for tid in ids:
        print(tid, flush=True)
        run(tid)
