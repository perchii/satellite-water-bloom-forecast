"""Prepare the second, stratified batch of satellite scenes for manual bloom review.

The script only creates a new CSV.  It never modifies the original manual-review
file, because the labels already entered there are source data.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import median


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "shershnevskoe_satellite_weather_merged.csv"
EXISTING_LABELS = ROOT / "manual_bloom_validation_template.csv"
OUTPUT = ROOT / "manual_bloom_validation_round2.csv"
BLIND_OUTPUT = ROOT / "manual_bloom_validation_round2_blind.csv"

MONTHS = (5, 6, 7, 8, 9)
SENSORS = ("LANDSAT_8_9", "SENTINEL_2")
PER_SENSOR_MONTH = 8


def number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def percentile_rank(value: float, values: list[float]) -> float:
    """Empirical percentile, using the same sensor and calendar month."""
    if len(values) <= 1:
        return 0.5
    return sum(item <= value for item in values) / len(values)


def spaced_pick(rows: list[dict[str, str]], count: int) -> list[dict[str, str]]:
    """Pick records spread through the sorted list, preferring different years."""
    if len(rows) <= count:
        return rows[:]
    chosen: list[dict[str, str]] = []
    used_years: set[str] = set()
    target_positions = [round(i * (len(rows) - 1) / max(count - 1, 1)) for i in range(count)]
    for target in target_positions:
        options = sorted(
            (row for row in rows if row not in chosen),
            key=lambda row: (
                row["year"] in used_years,
                abs(rows.index(row) - target),
                row["date"],
            ),
        )
        selected = options[0]
        chosen.append(selected)
        used_years.add(selected["year"])
    return chosen


def main() -> None:
    with SOURCE.open(encoding="utf-8-sig", newline="") as handle:
        all_rows = list(csv.DictReader(handle))
    with EXISTING_LABELS.open(encoding="utf-8-sig", newline="") as handle:
        reviewed_pairs = {
            (row["date"], row["sensor"])
            for row in csv.DictReader(handle)
            if row.get("date") and row.get("sensor")
        }

    valid_by_sensor: dict[str, list[dict[str, str]]] = defaultdict(list)
    comparison_groups: dict[tuple[str, str], list[float]] = defaultdict(list)
    for row in all_rows:
        fai = number(row.get("FAI_mean", ""))
        if row.get("usable_for_fai") == "True" and fai is not None:
            valid_by_sensor[row["sensor"]].append(row)
            comparison_groups[(row["sensor"], row["month"])].append(fai)

    # The previous usable image from the same sensor is the only fair reference
    # for a FAI jump.  It is an observation, not a claim about the exact onset day.
    previous_by_pair: dict[tuple[str, str], dict[str, str]] = {}
    for sensor, rows in valid_by_sensor.items():
        previous: dict[str, str] | None = None
        for row in sorted(rows, key=lambda item: item["date"]):
            previous_by_pair[(row["date"], sensor)] = previous or {}
            previous = row

    candidates: dict[tuple[str, int], list[dict[str, str]]] = defaultdict(list)
    for row in all_rows:
        sensor = row["sensor"]
        month = int(row["month"])
        fai = number(row.get("FAI_mean", ""))
        cloud = number(row.get("scene_cloud_pct", ""))
        water = number(row.get("clear_water_frac", ""))
        if (
            sensor not in SENSORS
            or month not in MONTHS
            or (row["date"], sensor) in reviewed_pairs
            or row.get("usable_for_fai") != "True"
            or fai is None
            or cloud is None
            or water is None
            or cloud > 35
            or water < 0.60
        ):
            continue
        group = comparison_groups[(sensor, row["month"])]
        previous = previous_by_pair[(row["date"], sensor)]
        previous_fai = number(previous.get("FAI_mean", "")) if previous else None
        previous_date = date.fromisoformat(previous["date"]) if previous else None
        current_date = date.fromisoformat(row["date"])
        row = row.copy()
        row["fai_month_sensor_percentile"] = f"{percentile_rank(fai, group):.3f}"
        row["fai_baseline_sensor_month"] = f"{median(group):.6f}"
        row["fai_delta_from_previous_clear_scene"] = (
            f"{fai - previous_fai:.6f}" if previous_fai is not None else ""
        )
        row["days_since_previous_clear_scene"] = (
            str((current_date - previous_date).days) if previous_date else ""
        )
        candidates[(sensor, month)].append(row)

    selected: list[dict[str, str]] = []
    for sensor in SENSORS:
        for month in MONTHS:
            group = sorted(candidates[(sensor, month)], key=lambda row: float(row["FAI_mean"]))
            if len(group) < PER_SENSOR_MONTH:
                raise ValueError(f"Not enough candidates for {sensor}, month {month}: {len(group)}")
            low = [row for row in group if float(row["fai_month_sensor_percentile"]) <= 0.25]
            middle = [
                row for row in group
                if 0.35 <= float(row["fai_month_sensor_percentile"]) <= 0.65
            ]
            high = [row for row in group if float(row["fai_month_sensor_percentile"]) >= 0.75]
            picks: list[tuple[dict[str, str], str]] = []
            for rows, label, count in ((low, "low_fai", 2), (middle, "middle_fai", 3), (high, "high_fai", 3)):
                for row in spaced_pick(rows, count):
                    if row not in [picked for picked, _ in picks]:
                        picks.append((row, label))
            # A thin group can make a bin short. Fill only from unused candidates
            # nearest to the missing bin's intended percentile centre.
            while len(picks) < PER_SENSOR_MONTH:
                used = {row["date"] for row, _ in picks}
                remaining = [row for row in group if row["date"] not in used]
                row = max(
                    remaining,
                    key=lambda item: (
                        abs(float(item["fai_delta_from_previous_clear_scene"] or 0.0)),
                        float(item["fai_month_sensor_percentile"]),
                    ),
                )
                picks.append((row, "fai_jump_candidate"))
            for row, label in picks[:PER_SENSOR_MONTH]:
                row["review_priority"] = label
                selected.append(row)

    fields = [
        "date", "sensor", "review_priority", "year", "month", "FAI_mean", "FAI_p90", "FAI_p95",
        "fai_month_sensor_percentile", "fai_baseline_sensor_month", "fai_delta_from_previous_clear_scene",
        "days_since_previous_clear_scene", "clear_water_frac", "scene_cloud_pct", "MNDWI_mean",
        "air_temp_c", "lake_mix_temp_c", "lake_temp_mean_prev_7d", "precipitation_sum_prev_7d",
        "calm_days_prev_7d", "manual_label", "manual_comment", "manual_reviewed",
    ]
    selected.sort(key=lambda row: (row["sensor"], row["date"]))
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in selected:
            output_row = {field: row.get(field, "") for field in fields}
            output_row.update({"manual_label": "", "manual_comment": "", "manual_reviewed": ""})
            writer.writerow(output_row)
    blind_fields = ["date", "sensor", "manual_label", "manual_comment", "manual_reviewed"]
    with BLIND_OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=blind_fields)
        writer.writeheader()
        for row in selected:
            writer.writerow({
                "date": row["date"],
                "sensor": row["sensor"],
                "manual_label": "",
                "manual_comment": "",
                "manual_reviewed": "",
            })
    print(f"Saved {len(selected)} detailed scenes to {OUTPUT.name}")
    print(f"Saved blind review sheet to {BLIND_OUTPUT.name}")
    for sensor in SENSORS:
        print(sensor, sum(row["sensor"] == sensor for row in selected))


if __name__ == "__main__":
    main()
