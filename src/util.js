const db = require('./db');

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseFloat(m[3] || 0);
}

function fmtPace(pace) {
  const m = Math.floor(pace), s = Math.round((pace - m) * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getPhysicalInfo() {
  const row = db.prepare('SELECT raw_json FROM exercises ORDER BY start_time DESC LIMIT 1').get();
  if (!row) return { maxHr: 190, restHr: 60, aerobicThr: 140, anaerobicThr: 170 };
  const raw = JSON.parse(row.raw_json);
  const p = raw.physicalInformation || {};
  return {
    maxHr: p.maximumHeartRate || 190,
    restHr: p.restingHeartRate || 60,
    aerobicThr: p.aerobicThreshold || 140,
    anaerobicThr: p.anaerobicThreshold || 170,
  };
}

const RUNNING_SPORTS = new Set([
  'RUNNING', 'ROAD_RUNNING', 'TRAIL_RUNNING', 'TREADMILL_RUNNING',
  'JOGGING', 'CROSS_COUNTRY_RUNNING', 'CROSS-COUNTRY_RUNNING',
  'TRACK_AND_FIELD_RUNNING', 'ULTRARUNNING_RUNNING',
]);
const HIKING_SPORTS = new Set(['HIKING']);

function isTargetSport(sport) {
  if (!sport) return false;
  const s = sport.toUpperCase().replace(/\s+/g, '_');
  return RUNNING_SPORTS.has(s) || HIKING_SPORTS.has(s);
}

module.exports = { parseDuration, fmtPace, getPhysicalInfo, isTargetSport };
