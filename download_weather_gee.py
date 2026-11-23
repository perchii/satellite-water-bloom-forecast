"""Ежедневные метеофакторы ERA5-Land для Шершнёвского водохранилища.

Запуск: python3 download_weather_gee.py
Перед первым запуском впишите свой Google Cloud Project ID ниже.
"""

from datetime import date

import ee
import numpy as np
import pandas as pd


# Тот же Project ID, который работает в shershnevskoe.py.
PROJECT_ID = "YOUR_GCP_PROJECT_ID"
OUTPUT_FILE = "shershnevskoe_daily_weather_era5land.csv"

# Центр акватории Шершнёвского водохранилища: lon, lat.
LAKE_COORDS = [61.2815, 55.0950]
START_DATE = "2013-04-01"  # апрель нужен для расчёта 30-дневных окон в мае
END_DATE = str(date.today())

COLLECTION = "ECMWF/ERA5_LAND/DAILY_AGGR"
BANDS = [
    "temperature_2m",
    "dewpoint_temperature_2m",
    "lake_mix_layer_temperature",
    "lake_total_layer_temperature",
    "u_component_of_wind_10m",
    "v_component_of_wind_10m",
    "total_precipitation_sum",
    "surface_solar_radiation_downwards_sum",
]


if PROJECT_ID == "YOUR_GCP_PROJECT_ID":
    raise ValueError("Укажи свой Project ID в переменной PROJECT_ID.")

try:
    ee.Initialize(project=PROJECT_ID)
except Exception:
    ee.Authenticate()
    ee.Initialize(project=PROJECT_ID)

# Геометрию можно создавать только после ee.Initialize().
LAKE_POINT = ee.Geometry.Point(LAKE_COORDS)


def image_to_feature(image):
    """Из дневного растра делает одну строку по точке в центре водохранилища."""
    image = ee.Image(image)
    values = image.select(BANDS).reduceRegion(
        reducer=ee.Reducer.first(),
        geometry=LAKE_POINT,
        scale=11132,
        maxPixels=1_000_000,
    )
    return ee.Feature(None, values).set({
        "date": ee.Date(image.get("system:time_start")).format("YYYY-MM-dd"),
    })


print("Загружаю ежедневный ERA5-Land из Earth Engine...")
collection = ee.ImageCollection(COLLECTION).filterDate(START_DATE, END_DATE)
features = collection.map(image_to_feature)
raw = features.getInfo()["features"]

rows = [feature["properties"] for feature in raw]
df = pd.DataFrame(rows)
df["date"] = pd.to_datetime(df["date"])
df = df.sort_values("date").reset_index(drop=True)

# Переводим единицы в удобные для модели.
for source, target in [
    ("temperature_2m", "air_temp_c"),
    ("dewpoint_temperature_2m", "dewpoint_c"),
    ("lake_mix_layer_temperature", "lake_mix_temp_c"),
    ("lake_total_layer_temperature", "lake_total_temp_c"),
]:
    df[target] = df[source] - 273.15

df["wind_speed_10m_ms"] = np.hypot(
    df["u_component_of_wind_10m"], df["v_component_of_wind_10m"]
)
# В ERA5 осадки — метры воды, радиация — Дж/м².
df["precipitation_mm"] = (df["total_precipitation_sum"] * 1000).clip(lower=0)
df["solar_radiation_mj_m2"] = df["surface_solar_radiation_downwards_sum"] / 1_000_000
df["is_calm_day"] = (df["wind_speed_10m_ms"] < 3.0).astype(int)

# Причинные признаки: на дату T используются только предыдущие дни, без T.
for window in (7, 14, 30):
    df[f"air_temp_mean_prev_{window}d"] = df["air_temp_c"].shift(1).rolling(window).mean()
    df[f"lake_temp_mean_prev_{window}d"] = df["lake_mix_temp_c"].shift(1).rolling(window).mean()
    df[f"precipitation_sum_prev_{window}d"] = df["precipitation_mm"].shift(1).rolling(window).sum()
    df[f"wind_mean_prev_{window}d"] = df["wind_speed_10m_ms"].shift(1).rolling(window).mean()
    df[f"calm_days_prev_{window}d"] = df["is_calm_day"].shift(1).rolling(window).sum()
    df[f"solar_sum_prev_{window}d"] = df["solar_radiation_mj_m2"].shift(1).rolling(window).sum()

# В результат оставляем период, совпадающий со спутниковым сезоном.
df = df[df["date"].dt.month.between(5, 9)].copy()
df["year"] = df["date"].dt.year
df["month"] = df["date"].dt.month
df.to_csv(OUTPUT_FILE, index=False, encoding="utf-8-sig")

print(f"Готово: {len(df)} ежедневных строк")
print(f"Файл: {OUTPUT_FILE}")
