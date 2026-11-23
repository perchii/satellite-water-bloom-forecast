"""Combine Google Earth Engine CV batch exports into one audit-ready table."""

from pathlib import Path

import pandas as pd


INPUT_DIR = Path("dataCV")
OUTPUT_FILE = INPUT_DIR / "shershnevskoe_cv_all_scenes.csv"
EXPECTED_BATCHES = {
    "shershnevskoe_cv_2013_2014_both.csv",
    "shershnevskoe_cv_2015_2016_both.csv",
    "shershnevskoe_cv_2017_2018_both.csv",
    "shershnevskoe_cv_2019_2020_both.csv",
    "shershnevskoe_cv_2021_2022_both.csv",
    "shershnevskoe_cv_2023_2024_both.csv",
    "shershnevskoe_cv_2025_2026_both.csv",
}
REQUIRED_COLUMNS = {
    "date",
    "sensor",
    "classified_water_area_m2",
    "artifact_fraction",
    "bloom_fraction_all_water",
    "bloom_fraction_non_artifact",
    "mean_bloom_probability",
}


def main() -> None:
    paths = sorted(INPUT_DIR.glob("shershnevskoe_cv_*_both.csv"))
    found = {path.name for path in paths}
    if found != EXPECTED_BATCHES:
        missing = sorted(EXPECTED_BATCHES - found)
        unexpected = sorted(found - EXPECTED_BATCHES)
        raise ValueError(f"Unexpected batch set. Missing: {missing}; unexpected: {unexpected}")

    frames = []
    for path in paths:
        frame = pd.read_csv(path)
        absent = REQUIRED_COLUMNS - set(frame.columns)
        if absent:
            raise ValueError(f"{path.name}: missing columns {sorted(absent)}")
        frame["source_batch"] = path.stem
        frames.append(frame)

    cv = pd.concat(frames, ignore_index=True)
    cv["date"] = pd.to_datetime(cv["date"], errors="raise")
    cv = cv.sort_values(["date", "sensor"]).reset_index(drop=True)

    duplicates = cv.duplicated(["date", "sensor"], keep=False)
    if duplicates.any():
        rows = cv.loc[duplicates, ["date", "sensor", "source_batch"]]
        raise ValueError(f"Duplicate date + sensor rows:\n{rows.to_string(index=False)}")

    # Keep all raw CV output, but make downstream quality filtering explicit.
    cv["cv_has_classified_water"] = cv["classified_water_area_m2"].gt(0)
    cv["cv_usable_strict"] = (
        cv["cv_has_classified_water"]
        & cv["artifact_fraction"].le(0.30)
        & cv["mean_bloom_probability"].notna()
    )
    cv["cv_quality_reason"] = "usable"
    cv.loc[~cv["cv_has_classified_water"], "cv_quality_reason"] = "no_classified_water"
    cv.loc[
        cv["cv_has_classified_water"] & cv["artifact_fraction"].gt(0.30),
        "cv_quality_reason",
    ] = "too_many_artifacts"
    cv.loc[
        cv["cv_has_classified_water"]
        & cv["artifact_fraction"].le(0.30)
        & cv["mean_bloom_probability"].isna(),
        "cv_quality_reason",
    ] = "missing_probability"

    cv["date"] = cv["date"].dt.strftime("%Y-%m-%d")
    cv.to_csv(OUTPUT_FILE, index=False, encoding="utf-8-sig")

    print(f"Saved: {OUTPUT_FILE.resolve()}")
    print(f"Rows: {len(cv)} | date range: {cv.date.min()} — {cv.date.max()}")
    print(cv.groupby("sensor").size().to_string())
    print("\nQuality flags:")
    print(cv["cv_quality_reason"].value_counts().to_string())


if __name__ == "__main__":
    main()
