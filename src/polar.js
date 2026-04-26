const config = require('./config');
const db = require('./db');
const { isTargetSport } = require('./util');

async function apiFetch(endpoint, token, accept = 'application/json') {
  const res = await fetch(`${config.apiBase}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

function getToken() {
  const row = db.prepare('SELECT access_token FROM auth WHERE id = 1').get();
  return row?.access_token;
}

async function exchangeToken(code) {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

async function registerUser(token) {
  try {
    const res = await fetch(`${config.apiBase}/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ 'member-id': `polar-dashboard-${Date.now()}` }),
    });
    if (res.status === 409) return; // already registered
    if (!res.ok) console.error('Register user:', res.status, await res.text());
  } catch (e) {
    console.error('Register user error:', e.message);
  }
}

async function syncExercises() {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');

  const exercises = await apiFetch('/exercises?samples=true&zones=true&route=true', token);
  if (!exercises || !exercises.length) return { synced: 0, skipped: 0 };

  let synced = 0, skipped = 0;

  const insertExercise = db.prepare(`
    INSERT OR REPLACE INTO exercises (id, raw_json, sport, detailed_sport, start_time, duration, distance, calories, hr_avg, hr_max, training_load, running_index, has_route)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSample = db.prepare(`INSERT OR REPLACE INTO exercise_samples (exercise_id, sample_type, recording_rate, data) VALUES (?, ?, ?, ?)`);
  const insertRoute = db.prepare(`INSERT OR REPLACE INTO exercise_routes (exercise_id, route_json) VALUES (?, ?)`);
  const insertZone = db.prepare(`INSERT OR REPLACE INTO exercise_zones (exercise_id, zone_index, lower_limit, upper_limit, in_zone) VALUES (?, ?, ?, ?, ?)`);

  db.transaction(() => {

  for (const ex of exercises) {
    const sport = ex.detailed_sport_info || ex.sport || '';
    if (!isTargetSport(sport)) { skipped++; continue; }

    insertExercise.run(
      ex.id, JSON.stringify(ex), ex.sport, ex.detailed_sport_info,
      ex.start_time, ex.duration, ex.distance || 0, ex.calories || 0,
      ex.heart_rate?.average || null, ex.heart_rate?.maximum || null,
      ex.training_load || ex.exercises?.[0]?.trainingLoadReport?.cardioLoad || null,
      ex.running_index || ex['running-index'] || ex.runningIndex || null,
      ex.has_route ? 1 : 0
    );

    if (ex.samples) {
      for (const s of ex.samples) {
        const sType = String(parseInt(s['sample-type'] ?? s.sample_type));
        if (sType == null) continue;
        insertSample.run(ex.id, sType, s['recording-rate'] ?? s.recording_rate, s.data);
      }
    }

    if (ex.route && ex.route.length) {
      insertRoute.run(ex.id, JSON.stringify(ex.route));
    }

    if (ex.heart_rate_zones) {
      for (const z of ex.heart_rate_zones) {
        insertZone.run(ex.id, z.index, z['lower-limit'] ?? z.lower_limit, z['upper-limit'] ?? z.upper_limit, z['in-zone'] ?? z.in_zone);
      }
    }

    synced++;
  }

  })();

  return { synced, skipped };
}

function getExercises(limit = 200) {
  return db.prepare(`
    SELECT id, sport, detailed_sport, start_time, duration, distance, calories,
           hr_avg, hr_max, training_load, running_index, has_route
    FROM exercises ORDER BY start_time DESC LIMIT ?
  `).all(limit);
}

function getExerciseDetail(id) {
  let ex = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  if (!ex) ex = db.prepare('SELECT * FROM exercises WHERE id LIKE ?').get(id + '%');
  if (!ex) return null;
  const samples = db.prepare('SELECT * FROM exercise_samples WHERE exercise_id = ?').all(id);
  const route = db.prepare('SELECT route_json FROM exercise_routes WHERE exercise_id = ?').get(id);
  const zones = db.prepare('SELECT * FROM exercise_zones WHERE exercise_id = ? ORDER BY zone_index').all(id);
  return { ...ex, samples, route: route ? JSON.parse(route.route_json) : null, zones };
}

module.exports = { exchangeToken, registerUser, syncExercises, getExercises, getExerciseDetail, getToken };
