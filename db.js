const { Pool } = require('pg');

// Railway provides DATABASE_URL in production. Locally we fall back to the dev cluster.
const connectionString =
  process.env.DATABASE_URL ||
  'postgres://bs_dev@127.0.0.1:55432/banjospirits';

const pool = new Pool({
  connectionString,
  // Railway Postgres needs SSL; local dev does not.
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS trees (
      id         SERIAL PRIMARY KEY,
      owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      x          REAL NOT NULL,
      z          REAL NOT NULL,
      name       TEXT,
      message    TEXT,
      color      TEXT,
      tier       TEXT,
      adopt      BOOLEAN DEFAULT FALSE,
      song       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stars (
      id         SERIAL PRIMARY KEY,
      owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      dx         REAL NOT NULL,
      dy         REAL NOT NULL,
      dz         REAL NOT NULL,
      name       TEXT,
      message    TEXT,
      tier       TEXT,
      song       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // keeps older databases in step with the melody feature
  await pool.query(`
    ALTER TABLE trees ADD COLUMN IF NOT EXISTS song TEXT;
    ALTER TABLE stars ADD COLUMN IF NOT EXISTS song TEXT;
  `);
  // somewhere durable to keep the session signing key, so it survives a redeploy
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// The signing key decides whether people stay signed in. Held in the database so a
// redeploy cannot change it: generated once, then read back every time after that.
// ON CONFLICT DO NOTHING means two containers starting at once still agree on one key.
async function getOrCreateSigningSecret() {
  const fresh = require('crypto').randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('jwt_secret', $1) ON CONFLICT (key) DO NOTHING`,
    [fresh]
  );
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key='jwt_secret'`);
  return rows[0].value;
}

module.exports = { pool, migrate, getOrCreateSigningSecret };
