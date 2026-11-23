// Interactive preview of the Shershnevskoye CV classifier for one date/scene.
// Run in https://code.earthengine.google.com/.
//
// Change TARGET_DATE and TARGET_SENSOR below. Leave SCENE_ID as null to
// classify the daily mosaic, exactly as it was classified for
// shershnevskoe_cv_all_scenes.csv. To inspect one source scene rather than a
// mosaic, paste its Earth Engine system:index into SCENE_ID.

// ============================== SETTINGS ==================================

var TRAINING_ASSET = 'projects/YOUR_GCP_PROJECT_ID/assets/cv_pixel_training_dataset';

var TARGET_DATE = '2025-07-15';       // YYYY-MM-DD
var TARGET_SENSOR = 'SENTINEL_2';     // 'SENTINEL_2' or 'LANDSAT_8_9'
var SCENE_ID = null;                  // e.g. 'LC08_...' or '20250715T...'; otherwise null

var WATER_OCCURRENCE_PCT = 50;
var SHORE_BUFFER_M = 30;
var REGION = ee.Geometry.Rectangle([61.133333, 55.000000, 61.333333, 55.133333], null, false);
var FEATURES = ['blue', 'green', 'red', 'nir', 'swir1', 'fai', 'mndwi', 'ndvi'];

var WATER = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence')
  .unmask(0)
  .gte(WATER_OCCURRENCE_PCT)
  .focalMin({radius: SHORE_BUFFER_M, units: 'meters'})
  .rename('water')
  .clip(REGION);

// ============================ FEATURES ====================================

function landsatFeatures(image) {
  var scaled = ee.Image(image).select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6'])
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
  var scaled = ee.Image(image).select(['B2', 'B3', 'B4', 'B8', 'B11']).multiply(0.0001);
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

function makeClassifier(points) {
  return ee.Classifier.smileRandomForest({
    numberOfTrees: 180,
    minLeafPopulation: 4,
    bagFraction: 0.632,
    seed: 42
  }).train({features: points, classProperty: 'class', inputProperties: FEATURES});
}

var training = ee.FeatureCollection(TRAINING_ASSET);
var landsatClassifier = makeClassifier(training.filter(ee.Filter.eq('sensor', 'LANDSAT_8_9')));
var sentinelClassifier = makeClassifier(training.filter(ee.Filter.eq('sensor', 'SENTINEL_2')));

// ============================ SCENE CHOICE ================================

var start = ee.Date(TARGET_DATE);
var end = start.advance(1, 'day');
var isSentinel = TARGET_SENSOR === 'SENTINEL_2';
var source = isSentinel
  ? ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  : ee.ImageCollection('LANDSAT/LC08/C02/T1_L2').merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'));

source = source.filterBounds(REGION);
var candidates = SCENE_ID === null
  ? source.filterDate(start, end)
  : source.filter(ee.Filter.eq('system:index', SCENE_ID));

print('Matching source scenes', candidates);
print('Number of matching scenes', candidates.size());

// With SCENE_ID=null this is the same daily mosaic used in the batch script.
var image = ee.Image(candidates.mosaic()).set({
  'system:time_start': start.millis(),
  'system:index': SCENE_ID === null ? ee.String('daily_mosaic_').cat(TARGET_DATE) : SCENE_ID
});
var features = (isSentinel ? sentinelFeatures(image) : landsatFeatures(image)).clip(REGION);
var classifier = isSentinel ? sentinelClassifier : landsatClassifier;
var scale = isSentinel ? 20 : 30;

// Class IDs: 0 = clean water, 1 = bloom, 2 = artifact.
var waterFeatures = features.updateMask(WATER);
var predictedClass = waterFeatures.classify(classifier).rename('predicted_class');
var classProbabilities = waterFeatures.classify(classifier.setOutputMode('MULTIPROBABILITY'));
var bloomProbability = classProbabilities.arrayGet([1]).rename('bloom_probability');

// ============================== MAP =======================================

Map.centerObject(REGION, 12);
Map.addLayer(image.clip(REGION),
  isSentinel
    ? {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000, gamma: 1.2}
    : {bands: ['SR_B4', 'SR_B3', 'SR_B2'], min: 7000, max: 18000, gamma: 1.2},
  'Original scene / daily mosaic');
Map.addLayer(WATER.selfMask(), {palette: ['3daee9']}, 'Permanent water mask', false);
Map.addLayer(features.select('fai').updateMask(WATER),
  {min: -0.02, max: 0.06, palette: ['0b1d4f', '2f7ed8', 'fef08a', 'dc2626']},
  'FAI', false);
Map.addLayer(predictedClass,
  {min: 0, max: 2, palette: ['1f77b4', '22c55e', 'f59e0b']},
  'CV class: clean water / bloom / artifact');
Map.addLayer(bloomProbability,
  {min: 0, max: 1, palette: ['0b1d4f', '3b82f6', 'fef08a', 'dc2626']},
  'CV probability of bloom');

var legend = ui.Panel({style: {position: 'bottom-left', padding: '8px 12px'}});
legend.add(ui.Label({value: 'CV classification', style: {fontWeight: 'bold'}}));
[['#1f77b4', '0 - clean water'], ['#22c55e', '1 - bloom'], ['#f59e0b', '2 - artifact']]
  .forEach(function(item) {
    legend.add(ui.Panel([
      ui.Label({style: {backgroundColor: item[0], padding: '8px', margin: '0 6px 4px 0'}}),
      ui.Label(item[1])
    ], ui.Panel.Layout.Flow('horizontal')));
  });
Map.add(legend);

// ============================= SUMMARY ====================================

var pixelArea = ee.Image.pixelArea();
var classifiedWater = ee.Image(1).updateMask(predictedClass.mask());
var bloom = predictedClass.eq(1);
var artifact = predictedClass.eq(2);
var valid = artifact.not();
function area(image) {
  return ee.Number(image.multiply(pixelArea).rename('area_m2').reduceRegion({
    reducer: ee.Reducer.sum(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('area_m2'));
}
var classifiedArea = area(classifiedWater);
var bloomArea = area(bloom);
var artifactArea = area(artifact);
var validArea = area(valid);
var summary = ee.Dictionary({
  date: TARGET_DATE,
  sensor: TARGET_SENSOR,
  scene_id: image.get('system:index'),
  classified_water_area_m2: classifiedArea,
  bloom_area_m2: bloomArea,
  artifact_area_m2: artifactArea,
  artifact_fraction: artifactArea.divide(classifiedArea),
  bloom_fraction_all_water: bloomArea.divide(classifiedArea),
  bloom_fraction_non_artifact: bloomArea.divide(validArea),
  mean_bloom_probability: bloomProbability.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: REGION, scale: scale, maxPixels: 1e10, tileScale: 4
  }).get('bloom_probability')
});
print('Classification summary', summary);
