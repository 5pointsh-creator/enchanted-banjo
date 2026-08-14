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

// ---- the lantern trail: looking for someone who is still alive ----
// Nothing here is a memorial. These are living people, and most of them never agreed to
// be listed, so the scroll takes short set answers rather than a blank box - and anything
// that could put somebody at a front door is refused before it is ever saved.
const CONTACT_DETAIL = [
  { re: /[^\s@]+@[^\s@]+\.[^\s@]+/, why: 'Please take the email address out - this is a public page.' },
  { re: /(https?:\/\/|www\.)\S+/i, why: 'Please take the web link out - this is a public page.' },
  { re: /\b\d+\s+[A-Za-z]+\s+(street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|way)\b/i,
    why: 'Please take the street address out. A town is fine; a house is not.' },
];
// Counted rather than matched on length: a run of digits only becomes a phone number at
// about nine of them, and "12 03 1998" is a date somebody lost touch, not a number to ring.
const PHONE_MIN_DIGITS = 9;
function looksLikePhone(text) {
  const runs = String(text).match(/[\d][\d\s().+-]{5,}[\d]/g) || [];
  return runs.some((r) => (r.match(/\d/g) || []).length >= PHONE_MIN_DIGITS);
}
function refuseContactDetail(fields) {
  const all = Object.values(fields).filter(Boolean).join(' \n ');
  for (const rule of CONTACT_DETAIL) if (rule.re.test(all)) return rule.why;
  if (looksLikePhone(all)) return 'Please take the phone number out - this is a public page.';
  return null;
}
const LANTERN_FIELDS = ['name', 'relation', 'age_now', 'last_area', 'lost_year', 'note'];
const readLantern = (b) => ({
  name: String(b.name || '').trim().slice(0, 60),
  relation: String(b.relation || '').trim().slice(0, 40),
  age_now: String(b.age_now || '').trim().slice(0, 20),
  last_area: String(b.last_area || '').trim().slice(0, 60),
  lost_year: String(b.lost_year || '').trim().slice(0, 12),
  note: String(b.note || '').trim().slice(0, 400),
});

app.get('/api/lanterns', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    `SELECT l.id,l.seq,l.name,l.relation,l.age_now,l.last_area,l.lost_year,l.note,l.status,
            l.owner_id,u.display_name AS owner,
            EXTRACT(EPOCH FROM (now()-l.confirmed_at))/86400 AS quiet_days
       FROM lanterns l LEFT JOIN users u ON u.id=l.owner_id ORDER BY l.seq`
  );
  res.json({ lanterns: rows.map((r) => decorate({ ...r, quiet_days: Math.round(+r.quiet_days) }, me)) });
});

app.post('/api/lanterns', requireAuth, async (req, res) => {
  const f = readLantern(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'Please put in the name of who you are looking for.' });
  const refusal = refuseContactDetail(f);
  if (refusal) return res.status(400).json({ error: refusal });
  try {
    // The next place along the trail. Retried because two people can hang a lantern at once.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows: last } = await pool.query('SELECT COALESCE(MAX(seq),0) AS m FROM lanterns');
      try {
        const { rows } = await pool.query(
          `INSERT INTO lanterns (owner_id,seq,name,relation,age_now,last_area,lost_year,note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [req.user.id, +last[0].m + 1, f.name, f.relation, f.age_now, f.last_area, f.lost_year, f.note]
        );
        return res.json({ lantern: decorate({ ...rows[0], quiet_days: 0 }, req.user) });
      } catch (e) {
        if (e.code !== '23505') throw e;   // someone took that place - step along and try again
      }
    }
    res.status(503).json({ error: 'The trail is busy just now - please try again.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong.' }); }
});

app.patch('/api/lanterns/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM lanterns WHERE id=$1', [req.params.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'That lantern is no longer there.' });
  if (row.owner_id !== req.user.id) return res.status(403).json({ error: 'You can only change your own.' });
  const b = req.body || {};
  const next = {};
  LANTERN_FIELDS.forEach((k) => { next[k] = b[k] !== undefined ? readLantern(b)[k] : row[k]; });
  const refusal = refuseContactDetail(next);
  if (refusal) return res.status(400).json({ error: refusal });
  const upd = await pool.query(
    `UPDATE lanterns SET name=$1,relation=$2,age_now=$3,last_area=$4,lost_year=$5,note=$6,
       confirmed_at=now() WHERE id=$7 RETURNING *`,
    [next.name, next.relation, next.age_now, next.last_area, next.lost_year, next.note, req.params.id]
  );
  res.json({ lantern: decorate({ ...upd.rows[0], quiet_days: 0 }, req.user) });
});

app.delete('/api/lanterns/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM lanterns WHERE id=$1', [req.params.id]);
  const row = rows[0];
  if (!row) return res.json({ ok: true });
  if (row.owner_id !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only take down your own.' });
  }
  await pool.query('DELETE FROM lanterns WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Still looking? One tap keeps it burning. Left unanswered it fades on its own, so the
// trail does not fill up with searches that ended years ago and were never closed.
app.post('/api/lanterns/:id/still-looking', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT owner_id FROM lanterns WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'That lantern is no longer there.' });
  if (rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'You can only answer for your own.' });
  await pool.query(`UPDATE lanterns SET confirmed_at=now(), status='looking' WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// A person who left and does not want to be found needs a way out that does not require
// them to make an account on the site that is looking for them.
app.post('/api/lanterns/:id/takedown', async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM lanterns WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.json({ ok: true });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 400);
  await pool.query('INSERT INTO takedowns (lantern_id, reason) VALUES ($1,$2)', [req.params.id, reason]);
  res.json({ ok: true });
});

app.get('/api/takedowns', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Owner only.' });
  const { rows } = await pool.query(
    `SELECT t.id,t.reason,t.created_at,l.id AS lantern_id,l.name
       FROM takedowns t JOIN lanterns l ON l.id=t.lantern_id
      WHERE NOT t.resolved ORDER BY t.created_at`
  );
  res.json({ takedowns: rows });
});

app.post('/api/takedowns/:id/resolve', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Owner only.' });
  await pool.query('UPDATE takedowns SET resolved=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
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

// ---- a link for one lantern ----
// A search posted to a group disappears the same day. Given its own address, the lantern
// can be pasted anywhere and shows who is being looked for, so the people who post are
// also the people who bring others back. Crawlers read the tags; a person is sent on in.
const escHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/lantern/:id', async (req, res) => {
  let row = null;
  if (dbReady) {
    try {
      const { rows } = await pool.query(
        'SELECT id,name,relation,last_area,lost_year,note FROM lanterns WHERE id=$1', [req.params.id]
      );
      row = rows[0] || null;
    } catch (e) { console.error(e); }
  }
  const target = `/lanterns.html?l=${encodeURIComponent(req.params.id)}`;
  const title = row ? `Looking for ${row.name} — Banjo Spirits` : 'The lantern trail — Banjo Spirits';
  const bits = row
    ? [row.relation && `${row.relation}.`, row.last_area && `Last known around ${row.last_area}.`,
       row.lost_year && `Out of contact since ${row.lost_year}.`, row.note].filter(Boolean).join(' ')
    : 'A trail of lanterns for people searching for someone who is still out there.';
  res.set('Content-Type', 'text/html; charset=utf-8').send(
`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(bits).slice(0, 300)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Banjo Spirits">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(bits).slice(0, 300)}">
<meta property="og:image" content="https://banjospirits.com/tour-poster.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${escHtml(target)}">
</head><body><p>Taking you to the lantern… <a href="${escHtml(target)}">continue</a></p>
<script>location.replace(${JSON.stringify(target)});</script></body></html>`);
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
