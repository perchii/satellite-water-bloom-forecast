// CV step 1: draw training polygons and export sampled pixels for one scene.
//
// How to use:
// 1. Open https://code.earthengine.google.com/ and paste this entire script.
// 2. Change sceneIndex, run the script, and inspect the image.
// 3. Select a drawing layer on the left and draw only unambiguous polygons.
//    Green = bloom, blue = clean water, orange = cloud/haze/shadow artifact.
// 4. Click "Export sampled pixels" in the panel. Start the created task in Tasks.
// 5. Write the decision and export status back into cv_scene_selection.csv.
//
// Do not draw shoreline vegetation as bloom. Skip ambiguous pixels.

var sceneIndex = 0;  // 0..29. See cv_scene_selection.csv.
var searchDays = 3;
var samplesPerClass = 400;

var queue = [
  {date: '2019-06-24', sensor: 'SENTINEL_2', role: 'bloom_reference'},
  {date: '2019-07-09', sensor: 'SENTINEL_2', role: 'bloom_reference'},
  {date: '2022-07-03', sensor: 'SENTINEL_2', role: 'bloom_reference'},
  {date: '2026-07-24', sensor: 'SENTINEL_2', role: 'bloom_reference'},
  {date: '2026-07-27', sensor: 'SENTINEL_2', role: 'bloom_reference'},
  {date: '2026-08-13', sensor: 'SENTINEL_2', role: 'bloom_reference'},
  {date: '2019-06-22', sensor: 'LANDSAT_8_9', role: 'bloom_reference'},
  {date: '2020-07-10', sensor: 'LANDSAT_8_9', role: 'bloom_reference'},
  {date: '2021-07-22', sensor: 'LANDSAT_8_9', role: 'bloom_reference'},
  {date: '2022-08-10', sensor: 'LANDSAT_8_9', role: 'bloom_reference'},
  {date: '2023-07-03', sensor: 'LANDSAT_8_9', role: 'bloom_reference'},
  {date: '2025-08-25', sensor: 'LANDSAT_8_9', role: 'bloom_reference'},
  {date: '2026-06-17', sensor: 'SENTINEL_2', role: 'clean_water_reference'},
  {date: '2026-06-20', sensor: 'SENTINEL_2', role: 'clean_water_reference'},
  {date: '2026-07-07', sensor: 'SENTINEL_2', role: 'clean_water_reference'},
  {date: '2016-05-05', sensor: 'LANDSAT_8_9', role: 'clean_water_reference'},
  {date: '2021-05-03', sensor: 'LANDSAT_8_9', role: 'clean_water_reference'},
  {date: '2023-07-23', sensor: 'SENTINEL_2', role: 'artifact_reference'},
  {date: '2015-05-03', sensor: 'LANDSAT_8_9', role: 'artifact_reference'},
  {date: '2016-08-09', sensor: 'LANDSAT_8_9', role: 'artifact_reference'},
  {date: '2022-07-24', sensor: 'LANDSAT_8_9', role: 'review_first'},
  {date: '2025-06-07', sensor: 'LANDSAT_8_9', role: 'review_first'},
  {date: '2024-06-12', sensor: 'LANDSAT_8_9', role: 'review_first'},
  {date: '2014-07-03', sensor: 'LANDSAT_8_9', role: 'review_first'},
  {date: '2023-08-12', sensor: 'LANDSAT_8_9', role: 'review_first'},
  {date: '2019-06-19', sensor: 'SENTINEL_2', role: 'review_first'},
  {date: '2021-08-02', sensor: 'SENTINEL_2', role: 'review_first'},
  {date: '2024-06-12', sensor: 'SENTINEL_2', role: 'review_first'},
  {date: '2025-06-09', sensor: 'SENTINEL_2', role: 'review_first'},
  {date: '2020-07-16', sensor: 'SENTINEL_2', role: 'review_first'}
];

if (sceneIndex < 0 || sceneIndex >= queue.length) {
  throw new Error('sceneIndex must be between 0 and ' + (queue.length - 1));
}

var scene = queue[sceneIndex];
var region = ee.Geometry.Rectangle([61.133333, 55.000000, 61.333333, 55.133333], null, false);
var targetDate = ee.Date(scene.date);
var startDate = targetDate.advance(-searchDays, 'day');
var endDate = targetDate.advance(searchDays + 1, 'day');
var waterMask = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence')
  .gte(60)
  .clip(region);

function closestToTarget(collection) {
  return collection.map(function(image) {
    var distance = ee.Number(image.get('system:time_start'))
      .subtract(targetDate.millis())
      .abs();
    return image.set('distance_to_target_ms', distance);
  }).sort('distance_to_target_ms');
}

function buildFeatures(image, sensor) {
  var blue;
  var green;
  var red;
  var nir;
  var swir1;
  if (sensor === 'SENTINEL_2') {
    var scaledS2 = image.multiply(0.0001);
    blue = scaledS2.select('B2');
    green = scaledS2.select('B3');
    red = scaledS2.select('B4');
    nir = scaledS2.select('B8');
    swir1 = scaledS2.select('B11');
  } else {
    var scaledLandsat = image.multiply(0.0000275).add(-0.2);
    blue = scaledLandsat.select('SR_B2');
    green = scaledLandsat.select('SR_B3');
    red = scaledLandsat.select('SR_B4');
    nir = scaledLandsat.select('SR_B5');
    swir1 = scaledLandsat.select('SR_B6');
  }
  blue = blue.rename('blue');
  green = green.rename('green');
  red = red.rename('red');
  nir = nir.rename('nir');
  swir1 = swir1.rename('swir1');
  var fai = nir.subtract(red.add(
    swir1.subtract(red).multiply(sensor === 'SENTINEL_2' ? (842 - 665) / (1610 - 665) : (865 - 655) / (1609 - 655))
  )).rename('fai');
  var mndwi = green.subtract(swir1).divide(green.add(swir1)).rename('mndwi');
  var ndvi = nir.subtract(red).divide(nir.add(red)).rename('ndvi');
  return ee.Image.cat([blue, green, red, nir, swir1, fai, mndwi, ndvi]);
}

var collection;
if (scene.sensor === 'SENTINEL_2') {
  collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(region)
    .filterDate(startDate, endDate);
} else {
  collection = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(region)
    .filterDate(startDate, endDate);
}

var sorted = closestToTarget(collection);
print('Scene queue entry:', scene);
print('Scenes in search window:', collection);

Map.centerObject(region, 12);
Map.addLayer(region, {color: 'yellow'}, 'Analysis extent', false);

var info = ui.Panel({style: {position: 'top-left', width: '350px', padding: '8px'}});
info.add(ui.Label('CV polygon annotation', {fontWeight: 'bold', fontSize: '16px'}));
info.add(ui.Label('Queue ' + sceneIndex + ': ' + scene.date + ' | ' + scene.sensor));
info.add(ui.Label('Role: ' + scene.role));
info.add(ui.Label('Draw only certain areas. Green = bloom; blue = clean water; orange = artifact. Do not label shore vegetation as bloom.', {whiteSpace: 'pre-wrap'}));
var status = ui.Label('Waiting for scene…', {whiteSpace: 'pre-wrap'});
info.add(status);
Map.add(info);

collection.size().evaluate(function(count) {
  if (count === 0) {
    status.setValue('No image found in ±' + searchDays + ' days. Set searchDays = 7 and run again.');
    return;
  }
  var image = ee.Image(sorted.first());
  var features = buildFeatures(image, scene.sensor).clip(region);
  var trainingImage = features.updateMask(waterMask);
  var scale = scene.sensor === 'SENTINEL_2' ? 10 : 30;
  var actualDate = ee.Date(image.get('system:time_start')).format('YYYY-MM-dd');

  print('Selected image:', image);
  print('Actual acquisition date:', actualDate);
  Map.addLayer(features.select(['red', 'green', 'blue']), {min: 0.0, max: 0.25, gamma: 1.2}, 'Natural colour');
  Map.addLayer(features.select(['nir', 'red', 'green']), {min: 0.0, max: 0.35, gamma: 1.2}, 'False colour (NIR-R-G)', false);
  Map.addLayer(features.select('fai'), {min: -0.01, max: scene.sensor === 'SENTINEL_2' ? 0.25 : 0.03, palette: ['081d58', 'ffffbf', 'd7191c']}, 'FAI', false);
  Map.addLayer(waterMask.selfMask(), {palette: ['00a6ff']}, 'Static water mask', false);

  var drawingTools = Map.drawingTools();
  drawingTools.setLinked(false);
  drawingTools.setDrawModes(['polygon']);
  drawingTools.layers().reset([]);
  var bloomLayer = drawingTools.addLayer([], '1_bloom', '#00ff00', true, false);
  var waterLayer = drawingTools.addLayer([], '0_clean_water', '#00a6ff', true, false);
  var artifactLayer = drawingTools.addLayer([], '2_artifact', '#ff9800', true, false);
  drawingTools.setShape('polygon');
  drawingTools.draw();

  function sampleLayer(layer, classValue, className) {
    return trainingImage.sample({
      region: layer.toGeometry(),
      scale: scale,
      numPixels: samplesPerClass,
      seed: 42,
      geometries: true,
      tileScale: 4
    }).map(function(feature) {
      return feature.set({
        class: classValue,
        class_name: className,
        queue_index: sceneIndex,
        requested_date: scene.date,
        actual_date: actualDate,
        sensor: scene.sensor,
        selection_role: scene.role
      });
    });
  }

  var exportButton = ui.Button({
    label: 'Export sampled pixels',
    onClick: function() {
      var bloomCount = bloomLayer.geometries().length();
      var waterCount = waterLayer.geometries().length();
      var artifactCount = artifactLayer.geometries().length();
      if (waterCount === 0) {
        status.setValue('Draw at least one clean-water polygon before export. Bloom and artifact are optional.');
        return;
      }
      var samples = sampleLayer(waterLayer, 0, 'clean_water');
      if (bloomCount > 0) {
        samples = samples.merge(sampleLayer(bloomLayer, 1, 'bloom'));
      }
      if (artifactCount > 0) {
        samples = samples.merge(sampleLayer(artifactLayer, 2, 'artifact'));
      }
      var taskName = 'shersh_cv_pixels_' + sceneIndex + '_' + scene.date.replace(/-/g, '') + '_' + scene.sensor;
      Export.table.toDrive({
        collection: samples,
        description: taskName,
        fileNamePrefix: taskName,
        fileFormat: 'CSV'
      });
      status.setValue('Export task created. Open Tasks, click Run, then mark polygons_exported = yes in cv_scene_selection.csv.');
      print('Export collection:', samples);
    }
  });
  info.add(exportButton);
  actualDate.evaluate(function(dateText) {
    status.setValue('Image loaded. Select a class layer on the left, then draw polygons. Actual acquisition: ' + dateText);
  });
});
