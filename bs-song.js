/* Banjo Spirits - "leave them a song".
   A tiny plucked-string (Karplus-Strong) banjo synth + a recorder/player widget.
   A melody is stored as an array of {n, t}: n = note index, t = ms from the first note.
   Works standalone on any page; no backend needed. */
(function () {
  // G-major pentatonic - any sequence of these sounds gentle and in-tune.
  const NOTES = [
    { name: 'G', f: 196.00 },
    { name: 'A', f: 220.00 },
    { name: 'B', f: 246.94 },
    { name: 'D', f: 293.66 },
    { name: 'E', f: 329.63 },
    { name: 'G', f: 392.00 },
  ];
  const KEY_COLORS = ['#b26bff', '#ff6ba0', '#6bd0ff', '#ffd36b', '#7dff9e', '#c9a6ff'];

  let ctx = null, master = null;
  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.6;
      // a gentle limiter so overlapping notes in a melody never clip or screech
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 20; comp.ratio.value = 12;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // one plucked banjo string - the same Karplus-Strong string as the forest banjo,
  // so the melody sounds like the banjo, not a piano. It's a one-shot buffer that is
  // rendered once and decays to silence on its own, so a note can never stick.
  function pluck(freq, when, dur) {
    const ac = audio();
    const sr = ac.sampleRate;
    const t = Math.max(when || ac.currentTime, ac.currentTime);
    dur = dur || 2.0;

    const N = Math.max(2, Math.round(sr / freq));
    const len = Math.floor(sr * dur);
    const buf = ac.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < N; i++) d[i] = Math.random() * 2 - 1;        // pluck excitation
    for (let i = N; i < len; i++) d[i] = 0.996 * 0.5 * (d[i - N] + d[i - N + 1]); // string decay

    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.setValueAtTime(0.75, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur - 0.15);     // fade out cleanly
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;

    src.connect(lp); lp.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
    src.onended = () => { try { src.disconnect(); lp.disconnect(); g.disconnect(); } catch (e) {} };
  }

  function playNote(n) { const note = NOTES[n] || NOTES[0]; pluck(note.f); }

  // play a whole melody (array of {n,t}); returns total ms
  function play(song) {
    if (!song || !song.length) return 0;
    const ac = audio();
    const base = ac.currentTime + 0.06;
    let last = 0;
    song.forEach((e) => { pluck((NOTES[e.n] || NOTES[0]).f, base + e.t / 1000); last = Math.max(last, e.t); });
    return last + 2200;
  }

  const step = (arr, ms) => arr.map((n, i) => ({ n, t: i * ms }));
  const PRESETS = [
    { name: 'Twinkle', notes: step([0, 0, 3, 3, 4, 4, 3], 460) },
    { name: 'Gentle climb', notes: step([0, 1, 2, 3, 4, 5], 420) },
    { name: 'Remembrance', notes: step([5, 4, 3, 2, 3, 4, 5, 5], 440) },
    { name: 'Soft lullaby', notes: step([2, 2, 4, 2, 2, 4, 3, 2], 470) },
  ];

  /* Build a recorder widget inside `host`.
     opts.onChange(song|null) fires whenever the melody changes.
     Returns { getSong, setSong, clear }. */
  function mountRecorder(host, opts) {
    opts = opts || {};
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div style="display:flex;gap:6px;margin:6px 0">${
        NOTES.map((nt, i) => `<button type="button" data-k="${i}"
          style="flex:1;height:44px;border:none;border-radius:9px;cursor:pointer;color:#160c26;font:600 13px/1 Segoe UI,sans-serif;
          background:${KEY_COLORS[i]};box-shadow:0 2px 8px rgba(0,0,0,.35)">${nt.name}</button>`).join('')
      }</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px">
        <button type="button" id="bss-play" style="cursor:pointer;font:inherit;font-size:13px;padding:7px 12px;border-radius:9px;border:1px solid #4a2f6e;background:#0e0718;color:#e8dcff">▶ Preview</button>
        <button type="button" id="bss-clear" style="cursor:pointer;font:inherit;font-size:13px;padding:7px 12px;border-radius:9px;border:1px solid #4a2f6e;background:#0e0718;color:#e8dcff">Clear</button>
        <span id="bss-count" style="font-size:12px;opacity:.6"></span>
      </div>
      <div style="margin-top:8px;font-size:12px;opacity:.6">Or pick a ready-made tune:</div>
      <div id="bss-presets" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"></div>`;
    host.appendChild(wrap);

    let song = [];
    let start = 0;
    const countEl = wrap.querySelector('#bss-count');
    const refresh = () => {
      countEl.textContent = song.length ? `${song.length} notes` : 'tap the keys to play a little melody';
      if (opts.onChange) opts.onChange(song.length ? song.slice() : null);
    };

    wrap.querySelectorAll('button[data-k]').forEach((b) => {
      b.addEventListener('click', () => {
        const n = +b.dataset.k;
        playNote(n);
        const now = performance.now();
        if (!song.length) start = now;
        song.push({ n, t: Math.round(now - start) });
        b.animate([{ transform: 'translateY(2px)', filter: 'brightness(1.4)' }, { transform: 'none', filter: 'none' }], { duration: 180 });
        refresh();
      });
    });
    wrap.querySelector('#bss-play').addEventListener('click', () => play(song));
    wrap.querySelector('#bss-clear').addEventListener('click', () => { song = []; refresh(); });

    const pbox = wrap.querySelector('#bss-presets');
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = p.name;
      b.style.cssText = 'cursor:pointer;font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;border:1px solid #3a2456;background:#160c26;color:#c9b6ff';
      b.addEventListener('click', () => { song = p.notes.map((e) => ({ n: e.n, t: e.t })); play(song); refresh(); });
      pbox.appendChild(b);
    });

    refresh();
    return {
      getSong: () => (song.length ? song.slice() : null),
      setSong: (s) => { song = Array.isArray(s) ? s.slice() : []; refresh(); },
      clear: () => { song = []; refresh(); },
    };
  }

  window.BSSong = { play, playNote, mountRecorder, NOTES, PRESETS };
})();
