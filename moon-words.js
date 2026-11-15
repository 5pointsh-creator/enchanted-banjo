// The moon page's own reckoning, shared so every page names the same moon the same way.
// Copied from moon.html line for line: the official tables, full-moon names, blue moons,
// supermoons, phase names and the drawing of the lit part. Needs moon-calc.js + moon-data.js.
(function(){
  var DAY = 86400000;
  var MC = window.MoonCalc, MD = window.MoonData;
  var KIND = { F: 'Full Moon', N: 'New Moon', Q1: 'First Quarter', L: 'Last Quarter' };
  var PH = MD.phases.map(function(p){ return { kind: KIND[p[0]], time: new Date(p[1]) }; });
  var SEASONS = MD.seasons.map(function(s){ return new Date(s); });
  // beyond the tables, work the phases out
  var lastT = PH[PH.length - 1].time;
  MC.phases(new Date(lastT.getTime() + 3600000), new Date(lastT.getTime() + 400 * DAY)).forEach(function(p){ PH.push({ kind: p.phase, time: p.time }); });
  var FULLS = PH.filter(function(p){ return p.kind === 'Full Moon'; });
  var NEWS  = PH.filter(function(p){ return p.kind === 'New Moon'; });

  var NAMES = ['Wolf','Snow','Worm','Pink','Flower','Strawberry','Buck','Sturgeon','Corn','Hunter’s','Beaver','Cold'];
  // The official tables cover 2026-2030; any other year (an old birthday, say) is worked
  // out from scratch, a year either side, and kept so it is only done once.
  var TABLE_FROM = FULLS[0].time, TABLE_TO = FULLS[FULLS.length - 1].time, YEARS = {};
  function contextFor(t){
    if (t > TABLE_FROM.getTime() + 60 * DAY && t < TABLE_TO.getTime() - 60 * DAY) return { fulls: FULLS, seasons: SEASONS };
    var y = new Date(t).getFullYear();
    if (!YEARS[y]) {
      var fulls = MC.phases(new Date(y - 1, 9, 1), new Date(y + 1, 3, 1)).filter(function(p){ return p.phase === 'Full Moon'; })
                    .map(function(p){ return { kind: 'Full Moon', time: p.time }; });
      var seasons = [].concat(MC.seasons(y - 1), MC.seasons(y), MC.seasons(y + 1)).map(function(s){ return s.time; });
      YEARS[y] = { fulls: fulls, seasons: seasons };
    }
    return YEARS[y];
  }
  function fullInfo(f){
    var t = f.time, local = new Date(t), y = local.getFullYear(), C = contextFor(t.getTime());
    var fulls = C.fulls, seasons = C.seasons;
    // the same full moon from this context's list (a computed list holds its own objects)
    var me = fulls.filter(function(x){ return Math.abs(x.time - t) < DAY; })[0] || f;
    var eq = null;
    seasons.forEach(function(s){ if (s.getUTCFullYear() === y && s.getUTCMonth() === 8) eq = s; });
    if (!eq) eq = new Date(Date.UTC(y, 8, 22, 12));
    var harvest = null;
    fulls.forEach(function(x){ if (!harvest || Math.abs(x.time - eq) < Math.abs(harvest.time - eq)) harvest = x; });
    var hi = fulls.indexOf(harvest), name;
    if (me === harvest) name = 'Harvest';
    else if (fulls[hi + 1] === me) name = 'Hunter’s';
    else name = NAMES[local.getMonth()];
    var km = MC.info(t).km;
    // blue: second full moon of a calendar month, or third of four in a season
    var sameMonth = fulls.filter(function(x){ var d = new Date(x.time); return d.getFullYear() === y && d.getMonth() === local.getMonth(); });
    var monthlyBlue = sameMonth.length > 1 && sameMonth[1] === me;
    var seasonalBlue = false;
    for (var i = 0; i + 1 < seasons.length; i++) {
      if (t >= seasons[i] && t < seasons[i + 1]) {
        var inS = fulls.filter(function(x){ return x.time >= seasons[i] && x.time < seasons[i + 1]; });
        seasonalBlue = inS.length === 4 && inS[2] === me;
      }
    }
    return { name: name, km: km, superMoon: km < 360000, monthlyBlue: monthlyBlue, seasonalBlue: seasonalBlue };
  }
  function next(list, t){ for (var i = 0; i < list.length; i++) if (list[i].time > t) return list[i]; return null; }
  function prev(list, t){ var r = null; for (var i = 0; i < list.length; i++) { if (list[i].time <= t) r = list[i]; else break; } return r; }
  function nearFull(t){ for (var i = 0; i < FULLS.length; i++) if (Math.abs(FULLS[i].time - t) < 0.8 * DAY) return FULLS[i]; return null; }
  function phaseName(inf){
    var p = inf.illumination;
    if (p < 0.02) return 'New Moon';
    if (p > 0.98) return 'Full Moon';
    // a quarter is the moment the moon stands 90 degrees from the sun; it moves about 12 a day,
    // so 6 either side is the half day around it
    if (Math.abs(inf.elongation - 90) < 6) return 'First Quarter';
    if (Math.abs(inf.elongation - 270) < 6) return 'Last Quarter';
    if (inf.waxing) return p < 0.5 ? 'Waxing Crescent' : 'Waxing Gibbous';
    return p > 0.5 ? 'Waning Gibbous' : 'Waning Crescent';
  }
  var TITLES = {
    'New Moon':'The Dark of the Moon', 'Waxing Crescent':'A Crescent, Growing', 'First Quarter':'Half Lit, Growing',
    'Waxing Gibbous':'More Than Half, and Growing', 'Full Moon':'Full', 'Waning Gibbous':'Past Full, Growing Smaller',
    'Last Quarter':'Half Lit, Growing Smaller', 'Waning Crescent':'A Crescent, Fading'
  };
  function nightOf(t){ return new Date(t.getTime() - (new Date(t).getHours() < 12 ? DAY : 0)); }
  function nearestFull(d){
    var around = null;
    contextFor(d.getTime()).fulls.forEach(function(x){ if (!around || Math.abs(x.time - d) < Math.abs(around.time - d)) around = x; });
    return around;
  }
  // the lit part, drawn as on the moon page; pass the moon photo (an Image) for the real face
  function drawMoon(ctx, mx, my, mr, inf, face){
    var photo = !!face;
    var el = inf.elongation, waxing = el < 180;
    var f = inf.illumination, a = mr * (1 - 2 * f);
    ctx.save(); ctx.beginPath(); ctx.arc(mx, my, mr, 0, 7); ctx.clip();
    if (face && face.complete && face.naturalWidth) {
      ctx.drawImage(face, mx - mr, my - mr, mr * 2, mr * 2);
      ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(255,225,170,0.35)';
      ctx.fillRect(mx - mr, my - mr, mr * 2, mr * 2); ctx.globalCompositeOperation = 'source-over';
    } else { ctx.fillStyle = '#e7e1cf'; ctx.fillRect(mx - mr, my - mr, mr * 2, mr * 2); }
    ctx.beginPath(); var N = 64, dir = waxing ? 1 : -1, th, k;
    for (k = 0; k <= N; k++) { th = -Math.PI / 2 + (k / N) * Math.PI; ctx.lineTo(mx - dir * mr * Math.cos(th), my + mr * Math.sin(th)); }
    for (k = N; k >= 0; k--) { th = -Math.PI / 2 + (k / N) * Math.PI; ctx.lineTo(mx + dir * a * Math.cos(th), my + mr * Math.sin(th)); }
    ctx.closePath();
    if (photo && 'filter' in ctx) ctx.filter = 'blur(' + Math.max(1, mr * 0.025) + 'px)';
    ctx.fillStyle = photo ? 'rgba(2,3,10,0.9)' : 'rgba(20,24,44,0.92)'; ctx.fill(); ctx.filter = 'none';
    if (photo) {
      var limb = ctx.createRadialGradient(mx, my, mr * 0.65, mx, my, mr);
      limb.addColorStop(0, 'rgba(0,0,0,0)'); limb.addColorStop(1, 'rgba(0,0,10,0.35)');
      ctx.fillStyle = limb; ctx.fillRect(mx - mr, my - mr, mr * 2, mr * 2);
    }
    ctx.restore();
  }
  function eclipseNear(t){
    var hit = null;
    MD.eclipses.forEach(function(e){ if (e[1] === 'lunar' && Math.abs(new Date(e[0]) - t) < 0.6 * DAY) hit = e[2]; });
    return hit;
  }
  window.MoonWords = { DAY: DAY, FULLS: FULLS, NEWS: NEWS, phaseName: phaseName, TITLES: TITLES, fullInfo: fullInfo,
    nearFull: nearFull, nearestFull: nearestFull, next: next, nightOf: nightOf, drawMoon: drawMoon, eclipseNear: eclipseNear };
})();
