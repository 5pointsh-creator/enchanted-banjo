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

  // one plucked note via a damped feedback delay line
  function pluck(freq, when, dur) {
    const ac = audio();
    const t = when || ac.currentTime;
    dur = dur || 2.4;
    const noiseLen = Math.max(0.015, 2 / freq);
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * noiseLen), ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = buf;

    const delay = ac.createDelay(0.05); delay.delayTime.value = 1 / freq;
    const fb = ac.createGain(); fb.gain.value = 0.972;
    const damp = ac.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = Math.min(7000, freq * 9);
    const out = ac.createGain(); out.gain.value = 0.0;

    src.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay);
    src.connect(out); delay.connect(out);
    out.connect(master);

    out.gain.setValueAtTime(0.85, t);
    out.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.start(t);
    const kill = (t - ac.currentTime + dur + 0.25) * 1000;
    setTimeout(() => { try { src.disconnect(); delay.disconnect(); fb.disconnect(); damp.disconnect(); out.disconnect(); } catch (e) {} }, Math.max(60, kill));
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
