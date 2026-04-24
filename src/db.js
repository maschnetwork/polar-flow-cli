const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'polar_data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    token_type TEXT DEFAULT 'bearer'
  );

  CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY,
    raw_json TEXT NOT NULL,
    sport TEXT,
    detailed_sport TEXT,
    start_time TEXT,
    duration TEXT,
    distance REAL,
    calories INTEGER,
    hr_avg INTEGER,
    hr_max INTEGER,
    training_load REAL,
    running_index INTEGER,
    has_route INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exercise_samples (
    exercise_id TEXT NOT NULL,
    sample_type TEXT NOT NULL,
    recording_rate INTEGER,
    data TEXT,
    PRIMARY KEY (exercise_id, sample_type),
    FOREIGN KEY (exercise_id) REFERENCES exercises(id)
  );

  CREATE TABLE IF NOT EXISTS exercise_routes (
    exercise_id TEXT PRIMARY KEY,
    route_json TEXT NOT NULL,
    FOREIGN KEY (exercise_id) REFERENCES exercises(id)
  );

  CREATE TABLE IF NOT EXISTS exercise_zones (
    exercise_id TEXT NOT NULL,
    zone_index INTEGER,
    lower_limit INTEGER,
    upper_limit INTEGER,
    in_zone TEXT,
    PRIMARY KEY (exercise_id, zone_index),
    FOREIGN KEY (exercise_id) REFERENCES exercises(id)
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    review_at TEXT NOT NULL,
    metrics TEXT NOT NULL,
    goals TEXT NOT NULL,
    analysis TEXT,
    review_notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_exercises_sport_time ON exercises(sport, start_time);
`);

module.exports = db;
