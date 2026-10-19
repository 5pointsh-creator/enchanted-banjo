/* The Moon Book: a letter before every full moon, by email to whoever signed up, and the
 * same letter kept as a page on the site.
 *
 * Every letter is worked out from the same tables the moon page uses (moon-data.js for the
 * Naval Observatory phases, NASA eclipses and the showers; moon-calc.js for the rest), so a
 * letter can never disagree with the page it links to. Nothing is written by hand: the
 * letter for each full moon is the same every time it is built, which is why only the
 * sending is recorded, never the words.
 *
 * Email goes out through Resend, and only when RESEND_API_KEY is set in Railway. Without
 * it the pages still work and nobody is asked to sign up for something that cannot reach
 * them. The monthly letter also needs a postal address (MOON_BOOK_ADDRESS): US law wants
 * one at the foot of every mailing, so without it only the sign-up confirmations go out.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const MoonCalc = require('./moon-calc.js');

const DAY = 86400000;
const SITE = 'https://www.banjospirits.com';
const TZ = 'America/New_York';                     // the letters speak Eastern time
const HOME = { lat: 39.96, lon: -83.0, label: 'Columbus, Ohio' };
const FIRST_LETTER = Date.UTC(2026, 9, 20);        // nothing before the Hunter's Moon of 2026
const SEND_BEFORE = 3 * DAY;                       // the letter goes out three days ahead
const YOUTUBE = 'https://www.youtube.com/@5days-banjospirits';
// Lights on the moon are open to everyone, so the letters point at them.
const LIGHTS_PUBLIC = true;
const FROM = process.env.MOON_BOOK_FROM || 'The Moon Book - Banjo Spirits <moon@banjospirits.com>';
const RESEND_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';

// ---------- the tables ----------
const MD = (() => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'moon-data.js'), 'utf8'), ctx);
  return ctx.window.MoonData;
})();
const PH = MD.phases.map(([k, t]) => ({ kind: k, time: new Date(t) }));
const FULLS = PH.filter((p) => p.kind === 'F').map((p) => p.time);
const NEWS = PH.filter((p) => p.kind === 'N').map((p) => p.time);
const SEASONS = MD.seasons.map((s) => new Date(s));

const NAMES = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Corn', 'Hunter’s', 'Beaver', 'Cold'];
const WHY = {
  'Wolf': 'Named for the wolves heard howling through the long midwinter nights.',
  'Snow': 'Named for the heaviest snows of the year, which so often fell in February.',
  'Worm': 'Named for the earthworms that show again as the ground thaws.',
  'Pink': 'Named for the wild pink phlox, one of the first flowers of spring.',
  'Flower': 'Named for the flowers that come out everywhere in May.',
  'Strawberry': 'Named for the wild strawberries ripe for picking in June.',
  'Buck': 'Named for the new antlers growing on the young bucks.',
  'Sturgeon': 'Named for the great fish caught in the lakes at the height of summer.',
  'Corn': 'Named for the corn coming in.',
  'Harvest': 'The full moon nearest the turn of autumn. It rose bright at dusk, night after night, so farmers could keep bringing the crops in after dark.',
  'Hunter’s': 'The full moon after the harvest. The fields were bare, and by its light hunters could see the deer and foxes crossing them.',
  'Beaver': 'Named for the time to set beaver traps, before the swamps froze over.',
  'Cold': 'Named for the long, cold nights at the turn of the year. It rides highest in the sky of any full moon.',
};
// For fun, and said so in the letter. Same colours and meanings as the lights on the moon.
const COLOURS = [['gold', 'luck'], ['red', 'love'], ['pink', 'friendship'], ['green', 'a good harvest, and money'],
  ['blue', 'healing'], ['silver', 'safe travels, and protection'], ['purple', 'peace'], ['orange', 'courage, and strength']];
const FRUITFUL = { Cancer: 2, Scorpio: 2, Pisces: 2, Taurus: 1, Capricorn: 1, Libra: 1 };

// ---------- Eastern time ----------
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
function parts(d) {
  const o = {}; partsFmt.formatToParts(d).forEach((p) => { o[p.type] = +p.value; });
  return { y: o.year, m: o.month - 1, d: o.day, h: o.hour };
}
const fmt = (d, opts) => d.toLocaleString('en-US', { timeZone: TZ, ...opts });
const dayName = (d) => fmt(d, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (d) => `${fmt(d, { weekday: 'short' })} ${fmt(d, { month: 'short' })} ${fmt(d, { day: 'numeric' })}`;
// a, b and c - the way a person lists things
const andList = (xs) => xs.length < 2 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
const clock = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' });
// a moment in the small hours belongs to the night before, the way people talk
function nightOf(d) { const p = parts(d); return p.h < 12 ? new Date(d.getTime() - DAY) : d; }
// noon Eastern on a calendar day, as a real moment
function easternNoon(y, m, d) {
  const guess = new Date(Date.UTC(y, m, d, 16));
  return new Date(guess.getTime() + (12 - parts(guess).h) * 3600000);
}

// ---------- which full moon is which ----------
function fullInfo(t) {
  const p = parts(t), y = p.y;
  const eq = SEASONS.find((s) => s.getUTCFullYear() === y && s.getUTCMonth() === 8) || new Date(Date.UTC(y, 8, 22, 12));
  let harvest = null;
  FULLS.forEach((x) => { if (!harvest || Math.abs(x - eq) < Math.abs(harvest - eq)) harvest = x; });
  const hi = FULLS.findIndex((x) => x.getTime() === harvest.getTime());
  const me = FULLS.findIndex((x) => x.getTime() === t.getTime());
  const name = me === hi ? 'Harvest' : me === hi + 1 ? 'Hunter’s' : NAMES[p.m];
  const km = MoonCalc.info(t).km;
  const sameMonth = FULLS.filter((x) => { const q = parts(x); return q.y === y && q.m === p.m; });
  const monthlyBlue = sameMonth.length > 1 && sameMonth[1].getTime() === t.getTime();
  let seasonalBlue = false;
  for (let i = 0; i + 1 < SEASONS.length; i++) {
    if (t >= SEASONS[i] && t < SEASONS[i + 1]) {
      const inS = FULLS.filter((x) => x >= SEASONS[i] && x < SEASONS[i + 1]);
      seasonalBlue = inS.length === 4 && inS[2].getTime() === t.getTime();
    }
  }
  return { name, km, superMoon: km < 360000, monthlyBlue, seasonalBlue };
}

const slugOf = (t) => { const p = parts(t); const n = fullInfo(t).name.replace('’', '').toLowerCase();
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${n}-moon`; };

// the letters that exist: one per full moon from the first, once its sending day has come
function lettersUpTo(now) {
  return FULLS.filter((f) => f.getTime() > FIRST_LETTER && f.getTime() - SEND_BEFORE <= now.getTime());
}
const letterBySlug = (slug) => FULLS.find((f) => f.getTime() > FIRST_LETTER && slugOf(f) === slug) || null;

// ---------- writing one ----------
function buildLetter(full) {
  const fi = fullInfo(full);
  const idx = FULLS.findIndex((x) => x.getTime() === full.getTime());
  const nextFull = FULLS[idx + 1] || new Date(full.getTime() + 29.53 * DAY);
  const from = new Date(full.getTime() - SEND_BEFORE), to = new Date(nextFull.getTime() - SEND_BEFORE);
  const night = nightOf(full);
  const title = `The ${fi.name} Moon`;
  const year = parts(full).y;

  // moonrise on the night itself, in Columbus
  const eve = easternNoon(parts(night).y, parts(night).m, parts(night).d);
  const rise = MoonCalc.events(eve, new Date(eve.getTime() + DAY), HOME.lat, HOME.lon).find((e) => e.type === 'rise');

  const badges = [];
  if (fi.superMoon) badges.push('a supermoon - closer and brighter than most');
  if (fi.monthlyBlue) badges.push('a blue moon - the second full moon in one month');
  if (fi.seasonalBlue) badges.push('a blue moon by the old almanac reckoning - the third full moon in a season of four');

  const newMoon = NEWS.find((n) => n > full && n < nextFull);
  const lines = [];
  if (newMoon) lines.push(['\u{1F311}', `New moon, ${dayName(nightOf(newMoon))}`, 'The darkest nights of the month - best for the stars.', newMoon]);
  MD.eclipses.forEach(([iso, kind, type, where]) => {
    const t = new Date(iso); if (t < from || t >= to) return;
    lines.push(['◐', `${type} eclipse of the ${kind === 'solar' ? 'sun' : 'moon'}, ${dayName(t)}`, `Seen from ${where}.`, t]);
  });
  for (const yy of [year, year + 1]) MD.showers.forEach(([name, m, d, note]) => {
    const t = easternNoon(yy, m - 1, d); const late = new Date(t.getTime() + 11 * 3600000);
    if (late < from || late >= to) return;
    const lit = Math.round(MoonCalc.info(late).illumination * 100);
    lines.push(['☄', `The ${name}, the night of ${dayName(t)}`,
      `${note[0].toUpperCase()}${note.slice(1)}. The moon is ${lit}% lit that night${lit < 30 ? ', so the sky will be dark.' : lit > 70 ? ', so only the bright ones will show.' : '.'}`, late]);
  });
  const nfi = fullInfo(nextFull);
  lines.push(['\u{1F315}', `Next full moon: the ${nfi.name} Moon, the night of ${dayName(nightOf(nextFull))}`,
    [nfi.superMoon && 'A supermoon.', (nfi.monthlyBlue || nfi.seasonalBlue) && 'A blue moon.', 'The next letter comes a few days before it.'].filter(Boolean).join(' '), new Date(nextFull.getTime() + DAY * 99)]);
  SEASONS.forEach((t) => {
    if (t < from || t >= to) return;
    const m = t.getUTCMonth();
    const name = m === 2 ? 'The spring equinox' : m === 5 ? 'The summer solstice' : m === 8 ? 'The autumn equinox' : 'The winter solstice';
    lines.push(['☀', `${name}, ${dayName(t)}`, m === 11 ? 'The longest night of the year.' : m === 5 ? 'The shortest night of the year.' : 'Day and night about even.', t]);
  });

  lines.sort((a, b) => a[3] - b[3]);

  // hunting and fishing: the old solunar rule, best within a day of the full and the new
  const best = [full, newMoon].filter(Boolean).map((t) => {
    const n = nightOf(t);
    return `${shortDay(new Date(n.getTime() - DAY))} to ${shortDay(new Date(n.getTime() + DAY))}`;
  });

  // planting: above-ground crops on a filling moon, roots on a waning one; best in the fruitful signs
  const fruitful = { waning: [], waxing: [] };
  for (let t = full.getTime(); t < nextFull.getTime(); t += DAY) {
    const p = parts(new Date(t)), noon = easternNoon(p.y, p.m, p.d), inf = MoonCalc.info(noon);
    if ((FRUITFUL[inf.sign] || 0) === 2) (inf.waxing ? fruitful.waxing : fruitful.waning).push(noon);
  }
  const runs = (days) => {
    const out = []; let start = null, prev = null;
    days.forEach((d) => {
      if (prev && d - prev < 1.5 * DAY) { prev = d; return; }
      if (start) out.push([start, prev]); start = d; prev = d;
    });
    if (start) out.push([start, prev]);
    return out.map(([a, b]) => (a.getTime() === b.getTime() ? shortDay(a) : `${shortDay(a)} to ${shortDay(b)}`));
  };

  // lucky number: the old way, add up the digits of the full moon's date until one is left
  const fp = parts(night);
  let n = String(fp.y) + String(fp.m + 1) + String(fp.d);
  while (n.length > 1) n = String([...n].reduce((s, c) => s + +c, 0));
  const lucky = +n, colour = COLOURS[(lucky - 1) % COLOURS.length];

  const sections = {
    title, year, fi, night, rise, badges, lines, best, newMoon,
    roots: runs(fruitful.waning), tops: runs(fruitful.waxing), lucky, colour,
    slug: slugOf(full), full, nextFull,
  };
  return sections;
}

// ---------- the same letter as a web page and as an email ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function letterBody(L, forEmail) {
  const P = (t) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#e9e4d6">${t}</p>`;
  const H = (t) => `<h2 style="margin:26px 0 10px;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#c9b277;font-weight:600">${t}</h2>`;
  const fullAt = `${clock(L.full)} Eastern${parts(L.full).d !== parts(L.night).d ? ' (' + shortDay(L.full) + ')' : ''}`;
  let h = '';
  h += P(`The full moon comes on the night of <b>${esc(dayName(L.night))}</b>. It is exactly full at ${esc(fullAt)}${L.rise ? `, and in ${HOME.label} it rises at ${esc(clock(L.rise.time))}` : ''}.`);
  if (L.badges.length) h += P(`This one is ${esc(L.badges.join(', and '))}.`);
  h += H('What the old folks said') + P(`<i>${esc(WHY[L.fi.name])}</i>`);
  if (L.lines.length) {
    h += H('Coming up this month');
    h += L.lines.map(([ic, b, s]) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#e9e4d6">${ic} <b>${esc(b)}</b><br><span style="color:#aab3d3">${esc(s)}</span></p>`).join('');
  }
  h += H('Hunting and fishing');
  h += P(`By the old solunar rule, the best days are around the full and new moon: <b>${L.best.map(esc).join('</b> and <b>')}</b>.`);
  h += H('Planting by the moon');
  h += P(`From the full moon to the new moon${L.newMoon ? ` (${esc(shortDay(nightOf(L.newMoon)))})` : ''}, the moon is getting smaller - the time for root crops: potatoes, carrots, onions, and for pulling weeds. After the new moon it fills again - the time for anything that grows above the ground.`);
  if (L.roots.length || L.tops.length) {
    h += P(`The most fruitful days, when the moon rides in a water sign: ${[
      L.roots.length ? `for roots, <b>${esc(andList(L.roots))}</b>` : '',
      L.tops.length ? `for what grows above ground, <b>${esc(andList(L.tops))}</b>` : '',
    ].filter(Boolean).join('; ')}.`);
  }
  h += H('Just for fun');
  h += P(`Lucky number this moon: <b>${L.lucky}</b> (the old way - add up the digits of the date until one is left). Lucky colour: <b>${esc(L.colour[0])}</b>, for ${esc(L.colour[1])}.`);
  const btn = (href, label) => `<a href="${href}" style="display:inline-block;margin:6px 6px 0 0;padding:12px 18px;border-radius:10px;background:#d8b45e;color:#1a1205;font-weight:700;text-decoration:none;font-size:15px">${label}</a>`;
  h += `<div style="margin:26px 0 6px">${LIGHTS_PUBLIC ? btn(SITE + '/moon.html#lights', '✨ Leave a light on the moon') : ''}${btn(SITE + '/moon.html', 'See tonight’s moon')}</div>`;
  if (!forEmail) h += P(`<a href="${YOUTUBE}" style="color:#e8c86a">Follow Banjo Spirits on YouTube</a>`);
  return h;
}

function letterText(L, unsubUrl, address) {
  const out = [];
  out.push(`THE MOON BOOK - ${L.title.toUpperCase()}, ${L.year}`, '');
  out.push(`The full moon comes on the night of ${dayName(L.night)}. It is exactly full at ${clock(L.full)} Eastern${parts(L.full).d !== parts(L.night).d ? ' (' + shortDay(L.full) + ')' : ''}${L.rise ? `, and in ${HOME.label} it rises at ${clock(L.rise.time)}` : ''}.`);
  if (L.badges.length) out.push(`This one is ${L.badges.join(', and ')}.`);
  out.push('', 'WHAT THE OLD FOLKS SAID', WHY[L.fi.name]);
  if (L.lines.length) { out.push('', 'COMING UP THIS MONTH'); L.lines.forEach(([, b, s]) => out.push(`- ${b}. ${s}`)); }
  out.push('', 'HUNTING AND FISHING', `Best days: ${L.best.join(' and ')}.`);
  out.push('', 'PLANTING BY THE MOON', 'Root crops from the full moon to the new moon; above-ground crops after the new moon.');
  if (L.roots.length) out.push(`Most fruitful for roots: ${andList(L.roots)}.`);
  if (L.tops.length) out.push(`Most fruitful above ground: ${andList(L.tops)}.`);
  out.push('', `JUST FOR FUN - lucky number ${L.lucky}, lucky colour ${L.colour[0]} (for ${L.colour[1]}).`);
  out.push('', LIGHTS_PUBLIC ? `Leave a light on the moon: ${SITE}/moon.html#lights` : `See tonight's moon: ${SITE}/moon.html`, `Read it on the site: ${SITE}/moon-book/${L.slug}`);
  out.push('', '--', 'You get this because you signed up for the Moon Book at banjospirits.com.', `Unsubscribe: ${unsubUrl}`);
  if (address) out.push(`Banjo Spirits, ${address}`);
  return out.join('\n');
}

function emailShell(inner, footer) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#05070f">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#05070f"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#0d1122;border:1px solid #232a44;border-radius:14px">
<tr><td style="padding:26px 24px 8px;font-family:Georgia,'Times New Roman',serif">${inner}</td></tr>
<tr><td style="padding:14px 24px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#7f88a8;border-top:1px solid #232a44">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}
const heading = (L) => `<p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c9b277">The Moon Book &middot; Banjo Spirits</p>
<h1 style="margin:0 0 18px;font-size:30px;font-weight:normal;color:#f7f1e1">${esc(L.title)}, ${L.year}</h1>`;

function letterEmail(L, unsubUrl, address) {
  const footer = `You get this because you signed up for the Moon Book at <a href="${SITE}" style="color:#b9a8e6">banjospirits.com</a>.
<a href="${esc(unsubUrl)}" style="color:#b9a8e6">Unsubscribe</a> - one click, and no more letters.
&nbsp;&middot;&nbsp; <a href="${YOUTUBE}" style="color:#b9a8e6">Banjo Spirits on YouTube</a>
<br>Banjo Spirits, ${esc(address)}`;
  return {
    subject: `${L.title}: the night of ${dayName(L.night)}`,
    html: emailShell(heading(L) + letterBody(L, true), footer),
    text: letterText(L, unsubUrl, address),
  };
}

// ---------- pages ----------
const PAGE_CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{background:#05070f;color:#e9e4d6;font-family:"Segoe UI",system-ui,sans-serif;padding:28px 18px 60px;min-height:100vh;
     background-image:radial-gradient(120% 420px at 50% 0%, #10162b 0%, #05070f 100%);background-repeat:no-repeat}
main{max-width:640px;margin:0 auto}
a{color:#e8c86a}
.top{font-size:11.5px;letter-spacing:4px;text-transform:uppercase;color:#c9b277;text-decoration:none}
.card{margin-top:16px;background:#0d1122;border:1px solid #232a44;border-radius:14px;padding:22px 20px;font-family:Georgia,"Times New Roman",serif}
.list a{display:block;padding:12px 0;border-bottom:1px solid #1d2338;text-decoration:none;color:#efe7d2;font-size:17px}
.list a span{display:block;font-size:13px;color:#8f99bb;font-family:"Segoe UI",system-ui,sans-serif}
.foot{margin-top:24px;font-size:13px;color:#7f88a8;line-height:1.6}`;

function page({ title, desc, canonical, body, noindex }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
<meta property="og:site_name" content="Banjo Spirits">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/moon-face.jpg">
<style>${PAGE_CSS}</style></head><body><main>
<a class="top" href="/moon.html">Banjo Spirits &middot; the moon</a>
${body}
</main></body></html>`;
}

const SIGNUP_FORM = `<form class="mb-form" onsubmit="return false" style="margin-top:20px;font-family:'Segoe UI',system-ui,sans-serif">
<p style="font-size:15px;color:#d9d2bf;margin-bottom:10px">Get the next one by email - once a month, a few days before the full moon.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap"><input type="email" required placeholder="Your email" style="flex:1;min-width:200px;padding:12px;border-radius:10px;border:1px solid #33405f;background:#05070f;color:#fff;font-size:16px">
<button style="padding:12px 18px;border-radius:10px;border:0;background:#d8b45e;color:#1a1205;font-weight:700;font-size:15px;cursor:pointer">Sign up</button></div>
<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">
<p class="mb-msg" style="margin-top:10px;font-size:14px;color:#ffe2a6"></p></form>
<script src="/moon-book-signup.js" defer></script>`;

// ---------- the module ----------
module.exports = function mountMoonBook(app, { pool, isReady, requireAuth, hashIp }) {
  const KEY = () => process.env.RESEND_API_KEY || '';
  const ADDRESS = () => process.env.MOON_BOOK_ADDRESS || '';

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS moon_book_subscribers (
        id              SERIAL PRIMARY KEY,
        email           TEXT NOT NULL UNIQUE,
        token           TEXT NOT NULL UNIQUE,
        confirmed_at    TIMESTAMPTZ,
        unsubscribed_at TIMESTAMPTZ,
        ip_hash         TEXT,
        last_mailed_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS moon_book_sends (
        slug          TEXT NOT NULL,
        subscriber_id INTEGER NOT NULL REFERENCES moon_book_subscribers(id) ON DELETE CASCADE,
        sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        ok            BOOLEAN NOT NULL,
        detail        TEXT,
        PRIMARY KEY (slug, subscriber_id)
      );
    `);
  }

  async function sendMail({ to, subject, html, text, unsubUrl }) {
    const headers = unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text, headers }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
    return body;
  }
  const unsubLink = (token) => `${SITE}/moon-book/unsubscribe?t=${token}`;

  async function sendConfirm(sub) {
    const url = `${SITE}/moon-book/confirm?t=${sub.token}`;
    const inner = `<p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c9b277">The Moon Book &middot; Banjo Spirits</p>
<h1 style="margin:0 0 16px;font-size:26px;font-weight:normal;color:#f7f1e1">One tap and you are in</h1>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#e9e4d6">Someone - hopefully you - asked for the Moon Book to be sent to this address: a letter a few days before every full moon, with its old name, what is coming in the sky, the best hunting, fishing and planting days, and a little luck.</p>
<a href="${url}" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#d8b45e;color:#1a1205;font-weight:700;text-decoration:none;font-size:16px;font-family:Arial,Helvetica,sans-serif">Yes, send me the Moon Book</a>
<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#aab3d3">If it was not you, do nothing. Without that tap, nothing is ever sent.</p>`;
    await sendMail({
      to: sub.email, subject: 'Confirm: the Moon Book from Banjo Spirits',
      html: emailShell(inner, `Banjo Spirits &middot; <a href="${SITE}" style="color:#b9a8e6">banjospirits.com</a>`),
      text: `Someone asked for the Moon Book to be sent to this address.\n\nTo confirm, open: ${url}\n\nIf it was not you, do nothing - nothing is sent without that.\n\nBanjo Spirits - ${SITE}`,
    });
  }

  // ---- signing up ----
  const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  app.get('/api/moon-book/status', (req, res) => res.json({ open: !!KEY() }));

  app.post('/api/moon-book/subscribe', async (req, res) => {
    if (!isReady()) return res.status(503).json({ error: 'Try again in a minute.' });
    if (!KEY()) return res.status(503).json({ error: 'The Moon Book is not open for sign-ups yet.' });
    const b = req.body || {};
    if (b.website) return res.json({ ok: true, message: 'Check your email.' });      // a robot filled the hidden box
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email does not look right. Check it and try again.' });
    const ip = hashIp(req.ip || '');
    try {
      const { rows: recent } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM moon_book_subscribers WHERE ip_hash=$1 AND created_at > now() - interval '1 hour'`, [ip]);
      if (recent[0].n >= 5) return res.status(429).json({ error: 'A lot of sign-ups from here just now. Try again in an hour.' });
      const { rows } = await pool.query('SELECT * FROM moon_book_subscribers WHERE email=$1', [email]);
      let sub = rows[0];
      if (sub && sub.confirmed_at && !sub.unsubscribed_at) return res.json({ ok: true, message: 'You are already on the list. The next letter comes a few days before the full moon.' });
      if (sub && sub.last_mailed_at && Date.now() - new Date(sub.last_mailed_at) < 10 * 60000) {
        return res.json({ ok: true, message: 'We just sent you a confirmation. Check your email (and the spam folder).' });
      }
      const token = crypto.randomBytes(18).toString('hex');
      if (sub) {
        ({ rows: [sub] } = await pool.query(
          `UPDATE moon_book_subscribers SET token=$2, confirmed_at=NULL, unsubscribed_at=NULL, last_mailed_at=now() WHERE id=$1 RETURNING *`, [sub.id, token]));
      } else {
        ({ rows: [sub] } = await pool.query(
          `INSERT INTO moon_book_subscribers (email, token, ip_hash, last_mailed_at) VALUES ($1,$2,$3,now()) RETURNING *`, [email, token, ip]));
      }
      await sendConfirm(sub);
      res.json({ ok: true, message: 'Almost there - we sent you an email. Tap the button in it to confirm (check the spam folder if it does not show up).' });
    } catch (e) {
      console.error('moon book subscribe:', e.message);
      res.status(500).json({ error: 'That did not go through. Try again in a minute.' });
    }
  });

  app.get('/moon-book/confirm', async (req, res) => {
    const t = String(req.query.t || '');
    let ok = false;
    if (isReady() && /^[a-f0-9]{36}$/.test(t)) {
      const r = await pool.query(
        `UPDATE moon_book_subscribers SET confirmed_at=COALESCE(confirmed_at, now()), unsubscribed_at=NULL WHERE token=$1 RETURNING id`, [t]);
      ok = !!r.rowCount;
    }
    const next = FULLS.find((f) => f > new Date());
    res.set('Content-Type', 'text/html; charset=utf-8').send(page({
      title: ok ? 'You are in - the Moon Book' : 'The Moon Book', noindex: true, desc: 'The Moon Book from Banjo Spirits.',
      body: `<div class="card"><h1 style="font-weight:normal;font-size:28px;color:#f7f1e1">${ok ? 'You are in.' : 'That link did not work.'}</h1>
<p style="margin-top:12px;font-size:17px;line-height:1.6">${ok
    ? `The next letter comes a few days before the ${esc(fullInfo(next).name)} Moon, on the night of ${esc(dayName(nightOf(next)))}.`
    : 'It may be old, or cut short by your email. Sign up again on the moon page and use the newest email we send.'}</p>
<p style="margin-top:16px"><a href="/moon.html">Go to tonight's moon</a> &nbsp;&middot;&nbsp; <a href="/moon-book">Read past letters</a></p></div>`,
    }));
  });

  // a page with a button, so a mail scanner that opens every link cannot unsubscribe anybody
  app.get('/moon-book/unsubscribe', (req, res) => {
    const t = String(req.query.t || '');
    res.set('Content-Type', 'text/html; charset=utf-8').send(page({
      title: 'Unsubscribe - the Moon Book', noindex: true, desc: 'Stop the Moon Book letters.',
      body: `<div class="card"><h1 style="font-weight:normal;font-size:26px;color:#f7f1e1">Stop the Moon Book?</h1>
<form method="POST" action="/moon-book/unsubscribe?t=${esc(t)}" style="margin-top:16px"><button style="padding:13px 20px;border-radius:10px;border:0;background:#d8b45e;color:#1a1205;font-weight:700;font-size:16px;cursor:pointer">Yes, no more letters</button></form></div>`,
    }));
  });
  const doUnsub = async (req, res) => {
    const t = String(req.query.t || '');
    if (isReady() && /^[a-f0-9]{36}$/.test(t)) {
      await pool.query(`UPDATE moon_book_subscribers SET unsubscribed_at=COALESCE(unsubscribed_at, now()) WHERE token=$1`, [t]);
    }
    if ((req.get('content-type') || '').includes('form') && /One-Click/.test(JSON.stringify(req.body || {}))) return res.send('ok');
    res.set('Content-Type', 'text/html; charset=utf-8').send(page({
      title: 'Unsubscribed - the Moon Book', noindex: true, desc: 'Unsubscribed.',
      body: `<div class="card"><h1 style="font-weight:normal;font-size:26px;color:#f7f1e1">Done. No more letters.</h1>
<p style="margin-top:12px;font-size:16px;line-height:1.6">The moon will still be there. <a href="/moon.html">Tonight's moon</a></p></div>`,
    }));
  };
  app.post('/moon-book/unsubscribe', require('express').urlencoded({ extended: false }), doUnsub);

  // ---- the archive ----
  app.get(['/moon-book', '/moon-book/'], (req, res) => {
    const list = lettersUpTo(new Date()).reverse();
    const items = list.map((f) => { const L = buildLetter(f);
      return `<a href="/moon-book/${L.slug}">${esc(L.title)}, ${L.year}<span>The night of ${esc(dayName(L.night))}${L.badges.length ? ' - ' + esc(L.badges[0].split(' - ')[0]) : ''}</span></a>`; }).join('');
    const next = FULLS.find((f) => f.getTime() - SEND_BEFORE > Date.now());
    res.set('Content-Type', 'text/html; charset=utf-8').send(page({
      title: 'The Moon Book - a letter before every full moon | Banjo Spirits',
      desc: 'A letter a few days before every full moon: its old name, what is coming in the sky, the best hunting, fishing and planting days, and a little luck.',
      canonical: `${SITE}/moon-book`,
      body: `<div class="card"><h1 style="font-weight:normal;font-size:32px;color:#f7f1e1">The Moon Book</h1>
<p style="margin-top:10px;font-size:17px;line-height:1.6">A letter a few days before every full moon: its old name, what is coming in the sky, the best days for hunting, fishing and planting, and a little luck.</p>
${KEY() ? SIGNUP_FORM : ''}
<div class="list" style="margin-top:18px">${items || `<p style="font-size:16px;color:#aab3d3">The first letter comes before the ${esc(fullInfo(next).name)} Moon.</p>`}</div></div>`,
    }));
  });

  app.get('/moon-book/:slug', (req, res, next) => {
    const f = letterBySlug(req.params.slug);
    if (!f || f.getTime() - SEND_BEFORE > Date.now()) return next();
    const L = buildLetter(f);
    res.set('Content-Type', 'text/html; charset=utf-8').send(page({
      title: `${L.title}, ${L.year} - the night of ${dayName(L.night)} | The Moon Book`,
      desc: `${L.title} ${L.year}: full on the night of ${dayName(L.night)}. ${WHY[L.fi.name]} Plus what is coming in the sky, hunting, fishing and planting days.`,
      canonical: `${SITE}/moon-book/${L.slug}`,
      body: `<div class="card">${heading(L)}${letterBody(L, false)}${KEY() ? SIGNUP_FORM : ''}</div>
<p class="foot"><a href="/moon-book">All the letters</a></p>`,
    }));
  });

  // ---- the owner's view ----
  app.get('/api/moon-book/subscribers', requireAuth, async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Owner only.' });
    const { rows } = await pool.query(`SELECT email, confirmed_at, unsubscribed_at, created_at FROM moon_book_subscribers ORDER BY created_at`);
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="moon-book-subscribers.csv"');
      return res.send('email,status,signed_up\n' + rows.map((r) =>
        `${r.email},${r.unsubscribed_at ? 'unsubscribed' : r.confirmed_at ? 'confirmed' : 'not confirmed'},${new Date(r.created_at).toISOString().slice(0, 10)}`).join('\n'));
    }
    res.json({
      confirmed: rows.filter((r) => r.confirmed_at && !r.unsubscribed_at).length,
      waiting: rows.filter((r) => !r.confirmed_at && !r.unsubscribed_at).length,
      unsubscribed: rows.filter((r) => r.unsubscribed_at).length,
      open: !!KEY(), address: !!ADDRESS(),
    });
  });

  // ---- sending ----
  // Once an hour: if a letter's sending day has come and its full moon has not passed,
  // anybody confirmed who has not had it yet gets it. The send is written down per person
  // before moving on, so a restart halfway through carries on instead of starting again.
  let running = false;
  async function sendDue(now = new Date()) {
    if (running || !isReady() || !KEY() || !ADDRESS()) return { skipped: true };
    running = true;
    try {
      const f = FULLS.find((x) => x.getTime() > FIRST_LETTER && x.getTime() - SEND_BEFORE <= now.getTime() && x > now);
      if (!f) return { none: true };
      const L = buildLetter(f);
      const { rows: due } = await pool.query(
        `SELECT s.* FROM moon_book_subscribers s
          WHERE s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL AND s.confirmed_at < $2
            AND NOT EXISTS (SELECT 1 FROM moon_book_sends m WHERE m.slug=$1 AND m.subscriber_id=s.id)
          ORDER BY s.id LIMIT 500`, [L.slug, f]);
      let sent = 0;
      for (const s of due) {
        const mail = letterEmail(L, unsubLink(s.token), ADDRESS());
        let ok = true, detail = null;
        try { await sendMail({ to: s.email, ...mail, unsubUrl: unsubLink(s.token) }); sent++; }
        catch (e) { ok = false; detail = e.message.slice(0, 300); console.error('moon book send:', detail); }
        await pool.query(`INSERT INTO moon_book_sends (slug, subscriber_id, ok, detail) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [L.slug, s.id, ok, detail]);
        await new Promise((r) => setTimeout(r, 600));      // Resend takes two a second
      }
      if (due.length) console.log(`Moon Book ${L.slug}: sent ${sent} of ${due.length}.`);
      return { slug: L.slug, due: due.length, sent };
    } finally { running = false; }
  }
  setInterval(() => { sendDue().catch((e) => console.error('moon book:', e.message)); }, 3600000).unref();
  setTimeout(() => { sendDue().catch((e) => console.error('moon book:', e.message)); }, 90000).unref();

  return { migrate, sendDue, buildLetter, letterEmail, lettersUpTo, FULLS };
};
module.exports.buildLetter = buildLetter;
module.exports.letterEmail = letterEmail;
module.exports.lettersUpTo = lettersUpTo;
module.exports.FULLS = FULLS;
module.exports.slugOf = slugOf;
