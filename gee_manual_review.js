// Ручная проверка одного кандидата на потенциальное цветение.
// 1. Открой https://code.earthengine.google.com/
// 2. Вставь этот код.
// 3. Впиши date и sensor из manual_bloom_validation_template.csv.

var date = '2020-07-15';
var sensor = 'SENTINEL_2'; // 'SENTINEL_2' или 'LANDSAT_8_9'
var searchDays = 3; // искать сцену в интервале ±3 дня от указанной даты

var region = ee.Geometry.Rectangle([61.133333, 55.000000, 61.333333, 55.133333], null, false);
var dayStart = ee.Date(date);
var searchStart = dayStart.advance(-searchDays, 'day');
var searchEnd = dayStart.advance(searchDays + 1, 'day');

// Добавляет каждому снимку расстояние по времени до целевой даты.
function closestToTarget(collection) {
  return collection.map(function(image) {
    var distanceMs = ee.Number(image.get('system:time_start'))
      .subtract(dayStart.millis())
      .abs();
    return image.set('distance_to_target_ms', distanceMs);
  }).sort('distance_to_target_ms');
}

Map.centerObject(region, 12);
Map.addLayer(region, {color: 'yellow'}, 'Рамка анализа', false);

if (sensor === 'SENTINEL_2') {
  var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(region)
    .filterDate(searchStart, searchEnd);
  var closest = closestToTarget(s2);

  print('Sentinel-2 scenes in ±' + searchDays + ' days:', s2);
  s2.size().evaluate(function(count) {
    if (count === 0) {
      print('Нет Sentinel-2 снимков даже в окне ±' + searchDays + ' дней. Увеличь searchDays до 7.');
      return;
    }
    var image = ee.Image(closest.first());
    print('Selected nearest Sentinel-2 image:', image);
    Map.addLayer(
      image.select(['B4', 'B3', 'B2']).multiply(0.0001),
      {min: 0.0, max: 0.25, gamma: 1.2},
      'Sentinel-2 natural colour'
    );
    Map.addLayer(
      image.select(['B8', 'B4', 'B3']).multiply(0.0001),
      {min: 0.0, max: 0.35, gamma: 1.2},
      'Sentinel-2 false colour (NIR-R-G)',
      false
    );
  });
} else {
  var landsat = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(region)
    .filterDate(searchStart, searchEnd);
  var closest = closestToTarget(landsat);
  var scale = 0.0000275;
  var offset = -0.2;

  print('Landsat 8/9 scenes in ±' + searchDays + ' days:', landsat);
  landsat.size().evaluate(function(count) {
    if (count === 0) {
      print('Нет Landsat 8/9 снимков даже в окне ±' + searchDays + ' дней. Увеличь searchDays до 7.');
      return;
    }
    var image = ee.Image(closest.first());
    print('Selected nearest Landsat image:', image);
    Map.addLayer(
      image.select(['SR_B4', 'SR_B3', 'SR_B2']).multiply(scale).add(offset),
      {min: 0.0, max: 0.25, gamma: 1.2},
      'Landsat natural colour'
    );
    Map.addLayer(
      image.select(['SR_B5', 'SR_B4', 'SR_B3']).multiply(scale).add(offset),
      {min: 0.0, max: 0.35, gamma: 1.2},
      'Landsat false colour (NIR-R-G)',
      false
    );
  });
}

// В шаблоне ручной разметки заполните:
// manual_label: bloom / no_bloom / shore_vegetation / turbidity / clouds_or_artifact
// manual_comment: короткое объяснение решения.
