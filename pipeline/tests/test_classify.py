import numpy as np
import pytest
from shapely.geometry import box

from solar_mapper.classify import Evidence, KindRules, elongation, name_kind, place_kind, resolve_kind
from solar_mapper.config import load_assumptions


@pytest.fixture(scope="module")
def rules():
    return KindRules.from_assumptions(load_assumptions())


def test_strong_class_beats_everything(rules):
    e = Evidence(footprint_m2=1500, overture_class="terrace", places_kind="commercial", land_use_kind="industrial")
    assert resolve_kind(e, rules) == ("landed_house", "overture_class")


def test_subtype_used_only_without_class(rules):
    assert resolve_kind(Evidence(footprint_m2=800, overture_subtype="industrial"), rules) == (
        "industrial",
        "overture_subtype",
    )


def test_building_name_beats_land_use(rules):
    e = Evidence(footprint_m2=24000, name_kind="retail", land_use_kind="landed_house")
    assert resolve_kind(e, rules) == ("retail", "building_name")


def test_places_beat_land_use(rules):
    e = Evidence(footprint_m2=1200, places_kind="commercial", land_use_kind="landed_house")
    assert resolve_kind(e, rules) == ("commercial", "place")


def test_non_residential_land_use_overrides_generic_residential_tag(rules):
    # The 20 identical "building=residential" blocks inside Elmina's industrial park.
    e = Evidence(footprint_m2=891, overture_class="residential", land_use_kind="industrial")
    assert resolve_kind(e, rules) == ("industrial", "land_use")


def test_land_use_name_source_is_carried_through(rules):
    e = Evidence(footprint_m2=6000, land_use_kind="apartment", land_use_source="land_use_name")
    assert resolve_kind(e, rules) == ("apartment", "land_use_name")


@pytest.mark.parametrize(
    "area, elong, expected",
    [
        (150, 1.2, ("landed_house", "land_use")),  # single house
        (360, 1.3, ("landed_house", "land_use")),  # semi-detached pair
        (1500, 6.0, ("landed_house", "land_use_shape")),  # terrace row
        (1500, 1.4, ("unknown", "size")),  # big compact building: don't guess
    ],
)
def test_residential_area_rules(rules, area, elong, expected):
    assert resolve_kind(Evidence(footprint_m2=area, elongation=elong, land_use_kind="landed_house"), rules) == expected


def test_generic_residential_tag_used_when_nothing_better(rules):
    e = Evidence(footprint_m2=1500, elongation=1.2, overture_class="residential")
    assert resolve_kind(e, rules) == ("landed_house", "overture_class_weak")


def test_size_fallback(rules):
    assert resolve_kind(Evidence(footprint_m2=120), rules) == ("landed_house", "size")
    assert resolve_kind(Evidence(footprint_m2=900), rules) == ("unknown", "size")


@pytest.mark.parametrize(
    "name, expected",
    [
        ("Sekolah Menengah Akademik Chong Hwa", "education"),
        ("SK Elmina", "education"),
        ("Surau Elmina Valley", "religious"),
        ("Kanopi Residences", "apartment"),
        ("Pangsapuri Harmoni Elmina", "apartment"),
        ("Google Data Center, Elmina Business Park 1A", "industrial"),
        ("Elmina Lakeside Mall", "retail"),
        ("Water Balancing Tank", "utility"),
        ("Alpha Tanks Solutions Sdn Bhd", None),  # a business, not a tank
        ("Skechers Elmina Lakeside", None),  # 'sk' must match whole words only
        ("Elmina Gardens", None),
        (None, None),
        (float("nan"), None),
    ],
)
def test_name_kind(rules, name, expected):
    assert name_kind(name, rules) == expected


def test_place_kind(rules):
    assert place_kind(["shopping_mall", "restaurant", "restaurant"], rules) == "retail"
    assert place_kind(["muslim_place_of_worship"], rules) == "religious"
    assert place_kind(["restaurant", "cafe"], rules) == "commercial"
    assert place_kind(["preschool"], rules) is None  # one home business is not a shop-office
    assert place_kind([], rules) is None


def test_elongation():
    out = elongation(np.array([box(0, 0, 10, 40), box(0, 0, 20, 20)]))
    assert out == pytest.approx([4.0, 1.0])
