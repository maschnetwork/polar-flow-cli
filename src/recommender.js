const db = require('./db');
const { parseDuration, fmtPace, getPhysicalInfo } = require('./util');

// Classify workout type from HR zone distribution and pace variance
function classifyWorkout(exercise) {
  const zones = db.prepare('SELECT * FROM exercise_zones WHERE exercise_id = ? ORDER BY zone_index').all(exercise.id);
  const samples = db.prepare("SELECT * FROM exercise_samples WHERE exercise_id = ? AND sample_type = '1'").get(exercise.id);
  const distKm = (exercise.distance || 0) / 1000;
  const durSec = parseDuration(exercise.duration);
  const sport = (exercise.detailed_sport || '').toUpperCase();

  if (sport.includes('HIK')) return { type: 'hike', label: '🥾 Hike', intensity: 'easy' };

  // HR zone time distribution — handle both 0-indexed (API) and 1-indexed (import) zones
  let zoneSeconds = [0, 0, 0, 0, 0]; // zones 1-5
  const minIdx = Math.min(...zones.map(z => z.zone_index));
  const offset = minIdx === 0 ? 0 : -1; // 0-based: no offset, 1-based: subtract 1
  for (const z of zones) {
    const sec = parseDuration(z.in_zone);
    const i = z.zone_index + offset;
    if (i >= 0 && i < 5) zoneSeconds[i] = sec;
  }
  const totalZoneSec = zoneSeconds.reduce((a, b) => a + b, 0) || durSec || 1;
  const zonePct = zoneSeconds.map(s => s / totalZoneSec);

  // Pace variance from speed samples
  let paceVariance = 0;
  if (samples?.data) {
    const vals = samples.data.split(',').map(Number).filter(v => v > 0);
    if (vals.length > 10) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      paceVariance = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) / mean;
    }
  }

  const hardPct = zonePct[3] + zonePct[4]; // zone 4+5
  const easyPct = zonePct[0] + zonePct[1]; // zone 1+2

  // High pace variance + significant hard zones = intervals
  if (paceVariance > 0.12 && hardPct > 0.2) return { type: 'interval', label: '⚡ Intervall', intensity: 'hard' };
  // Sustained zone 3-4 effort = tempo
  if (zonePct[2] + zonePct[3] > 0.4 && hardPct > 0.15) return { type: 'tempo', label: '🔥 Tempodauerlauf', intensity: 'hard' };
  // Long duration at easy pace
  if (distKm >= 15 || durSec >= 5400) return { type: 'long', label: '🏃 Langer Lauf', intensity: 'moderate' };
  // Default: easy run
  return { type: 'easy', label: '🟢 Dauerlauf', intensity: 'easy' };
}

// Calculate TRIMP-like training load from HR and duration
function trainingLoad(exercise) {
  if (exercise.hr_avg && exercise.duration) {
    const durMin = parseDuration(exercise.duration) / 60;
    // Simplified TRIMP: duration * intensity factor
    return durMin * (exercise.hr_avg / 150); // normalized to ~150bpm reference
  }
  return exercise.training_load || 0;
}

// Acute:Chronic Workload Ratio
function calculateACR(exercises) {
  const now = new Date();
  const weekMs = 7 * 24 * 3600 * 1000;

  const loadByWeek = (weeksBack) => {
    const from = new Date(now - (weeksBack + 1) * weekMs);
    const to = new Date(now - weeksBack * weekMs);
    return exercises
      .filter(e => { const d = new Date(e.start_time); return d >= from && d < to; })
      .reduce((sum, e) => sum + trainingLoad(e), 0);
  };

  const acute = loadByWeek(0);
  const chronic4 = [0, 1, 2, 3].reduce((s, w) => s + loadByWeek(w), 0) / 4;

  return { acute, chronic: chronic4, ratio: chronic4 > 0 ? acute / chronic4 : 0 };
}

// Get workout distribution for last N days
function recentDistribution(exercises, days = 14) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const recent = exercises.filter(e => new Date(e.start_time) >= cutoff);

  const counts = { easy: 0, tempo: 0, interval: 0, long: 0, hike: 0 };
  const classified = recent.map(e => {
    const c = classifyWorkout(e);
    counts[c.type] = (counts[c.type] || 0) + 1;
    return { ...e, classification: c };
  });

  const total = classified.length || 1;
  const phys = getPhysicalInfo();
  const hardCount = classified.filter(e => e.hr_avg && e.hr_avg >= phys.aerobicThr).length;
  const easyHardRatio = { easy: (total - hardCount) / total, hard: hardCount / total };

  return { classified, counts, easyHardRatio, total };
}

// Calculate pace/distance/duration stats from recent runs by type
function getTrainingStats() {
  const runs = db.prepare(`
    SELECT distance, duration, hr_avg FROM exercises
    WHERE sport = 'RUNNING' AND distance > 0 ORDER BY start_time DESC LIMIT 40
  `).all();

  const phys = getPhysicalInfo();
  const parsed = runs.map(r => {
    const sec = parseDuration(r.duration);
    return { pace: (sec / 60) / (r.distance / 1000), hr: r.hr_avg, dist: r.distance / 1000, durMin: sec / 60 };
  });

  const byType = (filter) => {
    const set = parsed.filter(filter);
    if (!set.length) return null;
    return {
      avgPace: set.reduce((s, p) => s + p.pace, 0) / set.length,
      avgDist: set.reduce((s, p) => s + p.dist, 0) / set.length,
      avgDur: set.reduce((s, p) => s + p.durMin, 0) / set.length,
      avgHr: set.reduce((s, p) => s + p.hr, 0) / set.length,
    };
  };

  return {
    phys,
    easy: byType(p => p.hr < phys.aerobicThr),
    tempo: byType(p => p.hr >= phys.aerobicThr && p.hr < phys.anaerobicThr),
    hard: byType(p => p.hr >= phys.anaerobicThr),
    long: byType(p => p.dist >= 12),
    all: byType(() => true),
  };
}

// Generate specific targets for the recommended workout type
function getTargets(type) {
  const stats = getTrainingStats();
  const phys = stats.phys;

  switch (type) {
    case 'easy':
      return {
        hr: { min: phys.restHr + 40, max: phys.aerobicThr - 5, label: `${phys.restHr + 40}–${phys.aerobicThr - 5} bpm (Zone 1-2)` },
        pace: { min: fmtPace((stats.easy?.avgPace || 7) - 0.3), max: fmtPace((stats.easy?.avgPace || 7) + 0.3), label: `${fmtPace((stats.easy?.avgPace || 7) - 0.3)}–${fmtPace((stats.easy?.avgPace || 7) + 0.3)} /km` },
        distance: { min: 5, max: 10, label: '5–10 km' },
        duration: { min: 30, max: 60, label: '30–60 min' },
      };
    case 'tempo':
      const tempoPace = stats.tempo?.avgPace || (stats.easy?.avgPace || 6.5) - 1;
      return {
        hr: { min: phys.aerobicThr, max: phys.anaerobicThr - 5, label: `${phys.aerobicThr}–${phys.anaerobicThr - 5} bpm (Zone 3-4)` },
        pace: { min: fmtPace(tempoPace - 0.2), max: fmtPace(tempoPace + 0.2), label: `${fmtPace(tempoPace - 0.2)}–${fmtPace(tempoPace + 0.2)} /km` },
        distance: { min: 6, max: 10, label: '6–10 km' },
        duration: { min: 25, max: 50, label: '25–50 min' },
      };
    case 'interval':
      const intPace = stats.hard?.avgPace || (stats.easy?.avgPace || 6.5) - 1.5;
      return {
        hr: { min: phys.anaerobicThr - 10, max: phys.maxHr - 5, label: `${phys.anaerobicThr - 10}–${phys.maxHr - 5} bpm (Zone 4-5)` },
        pace: { min: fmtPace(intPace - 0.3), max: fmtPace(intPace + 0.3), label: `${fmtPace(intPace - 0.3)}–${fmtPace(intPace + 0.3)} /km (work intervals)` },
        distance: { min: 6, max: 10, label: '6–10 km total (incl. warmup/cooldown)' },
        duration: { min: 35, max: 55, label: '35–55 min' },
      };
    case 'long':
      const longPace = (stats.easy?.avgPace || 6.5) + 0.2;
      return {
        hr: { min: phys.restHr + 40, max: phys.aerobicThr, label: `${phys.restHr + 40}–${phys.aerobicThr} bpm (Zone 1-2)` },
        pace: { min: fmtPace(longPace - 0.2), max: fmtPace(longPace + 0.4), label: `${fmtPace(longPace - 0.2)}–${fmtPace(longPace + 0.4)} /km` },
        distance: { min: 14, max: Math.round((stats.long?.avgDist || 15) * 1.1), label: `14–${Math.round((stats.long?.avgDist || 15) * 1.1)} km` },
        duration: { min: 75, max: 130, label: '75–130 min' },
      };
    default:
      return null;
  }
}

// Main recommendation engine
function recommend() {
  const cutoff = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const exercises = db.prepare(`
    SELECT id, sport, detailed_sport, start_time, duration, distance, calories,
           hr_avg, hr_max, training_load, running_index, has_route
    FROM exercises WHERE start_time >= ? ORDER BY start_time DESC
  `).all(cutoff);

  if (exercises.length === 0) {
    return {
      recommendation: { type: 'easy', label: '🟢 Dauerlauf', reason: 'No workout history yet. Start with an easy run to build your base.' },
      acr: { acute: 0, chronic: 0, ratio: 0 },
      distribution: { counts: {}, easyHardRatio: { easy: 1, hard: 0 }, total: 0 },
      recentWorkouts: [],
      injuryRisk: 'low',
    };
  }

  const acr = calculateACR(exercises);
  const dist = recentDistribution(exercises, 14);
  const last = dist.classified[0];
  const lastType = last?.classification?.type;
  const daysSinceLast = last ? (Date.now() - new Date(last.start_time)) / (24 * 3600 * 1000) : 99;

  // Injury risk assessment
  let injuryRisk = 'low';
  if (acr.ratio > 1.5) injuryRisk = 'high';
  else if (acr.ratio > 1.3) injuryRisk = 'moderate';

  // Recommendation logic
  let rec;

  if (injuryRisk === 'high') {
    rec = { type: 'easy', label: '🟢 Dauerlauf (Recovery)', reason: `ACR is ${acr.ratio.toFixed(2)} — high injury risk! Take a rest day or very easy recovery run. Your body needs to absorb the recent training load.` };
  } else if (injuryRisk === 'moderate') {
    rec = { type: 'easy', label: '🟢 Dauerlauf (Recovery)', reason: `ACR is ${acr.ratio.toFixed(2)} — your recent load is significantly above your 4-week average. Keep it easy to avoid overtraining. An easy recovery run or rest day is the smart choice.` };
  } else if (daysSinceLast > 3) {
    rec = { type: 'easy', label: '🟢 Dauerlauf', reason: `${Math.floor(daysSinceLast)} days since last workout. Ease back in with a comfortable run.` };
  } else if (dist.easyHardRatio.hard > 0.25) {
    rec = { type: 'easy', label: '🟢 Dauerlauf', reason: `Your hard/easy ratio is ${Math.round(dist.easyHardRatio.hard*100)}% hard — above the 20% target. Add more easy runs to protect against injury and let adaptations happen.` };
  } else if (lastType === 'interval' || lastType === 'tempo') {
    rec = { type: 'easy', label: '🟢 Dauerlauf (Recovery)', reason: 'Last session was hard. Follow up with an easy recovery run to let your body adapt.' };
  } else if (dist.counts.long === 0 && dist.total >= 3) {
    rec = { type: 'long', label: '🏃 Langer Lauf', reason: 'No long run in the last 2 weeks. Time for a longer endurance session to build aerobic base.' };
  } else if (dist.counts.interval === 0 && dist.easyHardRatio.hard < 0.15 && injuryRisk === 'low') {
    rec = { type: 'interval', label: '⚡ Intervall', reason: 'No speed work recently and your load is manageable. Add some intervals to build VO2max and speed.' };
  } else if (dist.counts.tempo === 0 && dist.easyHardRatio.hard < 0.15 && injuryRisk === 'low') {
    rec = { type: 'tempo', label: '🔥 Tempodauerlauf', reason: 'No tempo runs recently. A threshold run will improve your lactate clearance and race pace.' };
  } else {
    rec = { type: 'easy', label: '🟢 Dauerlauf', reason: 'Good balance this week. An easy run keeps the 80/20 ratio on track and builds your aerobic base.' };
  }

  return {
    recommendation: rec,
    targets: getTargets(rec.type),
    acr: { acute: +acr.acute.toFixed(1), chronic: +acr.chronic.toFixed(1), ratio: +acr.ratio.toFixed(2) },
    distribution: { counts: dist.counts, easyHardRatio: dist.easyHardRatio, total: dist.total },
    recentWorkouts: dist.classified.slice(0, 10).map(e => ({
      id: e.id, start_time: e.start_time, distance: e.distance, duration: e.duration,
      hr_avg: e.hr_avg, classification: e.classification,
    })),
    injuryRisk,
  };
}

module.exports = { recommend, classifyWorkout };
