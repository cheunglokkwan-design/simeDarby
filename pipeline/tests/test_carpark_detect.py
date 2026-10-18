"""Car-park detection logic, without network or model weights (detector and tiles are stand-ins)."""

import io
import json

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Point, box

from solar_mapper.app_export import export_detected
from solar_mapper.carpark_detect import (
    Detection,
    chip_blocks,
    cluster_carparks,
    detect_vehicles,
    lonlat_to_pixel,
    mapped_found,
    pixel_to_lonlat,
    tile_polygon,
    tiles_covering,
)
from solar_mapper.config import load_assumptions

UTM = 32647
Z = 19


@pytest.fixture(scope="module")
def cfg():
    return load_assumptions()["carpark_detection"]


def test_pixel_lonlat_round_trip():
    lon, lat = 101.51, 3.1816  # Elmina Lakeside Mall
    px, py = lonlat_to_pixel(lon, lat, Z)
    assert pixel_to_lonlat(px, py, Z) == pytest.approx((lon, lat), abs=1e-9)
    assert tile_polygon(int(px // 256), int(py // 256), Z).contains(Point(lon, lat))


def test_tiles_and_blocks():
    px, py = lonlat_to_pixel(101.51, 3.1816, Z)
    x, y = int(px // 256), int(py // 256)
    tiles = tiles_covering(tile_polygon(x, y, Z).buffer(-1e-7), Z)
    assert tiles == {(x, y)}
    assert chip_blocks({(8, 8), (9, 9), (12, 8)}, 4) == [(2, 2), (3, 2)]


def jpeg():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (256, 256), (90, 90, 90)).save(buf, "JPEG")
    return buf.getvalue()


def test_detections_land_at_the_right_coordinates():
    calls = []
    tile = jpeg()

    def fetch(z, x, y):
        calls.append((z, x, y))
        return tile

    detect = lambda image: [Detection(512.0, 256.0, 0.9, "small vehicle")]  # noqa: E731
    cars = detect_vehicles([(100, 200)], 4, Z, fetch, detect)
    assert len(calls) == 16  # one 4 x 4 chip
    expected = pixel_to_lonlat(100 * 4 * 256 + 512, 200 * 4 * 256 + 256, Z)
    assert (cars.iloc[0].lon, cars.iloc[0].lat) == pytest.approx(expected)
    assert cars.crs.to_epsg() == 4326


def grid(x0, y0, nx, ny, dx=2.5, dy=11.5):
    return [Point(x0 + i * dx, y0 + j * dy) for i in range(nx) for j in range(ny)]


def test_cluster_carparks_keeps_lots_and_drops_the_rest(cfg):
    points = (
        grid(0, 0, 10, 2)  # a lot: two facing rows of 10 bays across a 6.5 m aisle
        + grid(0, 500, 12, 1)  # street parking along a road
        + grid(1000, 0, 4, 3)  # on the roof deck of a building
        + grid(0, 1000, 10, 2)  # a lot that is already mapped
        + grid(2000, 2000, 3, 1)  # three stray cars
    )
    cars = gpd.GeoDataFrame(geometry=points, crs=UTM)
    buildings = gpd.GeoSeries([box(990, -20, 1030, 50)], crs=UTM)
    streets = gpd.GeoSeries([LineString([(-50, 500), (100, 500)])], crs=UTM)
    mapped = gpd.GeoSeries([box(-10, 990, 40, 1030)], crs=UTM)
    lots, reasons = cluster_carparks(cars, buildings, streets, mapped, cfg)
    assert lots["vehicles"].tolist() == [20]
    assert lots.geometry.iloc[0].contains(Point(10, 5))
    assert dict(reasons) == {"street_parking": 1, "on_roofs": 1, "already_mapped": 1, "too_few_vehicles": 1}
    assert mapped_found(cars, mapped, cfg["min_vehicles"]) == 1


def test_cluster_carparks_no_vehicles(cfg):
    empty = gpd.GeoDataFrame(geometry=[], crs=UTM)
    lots, reasons = cluster_carparks(empty, gpd.GeoSeries([], crs=UTM), gpd.GeoSeries([], crs=UTM), gpd.GeoSeries([], crs=UTM), cfg)
    assert lots.empty and not reasons


def test_export_detected(tmp_path):
    assert export_detected(tmp_path) == ([], [])
    lot = gpd.GeoDataFrame({"vehicles": [24]}, geometry=[box(101.5, 3.18, 101.5005, 3.1805)], crs=4326)
    (tmp_path / "detected_carparks.geojson").write_text(lot.to_json())
    cars = gpd.GeoDataFrame({"confidence": [0.8]}, geometry=[Point(101.50021, 3.18022)], crs=4326)
    (tmp_path / "detected_vehicles.geojson").write_text(cars.to_json())
    lots, vehicles = export_detected(tmp_path)
    assert lots[0]["id"] == "detected/0"
    assert lots[0]["tags"] == {"name": "Car park (AI-detected, 24 vehicles)", "source": "detected", "vehicles": 24}
    assert vehicles == [[101.50021, 3.18022]]
    json.dumps(lots)  # serialisable as-is
