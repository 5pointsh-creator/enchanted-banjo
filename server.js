const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, migrate } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTION = !!process.env.DATABASE_URL;
// never sign real sessions with a secret that sits in a public repo
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (PRODUCTION ? require('crypto').randomBytes(32).toString('hex') : 'dev-secret-change-me');
if (PRODUCTION && !process.env.JWT_SECRET) {
  console.warn('JWT_SECRET not set - using a temporary one, everyone signs in again after a redeploy.');
}

// Railway terminates HTTPS at its proxy, so req.secure needs this to be true
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// The site must come up even before a database exists, otherwise the very first
// deploy dies and takes the whole page with it. Until the database answers, the
// API politely refuses and the front-end falls back to on-device demo storage.
let dbReady = false;
app.use('/api', (req, res, next) => {
  if (!dbReady) {
    return res.status(503).json({ error: 'The shared database is still being set up - saving to this device for now.' });
  }
  next();
});

// ---- auth helpers ----
function issueToken(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('bs_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: PRODUCTION,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}
function currentUser(req) {
  const t = req.cookies && req.cookies.bs_token;
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET); } catch { return null; }
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please sign in first.' });
  req.user = u;
  next();
}
const publicUser = (row) => ({ id: row.id, email: row.email, displayName: row.display_name });

// ---- auth routes ----
app.post('/api/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim() || email.split('@')[0];
    if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING *',
      [email, hash, displayName]
    );
    issueToken(res, rows[0]);
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email is already registered - try signing in.' });
    console.error(e); res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'No account with that email.' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password.' });
    issueToken(res, rows[0]);
    res.json({ user: publicUser(rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong.' }); }
});

app.post('/api/logout', (req, res) => { res.clearCookie('bs_token'); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ user: null });
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [u.id]);
  res.json({ user: rows.length ? publicUser(rows[0]) : null });
});

// ---- trees (shared) ----
app.get('/api/trees', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT t.id,t.x,t.z,t.name,t.message,t.color,t.tier,t.adopt,t.song,u.display_name AS owner FROM trees t LEFT JOIN users u ON u.id=t.owner_id ORDER BY t.id'
  );
  res.json({ trees: rows });
});
app.post('/api/trees', requireAuth, async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO trees (owner_id,x,z,name,message,color,tier,adopt,song) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [req.user.id, +b.x || 0, +b.z || 0, (b.name || '').slice(0, 60), (b.message || '').slice(0, 200),
     b.color || '#b26bff', b.tier || 'spirit', !!b.adopt, b.song || null]
  );
  res.json({ tree: rows[0] });
});

// ---- stars (shared) ----
app.get('/api/stars', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT s.id,s.dx,s.dy,s.dz,s.name,s.message,s.tier,s.song,u.display_name AS owner FROM stars s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.id'
  );
  res.json({ stars: rows });
});
app.post('/api/stars', requireAuth, async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO stars (owner_id,dx,dy,dz,name,message,tier,song) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [req.user.id, +b.dx || 0, +b.dy || 0, +b.dz || 0, (b.name || '').slice(0, 60), (b.message || '').slice(0, 200), b.tier || 'white', b.song || null]
  );
  res.json({ star: rows[0] });
});

// ---- static site (same HTML the Pages preview serves) ----
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

app.listen(PORT, () => console.log(`Banjo Spirits running on :${PORT}`));

// Keep trying: the database is often attached minutes after the first deploy.
function connect() {
  migrate()
    .then(() => { dbReady = true; console.log('Database connected - accounts and shared dedications are live.'); })
    .catch((e) => {
      console.warn('No database yet, running in demo mode. Retrying in 30s. (' + e.message + ')');
      setTimeout(connect, 30000);
    });
}
connect();
