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
// Comments and campfire notes record who wrote them, not who owns them, so they need
// their own version - handing the first one `owner_id` quietly marks everything "not mine"
// and the Remove button never appears on your own words.
const decorateAuthored = (row, me) => {
  const { author_id, ...rest } = row;
  return { ...rest, mine: !!(me && author_id && author_id === me.id) };
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

// ---- Paper Valley: looking for someone who is still alive ----
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
            l.found_note,l.owner_id,u.display_name AS owner,
            EXTRACT(EPOCH FROM (now()-l.confirmed_at))/86400 AS quiet_days,
            (SELECT COUNT(*) FROM lantern_comments c WHERE c.lantern_id = l.id) AS comment_count
       FROM lanterns l LEFT JOIN users u ON u.id=l.owner_id ORDER BY l.seq`
  );
  res.json({ lanterns: rows.map((r) => decorate(
    { ...r, quiet_days: Math.round(+r.quiet_days), comment_count: +r.comment_count }, me)) });
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

// ---- what people walking past know ----
app.get('/api/lanterns/:id/comments', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    `SELECT c.id, c.body, c.created_at, c.author_id, u.display_name AS author
       FROM lantern_comments c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.lantern_id = $1 ORDER BY c.created_at`, [req.params.id]
  );
  res.json({ comments: rows.map((r) => decorateAuthored(r, me ? { id: me.id } : null)) });
});

app.post('/api/lanterns/:id/comments', requireAuth, async (req, res) => {
  const body = String((req.body || {}).body || '').trim().slice(0, 600);
  if (!body) return res.status(400).json({ error: 'Please write something first.' });
  const refusal = refuseContactDetail({ body });
  if (refusal) return res.status(400).json({ error: refusal });
  const { rows: l } = await pool.query('SELECT id FROM lanterns WHERE id=$1', [req.params.id]);
  if (!l.length) return res.status(404).json({ error: 'That lantern is no longer there.' });
  const { rows } = await pool.query(
    `INSERT INTO lantern_comments (lantern_id, author_id, body) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, req.user.id, body]
  );
  res.json({ comment: { ...decorateAuthored(rows[0], req.user), author: req.user.displayName } });
});

// Own comment, or the site owner taking down something cruel.
app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT author_id FROM lantern_comments WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.json({ ok: true });
  if (rows[0].author_id !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only remove your own.' });
  }
  await pool.query('DELETE FROM lantern_comments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- "I have information" ----
// Private, and deliberately so. Posting your own contact details on a public page is how
// people searching get found by scammers instead; this way the message reaches the searcher
// and nobody else, and they choose what to give back.
app.post('/api/lanterns/:id/tip', requireAuth, async (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '').trim().slice(0, 1200);
  const contact = String(b.contact || '').trim().slice(0, 200);
  if (!body) return res.status(400).json({ error: 'Please write what you know first.' });
  const { rows: l } = await pool.query('SELECT owner_id FROM lanterns WHERE id=$1', [req.params.id]);
  if (!l.length) return res.status(404).json({ error: 'That lantern is no longer there.' });
  if (l[0].owner_id === req.user.id) return res.status(400).json({ error: 'That is your own lantern.' });
  await pool.query(
    'INSERT INTO lantern_tips (lantern_id, author_id, body, contact) VALUES ($1,$2,$3,$4)',
    [req.params.id, req.user.id, body, contact || null]
  );
  res.json({ ok: true });
});

// Everything left for the lanterns you are the one searching on.
app.get('/api/tips', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.body, t.contact, t.created_at, t.read_at, t.lantern_id,
            l.name AS looking_for, u.display_name AS author
       FROM lantern_tips t
       JOIN lanterns l ON l.id = t.lantern_id
       LEFT JOIN users u ON u.id = t.author_id
      WHERE l.owner_id = $1 ORDER BY t.created_at DESC`, [req.user.id]
  );
  res.json({ tips: rows });
});

app.post('/api/tips/:id/read', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE lantern_tips t SET read_at = now()
       FROM lanterns l WHERE l.id = t.lantern_id AND t.id = $1 AND l.owner_id = $2`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

// ---- found ----
// The whole point of the place, and the only thing that will convince anyone else to post.
app.post('/api/lanterns/:id/found', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT owner_id FROM lanterns WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'That lantern is no longer there.' });
  if (rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Only the person searching can say that.' });
  const note = String((req.body || {}).note || '').trim().slice(0, 600);
  const refusal = refuseContactDetail({ note });
  if (refusal) return res.status(400).json({ error: refusal });
  const upd = await pool.query(
    `UPDATE lanterns SET status='found', found_at=now(), found_note=$2, confirmed_at=now()
      WHERE id=$1 RETURNING *`, [req.params.id, note || null]
  );
  res.json({ lantern: decorate({ ...upd.rows[0], quiet_days: 0 }, req.user) });
});

// The reunion stories, which live in the mill.
app.get('/api/reunions', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, relation, last_area, lost_year, found_note, found_at
       FROM lanterns WHERE status='found' ORDER BY found_at DESC NULLS LAST LIMIT 200`
  );
  res.json({ reunions: rows });
});

// ---- the campfire ----
// Not another place to post about a missing person: the place where people who are
// searching hand on what they have learned about searching. Take one, leave one.
app.get('/api/campfire', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    `SELECT n.id, n.body, n.created_at, n.author_id, u.display_name AS author
       FROM campfire_notes n LEFT JOIN users u ON u.id = n.author_id
      ORDER BY n.created_at DESC LIMIT 200`
  );
  res.json({ notes: rows.map((r) => decorateAuthored(r, me ? { id: me.id } : null)) });
});

app.post('/api/campfire', requireAuth, async (req, res) => {
  const body = String((req.body || {}).body || '').trim().slice(0, 600);
  if (!body) return res.status(400).json({ error: 'Please write something first.' });
  const refusal = refuseContactDetail({ body });
  if (refusal) return res.status(400).json({ error: refusal });
  const { rows } = await pool.query(
    'INSERT INTO campfire_notes (author_id, body) VALUES ($1,$2) RETURNING *',
    [req.user.id, body]
  );
  res.json({ note: { ...decorateAuthored(rows[0], req.user), author: req.user.displayName } });
});

app.delete('/api/campfire/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT author_id FROM campfire_notes WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.json({ ok: true });
  if (rows[0].author_id !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only remove your own.' });
  }
  await pool.query('DELETE FROM campfire_notes WHERE id=$1', [req.params.id]);
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

// ---- the wheel ("5 Days") ----
// A car is a feeling, not a person, so the same twelve cars hold everybody carrying the
// same thing. Reading is open to anyone; writing needs an account, the same as the forest,
// because a reply left under somebody's worst day has to be answerable to something.
// What is SHOWN is anonymous unless the writer chooses to sign it.

const MAX_NOTE = 1200;
const MAX_REPLY = 600;
const MAX_SONG = 160;

const wheelPublic = (row, me) => {
  const { author_id, ...rest } = row;
  return { ...rest, mine: !!(me && author_id && author_id === me.id) };
};

app.get('/api/wheel', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.kind, c.seq, c.built_in,
            COUNT(n.id)::int AS notes,
            MAX(n.created_at)  AS latest
       FROM wheel_cars c
       LEFT JOIN wheel_notes n ON n.car_id = c.id
      GROUP BY c.id
      ORDER BY c.seq`
  );
  res.json({ cars: rows });
});

app.get('/api/wheel/:carId/notes', async (req, res) => {
  const me = currentUser(req);
  const { rows: notes } = await pool.query(
    `SELECT id, car_id, signed_as, body, song, author_id, created_at
       FROM wheel_notes WHERE car_id=$1 ORDER BY created_at DESC LIMIT 200`,
    [req.params.carId]
  );
  if (!notes.length) return res.json({ notes: [] });
  // one query for every reply in the car, then grouped in memory - a query per note
  // would be a dozen round trips for a car anyone actually writes in
  const { rows: replies } = await pool.query(
    `SELECT id, note_id, signed_as, body, song, author_id, created_at
       FROM wheel_replies WHERE note_id = ANY($1::int[]) ORDER BY created_at`,
    [notes.map((n) => n.id)]
  );
  const byNote = new Map();
  for (const r of replies) {
    if (!byNote.has(r.note_id)) byNote.set(r.note_id, []);
    byNote.get(r.note_id).push(wheelPublic(r, me));
  }
  res.json({
    notes: notes.map((n) => ({ ...wheelPublic(n, me), replies: byNote.get(n.id) || [] })),
  });
});

// Everything written today, in the order it was written. This is what the wheel carries
// up one car at a time during the nightly turn.
app.get('/api/wheel/today', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    `SELECT n.id, n.car_id, c.name AS car, n.signed_as, n.body, n.song, n.author_id, n.created_at
       FROM wheel_notes n JOIN wheel_cars c ON c.id = n.car_id
      WHERE n.created_at > now() - interval '24 hours'
      ORDER BY n.created_at`
  );
  res.json({ notes: rows.map((r) => wheelPublic(r, me)) });
});

app.get('/api/wheel/note/:id', async (req, res) => {
  const me = currentUser(req);
  const { rows } = await pool.query(
    `SELECT n.id, n.car_id, c.name AS car, n.signed_as, n.body, n.song, n.author_id, n.created_at
       FROM wheel_notes n JOIN wheel_cars c ON c.id = n.car_id
      WHERE n.id=$1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'That note is gone.' });
  res.json({ note: wheelPublic(rows[0], me) });
});

app.post('/api/wheel/notes', requireAuth, async (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '').trim().slice(0, MAX_NOTE);
  const song = String(b.song || '').trim().slice(0, MAX_SONG);
  const signedAs = String(b.signedAs || '').trim().slice(0, 40) || null;
  if (!body) return res.status(400).json({ error: 'Write something first.' });

  let carId = +b.carId || 0;

  // Hanging a new car: what somebody is carrying had no name on the wheel yet. It goes
  // on the end rather than into the alternating run, so a new one can never drop two
  // heavy cars next to each other.
  const newCar = String(b.newCar || '').trim().slice(0, 40);
  if (!carId && newCar) {
    const dup = await pool.query('SELECT id FROM wheel_cars WHERE lower(name)=lower($1)', [newCar]);
    if (dup.rows.length) {
      carId = dup.rows[0].id;
    } else {
      const { rows: seqRows } = await pool.query('SELECT COALESCE(MAX(seq),-1)+1 AS next FROM wheel_cars');
      const { rows } = await pool.query(
        'INSERT INTO wheel_cars (name, kind, seq, built_in, owner_id) VALUES ($1,$2,$3,FALSE,$4) RETURNING id',
        [newCar, 'heavy', seqRows[0].next, req.user.id]
      );
      carId = rows[0].id;
    }
  }
  if (!carId) return res.status(400).json({ error: 'Pick a car, or name a new one.' });

  const car = await pool.query('SELECT id FROM wheel_cars WHERE id=$1', [carId]);
  if (!car.rows.length) return res.status(404).json({ error: 'No such car.' });

  const { rows } = await pool.query(
    `INSERT INTO wheel_notes (car_id, author_id, signed_as, body, song)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, car_id, signed_as, body, song, author_id, created_at`,
    [carId, req.user.id, signedAs, body, song || null]
  );
  res.json({ note: { ...wheelPublic(rows[0], req.user), replies: [] } });
});

app.post('/api/wheel/notes/:id/replies', requireAuth, async (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '').trim().slice(0, MAX_REPLY);
  const song = String(b.song || '').trim().slice(0, MAX_SONG);
  const signedAs = String(b.signedAs || '').trim().slice(0, 40) || null;
  // A song on its own is a complete reply here - sometimes there is nothing to say and
  // you just want to hand somebody something to listen to.
  if (!body && !song) return res.status(400).json({ error: 'Say something, or send a song.' });

  const note = await pool.query('SELECT id FROM wheel_notes WHERE id=$1', [req.params.id]);
  if (!note.rows.length) return res.status(404).json({ error: 'That note is gone.' });

  const { rows } = await pool.query(
    `INSERT INTO wheel_replies (note_id, author_id, signed_as, body, song)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, note_id, signed_as, body, song, author_id, created_at`,
    [req.params.id, req.user.id, signedAs, body || null, song || null]
  );
  res.json({ reply: wheelPublic(rows[0], req.user) });
});

for (const [table, what] of [['wheel_notes', 'note'], ['wheel_replies', 'reply']]) {
  app.delete(`/api/${table.replace('_', '/')}/:id`, requireAuth, async (req, res) => {
    const { rows } = await pool.query(`SELECT author_id FROM ${table} WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.json({ ok: true });
    if (rows[0].author_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: `You can only remove your own ${what}.` });
    }
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  });
}

// One note, given its own address. A link pasted into a group has to arrive as
// something worth opening - the car it belongs to and the words themselves - or nobody
// taps it. The page itself is only a set of tags and a redirect; the wheel does the rest.
app.get('/wheel/:id', async (req, res) => {
  let row = null;
  if (dbReady) {
    try {
      const { rows } = await pool.query(
        `SELECT n.id, n.body, n.song, c.name AS car
           FROM wheel_notes n JOIN wheel_cars c ON c.id = n.car_id
          WHERE n.id=$1`, [req.params.id]
      );
      row = rows[0] || null;
    } catch (e) { console.error(e); }
  }
  const target = `/wheel.html?n=${encodeURIComponent(req.params.id)}`;
  const title = row ? `${row.car} — 5 Days at Banjo Spirits` : '5 Days — Banjo Spirits';
  // Kept short on purpose. A share is an invitation to come and sit with somebody,
  // not a way of republishing the whole of what they said.
  const excerpt = row
    ? String(row.body).replace(/\s+/g, ' ').slice(0, 180) + (row.body.length > 180 ? '…' : '')
    : 'A Ferris wheel at night. Every car carries something people are going through.';
  res.set('Content-Type', 'text/html; charset=utf-8').send(
`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(excerpt)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Banjo Spirits">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(excerpt)}">
<meta property="og:image" content="https://www.banjospirits.com/tour-poster.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${escHtml(target)}">
</head><body><p>Taking you to the wheel… <a href="${escHtml(target)}">continue</a></p>
<script>location.replace(${JSON.stringify(target)});</script></body></html>`);
});

// ---- the night book ----
// Everything on the wheel is drawn on a canvas, which means a search engine reads the
// whole page as blank. All those words and not one of them findable. So this page is
// rendered as plain HTML ON THE SERVER - if it were assembled in the browser like the
// wheel is, it would be just as invisible and there would be no point building it.
//
// A night runs from one eight o'clock to the next, in the ride's own timezone. Adding
// four hours before truncating shifts the 20:00 boundary onto midnight, so the grouping
// falls out of one expression and follows daylight saving without any help.
// ::text on purpose. node-postgres turns a bare `date` into a JS Date, which then gets
// re-read in the server's own timezone and lands on the wrong day; a plain 'YYYY-MM-DD'
// string cannot drift.
const NIGHT_BOUNDARY =
  "date_trunc('day', (n.created_at AT TIME ZONE 'America/New_York') + interval '4 hours')::date::text";

app.get(['/night-book', '/night-book.html'], async (req, res) => {
  let nights = [];
  if (dbReady) {
    try {
      const { rows } = await pool.query(
        `SELECT n.id, n.body, n.song, n.signed_as, n.created_at, c.name AS car,
                ${NIGHT_BOUNDARY} AS night
           FROM wheel_notes n JOIN wheel_cars c ON c.id = n.car_id
          WHERE n.created_at > now() - interval '60 days'
          ORDER BY night DESC, n.created_at`
      );
      const { rows: replies } = await pool.query(
        `SELECT r.note_id, r.body, r.song, r.signed_as
           FROM wheel_replies r
          WHERE r.note_id = ANY($1::int[]) ORDER BY r.created_at`,
        [rows.map((r) => r.id)]
      );
      const byNote = new Map();
      for (const r of replies) {
        if (!byNote.has(r.note_id)) byNote.set(r.note_id, []);
        byNote.get(r.note_id).push(r);
      }
      const grouped = new Map();
      for (const r of rows) {
        const key = String(r.night);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push({ ...r, replies: byNote.get(r.id) || [] });
      }
      nights = [...grouped.entries()].map(([night, notes]) => ({ night, notes }));
    } catch (e) { console.error(e); }
  }

  const dateLabel = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long' });
  const count = (n) => n === 1 ? 'one thing' : NUMBER_WORDS[n] || String(n) + ' things';
  const songBit = (sng) => sng
    ? `<a class="song" rel="nofollow" href="https://duckduckgo.com/?q=${encodeURIComponent(sng + ' song')}">&#9834; ${escHtml(sng)}</a>`
    : '';

  const body = nights.length ? nights.map((nt) => `
    <section>
      <h2>${escHtml(dateLabel(nt.night))}</h2>
      <p class="carried">The wheel carried ${escHtml(count(nt.notes.length))} up.</p>
      ${nt.notes.map((n) => `
        <article>
          <p class="car">${escHtml(n.car)}</p>
          <p class="said">${escHtml(n.body)}</p>
          ${songBit(n.song)}
          ${n.replies.length ? `<div class="back">${n.replies.map((r) => `
            <p>${r.body ? escHtml(r.body) : ''} ${songBit(r.song)}</p>`).join('')}</div>` : ''}
        </article>`).join('')}
    </section>`).join('')
    : '<p class="empty">The wheel has not carried anything up yet. Come back after eight.</p>';

  res.set('Content-Type', 'text/html; charset=utf-8').send(
`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Night Book — 5 Days at Banjo Spirits</title>
<meta name="description" content="What the wheel carried up each night: what people are going through, in their own words, and the songs that helped.">
<link rel="canonical" href="https://www.banjospirits.com/night-book">
<meta property="og:site_name" content="Banjo Spirits">
<meta property="og:title" content="The Night Book — 5 Days at Banjo Spirits">
<meta property="og:description" content="What the wheel carried up each night, in people's own words.">
<meta property="og:image" content="https://www.banjospirits.com/tour-poster.jpg">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0718;color:#efe6ff;font-family:"Segoe UI",system-ui,sans-serif;
       line-height:1.7;padding:34px 20px 70px}
  main{max-width:660px;margin:0 auto}
  h1{font-size:26px;color:#ffeccd;margin-bottom:6px}
  .sub{opacity:.62;font-size:14px;margin-bottom:30px}
  .sub a{color:#c7b3ff}
  section{margin-bottom:38px}
  h2{font-size:17px;color:#ffdca8;border-bottom:1px solid #2a1f45;padding-bottom:7px}
  .carried{font-size:12.5px;opacity:.55;margin:6px 0 16px}
  article{border-left:2px solid #2e2350;padding:2px 0 2px 14px;margin-bottom:18px}
  .car{font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;opacity:.5}
  /* somebody will paste a long URL or lean on one key; without this it runs off the page */
  .said{font-size:15px;margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
  .back p{overflow-wrap:anywhere}
  .song{overflow-wrap:anywhere}
  .song{display:inline-block;margin-top:6px;font-size:12.5px;color:#ffdca8;
        text-decoration:none;border-bottom:1px dotted #6b5794}
  .back{margin-top:9px;padding-left:12px;border-left:1px solid #251b42;font-size:13.5px;opacity:.8}
  .empty{opacity:.6}
  footer{max-width:660px;margin:44px auto 0;padding-top:16px;border-top:1px solid #2a1f45;
         font-size:12px;opacity:.6}
  footer a{color:#c7b3ff}
</style>
</head><body><main>
<h1>The Night Book</h1>
<p class="sub">Every night at eight the wheel turns and carries up whatever was written that
day. This is what it carried. <a href="/wheel.html">Go to the wheel</a>.</p>
${body}
</main>
<footer>
If you are at the end of it, please talk to someone tonight. In the US call or text
<b>988</b> — the Suicide &amp; Crisis Lifeline, free, 24 hours. Elsewhere:
<a href="https://findahelpline.com" rel="nofollow">findahelpline.com</a>.
</footer>
<script src="/portal.js" defer></script>
</body></html>`);
});
const NUMBER_WORDS = ['nothing','one thing','two things','three things','four things','five things',
  'six things','seven things','eight things','nine things','ten things','eleven things','twelve things'];

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
  const target = `/paper-valley.html?l=${encodeURIComponent(req.params.id)}`;
  const title = row ? `Looking for ${row.name} — Banjo Spirits` : 'Paper Valley — Banjo Spirits';
  const bits = row
    ? [row.relation && `${row.relation}.`, row.last_area && `Last known around ${row.last_area}.`,
       row.lost_year && `Out of contact since ${row.lost_year}.`, row.note].filter(Boolean).join(' ')
    : 'Paper Valley - a trail of lanterns for people searching for someone who is still out there.';
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
// A page fetched ahead of a portal is only worth fetching if the browser is allowed to
// keep it: with no lifetime at all it has to come back and ask again on the way in, which
// is the round trip the whole thing was meant to avoid. A minute is long enough to cover
// the walk from one place to another and short enough that a deploy is visible almost at
// once. Only the HTML - the scripts keep asking every time, so a fix to them is never
// sitting stale in somebody's browser.
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=60');
  },
}));

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
