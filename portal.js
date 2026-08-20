/* Banjo Spirits - the portal.

   The four places used to be four pages: you tapped a button, the screen changed, you
   were somewhere else. A portal makes them one world instead. You go THROUGH something
   to get there, and the colour of what you go through tells you where you are headed
   before you arrive - green for the forest, deep blue for the sky, amber for Paper
   Valley, purple and bulb-gold for the wheel.

   Two halves: the going-in, played here before the browser leaves; and the coming-out,
   played on the far side when the next page loads. The far side knows to play it because
   the going-in leaves a note in sessionStorage - not in the address, which would end up
   copied into somebody's link. */
(function () {
  'use strict';

  var DOORS = {
    'plant.html':        { rim: [ 90, 210, 120], core: [200, 255, 215], name: 'forest' },
    'forest.html':       { rim: [ 90, 210, 120], core: [200, 255, 215], name: 'forest' },
    'sky.html':          { rim: [ 96, 130, 235], core: [205, 220, 255], name: 'sky' },
    'paper-valley.html': { rim: [225, 150,  60], core: [255, 225, 175], name: 'valley' },
    'wheel.html':        { rim: [165, 105, 230], core: [255, 220, 165], name: 'wheel' },
    'night-book':        { rim: [165, 105, 230], core: [255, 220, 165], name: 'wheel' },
    'index.html':        { rim: [150, 120, 210], core: [235, 225, 255], name: 'home' },
    '':                  { rim: [150, 120, 210], core: [235, 225, 255], name: 'home' },
  };

  // The first time somebody goes through, it is the thing they came for and it wants
  // room to breathe. By the fourth or fifth trip it is a door they are trying to get
  // through, and every extra tenth of a second is a toll. So it plays long once and
  // brisk thereafter, which is the only way to have it both ways.
  var FIRST_IN_MS = 2500, IN_MS = 1200, OUT_MS = 700;
  var KEY = 'bs_portal_arrival', SEEN = 'bs_portal_seen';

  var reduced = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The portal used to be pure cost: nothing about the next page began loading until the
  // animation had finished and the browser was told to leave. So every tenth of a second
  // of ceremony was a tenth of a second added to the wait. It should have been the other
  // way round from the start - the journey is exactly the window in which the arrival
  // ought to be getting ready. So the moment a finger goes down on a portal link, before
  // the tap has even been counted as a click, the destination starts loading behind the
  // animation. On browsers that can do it the whole page is built in the background,
  // scripts and all, and the portal opens onto something already there.
  var canSpeculate = typeof HTMLScriptElement !== 'undefined' &&
                     HTMLScriptElement.supports &&
                     HTMLScriptElement.supports('speculationrules');
  var canHint = (function () {
    try {
      var l = document.createElement('link');
      return !!(l.relList && l.relList.supports && l.relList.supports('prefetch'));
    } catch (e) { return false; }
  })();
  var warmed = {};

  function doorFor(href) {
    try {
      var path = new URL(href, location.href).pathname.replace(/^\/+/, '');
      return DOORS[path] || DOORS[path.replace(/\.html$/, '')] || null;
    } catch (e) { return null; }
  }

  function makeCanvas() {
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;' +
                       'pointer-events:none;display:block';
    document.body.appendChild(cv);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { cv: cv, ctx: ctx, w: innerWidth, h: innerHeight };
  }

  var rgb = function (c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; };

  // Sparks are seeded once and then only ever re-read, so the mouth of the portal keeps
  // its shape for the whole journey instead of boiling from frame to frame.
  function seedSparks(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({
        a: Math.random() * Math.PI * 2,
        d: 0.55 + Math.random() * 0.85,   // where it sits, as a fraction of the radius
        s: 0.6 + Math.random() * 0.9,     // how fast it is drawn in
        r: 0.7 + Math.random() * 1.5,
      });
    }
    return out;
  }

  function drawPortal(g, door, t, opening) {
    var ctx = g.ctx, w = g.w, h = g.h;
    var cx = w / 2, cy = h / 2;
    var reach = Math.sqrt(w * w + h * h) * 0.62;

    // Going in, the mouth rushes at you and swallows the screen. Coming out, the same
    // shape runs backwards and lets go of it.
    var e = opening ? t * t * (3 - 2 * t) : 1 - (t * t * (3 - 2 * t));
    var radius = 24 + e * reach;
    var glow = opening ? Math.min(1, t * 1.35) : Math.max(0, 1 - t * 1.1);

    ctx.clearRect(0, 0, w, h);

    // the dark of the doorway, so the page behind is genuinely gone rather than dimmed
    var throat = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    throat.addColorStop(0, 'rgba(4,2,10,' + (0.92 * glow) + ')');
    throat.addColorStop(0.72, 'rgba(6,3,14,' + (0.80 * glow) + ')');
    throat.addColorStop(1, 'rgba(6,3,14,0)');
    ctx.fillStyle = throat;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();

    // the rim - two rings turning against each other, which is what stops it reading as
    // a flat circle
    for (var k = 0; k < 2; k++) {
      var rr = radius * (k ? 0.90 : 1);
      var spin = (k ? -1 : 1) * t * 2.6;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin);
      ctx.lineWidth = Math.max(2, radius * (k ? 0.030 : 0.055));
      var ring = ctx.createLinearGradient(-rr, 0, rr, 0);
      ring.addColorStop(0, rgb(door.rim, 0.15 * glow));
      ring.addColorStop(0.5, rgb(door.core, 0.95 * glow));
      ring.addColorStop(1, rgb(door.rim, 0.15 * glow));
      ctx.strokeStyle = ring;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // the halo it throws onto the room
    var halo = ctx.createRadialGradient(cx, cy, radius * 0.86, cx, cy, radius * 1.5);
    halo.addColorStop(0, rgb(door.rim, 0.34 * glow));
    halo.addColorStop(1, rgb(door.rim, 0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, radius * 1.5, 0, Math.PI * 2); ctx.fill();

    // sparks drawn down the throat
    for (var i = 0; i < g.sparks.length; i++) {
      var p = g.sparks[i];
      var pull = opening ? (1 - t * p.s) : (t * p.s);
      if (pull <= 0.02 || pull > 1.4) continue;
      var d = radius * p.d * pull;
      var x = cx + Math.cos(p.a + t * 1.7) * d;
      var y = cy + Math.sin(p.a + t * 1.7) * d;
      ctx.fillStyle = rgb(door.core, 0.55 * glow * Math.min(1, pull * 1.6));
      ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
    }

    // the last of the going-in: the doorway is bigger than the screen, so wash it out
    if (opening && t > 0.72) {
      var wash = (t - 0.72) / 0.28;
      ctx.fillStyle = rgb(door.core, Math.min(1, wash * 0.9));
      ctx.fillRect(0, 0, w, h);
    }
    if (!opening && t < 0.22) {
      var fade = 1 - t / 0.22;
      ctx.fillStyle = rgb(door.core, fade * 0.9);
      ctx.fillRect(0, 0, w, h);
    }
  }

  function run(door, opening, ms, done) {
    var g = makeCanvas();
    g.sparks = seedSparks(70);
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / ms);
      drawPortal(g, door, t, opening);
      if (t < 1) requestAnimationFrame(frame);
      else {
        if (opening) { done(); }                 // leave the wash on screen while it navigates
        else { g.cv.remove(); }
      }
    }
    requestAnimationFrame(frame);
  }

  function travel(href, door) {
    if (reduced) { location.href = href; return; }
    var first = true;
    try {
      first = !sessionStorage.getItem(SEEN);
      sessionStorage.setItem(SEEN, '1');
      sessionStorage.setItem(KEY, door.name);
    } catch (e) {}
    run(door, true, first ? FIRST_IN_MS : IN_MS, function () { location.href = href; });
  }

  // ---- getting the far side ready ----------------------------------------
  // Chrome and Edge will build the page properly if asked - not just fetch the file but
  // run it, so it is finished and waiting. "conservative" means they only start when a
  // finger actually goes down on one of these links, never on the chance somebody might
  // tap it, so hovering around the page costs nothing and nobody's data is spent on a
  // journey they did not take.
  function speculate(urls) {
    if (!canSpeculate || !urls.length) return;
    var s = document.createElement('script');
    s.type = 'speculationrules';
    s.textContent = JSON.stringify({
      prerender: [{ source: 'list', urls: urls, eagerness: 'conservative' }],
    });
    document.head.appendChild(s);
  }

  // Everywhere else, fetch the page itself so it is sitting in the cache by the time the
  // browser goes looking for it. Less than a prerender, but it turns the arrival from a
  // round trip into a lookup.
  function warm(href) {
    if (canSpeculate || warmed[href]) return;
    warmed[href] = 1;
    if (canHint) {
      var l = document.createElement('link');
      l.rel = 'prefetch';
      l.as = 'document';
      l.href = href;
      document.head.appendChild(l);
      return;
    }
    // Safari understands neither of the above, so ask for the page outright. Only ever
    // instead of the hint, never as well as it - doing both means the same page comes
    // down the wire twice, which on somebody's phone is their data spent for nothing.
    try { fetch(href, { credentials: 'same-origin' }).catch(function () {}); } catch (e) {}
  }

  // ---- wiring -------------------------------------------------------------
  function arrive() {
    var name;
    try { name = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch (e) {}
    if (!name || reduced) return;
    var door = null;
    for (var k in DOORS) if (DOORS[k].name === name) { door = DOORS[k]; break; }
    if (door) run(door, false, OUT_MS, function () {});
  }

  function portalLink(el) {
    var a = el && el.closest && el.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return null;
    try { if (new URL(a.href, location.href).origin !== location.origin) return null; }
    catch (e) { return null; }
    return doorFor(a.getAttribute('href')) ? a : null;
  }

  function wire() {
    // Hand the browser the list of doors on this page once, up front.
    var urls = [], seen = {};
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = portalLink(links[i]);
      if (!a || seen[a.href]) continue;
      seen[a.href] = 1;
      urls.push(new URL(a.href, location.href).pathname);
    }
    speculate(urls);

    // The head start. A tap is a finger going down and then coming up, and the browser
    // waits for the second half before it calls it a click - so starting here buys the
    // destination a tenth of a second before the portal has even opened.
    document.addEventListener('pointerdown', function (ev) {
      var a = portalLink(ev.target);
      if (a) warm(a.href);
    }, { passive: true });

    document.addEventListener('click', function (ev) {
      // let people open things in a new tab, and leave modified clicks alone
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey ||
          ev.shiftKey || ev.altKey) return;
      var a = portalLink(ev.target);
      if (!a) return;
      var door = doorFor(a.getAttribute('href'));
      warm(a.href);            // in case the tap arrived without a pointerdown
      ev.preventDefault();
      travel(a.href, door);
    }, false);
  }

  // A page built in the background is running minutes-in-browser-time before anybody
  // arrives on it - so if it played its coming-out animation at load, it would play it to
  // an empty room and be over before the portal ever opened. Worse, it would take the note
  // left in sessionStorage with it, and the real arrival would find nothing to answer.
  // So while it is still being built ahead of time, it waits, and does its half of the
  // journey at the moment somebody actually lands on it.
  function start() {
    wire();
    if (document.prerendering) {
      document.addEventListener('prerenderingchange', function () { arrive(); }, { once: true });
    } else {
      arrive();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }

  window.BSPortal = { travel: travel, doorFor: doorFor };
})();
