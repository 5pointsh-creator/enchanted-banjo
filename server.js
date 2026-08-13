const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, migrate, getOrCreateSigningSecret, ensureOwnerCode } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTION = !!process.env.DATABASE_URL;

// Never sign real sessions with a secret that sits in a public repo. A JWT_SECRET in the
// environment wins if one is set; otherwise the key comes from the database, which keeps
// people signed in across redeploys without anyone having to configure anything.
let signingSecret = process.env.JWT_SECRET || (PRODUCTION ? null : 'dev-secret-change-me');
let secretSource = process.env.JWT_SECRET ? 'environment' : (PRODUCTION ? 'pending' : 'development');

// Railway terminates HTTPS at its proxy, so req.secure needs this to be true
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// The site must come up even before a database exists, otherwise the very first
// deploy dies and takes the whole page with it. Until the database answers, the
// API politely refuses and the front-end falls back to on-device demo storage.
let dbReady = false;

// Answers before the database is up, so it can report on the database itself.
// Deliberately says only where the session key came from, never what it is.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: dbReady, sessionKey: secretSource });
});

app.use('/api', (req, res, next) => {
  if (!dbReady) {
    return res.status(503).json({ error: 'The shared database is still being set up - saving to this device for now.' });
  }
  next();
});

// ---- auth helpers ----
function issueToken(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email }, signingSecret, { expiresIn: '30d' });
  res.cookie('bs_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: PRODUCTION,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}
function currentUser(req) {
  const t = req.cookies && req.cookies.bs_token;
  if (!t || !signingSecret) return null;
  try { return jwt.verify(t, signingSecret); } catch { return null; }
}
// Reads the account fresh rather than trusting the cookie's copy, so a removed account
// cannot keep acting on an old token, and so ownership is always current.
async function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please sign in first.' });
  try {
    const { rows } = await pool.query('SELECT id,email,display_name,is_admin FROM users WHERE id=$1', [u.id]);
    if (!rows.length) return res.status(401).json({ error: 'Please sign in again.' });
    req.user = { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name, isAdmin: !!rows[0].is_admin };
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong.' }); }
}
const publicUser = (row) => ({ id: row.id, email: row.email, displayName: row.display_name, isOwner: !!row.is_admin });
// Tells you which ones are yours, without handing out anybody's account id.
const decorate = (row, me) => {
  const { owner_id, ...rest } = row;
  return { ...rest, mine: !!(me && owner_id && owner_id === me.id) };
};

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

// A tree already dedicated cannot be dedicated again: claiming one of the forest's own
// trees lands exactly on it, so anything this close is that same tree. New trees keep a
// wider berth so nobody's plaque ends up inside somebody else's.
const SAME_TREE = 0.75;
const TREE_CLEARANCE = 4;

async function tooCloseToExistingTree(x, z, isAdopt) {
  const limit = isAdopt ? SAME_TREE : TREE_CLEARANCE;
  const { rows } = await pool.query(
    'SELECT id, adopt FROM trees WHERE (x-$1)*(x-$1) + (z-$2)*(z-$2) < $3 LIMIT 1',
    [x, z, limit * limit]
  );
  return rows[0] || null;
}

// ---- trees (shared) ----
app.get('/api/trees', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    'SELECT t.id,t.x,t.z,t.name,t.message,t.color,t.tier,t.adopt,t.song,t.owner_id,u.display_name AS owner FROM trees t LEFT JOIN users u ON u.id=t.owner_id ORDER BY t.id'
  );
  res.json({ trees: rows.map((r) => decorate(r, me)) });
});
app.post('/api/trees', requireAuth, async (req, res) => {
  const b = req.body || {};
  const x = +b.x || 0, z = +b.z || 0;
  const clash = await tooCloseToExistingTree(x, z, !!b.adopt);
  if (clash) {
    return res.status(409).json({
      error: b.adopt
        ? 'Someone has already dedicated this tree. Please choose another one.'
        : 'There is already a tree here. Please plant a little further away.',
    });
  }
  const { rows } = await pool.query(
    'INSERT INTO trees (owner_id,x,z,name,message,color,tier,adopt,song) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [req.user.id, x, z, (b.name || '').slice(0, 60), (b.message || '').slice(0, 200),
     b.color || '#b26bff', b.tier || 'spirit', !!b.adopt, b.song || null]
  );
  res.json({ tree: decorate(rows[0], req.user) });
});

// ---- stars (shared) ----
app.get('/api/stars', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    'SELECT s.id,s.dx,s.dy,s.dz,s.name,s.message,s.tier,s.song,s.owner_id,u.display_name AS owner FROM stars s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.id'
  );
  res.json({ stars: rows.map((r) => decorate(r, me)) });
});
app.post('/api/stars', requireAuth, async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO stars (owner_id,dx,dy,dz,name,message,tier,song) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [req.user.id, +b.dx || 0, +b.dy || 0, +b.dz || 0, (b.name || '').slice(0, 60), (b.message || '').slice(0, 200), b.tier || 'white', b.song || null]
  );
  res.json({ star: decorate(rows[0], req.user) });
});

// ---- changing your mind: edit or remove your own dedication ----
// Grief makes for typos, and a name spelt wrong is not a small thing. Anyone may edit or
// remove their own; the site owner may remove anything, which is the only way to take down
// something cruel written beside somebody else's mother.
function editRoutes(table, key, fields) {
  app.patch(`/api/${table}/:id`, requireAuth, async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'That one no longer exists.' });
    if (row.owner_id !== req.user.id) return res.status(403).json({ error: 'You can only change your own.' });
    const b = req.body || {};
    const next = {
      name: (b.name !== undefined ? String(b.name).slice(0, 60) : row.name),
      message: (b.message !== undefined ? String(b.message).slice(0, 200) : row.message),
      song: (b.song !== undefined ? b.song : row.song),
    };
    const upd = await pool.query(
      `UPDATE ${table} SET name=$1, message=$2, song=$3 WHERE id=$4 RETURNING *`,
      [next.name, next.message, next.song, req.params.id]
    );
    res.json({ [key]: decorate(upd.rows[0], req.user) });
  });

  app.delete(`/api/${table}/:id`, requireAuth, async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]);
    const row = rows[0];
    if (!row) return res.json({ ok: true });
    if (row.owner_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'You can only remove your own.' });
    }
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  });
}
editRoutes('trees', 'tree', ['name', 'message', 'song']);
editRoutes('stars', 'star', ['name', 'message', 'song']);

// ---- becoming the site owner ----
// Whoever runs the site needs to be able to take down something cruel, but there is no
// email to send a code to and environment variables have already proved too easy to mistype.
// So: on the first start with no owner, a one-time word is printed in the deploy log. The
// signed-in person who types it back becomes the owner. It works exactly once.
app.post('/api/claim-owner', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key='owner_code'`);
  if (!rows.length) return res.status(409).json({ error: 'This site already has an owner.' });
  const given = String((req.body || {}).code || '').trim().toLowerCase();
  if (!given || given !== rows[0].value) return res.status(403).json({ error: 'That code is not right.' });
  await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [req.user.id]);
  await pool.query(`DELETE FROM settings WHERE key='owner_code'`);
  console.log('Site owner claimed by user ' + req.user.id + '. The one-time code is now spent.');
  res.json({ ok: true });
});

// ---- static site (same HTML the Pages preview serves) ----
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

app.listen(PORT, () => console.log(`Banjo Spirits running on :${PORT}`));

// Keep trying: the database is often attached minutes after the first deploy.
function connect() {
  migrate()
    .then(async () => {
      if (!signingSecret) {
        signingSecret = await getOrCreateSigningSecret();
        secretSource = 'database';
      }
      dbReady = true;
      console.log('Database connected - accounts and shared dedications are live.');
      console.log('Session key source: ' + secretSource);
      const code = await ensureOwnerCode();
      if (code) {
        console.log('');
        console.log('  This site has no owner yet.');
        console.log('  Sign in on the site, open /owner.html and enter:  ' + code);
        console.log('  That makes you the owner and the code stops working.');
        console.log('');
      }
    })
    .catch((e) => {
      console.warn('No database yet, running in demo mode. Retrying in 30s. (' + e.message + ')');
      setTimeout(connect, 30000);
    });
}
connect();
