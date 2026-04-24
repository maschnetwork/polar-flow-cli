#!/usr/bin/env node
// Import Polar Flow data export into SQLite
// Usage: node src/import.js <path-to-export-zip-or-folder>

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { isTargetSport } = require('./util');

// Convert Polar export duration format to ISO 8601
// Polar uses "PT1H23M45S" or sometimes "01:23:45" or milliseconds
function normalizeDuration(dur) {
  if (!dur) return null;
  if (typeof dur === 'string' && dur.startsWith('PT')) return dur;
  if (typeof dur === 'string' && dur.includes(':')) {
    const parts = dur.split(':').map(Number);
    if (parts.length === 3) return `PT${parts[0]}H${parts[1]}M${parts[2]}S`;
    if (parts.length === 2) return `PT${parts[0]}M${parts[1]}S`;
  }
  if (typeof dur === 'number') {
    // assume milliseconds
    const sec = Math.round(dur / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `PT${h}H${m}M${s}S`;
  }
  return dur;
}

// Try to extract exercise data from various Polar JSON formats
function parseTrainingSession(json, filename) {
  // The export can have different structures. Common fields:
  const ex = json.exercises?.[0] || json;

  // Sport detection - handle numeric IDs from Polar export
  const SPORT_ID_MAP = {
    '1': 'RUNNING', '3': 'CYCLING', '11': 'HIKING', '13': 'STRENGTH_TRAINING',
    '15': 'OTHER_INDOOR', '2': 'CYCLING', '5': 'OTHER_OUTDOOR',
  };

  let sport = '';
  const sportField = ex.sport || json.sport;
  if (sportField?.id) sport = SPORT_ID_MAP[sportField.id] || sportField.id;
  else if (typeof sportField === 'string') sport = sportField;
  else sport = json.detailedSportInfo || json.detailed_sport_info || ex.detailedSportInfo || '';

  const sportUpper = sport.toUpperCase().replace(/\s+/g, '_');
  if (!isTargetSport(sportUpper)) return null;

  // Extract ID
  const id = json.identifier?.id || json.id || json.entityId || filename.replace(/\.json$/i, '');

  // Start time
  const startTime = json.startTime || json.start_time || ex.startTime || '';

  // Duration (Polar export uses durationMillis)
  const duration = normalizeDuration(json.durationMillis || ex.durationMillis || ex.duration || json.duration);

  // Distance (meters)
  const distance = json.distanceMeters || ex.distanceMeters || ex.distance || json.distance || 0;

  // Calories
  const calories = json.calories || ex.calories || ex.kiloCalories || 0;

  // Heart rate
  const hrAvg = json.hrAvg || ex.heartRate?.average || ex.heart_rate?.average || json.heartRate?.average || null;
  const hrMax = json.hrMax || ex.heartRate?.maximum || ex.heart_rate?.maximum || json.heartRate?.maximum || null;

  // Training load
  const trainingLoad = ex.trainingLoadReport?.trainingLoad || json.trainingLoad || ex.trainingLoad || ex.training_load || null;

  // Running index
  const runningIndex = ex.runningIndex || ex['running-index'] || json.runningIndex || null;

  // Route
  const routes = ex.routes || json.routes || ex.route || json.route || [];
  const hasRoute = routes.length > 0;

  // Samples from exercise
  const samples = ex.samples || json.samples || [];

  // HR Zones from exercise
  const zones = ex.zones || json.zones || ex.heartRateZones || json.heartRateZones || [];

  return {
    id, sport: sportUpper, detailed_sport: sportUpper, startTime, duration,
    distance, calories, hrAvg, hrMax, trainingLoad, runningIndex, hasRoute,
    samples, zones, route: routes, raw: json,
  };
}

function importFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let json;
  try { json = JSON.parse(raw); } catch { return null; }

  const filename = path.basename(filePath);
  return parseTrainingSession(json, filename);
}

function importAll(inputPath) {
  let files = [];

  // Handle zip file
  if (inputPath.endsWith('.zip')) {
    const { execSync } = require('child_process');
    const tmpDir = path.join(__dirname, '..', '.polar_import_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`unzip -o -q "${inputPath}" -d "${tmpDir}"`);
    inputPath = tmpDir;
  }

  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.json') && entry.name.includes('training')) files.push(full);
      }
    };
    walk(inputPath);
  } else {
    files = [inputPath];
  }

  console.log(`Found ${files.length} training session files`);

  const insertExercise = db.prepare(`
    INSERT OR IGNORE INTO exercises (id, raw_json, sport, detailed_sport, start_time, duration, distance, calories, hr_avg, hr_max, training_load, running_index, has_route)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSample = db.prepare(`INSERT OR IGNORE INTO exercise_samples (exercise_id, sample_type, recording_rate, data) VALUES (?, ?, ?, ?)`);
  const insertRoute = db.prepare(`INSERT OR IGNORE INTO exercise_routes (exercise_id, route_json) VALUES (?, ?)`);
  const insertZone = db.prepare(`INSERT OR IGNORE INTO exercise_zones (exercise_id, zone_index, lower_limit, upper_limit, in_zone) VALUES (?, ?, ?, ?, ?)`);

  let imported = 0, skipped = 0, errors = 0;

  for (const file of files) {
    try {
      const ex = importFile(file);
      if (!ex) { skipped++; continue; }

      insertExercise.run(
        ex.id, JSON.stringify(ex.raw), ex.sport, ex.detailed_sport,
        ex.startTime, ex.duration, ex.distance || 0, ex.calories || 0,
        ex.hrAvg, ex.hrMax, ex.trainingLoad, ex.runningIndex,
        ex.hasRoute ? 1 : 0
      );

      // Handle Polar export sample format: {samples: [{type, intervalMillis, values}]}
      const rawSamples = ex.samples;
      let sampleList = [];
      if (rawSamples?.samples && Array.isArray(rawSamples.samples)) {
        sampleList = rawSamples.samples;
      } else if (Array.isArray(rawSamples)) {
        sampleList = rawSamples;
      }

      const SAMPLE_TYPE_MAP = { 'HEART_RATE': '0', 'SPEED': '1', 'CADENCE': '8', 'ALTITUDE': '3', 'DISTANCE': '10', 'TEMPERATURE': '9' };
      for (const s of sampleList) {
        if (s.type && s.values) {
          // Polar export format
          const typeId = SAMPLE_TYPE_MAP[s.type] || s.type;
          const rate = Math.round((s.intervalMillis || 1000) / 1000);
          const data = s.values.map(v => v === 'NaN' ? '' : v).join(',');
          insertSample.run(ex.id, typeId, rate, data);
        } else if (s['sample-type'] || s.sampleType) {
          // API format
          insertSample.run(ex.id, String(s['sample-type'] || s.sampleType), s['recording-rate'] || s.recordingRate || 5, s.data || '');
        }
      }

      // Handle Polar export route format: {route: {wayPoints: [{latitude, longitude, altitude, elapsedMillis}]}}
      let routePoints = [];
      if (ex.route?.route?.wayPoints) {
        routePoints = ex.route.route.wayPoints;
      } else if (ex.route?.wayPoints) {
        routePoints = ex.route.wayPoints;
      } else if (Array.isArray(ex.route) && ex.route.length && ex.route[0].latitude) {
        routePoints = ex.route;
      }
      if (routePoints.length) {
        insertRoute.run(ex.id, JSON.stringify(routePoints));
      }

      // Handle Polar export zone format: [{type, zones: [{lowerLimit, higherLimit, inZone(ms)}]}]
      let zoneList = [];
      if (Array.isArray(ex.zones)) {
        const hrZone = ex.zones.find(z => z.type === 'ZONE_TYPE_HEART_RATE') || ex.zones[0];
        if (hrZone?.zones) {
          zoneList = hrZone.zones;
        } else if (ex.zones[0]?.['lower-limit'] !== undefined || ex.zones[0]?.lowerLimit !== undefined) {
          zoneList = ex.zones;
        }
      }
      for (let i = 0; i < zoneList.length; i++) {
        const z = zoneList[i];
        const lower = z.lowerLimit || z['lower-limit'] || z.lower_limit || 0;
        const upper = z.higherLimit || z['upper-limit'] || z.upper_limit || 0;
        let inZone = z.inZone || z['in-zone'] || z.in_zone || '';
        // Convert ms to ISO duration if numeric
        if (typeof inZone === 'number') {
          const sec = Math.round(inZone / 1000);
          const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
          inZone = `PT${h}H${m}M${s}S`;
        }
        insertZone.run(ex.id, z.index || i + 1, Math.round(lower), Math.round(upper), inZone);
      }

      imported++;
    } catch (e) {
      errors++;
      console.error(`Error importing ${path.basename(file)}: ${e.message}`);
    }
  }

  // Cleanup temp dir
  const tmpDir = path.join(__dirname, '..', '.polar_import_tmp');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });

  return { imported, skipped, errors, total: files.length };
}

// CLI mode
if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.log('Usage: node src/import.js <path-to-export-zip-or-folder>');
    console.log('  Accepts: .zip file from Polar account export, or extracted folder');
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`File not found: ${input}`);
    process.exit(1);
  }
  console.log(`Importing from: ${input}`);
  const result = importAll(input);
  console.log(`\nDone! Imported: ${result.imported}, Skipped (non-running/hiking): ${result.skipped}, Errors: ${result.errors}`);
  const total = db.prepare('SELECT COUNT(*) as c FROM exercises').get().c;
  console.log(`Total exercises in database: ${total}`);
}

module.exports = { importAll };
