"""Create the scene register for the first pixel-level CV annotation batch."""

from __future__ import annotations

import csv
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "cv_scene_selection.csv"

# The first 20 scenes have a whole-scene visual decision already.  The last 10
# are deliberately only candidates: inspect them before drawing any polygons.
SCENES = [
    ("2019-06-24", "SENTINEL_2", "bloom_reference", "bloom", "manual, confident"),
    ("2019-07-09", "SENTINEL_2", "bloom_reference", "bloom", "manual, confident"),
    ("2022-07-03", "SENTINEL_2", "bloom_reference", "bloom", "manual, confident"),
    ("2026-07-24", "SENTINEL_2", "bloom_reference", "bloom", "manual, confident"),
    ("2026-07-27", "SENTINEL_2", "bloom_reference", "bloom", "manual, confident"),
    ("2026-08-13", "SENTINEL_2", "bloom_reference", "bloom", "manual, confident"),
    ("2019-06-22", "LANDSAT_8_9", "bloom_reference", "bloom", "manual, confident"),
    ("2020-07-10", "LANDSAT_8_9", "bloom_reference", "bloom", "manual, strong"),
    ("2021-07-22", "LANDSAT_8_9", "bloom_reference", "bloom", "manual, strong"),
    ("2022-08-10", "LANDSAT_8_9", "bloom_reference", "bloom", "manual, strong"),
    ("2023-07-03", "LANDSAT_8_9", "bloom_reference", "bloom", "manual, strong"),
    ("2025-08-25", "LANDSAT_8_9", "bloom_reference", "bloom", "manual, strong"),
    ("2026-06-17", "SENTINEL_2", "clean_water_reference", "no_bloom", "manual"),
    ("2026-06-20", "SENTINEL_2", "clean_water_reference", "no_bloom", "manual"),
    ("2026-07-07", "SENTINEL_2", "clean_water_reference", "no_bloom", "manual"),
    ("2016-05-05", "LANDSAT_8_9", "clean_water_reference", "no_bloom", "manual"),
    ("2021-05-03", "LANDSAT_8_9", "clean_water_reference", "no_bloom", "manual"),
    ("2023-07-23", "SENTINEL_2", "artifact_reference", "clouds_or_artifact", "manual: cloud, haze and shadows"),
    ("2015-05-03", "LANDSAT_8_9", "artifact_reference", "clouds_or_artifact", "manual: uncertain, likely artifact"),
    ("2016-08-09", "LANDSAT_8_9", "artifact_reference", "clouds_or_artifact", "manual: haze"),
    ("2022-07-24", "LANDSAT_8_9", "review_first", "", "very high FAI and jump; inspect first"),
    ("2025-06-07", "LANDSAT_8_9", "review_first", "", "very high FAI and jump; inspect first"),
    ("2024-06-12", "LANDSAT_8_9", "review_first", "", "high FAI and jump; inspect first"),
    ("2014-07-03", "LANDSAT_8_9", "review_first", "", "low FAI control; inspect first"),
    ("2023-08-12", "LANDSAT_8_9", "review_first", "", "low FAI control; inspect first"),
    ("2019-06-19", "SENTINEL_2", "review_first", "", "high FAI and positive jump; inspect first"),
    ("2021-08-02", "SENTINEL_2", "review_first", "", "high FAI and positive jump; inspect first"),
    ("2024-06-12", "SENTINEL_2", "review_first", "", "high FAI and positive jump; inspect first"),
    ("2025-06-09", "SENTINEL_2", "review_first", "", "high FAI; inspect first"),
    ("2020-07-16", "SENTINEL_2", "review_first", "", "low FAI control; inspect first"),
]


def main() -> None:
    fields = [
        "queue_index", "date", "sensor", "selection_role", "initial_scene_label",
        "evidence", "final_scene_label", "review_note", "polygons_exported",
    ]
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for index, (scene_date, sensor, role, initial_label, evidence) in enumerate(SCENES):
            writer.writerow({
                "queue_index": index,
                "date": scene_date,
                "sensor": sensor,
                "selection_role": role,
                "initial_scene_label": initial_label,
                "evidence": evidence,
                "final_scene_label": "",
                "review_note": "",
                "polygons_exported": "",
            })
    print(f"Saved {len(SCENES)} scenes to {OUTPUT.name}")


if __name__ == "__main__":
    main()
