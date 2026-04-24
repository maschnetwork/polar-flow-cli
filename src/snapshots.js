const db = require('./db');
const { parseDuration, getPhysicalInfo } = require('./util');

function computeMetrics(days = 14) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const runs = db.prepare(`
    SELECT distance, duration, hr_avg, running_index FROM exercises
    WHERE sport='RUNNING' AND distance > 0 AND start_time >= ? ORDER BY start_time
  `).all(cutoff);

  if (!runs.length) return null;

  const threshold = getPhysicalInfo().aerobicThr;
  const totalKm = runs.reduce((s, r) => s + r.distance / 1000, 0);
  const totalMin = runs.reduce((s, r) => s + parseDuration(r.duration) / 60, 0);
  const avgHr = runs.reduce((s, r) => s + (r.hr_avg || 0), 0) / runs.length;
  const avgRi = runs.filter(r => r.running_index).reduce((s, r, _, a) => s + r.running_index / a.length, 0);
  const avgPace = totalMin / totalKm;
  const easyRuns = runs.filter(r => r.hr_avg && r.hr_avg < threshold);
  const easyPct = runs.length ? easyRuns.length / runs.length : 0;
  const avgEasyHr = easyRuns.length ? easyRuns.reduce((s, r) => s + r.hr_avg, 0) / easyRuns.length : null;

  return {
    period_days: days,
    run_count: runs.length,
    total_km: +totalKm.toFixed(1),
    weekly_km: +(totalKm / (days / 7)).toFixed(1),
    avg_pace_min_km: +avgPace.toFixed(2),
    avg_hr: Math.round(avgHr),
    avg_easy_hr: avgEasyHr ? Math.round(avgEasyHr) : null,
    avg_running_index: +avgRi.toFixed(1),
    easy_hard_ratio: +(easyPct * 100).toFixed(0),
    long_runs: runs.filter(r => r.distance > 14000).length,
  };
}

function generateAnalysis(metrics) {
  const lines = [];

  // Volume assessment
  if (metrics.weekly_km < 25) lines.push(`⚠️ Weekly volume is low at ${metrics.weekly_km} km/week. Target 30-40 km for consistent progress.`);
  else if (metrics.weekly_km > 45) lines.push(`⚠️ Weekly volume is high at ${metrics.weekly_km} km/week. Watch for overtraining signs.`);
  else lines.push(`✅ Weekly volume of ${metrics.weekly_km} km/week is in a good range.`);

  // Easy/hard ratio
  if (metrics.easy_hard_ratio < 70) lines.push(`⚠️ Only ${metrics.easy_hard_ratio}% of runs are easy — too many hard sessions. Target 80% easy / 20% hard to build aerobic base and avoid injury.`);
  else if (metrics.easy_hard_ratio >= 80) lines.push(`✅ Easy/hard ratio of ${metrics.easy_hard_ratio}% is on target.`);
  else lines.push(`📊 Easy/hard ratio is ${metrics.easy_hard_ratio}% — getting closer to the 80% target.`);

  // Easy run HR
  if (metrics.avg_easy_hr) {
    if (metrics.avg_easy_hr > 145) lines.push(`⚠️ Easy run avg HR is ${metrics.avg_easy_hr} bpm — too high. Slow down easy runs to stay below 140 bpm. It should feel conversational.`);
    else if (metrics.avg_easy_hr > 138) lines.push(`📊 Easy run avg HR is ${metrics.avg_easy_hr} bpm — slightly high. Try to keep below 140.`);
    else lines.push(`✅ Easy run HR of ${metrics.avg_easy_hr} bpm is well controlled.`);
  }

  // Running index
  if (metrics.avg_running_index) {
    if (metrics.avg_running_index >= 55) lines.push(`✅ Running index of ${metrics.avg_running_index} shows good aerobic fitness.`);
    else if (metrics.avg_running_index >= 50) lines.push(`📊 Running index of ${metrics.avg_running_index} is decent. Structured training can push this above 55.`);
    else lines.push(`📊 Running index of ${metrics.avg_running_index} has room to grow. Focus on consistent easy volume and occasional speed work.`);
  }

  // Long runs
  if (metrics.long_runs === 0) lines.push(`⚠️ No long runs (>14km) in this period. Add one every 2 weeks to build endurance.`);
  else lines.push(`✅ ${metrics.long_runs} long run(s) — good for endurance development.`);

  // Frequency
  const runsPerWeek = metrics.run_count / (metrics.period_days / 7);
  if (runsPerWeek < 2.5) lines.push(`⚠️ Only ${runsPerWeek.toFixed(1)} runs/week. Aim for 3-4 to maintain consistency.`);
  else if (runsPerWeek > 5) lines.push(`⚠️ ${runsPerWeek.toFixed(1)} runs/week is high. Make sure you have rest days.`);
  else lines.push(`✅ ${runsPerWeek.toFixed(1)} runs/week is a solid frequency.`);

  return lines.join('\n');
}

function createSnapshot(reviewDays = 14) {
  const metrics = computeMetrics(14);
  if (!metrics) return null;

  const reviewAt = new Date(Date.now() + reviewDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const goals = {
    target_easy_hr: '< 140 bpm (slow down easy runs)',
    target_easy_ratio: '> 75% easy runs (currently ' + metrics.easy_hard_ratio + '%)',
    target_weekly_km: '30-40 km consistent (currently ' + metrics.weekly_km + ' km/week)',
    target_weekly_runs: '3-4 runs/week with clear purpose',
    target_intervals: 'Add 1 interval session every 2 weeks',
    target_long_run: '1 long run (15-20km) every 2 weeks',
    avoid: 'No more than 10% weekly volume increase',
  };

  const analysis = generateAnalysis(metrics);

  db.prepare('INSERT INTO snapshots (review_at, metrics, goals, analysis) VALUES (?, ?, ?, ?)').run(
    reviewAt, JSON.stringify(metrics), JSON.stringify(goals), analysis
  );

  return { metrics, goals, analysis, review_at: reviewAt };
}

function getSnapshots() {
  return db.prepare('SELECT * FROM snapshots ORDER BY created_at DESC').all().map(s => ({
    ...s, metrics: JSON.parse(s.metrics), goals: JSON.parse(s.goals), analysis: s.analysis,
  }));
}

function reviewSnapshot(id) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  if (!snap) return null;

  const baseline = JSON.parse(snap.metrics);
  const current = computeMetrics(14);
  if (!current) return null;

  const compare = (key, label, lowerBetter = true) => {
    const b = baseline[key], c = current[key];
    if (b == null || c == null) return { label, baseline: b, current: c, diff: 0, pct: null, improved: false };
    const diff = c - b;
    const pct = b ? ((diff / b) * 100).toFixed(1) : null;
    const improved = lowerBetter ? diff < 0 : diff > 0;
    return { label, baseline: b, current: c, diff: +diff.toFixed(1), pct, improved };
  };

  return {
    snapshot: { ...snap, metrics: baseline, goals: JSON.parse(snap.goals), analysis: snap.analysis },
    current,
    currentAnalysis: generateAnalysis(current),
    comparison: [
      compare('avg_hr', 'Avg Heart Rate', true),
      compare('avg_easy_hr', 'Avg Easy Run HR', true),
      compare('avg_running_index', 'Running Index', false),
      compare('avg_pace_min_km', 'Avg Pace', true),
      compare('easy_hard_ratio', 'Easy Run %', false),
      compare('weekly_km', 'Weekly Volume', false),
      compare('run_count', 'Run Count', false),
      compare('long_runs', 'Long Runs', false),
    ],
  };
}

function addReviewNotes(id, notes) {
  db.prepare('UPDATE snapshots SET review_notes = ? WHERE id = ?').run(notes, id);
}

module.exports = { createSnapshot, getSnapshots, reviewSnapshot, addReviewNotes, computeMetrics };
