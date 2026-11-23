"""Landsat 8/9 + Sentinel-2: FAI и качество наблюдений Шершнёвского вдхр."""
from datetime import date, timedelta
from pathlib import Path

import ee
import pandas as pd

PROJECT_ID = "YOUR_GCP_PROJECT_ID"
FIRST_YEAR, FIRST_MONTH, LAST_MONTH = 2013, 5, 9
OUTPUT_FILE = Path("shershnevskoe_multisensor_water_quality.csv")

# Не отбрасываем сцену из-за облачности всего тайла. Оставляем её, если
# чистой остаётся достаточно большая доля постоянной акватории.
MAX_SCENE_CLOUD = 100
MIN_CLEAR_WATER_FRAC = 0.60
WATER_OCCURRENCE_PCT, SHORE_BUFFER_M = 50, 30

SR_SCALE, SR_OFFSET = 0.0000275, -0.2
ST_SCALE, ST_OFFSET = 0.00341802, 149.0
LANDSAT_8, LANDSAT_9 = "LANDSAT/LC08/C02/T1_L2", "LANDSAT/LC09/C02/T1_L2"
SENTINEL_2 = "COPERNICUS/S2_SR_HARMONIZED"

try:
    ee.Initialize(project=PROJECT_ID)
except Exception:
    ee.Authenticate()
    ee.Initialize(project=PROJECT_ID)

# Рамка нужна, чтобы искать сцены; показатели считаются только на water mask.
region = ee.Geometry.Rectangle([61.133333, 55.000000, 61.333333, 55.133333], geodesic=False)
static_water = (
    ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").unmask(0)
    .gte(WATER_OCCURRENCE_PCT).focalMin(radius=SHORE_BUFFER_M, units="meters")
    .rename("STATIC_WATER").clip(region)
)


def landsat_clear_mask(image):
    qa = image.select("QA_PIXEL")
    clear = (
        qa.bitwiseAnd(1 << 0).eq(0)  # fill
        .And(qa.bitwiseAnd(1 << 1).eq(0))  # dilated cloud
        .And(qa.bitwiseAnd(1 << 2).eq(0))  # cirrus
        .And(qa.bitwiseAnd(1 << 3).eq(0))  # cloud
        .And(qa.bitwiseAnd(1 << 4).eq(0))  # cloud shadow
        .And(qa.bitwiseAnd(1 << 5).eq(0))  # snow
    )
    return clear.And(image.select("QA_RADSAT").eq(0))


def sentinel_clear_mask(image):
    # Sentinel-2 Scene Classification Layer: clouds, shadows, cirrus, snow.
    scl = image.select("SCL")
    return (
        scl.neq(0).And(scl.neq(1)).And(scl.neq(3))
        .And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
    )


def common_bands(bands, clear_mask):
    clear_water = static_water.And(clear_mask).rename("CLEAR_WATER").toByte()
    return ee.Image.cat([bands, static_water.toByte(), clear_water])


def landsat_products(image):
    image = ee.Image(image)
    clear_water = static_water.And(landsat_clear_mask(image))

    def sr(source, target):
        return image.select(source).multiply(SR_SCALE).add(SR_OFFSET).rename(target).toFloat()

    green, red = sr("SR_B3", "GREEN"), sr("SR_B4", "RED")
    nir, swir = sr("SR_B5", "NIR"), sr("SR_B6", "SWIR1")
    mndwi = green.subtract(swir).divide(green.add(swir)).rename("MNDWI")
    fai = nir.subtract(red.add(swir.subtract(red).multiply((865 - 655) / (1609 - 655)))).rename("FAI")

    turbidity = red.multiply(346.32).divide(ee.Image.constant(1).subtract(red.divide(0.19905))).rename("TURBIDITY")
    spm = red.multiply(289.29).divide(ee.Image.constant(1).subtract(red.divide(0.1686))).rename("SPM")
    b10 = image.select("ST_B10").multiply(ST_SCALE).add(ST_OFFSET).subtract(273.15).rename("B10_C")
    bands = ee.Image.cat([
        fai.updateMask(clear_water), mndwi.updateMask(clear_water),
        turbidity.updateMask(clear_water.And(red.gt(0)).And(red.lt(0.19905))),
        spm.updateMask(clear_water.And(red.gt(0)).And(red.lt(0.1686))),
        b10.updateMask(clear_water),
    ])
    return common_bands(bands, landsat_clear_mask(image))


def sentinel_products(image):
    image = ee.Image(image)
    clear_water = static_water.And(sentinel_clear_mask(image))
    # B11/SCL имеют 20 м, поэтому агрегируем Sentinel-2 на 20 м, а не на 10 м.
    green = image.select("B3").divide(10000).resample("bilinear")
    red = image.select("B4").divide(10000).resample("bilinear")
    nir = image.select("B8").divide(10000).resample("bilinear")
    swir = image.select("B11").divide(10000)
    mndwi = green.subtract(swir).divide(green.add(swir)).rename("MNDWI")
    fai = nir.subtract(red.add(swir.subtract(red).multiply((842 - 665) / (1610 - 665)))).rename("FAI")
    return common_bands(ee.Image.cat([fai.updateMask(clear_water), mndwi.updateMask(clear_water)]), sentinel_clear_mask(image))


REDUCER = (
    ee.Reducer.mean()
    .combine(reducer2=ee.Reducer.median(), sharedInputs=True)
    .combine(reducer2=ee.Reducer.minMax(), sharedInputs=True)
    .combine(reducer2=ee.Reducer.stdDev(), sharedInputs=True)
    .combine(reducer2=ee.Reducer.count(), sharedInputs=True)
    .combine(reducer2=ee.Reducer.percentile([90, 95]), sharedInputs=True)
)


def ref_water_pixels(scale):
    return static_water.reduceRegion(
        reducer=ee.Reducer.sum(), geometry=region, scale=scale,
        maxPixels=1_000_000_000, tileScale=4,
    ).get("STATIC_WATER").getInfo()


REFERENCE_PIXELS = {20: ref_water_pixels(20), 30: ref_water_pixels(30)}


def date_key(image):
    image = ee.Image(image)
    return image.set("date_key", ee.Date(image.get("system:time_start")).format("YYYY-MM-dd"))


def add_stats(row, stats, label, band):
    for suffix, reducer_name in {
        "mean": "mean", "median": "median", "min": "min", "max": "max",
        "std": "stdDev", "pixels": "count", "p90": "p90", "p95": "p95",
    }.items():
        row[f"{label}_{suffix}"] = stats.get(f"{band}_{reducer_name}")


def summarize(product, sensor, scale, day, source_count, scene_cloud_pct):
    bands = ["FAI", "MNDWI"]
    if sensor == "LANDSAT_8_9":
        bands += ["TURBIDITY", "SPM", "B10_C"]
    stats = product.select(bands).reduceRegion(
        reducer=REDUCER, geometry=region, scale=scale,
        maxPixels=1_000_000_000, tileScale=4,
    ).getInfo()
    clear_pixels = product.select("CLEAR_WATER").reduceRegion(
        reducer=ee.Reducer.sum(), geometry=region, scale=scale,
        maxPixels=1_000_000_000, tileScale=4,
    ).get("CLEAR_WATER").getInfo() or 0
    clear_frac = clear_pixels / REFERENCE_PIXELS[scale] if REFERENCE_PIXELS[scale] else 0
    row = {
        "date": day, "year": int(day[:4]), "month": int(day[5:7]), "sensor": sensor,
        "source_scene_count": source_count, "scene_cloud_pct": scene_cloud_pct,
        "clear_water_pixels": clear_pixels, "reference_water_pixels": REFERENCE_PIXELS[scale],
        "clear_water_frac": clear_frac, "usable_for_fai": clear_frac >= MIN_CLEAR_WATER_FRAC,
    }
    add_stats(row, stats, "FAI", "FAI")
    add_stats(row, stats, "MNDWI", "MNDWI")
    add_stats(row, stats, "Turbidity_FNU", "TURBIDITY")
    add_stats(row, stats, "SPM_mgL", "SPM")
    add_stats(row, stats, "B10_C", "B10_C")
    return row


def daily_rows(collection, products, sensor, scale):
    """Мозаика перекрывающихся сцен одной даты -> одна строка CSV."""
    collection = collection.map(date_key)
    days = collection.aggregate_array("date_key").distinct().sort().getInfo()
    rows = []
    cloud_field = "CLOUD_COVER" if sensor == "LANDSAT_8_9" else "CLOUDY_PIXEL_PERCENTAGE"
    for day in days:
        same_day = collection.filter(ee.Filter.eq("date_key", day))
        product = products(ee.Image(same_day.mosaic()))
        row = summarize(product, sensor, scale, day, same_day.size().getInfo(), same_day.aggregate_mean(cloud_field).getInfo())
        rows.append(row)
        print(f"{sensor} {day}: чистая вода {row['clear_water_frac']:.0%}")
    return rows


def process_year(year):
    start = date(year, FIRST_MONTH, 1)
    end = date(year, LAST_MONTH + 1, 1)
    if year == date.today().year:
        end = min(end, date.today() + timedelta(days=1))
    if start >= end:
        return []
    common = lambda c: c.filterBounds(region).filterDate(str(start), str(end))
    landsat = common(ee.ImageCollection(LANDSAT_8).merge(ee.ImageCollection(LANDSAT_9))).filter(ee.Filter.lt("CLOUD_COVER", MAX_SCENE_CLOUD))
    sentinel = common(ee.ImageCollection(SENTINEL_2)).filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", MAX_SCENE_CLOUD))
    l_count, s_count = landsat.size().getInfo(), sentinel.size().getInfo()
    print(f"\n{year}: Landsat={l_count}, Sentinel-2={s_count}")
    rows = daily_rows(landsat, landsat_products, "LANDSAT_8_9", 30) if l_count else []
    rows += daily_rows(sentinel, sentinel_products, "SENTINEL_2", 20) if s_count else []
    return rows


all_rows = []
for year in range(FIRST_YEAR, date.today().year + 1):
    try:
        all_rows.extend(process_year(year))
        if all_rows:
            pd.DataFrame(all_rows).sort_values(["date", "sensor"]).to_csv(OUTPUT_FILE, index=False, encoding="utf-8-sig")
    except Exception as error:
        print(f"⚠ {year}: {error}")

if not all_rows:
    raise RuntimeError("Не удалось получить ни одной сцены.")
df = pd.DataFrame(all_rows).sort_values(["date", "sensor"]).reset_index(drop=True)
df.to_csv(OUTPUT_FILE, index=False, encoding="utf-8-sig")
print(f"\nГотово: {len(df)} дневных наблюдений; пригодно для FAI: {df.usable_for_fai.sum()}")
print(OUTPUT_FILE.resolve())
