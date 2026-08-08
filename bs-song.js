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
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // one plucked note: a warm tone with a fast attack and a natural decay.
  // No feedback loop - every note is self-contained and always dies away cleanly.
  function pluck(freq, when, dur) {
    const ac = audio();
    const t = Math.max(when || ac.currentTime, ac.currentTime);
    dur = dur || 1.8;

    const o1 = ac.createOscillator(); o1.type = 'triangle'; o1.frequency.value = freq;
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2; // faint shimmer
    const shimmer = ac.createGain(); shimmer.gain.value = 0.15;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(6500, freq * 6), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(600, freq * 2), t + dur);
    const g = ac.createGain(); g.gain.value = 0.0001;

    o1.connect(g); o2.connect(shimmer); shimmer.connect(g); g.connect(lp); lp.connect(master);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.40, t + 0.006);   // quick pluck attack
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);   // gentle decay to silence

    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    o1.onended = () => { try { o1.disconnect(); o2.disconnect(); shimmer.disconnect(); g.disconnect(); lp.disconnect(); } catch (e) {} };
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
