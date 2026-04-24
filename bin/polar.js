#!/usr/bin/env node
const http = require('http');
const config = require('../src/config');
const db = require('../src/db');
const polar = require('../src/polar');
const snapshots = require('../src/snapshots');
const recommender = require('../src/recommender');
const { parseDuration, fmtPace } = require('../src/util');

const [,, cmd, ...args] = process.argv;

function parseFlag(name, fallback) {
  const i = args.indexOf('--' + name);
  if (i === -1) return fallback;
  return args[i + 1] || fallback;
}

function fmtDuration(iso) {
  if (!iso) return '—';
  let totalSec = Math.round(parseDuration(iso));
  if (!totalSec) return iso;
  const h = Math.floor(totalSec / 3600), min = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  return h ? `${h}h${min}m${s}s` : min ? `${min}m${s}s` : `${s}s`;
}

function fmtDist(m) { return (m / 1000).toFixed(1) + ' km'; }

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

// ── auth ──────────────────────────────────────────────────
async function cmdAuth() {
  const open = (await import('open')).default;
  const url = `${config.authUrl}?response_type=code&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}`;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost:8080');
    if (!u.pathname.startsWith('/callback')) { res.writeHead(404); res.end(); return; }

    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (error || !code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Auth failed</h2><p>' + esc(error || 'No code received') + '</p>');
      server.close();
      process.exit(1);
    }

    try {
      const token = await polar.exchangeToken(code);
      db.prepare('INSERT OR REPLACE INTO auth (id, access_token, user_id, token_type) VALUES (1, ?, ?, ?)').run(
        token.access_token, token.x_user_id, token.token_type
      );
      await polar.registerUser(token.access_token);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>✅ Authenticated!</h2><p>You can close this window.</p>');
      console.log('✅ Authenticated successfully');
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Auth failed</h2><p>' + e.message + '</p>');
      console.error('Auth failed:', e.message);
    }
    server.close();
  });

  server.listen(8080, () => {
    console.log('Opening browser for Polar authorization...');
    console.log('(waiting for callback on http://localhost:8080/callback — times out in 5 min)');
    open(url);
    setTimeout(() => { console.error('Auth timed out.'); server.close(); process.exit(1); }, 5 * 60 * 1000);
  });
}

// ── sync ──────────────────────────────────────────────────
async function cmdSync() {
  if (!polar.getToken()) { console.error('Not authenticated. Run: polar auth'); process.exit(1); }
  console.log('Syncing exercises from Polar...');
  const result = await polar.syncExercises();
  console.log(`✅ Synced: ${result.synced}, Skipped: ${result.skipped}`);
}

// ── exercises ─────────────────────────────────────────────
function cmdExercises() {
  const limit = parseInt(parseFlag('limit', '15'));
  const rows = polar.getExercises(limit);
  if (!rows.length) { console.log('No exercises found.'); return; }

  console.log(`${pad('ID', 10)} ${pad('Date', 12)} ${pad('Sport', 10)} ${rpad('Dist', 8)} ${rpad('Duration', 10)} ${rpad('HR', 7)} ${rpad('RI', 4)}`);
  console.log('─'.repeat(65));
  for (const r of rows) {
    console.log(
      `${pad(r.id?.slice(0, 8) || '?', 10)} ` +
      `${pad(r.start_time?.slice(0, 10) || '?', 12)} ` +
      `${pad(r.detailed_sport || r.sport || '', 10)} ` +
      `${rpad(fmtDist(r.distance || 0), 8)} ` +
      `${rpad(fmtDuration(r.duration), 10)} ` +
      `${rpad(r.hr_avg ? r.hr_avg + '/' + r.hr_max : '—', 7)} ` +
      `${rpad(r.running_index || '—', 4)}`
    );
  }
}

// ── exercise <id> ─────────────────────────────────────────
function cmdExercise() {
  const id = args[0];
  if (!id) { console.error('Usage: polar exercise <id>'); process.exit(1); }
  const ex = polar.getExerciseDetail(id);
  if (!ex) { console.error('Exercise not found:', id); process.exit(1); }

  const durSec = fmtDuration(ex.duration);
  const distKm = (ex.distance || 0) / 1000;
  const paceSec = ex.duration && ex.distance ? parseDuration(ex.duration) / 60 / distKm : null;

  console.log(`\n📋 Exercise ${ex.id}`);
  console.log(`   Date:     ${ex.start_time}`);
  console.log(`   Sport:    ${ex.detailed_sport || ex.sport}`);
  console.log(`   Distance: ${distKm.toFixed(1)} km`);
  console.log(`   Duration: ${durSec}`);
  if (paceSec) console.log(`   Pace:     ${fmtPace(paceSec)} /km`);
  console.log(`   HR:       ${ex.hr_avg || '—'} avg / ${ex.hr_max || '—'} max`);
  console.log(`   Calories: ${ex.calories || '—'}`);
  if (ex.training_load) console.log(`   Load:     ${ex.training_load}`);
  if (ex.running_index) console.log(`   RI:       ${ex.running_index}`);

  if (ex.zones?.length) {
    console.log('\n   HR Zones:');
    for (const z of ex.zones) {
      console.log(`     Zone ${z.zone_index}: ${z.lower_limit}–${z.upper_limit} bpm  ${fmtDuration(z.in_zone)}`);
    }
  }

  const cls = recommender.classifyWorkout(ex);
  console.log(`\n   Type:     ${cls.label}`);
}

// ── stats ─────────────────────────────────────────────────
function cmdStats() {
  const days = parseInt(parseFlag('days', '14'));
  const metrics = snapshots.computeMetrics(days);
  if (!metrics) { console.log('No running data found.'); return; }

  console.log(`\n📊 Stats (last ${days} days)`);
  console.log(`   Runs:          ${metrics.run_count}`);
  console.log(`   Total:         ${metrics.total_km} km`);
  console.log(`   Weekly:        ${metrics.weekly_km} km/week`);
  console.log(`   Avg pace:      ${fmtPace(metrics.avg_pace_min_km)} /km`);
  console.log(`   Avg HR:        ${metrics.avg_hr} bpm`);
  if (metrics.avg_easy_hr) console.log(`   Avg easy HR:   ${metrics.avg_easy_hr} bpm`);
  console.log(`   Running index: ${metrics.avg_running_index}`);
  console.log(`   Easy/hard:     ${metrics.easy_hard_ratio}% easy`);
  console.log(`   Long runs:     ${metrics.long_runs}`);
}

// ── snapshot ──────────────────────────────────────────────
function cmdSnapshot() {
  const snap = snapshots.createSnapshot();
  if (!snap) { console.log('No data to snapshot.'); return; }
  console.log('✅ Snapshot created');
  console.log(`   Review at: ${snap.review_at}`);
  console.log(`\n${snap.analysis}`);
}

// ── review ────────────────────────────────────────────────
function cmdReview() {
  let id = args[0] ? parseInt(args[0]) : null;

  if (!id) {
    const all = snapshots.getSnapshots();
    if (!all.length) { console.log('No snapshots found. Run: polar snapshot'); return; }
    id = all[0].id;
  }

  const review = snapshots.reviewSnapshot(id);
  if (!review) { console.error('Snapshot not found:', id); process.exit(1); }

  console.log(`\n📸 Snapshot #${review.snapshot.id} (${review.snapshot.created_at})`);
  console.log(`   Review date: ${review.snapshot.review_at}\n`);

  console.log(`${pad('Metric', 20)} ${rpad('Then', 8)} ${rpad('Now', 8)} ${rpad('Diff', 8)} ${'Status'}`);
  console.log('─'.repeat(55));
  for (const c of review.comparison) {
    if (c.baseline == null && c.current == null) continue;
    const arrow = c.improved ? '✅' : c.diff === 0 ? '➖' : '⚠️';
    console.log(
      `${pad(c.label, 20)} ${rpad(c.baseline ?? '—', 8)} ${rpad(c.current ?? '—', 8)} ${rpad((c.diff > 0 ? '+' : '') + c.diff, 8)} ${arrow}`
    );
  }

  console.log(`\n📝 Current analysis:\n${review.currentAnalysis}`);
}

// ── recommend ─────────────────────────────────────────────
function cmdRecommend() {
  const r = recommender.recommend();
  const rec = r.recommendation;
  const t = r.targets;

  console.log(`\n🎯 Recommendation: ${rec.label}`);
  console.log(`   ${rec.reason}`);

  if (t) {
    console.log('\n   Targets:');
    if (t.hr) console.log(`     HR:       ${t.hr.label}`);
    if (t.pace) console.log(`     Pace:     ${t.pace.label}`);
    if (t.distance) console.log(`     Distance: ${t.distance.label}`);
    if (t.duration) console.log(`     Duration: ${t.duration.label}`);
  }

  console.log(`\n   ACR:         ${r.acr.ratio} (acute: ${r.acr.acute}, chronic: ${r.acr.chronic})`);
  console.log(`   Injury risk: ${r.injuryRisk}`);

  const d = r.distribution;
  if (d.total) {
    console.log(`\n   Last 14 days (${d.total} sessions):`);
    const c = d.counts;
    const types = Object.entries(c).filter(([, v]) => v > 0);
    if (types.length) console.log(`     ${types.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    console.log(`     Easy/hard: ${Math.round(d.easyHardRatio.easy * 100)}/${Math.round(d.easyHardRatio.hard * 100)}`);
  }
}

// ── backup ────────────────────────────────────────────────
function cmdBackup() {
  const dest = args[0];
  if (!dest) { console.error('Usage: polar backup <path>'); process.exit(1); }
  console.log(`Backing up to ${dest}...`);
  db.backup(dest).then(() => {
    console.log('✅ Backup complete');
  }).catch(e => {
    console.error('Backup failed:', e.message);
    process.exit(1);
  });
}

// ── help ──────────────────────────────────────────────────
function cmdHelp() {
  console.log(`
🏃 Polar CLI

Usage: polar <command> [options]

Commands:
  auth                  Authenticate with Polar (opens browser)
  sync                  Fetch new exercises from Polar API
  exercises [--limit N] List recent exercises (default: 15)
  exercise <id>         Show exercise detail
  stats [--days N]      Training metrics summary (default: 14 days)
  snapshot              Create a progress checkpoint
  review [id]           Compare current vs checkpoint (latest if no id)
  recommend             Get next workout recommendation
  backup <path>         Backup database to file
  import <path>         Import Polar export zip/folder
  help                  Show this help
`);
}

// ── routing ───────────────────────────────────────────────
const commands = {
  auth: cmdAuth,
  sync: cmdSync,
  exercises: cmdExercises,
  exercise: cmdExercise,
  stats: cmdStats,
  snapshot: cmdSnapshot,
  review: cmdReview,
  recommend: cmdRecommend,
  backup: cmdBackup,
  import: () => {
    const input = args[0];
    if (!input) { console.error('Usage: polar import <path>'); process.exit(1); }
    const importer = require('../src/import');
    const result = importer.importAll(input);
    console.log(`✅ Imported: ${result.imported}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
  },
  help: cmdHelp,
};

const fn = commands[cmd];
if (!fn) {
  if (cmd) console.error(`Unknown command: ${cmd}`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}

Promise.resolve(fn()).catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
