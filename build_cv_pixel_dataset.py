"""Combine raw GEE pixel exports into an auditable CV training dataset.

Raw exports in ``pics/`` are never modified.  The script creates a normalized
dataset with explicit longitude/latitude fields and a scene-level audit.
"""

from __future__ import annotations

import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "pics"
DATASET = ROOT / "cv_pixel_training_dataset.csv"
AUDIT = ROOT / "cv_pixel_dataset_audit.csv"

FEATURES = ("blue", "green", "red", "nir", "swir1", "fai", "mndwi", "ndvi")
LABELS = {"clean_water": 0, "bloom": 1, "artifact": 2}


def as_float(value: str, field: str, source: Path) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{source.name}: invalid {field} value {value!r}") from error
    if not math.isfinite(result):
        raise ValueError(f"{source.name}: non-finite {field} value {value!r}")
    return result


def main() -> None:
    raw_files = sorted(RAW_DIR.glob("shersh_cv_pixels_*.csv"))
    if not raw_files:
        raise FileNotFoundError("No shersh_cv_pixels_*.csv files found in pics/")

    output_rows: list[dict[str, object]] = []
    scene_counts: dict[tuple[str, str, str], Counter[str]] = defaultdict(Counter)
    coordinate_classes: dict[tuple[str, float, float], set[str]] = defaultdict(set)

    for source in raw_files:
        with source.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        for row in rows:
            class_name = row.get("class_name", "")
            if class_name not in LABELS:
                raise ValueError(f"{source.name}: unexpected class_name {class_name!r}")
            geometry = json.loads(row[".geo"])
            if geometry.get("type") != "Point" or len(geometry.get("coordinates", [])) != 2:
                raise ValueError(f"{source.name}: expected Point geometry")
            longitude, latitude = (as_float(value, "coordinate", source) for value in geometry["coordinates"])
            scene_key = (row["requested_date"], row["sensor"], row["queue_index"])
            scene_id = "_".join((row["requested_date"].replace("-", ""), row["sensor"], row["queue_index"]))
            output = {
                "scene_id": scene_id,
                "queue_index": int(row["queue_index"]),
                "requested_date": row["requested_date"],
                "actual_date": row["actual_date"],
                "sensor": row["sensor"],
                "selection_role": row["selection_role"],
                "class": LABELS[class_name],
                "class_name": class_name,
                "longitude": longitude,
                "latitude": latitude,
                "source_file": source.name,
            }
            output.update({feature: as_float(row[feature], feature, source) for feature in FEATURES})
            output_rows.append(output)
            scene_counts[scene_key][class_name] += 1
            coordinate_classes[(scene_id, longitude, latitude)].add(class_name)

    conflicting_coordinates = {
        key: classes for key, classes in coordinate_classes.items() if len(classes) > 1
    }
    if conflicting_coordinates:
        raise ValueError(
            "The same pixel was labelled with different classes: "
            f"{len(conflicting_coordinates)} conflicts. Redraw those polygons without overlap."
        )

    # Same coordinate can appear more than once in the same class after overlapping
    # polygons. That is harmless but we keep only one copy in the prepared dataset.
    unique_rows: list[dict[str, object]] = []
    seen: set[tuple[str, str, float, float]] = set()
    for row in output_rows:
        key = (str(row["scene_id"]), str(row["class_name"]), float(row["longitude"]), float(row["latitude"]))
        if key not in seen:
            seen.add(key)
            unique_rows.append(row)

    fields = [
        "scene_id", "queue_index", "requested_date", "actual_date", "sensor", "selection_role",
        "class", "class_name", "longitude", "latitude", *FEATURES, "source_file",
    ]
    with DATASET.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(unique_rows)

    audit_fields = [
        "queue_index", "requested_date", "actual_date", "sensor", "selection_role",
        "clean_water_points", "bloom_points", "artifact_points", "total_points", "source_file",
    ]
    audit_rows = []
    for scene_date, sensor, queue_index in sorted(scene_counts, key=lambda item: int(item[2])):
        counts = scene_counts[(scene_date, sensor, queue_index)]
        related = next(row for row in output_rows if (row["requested_date"], row["sensor"], str(row["queue_index"])) == (scene_date, sensor, queue_index))
        audit_rows.append({
            "queue_index": queue_index,
            "requested_date": scene_date,
            "actual_date": related["actual_date"],
            "sensor": sensor,
            "selection_role": related["selection_role"],
            "clean_water_points": counts["clean_water"],
            "bloom_points": counts["bloom"],
            "artifact_points": counts["artifact"],
            "total_points": sum(counts.values()),
            "source_file": related["source_file"],
        })
    with AUDIT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=audit_fields)
        writer.writeheader()
        writer.writerows(audit_rows)

    print(f"Raw points: {len(output_rows)}")
    print(f"Unique prepared points: {len(unique_rows)}")
    print(f"Scenes: {len(scene_counts)}")
    print("Classes:", dict(Counter(str(row["class_name"]) for row in unique_rows)))
    print("Exact duplicates removed:", len(output_rows) - len(unique_rows))
    print(f"Saved {DATASET.name} and {AUDIT.name}")


if __name__ == "__main__":
    main()
