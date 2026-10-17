/* Where the moon is, worked out in the browser from the date - no service to call.
 *
 * Sun and moon positions follow Paul Schlyter's "How to compute planetary positions"
 * (orbital elements plus the main lunar perturbations), good to a couple of minutes of
 * arc. That is far finer than a page needs: rise and set times land within a few
 * minutes of the US Naval Observatory's, phases within a few minutes of theirs.
 *
 * Everything takes and returns real Date objects; display is left to the page, in the
 * visitor's own time zone.
 */
(function (root) {
  var RAD = Math.PI / 180, DEG = 180 / Math.PI, DAY = 86400000;
  function rev(x) { return x - Math.floor(x / 360) * 360; }
  function sind(x) { return Math.sin(x * RAD); }
  function cosd(x) { return Math.cos(x * RAD); }
  function atan2d(y, x) { return Math.atan2(y, x) * DEG; }
  function asind(x) { return Math.asin(x) * DEG; }

  // Schlyter's day number: days since 2000 Jan 0.0 UT
  function dayNumber(date) { return date.getTime() / DAY + 2440587.5 - 2451543.5; }
  function obliquity(d) { return 23.4393 - 3.563e-7 * d; }

  function sun(d) {
    var w = 282.9404 + 4.70935e-5 * d, e = 0.016709 - 1.151e-9 * d, M = rev(356.0470 + 0.9856002585 * d);
    var E = M + DEG * e * sind(M) * (1 + e * cosd(M));
    var xv = cosd(E) - e, yv = Math.sqrt(1 - e * e) * sind(E);
    var v = atan2d(yv, xv), r = Math.sqrt(xv * xv + yv * yv);
    var lon = rev(v + w);
    return { lon: lon, r: r, M: M, L: rev(M + w) };
  }

  function moon(d) {
    var N = rev(125.1228 - 0.0529538083 * d), i = 5.1454, w = rev(318.0634 + 0.1643573223 * d);
    var a = 60.2666, e = 0.054900, M = rev(115.3654 + 13.0649929509 * d);
    var E = M + DEG * e * sind(M) * (1 + e * cosd(M));
    for (var k = 0; k < 6; k++) { E = E - (E - DEG * e * sind(E) - M) / (1 - e * cosd(E)); }
    var xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
    var v = atan2d(yv, xv), r = Math.sqrt(xv * xv + yv * yv);
    var xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    var yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    var zh = r * (sind(v + w) * sind(i));
    var lon = atan2d(yh, xh), lat = atan2d(zh, Math.sqrt(xh * xh + yh * yh));
    // the largest perturbations, from the sun's pull
    var S = sun(d), Ms = S.M, Ls = S.L, Lm = rev(N + w + M), D = rev(Lm - Ls), F = rev(Lm - N);
    lon += -1.274 * sind(M - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms)
         - 0.059 * sind(2 * M - 2 * D) - 0.057 * sind(M - 2 * D + Ms) + 0.053 * sind(M + 2 * D)
         + 0.046 * sind(2 * D - Ms) + 0.041 * sind(M - Ms) - 0.035 * sind(D)
         - 0.031 * sind(M + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(M - 4 * D);
    lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(M - F - 2 * D) - 0.046 * sind(M + F - 2 * D)
         + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * M + F);
    r += -0.58 * cosd(M - 2 * D) - 0.46 * cosd(2 * D);
    return { lon: rev(lon), lat: lat, r: r, sunLon: S.lon, sunL: Ls };
  }

  // equatorial position seen from a place on the ground (topocentric), and its altitude
  function altitude(date, latDeg, lonDeg) {
    var d = dayNumber(date), m = moon(d), ecl = obliquity(d);
    var xg = m.r * cosd(m.lon) * cosd(m.lat), yg = m.r * sind(m.lon) * cosd(m.lat), zg = m.r * sind(m.lat);
    var xe = xg, ye = yg * cosd(ecl) - zg * sind(ecl), ze = yg * sind(ecl) + zg * cosd(ecl);
    var RA = rev(atan2d(ye, xe)), Dec = atan2d(ze, Math.sqrt(xe * xe + ye * ye));
    var ut = (date.getTime() / DAY % 1 + 1) % 1 * 24;
    var GMST0 = rev(m.sunL + 180) / 15;
    var LST = rev((GMST0 + ut) * 15 + lonDeg);
    var HA = rev(LST - RA);
    var mpar = asind(1 / m.r);
    var gclat = latDeg - 0.1924 * sind(2 * latDeg), rho = 0.99833 + 0.00167 * cosd(2 * latDeg);
    var g = atan2d(Math.tan(gclat * RAD), cosd(HA));
    var topRA = RA - mpar * rho * cosd(gclat) * sind(HA) / cosd(Dec);
    var topDec = Dec - mpar * rho * sind(gclat) * sind(g - Dec) / sind(g);
    var topHA = rev(LST - topRA);
    var alt = asind(sind(latDeg) * sind(topDec) + cosd(latDeg) * cosd(topDec) * cosd(topHA));
    return { alt: alt, ha: topHA, par: mpar };
  }

  // rise, set, overhead and underfoot between two moments, found by scanning then halving
  function events(from, to, latDeg, lonDeg) {
    var out = [], step = 10 * 60000, t = from.getTime();
    var h0 = -0.583 - 0.2725 * 0.95;                 // refraction and the moon's half-width
    function f(ms) { var a = altitude(new Date(ms), latDeg, lonDeg); return a; }
    var prev = f(t);
    while (t < to.getTime()) {
      var t2 = t + step, cur = f(t2);
      if ((prev.alt - h0) * (cur.alt - h0) < 0) {
        var lo = t, hi = t2, up = cur.alt > prev.alt;
        for (var k = 0; k < 20; k++) { var mid = (lo + hi) / 2, am = f(mid).alt; if ((am - h0 > 0) === up) hi = mid; else lo = mid; }
        out.push({ type: up ? 'rise' : 'set', time: new Date((lo + hi) / 2) });
      }
      // overhead (hour angle passes 0) and underfoot (passes 180)
      var p0 = prev.ha, p1 = cur.ha;
      [[0, 'overhead'], [180, 'underfoot']].forEach(function (z) {
        var a0 = rev(p0 - z[0] + 180) - 180, a1 = rev(p1 - z[0] + 180) - 180;
        if (a0 < 0 && a1 >= 0 && a1 - a0 < 90) {
          var lo = t, hi = t2;
          for (var k = 0; k < 20; k++) { var mid = (lo + hi) / 2, am = rev(f(mid).ha - z[0] + 180) - 180; if (am >= 0) hi = mid; else lo = mid; }
          out.push({ type: z[1], time: new Date((lo + hi) / 2) });
        }
      });
      prev = cur; t = t2;
    }
    return out.sort(function (a, b) { return a.time - b.time; });
  }

  // elongation of the moon from the sun along the ecliptic, 0 new .. 180 full
  function phaseAngle(date) { var m = moon(dayNumber(date)); return rev(m.lon - m.sunLon); }

  // the moments the moon reaches new (0), first quarter (90), full (180), last quarter (270)
  function phases(from, to) {
    var out = [], step = 6 * 3600000, t = from.getTime(), prev = phaseAngle(from);
    var names = { 0: 'New Moon', 90: 'First Quarter', 180: 'Full Moon', 270: 'Last Quarter' };
    while (t < to.getTime()) {
      var t2 = t + step, cur = phaseAngle(new Date(t2));
      [0, 90, 180, 270].forEach(function (z) {
        var a0 = rev(prev - z + 180) - 180, a1 = rev(cur - z + 180) - 180;
        if (a0 < 0 && a1 >= 0) {
          var lo = t, hi = t2;
          for (var k = 0; k < 24; k++) { var mid = (lo + hi) / 2, am = rev(phaseAngle(new Date(mid)) - z + 180) - 180; if (am >= 0) hi = mid; else lo = mid; }
          var when = new Date((lo + hi) / 2);
          out.push({ phase: names[z], angle: z, time: when, km: moon(dayNumber(when)).r * 6378.14 });
        }
      });
      prev = cur; t = t2;
    }
    return out;
  }

  // the sun's ecliptic longitude reaching 0/90/180/270: the equinoxes and solstices
  function seasons(year) {
    var out = [], t = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1), step = DAY;
    function sl(ms) { return sun(dayNumber(new Date(ms))).lon; }
    var prev = sl(t);
    while (t < end) {
      var t2 = t + step, cur = sl(t2);
      [0, 90, 180, 270].forEach(function (z) {
        var a0 = rev(prev - z + 180) - 180, a1 = rev(cur - z + 180) - 180;
        if (a0 < 0 && a1 >= 0) {
          var lo = t, hi = t2;
          for (var k = 0; k < 24; k++) { var mid = (lo + hi) / 2, am = rev(sl(mid) - z + 180) - 180; if (am >= 0) hi = mid; else lo = mid; }
          out.push({ angle: z, time: new Date((lo + hi) / 2) });
        }
      });
      prev = cur; t = t2;
    }
    return out;
  }

  function info(date) {
    var d = dayNumber(date), m = moon(d), el = rev(m.lon - m.sunLon);
    var cosE = cosd(m.lon - m.sunLon) * cosd(m.lat);
    var illum = (1 - cosE) / 2;
    return {
      elongation: el,                          // 0..360, waxing below 180
      illumination: illum,                     // 0..1
      waxing: el < 180,
      km: m.r * 6378.14,
      miles: m.r * 6378.14 * 0.621371,
      eclipticLon: m.lon,
      sign: ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'][Math.floor(m.lon / 30)]
    };
  }

  root.MoonCalc = { info: info, events: events, phases: phases, seasons: seasons, altitude: altitude, phaseAngle: phaseAngle };
  if (typeof module !== 'undefined') module.exports = root.MoonCalc;
})(typeof window !== 'undefined' ? window : globalThis);
