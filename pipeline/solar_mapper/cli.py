"""Command line entry point: ``solar-mapper <command> --township elmina``."""

from __future__ import annotations

import argparse
import json
import logging

import geopandas as gpd
import pandas as pd

from .app_export import export_app
from .boundary import write_boundary
from .buildings import run_phase1, write_outputs
from .config import load_assumptions, load_township
from .overture import download
from .solar import add_solar_potential, summarise_solar, write_solar_outputs
from .spotcheck import make_sheet, score_sheet


def cmd_phase1(args) -> None:
    t = load_township(args.township)
    download(t, refresh=args.refresh)
    write_boundary(t)
    buildings, summary = run_phase1(t)
    write_outputs(buildings, summary, t)
    sheet = t.processed_dir / "spotcheck_heights.csv"
    if sheet.exists() and not args.new_spotcheck:
        logging.info("kept existing %s (pass --new-spotcheck to redraw)", sheet)
    else:
        make_sheet(buildings).to_csv(sheet, index=False)
        logging.info("wrote %s", sheet)
    print(json.dumps(summary, indent=2))


def cmd_phase2(args) -> None:
    t = load_township(args.township)
    src = t.processed_dir / "buildings.parquet"
    if not src.exists():
        raise SystemExit(f"{src} not found: run `solar-mapper phase1 --township {t.slug}` first")
    cfg = load_assumptions()["solar"]
    sites = add_solar_potential(gpd.read_parquet(src), cfg)
    summary = summarise_solar(sites, cfg, t)
    write_solar_outputs(sites, summary, t)
    print(json.dumps(summary, indent=2))


def cmd_export_app(args) -> None:
    export_app(load_township(args.township))


def cmd_run(args) -> None:
    """Every step for one township: phase1, phase2, export for the web app."""
    cmd_phase1(args)
    cmd_phase2(args)
    cmd_export_app(args)


def cmd_spotcheck_score(args) -> None:
    t = load_township(args.township)
    sheet = pd.read_csv(t.processed_dir / "spotcheck_heights.csv")
    print(json.dumps(score_sheet(sheet), indent=2))


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(prog="solar-mapper")
    sub = parser.add_subparsers(dest="command", required=True)

    p1 = sub.add_parser("phase1", help="download data, derive boundary, build the buildings layer")
    p1.add_argument("--township", default="elmina")
    p1.add_argument("--refresh", action="store_true", help="re-download Overture data")
    p1.add_argument("--new-spotcheck", action="store_true", help="redraw the spot-check sample")
    p1.set_defaults(func=cmd_phase1)

    p2 = sub.add_parser("phase2", help="solar potential (kWp, kWh) for every building")
    p2.add_argument("--township", default="elmina")
    p2.set_defaults(func=cmd_phase2)

    ex = sub.add_parser("export-app", help="write public/data/<township>.json for the web app")
    ex.add_argument("--township", default="elmina")
    ex.set_defaults(func=cmd_export_app)

    run = sub.add_parser("run", help="phase1 + phase2 + export-app")
    run.add_argument("--township", default="elmina")
    run.add_argument("--refresh", action="store_true", help="re-download Overture data")
    run.add_argument("--new-spotcheck", action="store_true", help="redraw the spot-check sample")
    run.set_defaults(func=cmd_run)

    sc = sub.add_parser("spotcheck-score", help="score the filled-in height spot-check sheet")
    sc.add_argument("--township", default="elmina")
    sc.set_defaults(func=cmd_spotcheck_score)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
