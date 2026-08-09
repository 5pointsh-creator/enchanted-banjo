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
}

module.exports = { pool, migrate };
