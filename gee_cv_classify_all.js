// Classify all Shershnevskoye reservoir scenes with the manually labelled
// pixel dataset. Run this in https://code.earthengine.google.com/.
//
// Before the first run:
// 1. Upload cv_pixel_training_dataset.csv to Assets as a Table.
//    In the upload dialog select longitude / latitude as geometry columns.
// 2. Copy its Asset ID and replace TRAINING_ASSET below.
// 3. Run the script. In Tasks start the single CSV export task.
//
// The script has one Random Forest for Landsat 8/9 and a separate one for
// Sentinel-2. This is intentional: the satellite bands are not numerically
// identical. It uses the same eight features and the same labels as the
// Python CV prototype, but the Earth Engine implementation cannot import a
// Python .joblib model byte-for-byte.

// ============================== SETTINGS ==================================

// Replace this example with the Asset ID displayed after uploading the CSV.
// Example: 'projects/YOUR_GCP_PROJECT_ID/assets/cv_pixel_training_dataset'
var TRAINING_ASSET = 'projects/YOUR_GCP_PROJECT_ID/assets/cv_pixel_training_dataset';

// One run processes only this year range. Change these three values for the
// next batch; do not run two identical batches.
var BATCH_START_YEAR = 2013;
var BATCH_END_YEAR = 2015;
var BATCH_LABEL = '2013_2015_both';
var PROCESS_LANDSAT = true;
var PROCESS_SENTINEL = true;
var FIRST_MONTH = 5;
var LAST_MONTH = 9;
// Set to null for a real batch. A number is useful only for a short test.
var MAX_DAYS_PER_SENSOR = null;
var WATER_OCCURRENCE_PCT = 50;
var SHORE_BUFFER_M = 30;

// A preview scene only. It affects the map, not the exported table.
// This date is only for the map. Keep it inside the selected batch, otherwise
// the map preview has no image; it never changes the exported rows.
var PREVIEW_DATE = '2013-06-21';
var PREVIEW_SENSOR = 'LANDSAT_8_9';
// Disable for batch exports. It avoids an irrelevant map error if the preview
// date is not in the current batch and slightly reduces interactive work.
var SHOW_PREVIEW = false;

var REGION = ee.Geometry.Rectangle([61.133333, 55.000000, 61.333333, 55.133333], null, false);
var FEATURES = ['blue', 'green', 'red', 'nir', 'swir1', 'fai', 'mndwi', 'ndvi'];
var CLASS_NAMES = ['clean_water', 'bloom', 'artifact']; // IDs: 0, 1, 2

var WATER = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence')
  .unmask(0)
  .gte(WATER_OCCURRENCE_PCT)
  .focalMin({radius: SHORE_BUFFER_M, units: 'meters'})
  .rename('water')
  .clip(REGION);

// ============================ FEATURES ====================================

function landsatFeatures(image) {
  image = ee.Image(image);
  var scaled = image.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6'])
    .multiply(0.0000275).add(-0.2);
  var blue = scaled.select('SR_B2').rename('blue');
  var green = scaled.select('SR_B3').rename('green');
  var red = scaled.select('SR_B4').rename('red');
  var nir = scaled.select('SR_B5').rename('nir');
  var swir1 = scaled.select('SR_B6').rename('swir1');
  var fai = nir.subtract(red.add(swir1.subtract(red).multiply((865 - 655) / (1609 - 655))))
    .rename('fai');
  var mndwi = green.subtract(swir1).divide(green.add(swir1)).rename('mndwi');
  var ndvi = nir.subtract(red).divide(nir.add(red)).rename('ndvi');
  return ee.Image.cat([blue, green, red, nir, swir1, fai, mndwi, ndvi]);
}

function sentinelFeatures(image) {
  image = ee.Image(image);
  var scaled = image.select(['B2', 'B3', 'B4', 'B8', 'B11']).multiply(0.0001);
  var blue = scaled.select('B2').rename('blue');
  var green = scaled.select('B3').rename('green');
  var red = scaled.select('B4').rename('red');
  var nir = scaled.select('B8').rename('nir');
  var swir1 = scaled.select('B11').rename('swir1');
  var fai = nir.subtract(red.add(swir1.subtract(red).multiply((842 - 665) / (1610 - 665))))
    .rename('fai');
  var mndwi = green.subtract(swir1).divide(green.add(swir1)).rename('mndwi');
  var ndvi = nir.subtract(red).divide(nir.add(red)).rename('ndvi');
  return ee.Image.cat([blue, green, red, nir, swir1, fai, mndwi, ndvi]);
}

// ============================= TRAINING ===================================

var points = ee.FeatureCollection(TRAINING_ASSET);
print('All uploaded training pixels', points.limit(5));
print('Training count by sensor and class', points.reduceColumns({
  reducer: ee.Reducer.frequencyHistogram(),
  selectors: ['sensor']
}));

function makeClassifier(trainingPoints) {
  // Similar to Python's RF: 180 trees, leaf size 4, fixed seed.
  // maxDepth / class_weight are unavailable in Earth Engine's SMILE RF.
  return ee.Classifier.smileRandomForest({
    numberOfTrees: 180,
    minLeafPopulation: 4,
    bagFraction: 0.632,
    seed: 42
  }).train({
    features: trainingPoints,
    classProperty: 'class',
    inputProperties: FEATURES
  });
}

var landsatTraining = points.filter(ee.Filter.eq('sensor', 'LANDSAT_8_9'));
var sentinelTraining = points.filter(ee.Filter.eq('sensor', 'SENTINEL_2'));
var landsatClassifier = makeClassifier(landsatTraining);
var sentinelClassifier = makeClassifier(sentinelTraining);

print('Landsat RF explanation', landsatClassifier.explain());
print('Sentinel-2 RF explanation', sentinelClassifier.explain());

// ======================= CLASSIFY AND SUMMARISE ===========================

function dayString(image) {
  return ee.Date(image.get('system:time_start')).format('YYYY-MM-dd');
}

function summarise(image, sensor, scale, classifier, featureBuilder) {
  image = ee.Image(image);
  var features = featureBuilder(image).clip(REGION);

  // Classify all permanent-water pixels. Clouds and shadows are deliberately
  // not removed first: class 2 ('artifact') is how the model marks them.
  var maskedFeatures = features.updateMask(WATER);
  var predictedClass = maskedFeatures.classify(classifier).rename('predicted_class');
  var probabilities = maskedFeatures.classify(
    classifier.setOutputMode('MULTIPROBABILITY')
  );
  // Class IDs were trained as 0 clean, 1 bloom, 2 artifact, so index 1 is P(bloom).
  var bloomProbability = probabilities.arrayGet([1]).rename('bloom_probability');
  var bloom = predictedClass.eq(1).rename('bloom');
  var artifact = predictedClass.eq(2).rename('artifact');
  var valid = artifact.not().rename('not_artifact');

  // Use one common, already classified pixel grid for every area. The static
  // water mask and satellite bands have different native projections, so it
  // is incorrect to use the JRC water mask itself as a denominator here.
  var pixelArea = ee.Image.pixelArea();
  var classifiedWater = ee.Image(1)
    .updateMask(predictedClass.mask())
    .rename('classified_water');
  var classifiedWaterArea = classifiedWater.multiply(pixelArea).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('classified_water');
  var bloomArea = bloom.multiply(pixelArea).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('bloom');
  var artifactArea = artifact.multiply(pixelArea).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('artifact');
  var validArea = valid.multiply(pixelArea).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('not_artifact');
  var meanBloomProbability = bloomProbability.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('bloom_probability');
  var meanFAI = maskedFeatures.select('fai').reduceRegion({
    reducer: ee.Reducer.mean(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('fai');

  classifiedWaterArea = ee.Number(classifiedWaterArea);
  bloomArea = ee.Number(bloomArea);
  artifactArea = ee.Number(artifactArea);
  validArea = ee.Number(validArea);

  return ee.Feature(null, {
    date: dayString(image),
    year: ee.Date(image.get('system:time_start')).get('year'),
    month: ee.Date(image.get('system:time_start')).get('month'),
    sensor: sensor,
    image_id: image.get('system:index'),
    source_scene_count: image.get('source_scene_count'),
    scene_cloud_pct: image.get('source_scene_cloud_pct'),
    // Area actually classified after applying the permanent-water mask.
    classified_water_area_m2: classifiedWaterArea,
    bloom_area_m2: bloomArea,
    artifact_area_m2: artifactArea,
    valid_area_m2: validArea,
    // Fractions use exactly the same classified-water area as denominator.
    bloom_fraction_all_water: bloomArea.divide(classifiedWaterArea),
    artifact_fraction: artifactArea.divide(classifiedWaterArea),
    // More useful after artifacts are removed. Null if all water is artifact.
    bloom_fraction_non_artifact: ee.Algorithms.If(
      validArea.gt(0), bloomArea.divide(validArea), null
    ),
    mean_bloom_probability: meanBloomProbability,
    mean_fai: meanFAI
  });
}

var start = ee.Date.fromYMD(BATCH_START_YEAR, FIRST_MONTH, 1);
var end = ee.Date.fromYMD(BATCH_END_YEAR, LAST_MONTH + 1, 1);

var landsat = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
  .filterBounds(REGION)
  .filterDate(start, end)
  .filter(ee.Filter.calendarRange(FIRST_MONTH, LAST_MONTH, 'month'))
  .map(function(image) {
    return image.set('date_key', ee.Date(image.get('system:time_start')).format('YYYY-MM-dd'));
  });
var sentinel = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(REGION)
  .filterDate(start, end)
  .filter(ee.Filter.calendarRange(FIRST_MONTH, LAST_MONTH, 'month'))
  .map(function(image) {
    return image.set('date_key', ee.Date(image.get('system:time_start')).format('YYYY-MM-dd'));
  });

function dailyMosaic(collection, day, cloudProperty) {
  var sameDay = collection.filter(ee.Filter.eq('date_key', day));
  return ee.Image(sameDay.mosaic()).set({
    'system:time_start': ee.Date.parse('YYYY-MM-dd', day).millis(),
    'system:index': ee.String('daily_mosaic_').cat(day),
    'source_scene_count': sameDay.size(),
    'source_scene_cloud_pct': sameDay.aggregate_mean(cloudProperty)
  });
}

// One exported row = one date + one sensor, exactly as in the satellite base.
var landsatDays = landsat.aggregate_array('date_key').distinct().sort();
var sentinelDays = sentinel.aggregate_array('date_key').distinct().sort();
if (MAX_DAYS_PER_SENSOR !== null) {
  landsatDays = landsatDays.slice(0, MAX_DAYS_PER_SENSOR);
  sentinelDays = sentinelDays.slice(0, MAX_DAYS_PER_SENSOR);
}
print('Selected dates — Landsat 8/9', landsatDays);
print('Selected dates — Sentinel-2', sentinelDays);
print('Requested daily scenes by sensor', ee.Dictionary({
  LANDSAT_8_9: PROCESS_LANDSAT ? landsatDays.size() : 0,
  SENTINEL_2: PROCESS_SENTINEL ? sentinelDays.size() : 0,
  total: (PROCESS_LANDSAT ? landsatDays.size() : ee.Number(0))
    .add(PROCESS_SENTINEL ? sentinelDays.size() : ee.Number(0))
}));
var landsatResults = PROCESS_LANDSAT
  ? ee.FeatureCollection(landsatDays.map(function(day) {
      return summarise(
        dailyMosaic(landsat, day, 'CLOUD_COVER'),
        'LANDSAT_8_9', 30, landsatClassifier, landsatFeatures
      );
    }))
  : ee.FeatureCollection([]);
var sentinelResults = PROCESS_SENTINEL
  ? ee.FeatureCollection(sentinelDays.map(function(day) {
      return summarise(
        dailyMosaic(sentinel, day, 'CLOUDY_PIXEL_PERCENTAGE'),
        'SENTINEL_2', 20, sentinelClassifier, sentinelFeatures
      );
    }))
  : ee.FeatureCollection([]);
var results = landsatResults.merge(sentinelResults).sort('date');

print('Output rows prepared for export', results.size());
print('Output rows by sensor', results.aggregate_histogram('sensor'));
print('First classified rows', results.limit(10));

Export.table.toDrive({
  collection: results,
  description: 'shershnevskoe_cv_' + BATCH_LABEL,
  fileNamePrefix: 'shershnevskoe_cv_' + BATCH_LABEL,
  fileFormat: 'CSV'
});

// =============================== PREVIEW ==================================

if (SHOW_PREVIEW) {
function previewCollection(sensor) {
  if (sensor === 'SENTINEL_2') {
    return sentinel.filterDate(PREVIEW_DATE, ee.Date(PREVIEW_DATE).advance(1, 'day'));
  }
  return landsat.filterDate(PREVIEW_DATE, ee.Date(PREVIEW_DATE).advance(1, 'day'));
}

var previewImages = previewCollection(PREVIEW_SENSOR);
print('Preview image collection', previewImages);
var previewImage = ee.Image(previewImages.first());
var previewFeatures = PREVIEW_SENSOR === 'SENTINEL_2'
  ? sentinelFeatures(previewImage) : landsatFeatures(previewImage);
var previewClassifier = PREVIEW_SENSOR === 'SENTINEL_2' ? sentinelClassifier : landsatClassifier;
var previewClass = previewFeatures.updateMask(WATER).classify(previewClassifier);
var previewProbability = previewFeatures.updateMask(WATER)
  .classify(previewClassifier.setOutputMode('MULTIPROBABILITY')).arrayGet([1]);

Map.centerObject(REGION, 12);
Map.addLayer(WATER.selfMask(), {palette: ['3daee9']}, 'Permanent water mask', false);
Map.addLayer(previewFeatures.select(['red', 'green', 'blue']),
  {min: 0.0, max: 0.25, gamma: 1.2}, 'Preview natural colour');
Map.addLayer(previewClass, {min: 0, max: 2, palette: ['1f77b4', '22c55e', 'f59e0b']},
  'CV class: water / bloom / artifact');
Map.addLayer(previewProbability, {min: 0, max: 1, palette: ['0b1d4f', '3b82f6', 'fef08a', 'dc2626']},
  'CV P(bloom)');
}
