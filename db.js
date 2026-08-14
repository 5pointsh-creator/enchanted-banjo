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
  // Paper Valley: people looking for someone who is still alive.
  // There is no x/z here on purpose. Lanterns are never scattered - each one takes the
  // next place along the trail, so the walk is always lit and the trail grows outwards
  // as people arrive. seq decides where it stands, and the world works it out from that.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lanterns (
      id           SERIAL PRIMARY KEY,
      owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      seq          INTEGER NOT NULL,
      name         TEXT,
      relation     TEXT,
      age_now      TEXT,
      last_area    TEXT,
      lost_year    TEXT,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'looking',
      confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lanterns_seq_idx ON lanterns (seq);
  `);
  // What somebody walking past knows, said out loud beside the lantern. Public, because
  // half of what helps a search is other people's half-memories arguing with each other.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lantern_comments (
      id         SERIAL PRIMARY KEY,
      lantern_id INTEGER NOT NULL REFERENCES lanterns(id) ON DELETE CASCADE,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS lantern_comments_lantern_idx ON lantern_comments (lantern_id);
  `);
  // And what they would rather not say in public. This is what replaces posting your own
  // social media on a page anyone can read: the message comes here, and only the person
  // searching sees it. They decide afterwards whether to hand over anything else.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lantern_tips (
      id         SERIAL PRIMARY KEY,
      lantern_id INTEGER NOT NULL REFERENCES lanterns(id) ON DELETE CASCADE,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      contact    TEXT,
      read_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS lantern_tips_lantern_idx ON lantern_tips (lantern_id);
  `);
  // When a search actually ends well. Kept apart from the lantern so the story survives
  // even after the lantern itself is taken down.
  await pool.query(`
    ALTER TABLE lanterns ADD COLUMN IF NOT EXISTS found_at TIMESTAMPTZ;
    ALTER TABLE lanterns ADD COLUMN IF NOT EXISTS found_note TEXT;
  `);
  // The campfire: what people have learned about searching, left for whoever comes next.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campfire_notes (
      id         SERIAL PRIMARY KEY,
      fire       TEXT NOT NULL DEFAULT 'general',
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Somebody who is not lost - who left, and does not want finding - must be able to say
  // so without needing an account. The request lands here and the site owner sees it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS takedowns (
      id         SERIAL PRIMARY KEY,
      lantern_id INTEGER REFERENCES lanterns(id) ON DELETE CASCADE,
      reason     TEXT,
      resolved   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // somewhere durable to keep the session signing key, so it survives a redeploy
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // whoever runs the site can take down something cruel; nobody else can
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`);
}

// Printed in the deploy log on the first start only, and only while nobody owns the site
// yet. Three plain words, because it gets read off one phone screen and typed into another.
const WORDS = ['banjo','forest','star','river','lantern','willow','ember','meadow','hollow',
               'thistle','harbour','clover','autumn','birch','quiet','amber','heather','moss'];
async function ensureOwnerCode() {
  const { rows: admins } = await pool.query('SELECT 1 FROM users WHERE is_admin LIMIT 1');
  if (admins.length) { await pool.query(`DELETE FROM settings WHERE key='owner_code'`); return null; }
  const existing = await pool.query(`SELECT value FROM settings WHERE key='owner_code'`);
  if (existing.rows.length) return existing.rows[0].value;
  const crypto = require('crypto');
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const code = `${pick()}-${pick()}-${pick()}`;
  await pool.query(`INSERT INTO settings (key,value) VALUES ('owner_code',$1)
                    ON CONFLICT (key) DO NOTHING`, [code]);
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key='owner_code'`);
  return rows[0].value;
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

module.exports = { pool, migrate, getOrCreateSigningSecret, ensureOwnerCode };
