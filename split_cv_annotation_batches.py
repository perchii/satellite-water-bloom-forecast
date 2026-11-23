"""Split the 30-scene CV annotation queue into three balanced team batches."""

from __future__ import annotations

import csv
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "cv_scene_selection.csv"
BATCHES = {
    "A": {0, 3, 6, 9, 12, 15, 17, 20, 23, 26},
    "B": {1, 4, 7, 10, 13, 16, 18, 21, 24, 27},
    "C": {2, 5, 8, 11, 14, 19, 22, 25, 28, 29},
}


def main() -> None:
    with SOURCE.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
        fields = list(rows[0])
    assigned = {int(row["queue_index"]) for indices in BATCHES.values() for row in rows if int(row["queue_index"]) in indices}
    expected = set(range(30))
    if assigned != expected:
        raise ValueError("Batch assignment must contain every queue index exactly once")
    for batch_name, indices in BATCHES.items():
        output = ROOT / f"cv_scene_batch_{batch_name}.csv"
        batch_rows = [row for row in rows if int(row["queue_index"]) in indices]
        with output.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows(batch_rows)
        print(f"{output.name}: {len(batch_rows)} scenes")


if __name__ == "__main__":
    main()
