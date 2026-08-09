/* Banjo Spirits - shared client for accounts + the shared database.
   If the backend API is reachable (the real site on Railway), everything is
   shared and saving requires an account. If not (the static GitHub Pages
   preview), it transparently falls back to the on-device demo storage. */
(function () {
  let mode = 'demo';   // 'live' once the API answers
  let user = null;

  const api = (p, opts = {}) =>
    fetch(p, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Something went wrong.');
        return d;
      });

  const parseSong = (v) => { if (!v) return null; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (e) { return null; } };
  // never let a half-written or corrupt entry blank the whole forest/sky
  const readList = (key) => { try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const treeFromServer = (t) => ({ id: t.id, x: t.x, z: t.z, name: t.name, msg: t.message, color: t.color, tier: t.tier, adopt: t.adopt, song: parseSong(t.song), owner: t.owner });
  const starFromServer = (s) => ({ id: s.id, dx: s.dx, dy: s.dy, dz: s.dz, name: s.name, msg: s.message, tier: s.tier, song: parseSong(s.song), owner: s.owner });

  async function init() {
    try {
      const d = await api('/api/me');   // only the real backend answers this as JSON
      mode = 'live';
      user = d.user;
    } catch (e) {
      mode = 'demo';
    }
    injectUI();
    renderChip();
    return { mode, user };
  }

  // ---------- data ----------
  async function getTrees() {
    if (mode === 'live') { const d = await api('/api/trees'); return d.trees.map(treeFromServer); }
    return readList('banjoSpiritTrees');
  }
  async function addTree(t) {
    if (mode === 'live') {
      const d = await api('/api/trees', { method: 'POST', body: JSON.stringify({ x: t.x, z: t.z, name: t.name, message: t.msg, color: t.color, tier: t.tier, adopt: t.adopt, song: t.song ? JSON.stringify(t.song) : null }) });
      return treeFromServer(d.tree);
    }
    const arr = readList('banjoSpiritTrees');
    t.idx = arr.length; arr.push(t); localStorage.setItem('banjoSpiritTrees', JSON.stringify(arr)); return t;
  }
  async function getStars() {
    if (mode === 'live') { const d = await api('/api/stars'); return d.stars.map(starFromServer); }
    return readList('banjoSpiritStars');
  }
  async function addStar(s) {
    if (mode === 'live') {
      const d = await api('/api/stars', { method: 'POST', body: JSON.stringify({ dx: s.dx, dy: s.dy, dz: s.dz, name: s.name, message: s.msg, tier: s.tier, song: s.song ? JSON.stringify(s.song) : null }) });
      return starFromServer(d.star);
    }
    const arr = readList('banjoSpiritStars');
    s.idx = arr.length; arr.push(s); localStorage.setItem('banjoSpiritStars', JSON.stringify(arr)); return s;
  }

  // ---------- auth ----------
  async function login(email, password) { const d = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }); user = d.user; renderChip(); return user; }
  async function register(email, password, displayName) { const d = await api('/api/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) }); user = d.user; renderChip(); return user; }
  async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch (e) {} user = null; renderChip(); }

  // Resolves when signed in; in demo mode it resolves immediately (no account needed).
  function ensureAuth() {
    if (mode === 'demo' || user) return Promise.resolve(true);
    return openAuth();
  }

  // ---------- UI (account chip + auth modal, injected once) ----------
  let authResolve = null;
  function injectUI() {
    if (document.getElementById('bs-chip')) return;
    const css = document.createElement('style');
    css.textContent = `
      #bs-chip{position:fixed;top:14px;right:14px;z-index:40;font:13px/1.2 "Segoe UI",system-ui,sans-serif}
      #bs-chip button{cursor:pointer;font:inherit;border-radius:10px;padding:8px 12px;border:1px solid #5a3aa0;background:rgba(20,12,36,.8);color:#e9d4ff;backdrop-filter:blur(3px)}
      #bs-auth{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(6,4,12,.8);backdrop-filter:blur(3px);font-family:"Segoe UI",system-ui,sans-serif}
      #bs-auth .card{background:#130c24;border:1px solid #4a2f6e;border-radius:16px;padding:22px;width:min(400px,92vw);color:#efe6ff}
      #bs-auth h3{margin-bottom:4px;font-size:19px}
      #bs-auth p.sub{opacity:.6;font-size:13px;margin-bottom:14px}
      #bs-auth .tabs{display:flex;gap:8px;margin-bottom:14px}
      #bs-auth .tabs button{flex:1;cursor:pointer;font:inherit;padding:9px;border-radius:10px;border:1px solid #4a2f6e;background:#0e0718;color:#c7b3ff}
      #bs-auth .tabs button.on{background:#6a3cff;color:#fff;border-color:#6a3cff}
      #bs-auth input{width:100%;margin:6px 0;padding:10px;border-radius:9px;border:1px solid #4a2f6e;background:#0e0718;color:#efe6ff;font:inherit}
      #bs-auth .err{color:#ff9aa2;font-size:13px;min-height:18px;margin:4px 0}
      #bs-auth .go{width:100%;margin-top:8px;cursor:pointer;font:inherit;padding:11px;border:none;border-radius:11px;background:linear-gradient(180deg,#7a3cff,#5322b0);color:#fff}
      #bs-auth .cancel{width:100%;margin-top:8px;cursor:pointer;font:inherit;padding:9px;border:1px solid #4a2f6e;border-radius:11px;background:transparent;color:#c7b3ff}
      #bs-dn{display:none}`;
    document.head.appendChild(css);

    const chip = document.createElement('div'); chip.id = 'bs-chip'; document.body.appendChild(chip);

    const modal = document.createElement('div'); modal.id = 'bs-auth';
    modal.innerHTML = `
      <div class="card">
        <h3>Sign in to Banjo Spirits</h3>
        <p class="sub">You need an account to plant a tree or dedicate a star - so it's saved to the shared forest and you can come back to it.</p>
        <div class="tabs"><button id="bs-tab-login" class="on">Sign in</button><button id="bs-tab-reg">Create account</button></div>
        <input id="bs-name" placeholder="Your name" autocomplete="name">
        <input id="bs-email" type="email" placeholder="Email" autocomplete="email">
        <input id="bs-pass" type="password" placeholder="Password (min 6 characters)" autocomplete="current-password">
        <div class="err" id="bs-err"></div>
        <button class="go" id="bs-go">Sign in</button>
        <button class="cancel" id="bs-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(modal);

    let tab = 'login';
    const nameEl = modal.querySelector('#bs-name');
    const setTab = (t) => {
      tab = t;
      modal.querySelector('#bs-tab-login').classList.toggle('on', t === 'login');
      modal.querySelector('#bs-tab-reg').classList.toggle('on', t === 'reg');
      nameEl.style.display = t === 'reg' ? 'block' : 'none';
      modal.querySelector('#bs-go').textContent = t === 'reg' ? 'Create account' : 'Sign in';
      modal.querySelector('#bs-err').textContent = '';
    };
    modal.querySelector('#bs-tab-login').onclick = () => setTab('login');
    modal.querySelector('#bs-tab-reg').onclick = () => setTab('reg');
    setTab('login');

    modal.querySelector('#bs-go').onclick = async () => {
      const err = modal.querySelector('#bs-err'); err.textContent = '';
      const email = modal.querySelector('#bs-email').value.trim();
      const pass = modal.querySelector('#bs-pass').value;
      try {
        if (tab === 'reg') await register(email, pass, nameEl.value.trim());
        else await login(email, pass);
        modal.style.display = 'none';
        if (authResolve) { authResolve(true); authResolve = null; }
      } catch (e) { err.textContent = e.message; }
    };
    modal.querySelector('#bs-cancel').onclick = () => {
      modal.style.display = 'none';
      if (authResolve) { authResolve(false); authResolve = null; }
    };
  }

  function openAuth() {
    return new Promise((resolve) => {
      authResolve = resolve;
      document.getElementById('bs-auth').style.display = 'flex';
    });
  }

  function renderChip() {
    const chip = document.getElementById('bs-chip'); if (!chip) return;
    if (mode === 'demo') { chip.innerHTML = ''; return; }   // preview: no account chrome
    chip.innerHTML = user
      ? `<button id="bs-out">${escapeHtml(user.displayName || user.email)} · Sign out</button>`
      : `<button id="bs-in">Sign in</button>`;
    if (user) chip.querySelector('#bs-out').onclick = () => logout();
    else chip.querySelector('#bs-in').onclick = () => openAuth();
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Share + Invite (works on the live site and the preview alike) ----------
  const SHARE_TEXT = 'Banjo Spirits - walk an enchanted forest, plant a memorial tree and dedicate a star for someone you love.';
  const INVITE_TEXT = "I thought you'd love this - Banjo Spirits. You can walk a peaceful forest, plant a tree and dedicate a star in memory of someone. Come see it:";

  const shareUrl = () => location.href.split('#')[0];
  const inviteUrl = () => {
    const u = new URL(location.href.split('#')[0]);
    u.searchParams.set('from', 'invite');
    return u.toString();
  };

  function toast(msg) {
    let t = document.getElementById('bs-toast');
    if (!t) { t = document.createElement('div'); t.id = 'bs-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Link copied'); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
      ta.select(); try { document.execCommand('copy'); toast('Link copied'); } catch (_) { toast('Copy failed'); }
      ta.remove();
    }
  }
  function openWin(u) { window.open(u, '_blank', 'noopener,noreferrer,width=640,height=560'); }

  function injectShare() {
    if (document.getElementById('bs-share')) return;
    const css = document.createElement('style');
    css.textContent = `
      #bs-share-btn{position:fixed;right:14px;bottom:14px;z-index:44;cursor:pointer;border:1px solid #6a3cff;
        border-radius:24px;padding:10px 15px;background:rgba(24,14,44,.82);color:#eadcff;backdrop-filter:blur(4px);
        font:600 13px/1 "Segoe UI",system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4)}
      #bs-share-btn:hover{background:rgba(48,26,86,.92)}
      /* on phones the bottom corners hold the walk pads / colour button, so move Share up top */
      @media (hover:none){ #bs-share-btn{top:12px;bottom:auto;right:12px} }
      #bs-share{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
        background:rgba(6,4,12,.72);backdrop-filter:blur(4px);font-family:"Segoe UI",system-ui,sans-serif}
      #bs-share .card{background:#140c26;border:1px solid #4a2f6e;border-radius:18px;padding:22px;width:min(420px,92vw);color:#efe6ff}
      #bs-share h3{font-size:19px;margin-bottom:2px}
      #bs-share p.sub{opacity:.62;font-size:13px;margin-bottom:14px}
      #bs-share .row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
      #bs-share .row button{flex:1 1 46%;cursor:pointer;font:inherit;padding:11px;border-radius:11px;border:1px solid #4a2f6e;
        background:#0e0718;color:#e8dcff;display:flex;align-items:center;justify-content:center;gap:7px}
      #bs-share .row button:hover{background:#1c1136;border-color:#6a3cff}
      #bs-share .primary{width:100%;cursor:pointer;font:inherit;padding:12px;border:none;border-radius:12px;
        background:linear-gradient(180deg,#7a3cff,#5322b0);color:#fff;margin-bottom:14px}
      #bs-share hr{border:none;border-top:1px solid #2c1c48;margin:14px 0}
      #bs-share h4{font-size:15px;margin-bottom:2px}
      #bs-share input{width:100%;margin:8px 0;padding:11px;border-radius:10px;border:1px solid #4a2f6e;background:#0e0718;color:#efe6ff;font:inherit}
      #bs-share .close{width:100%;margin-top:10px;cursor:pointer;font:inherit;padding:10px;border:1px solid #4a2f6e;border-radius:11px;background:transparent;color:#c7b3ff}
      #bs-toast{position:fixed;left:50%;bottom:76px;transform:translate(-50%,12px);z-index:70;opacity:0;pointer-events:none;
        background:#2a1750;border:1px solid #6a3cff;color:#eadcff;padding:9px 16px;border-radius:20px;font:13px "Segoe UI",system-ui,sans-serif;transition:.25s}
      #bs-toast.show{opacity:1;transform:translate(-50%,0)}`;
    document.head.appendChild(css);

    const btn = document.createElement('button');
    btn.id = 'bs-share-btn'; btn.type = 'button'; btn.innerHTML = '✦ Share';
    document.body.appendChild(btn);

    const modal = document.createElement('div'); modal.id = 'bs-share';
    modal.innerHTML = `
      <div class="card">
        <h3>Share Banjo Spirits</h3>
        <p class="sub">Help someone find a little peace here.</p>
        <button class="primary" id="bs-sh-native">Share…</button>
        <div class="row">
          <button data-net="facebook">Facebook</button>
          <button data-net="x">X</button>
          <button data-net="whatsapp">WhatsApp</button>
          <button data-net="email">Email</button>
        </div>
        <div class="row"><button id="bs-sh-copy" style="flex:1 1 100%">Copy link</button></div>
        <hr>
        <h4>Invite a friend</h4>
        <p class="sub">Send a personal invite to someone you'd like to see it.</p>
        <input id="bs-inv-name" placeholder="Their name (optional)">
        <button class="primary" id="bs-inv-send">Send invite</button>
        <div class="row"><button id="bs-inv-copy" style="flex:1 1 100%">Copy invite link</button></div>
        <button class="close" id="bs-sh-close">Close</button>
      </div>`;
    document.body.appendChild(modal);

    const show = (v) => { modal.style.display = v ? 'flex' : 'none'; };
    btn.onclick = () => show(true);
    modal.querySelector('#bs-sh-close').onclick = () => show(false);
    modal.onclick = (e) => { if (e.target === modal) show(false); };

    modal.querySelector('#bs-sh-native').onclick = async () => {
      const url = shareUrl();
      if (navigator.share) { try { await navigator.share({ title: 'Banjo Spirits', text: SHARE_TEXT, url }); } catch (e) {} }
      else copy(url);
    };
    modal.querySelectorAll('.row button[data-net]').forEach((b) => {
      b.onclick = () => {
        const url = encodeURIComponent(shareUrl());
        const text = encodeURIComponent(SHARE_TEXT);
        const net = b.dataset.net;
        if (net === 'facebook') openWin(`https://www.facebook.com/sharer/sharer.php?u=${url}`);
        else if (net === 'x') openWin(`https://twitter.com/intent/tweet?url=${url}&text=${text}`);
        else if (net === 'whatsapp') openWin(`https://wa.me/?text=${text}%20${url}`);
        else if (net === 'email') location.href = `mailto:?subject=${encodeURIComponent('Banjo Spirits')}&body=${text}%0A%0A${url}`;
      };
    });
    modal.querySelector('#bs-sh-copy').onclick = () => copy(shareUrl());

    const inviteMessage = () => {
      const nm = modal.querySelector('#bs-inv-name').value.trim();
      const hi = nm ? `Hi ${nm}, ` : '';
      return `${hi}${INVITE_TEXT} ${inviteUrl()}`;
    };
    modal.querySelector('#bs-inv-send').onclick = async () => {
      const msg = inviteMessage();
      if (navigator.share) { try { await navigator.share({ title: 'You are invited to Banjo Spirits', text: msg, url: inviteUrl() }); return; } catch (e) {} }
      location.href = `mailto:?subject=${encodeURIComponent('You are invited to Banjo Spirits')}&body=${encodeURIComponent(msg)}`;
    };
    modal.querySelector('#bs-inv-copy').onclick = () => copy(inviteUrl());
  }

  window.BS = { init, getTrees, addTree, getStars, addStar, login, register, logout, ensureAuth, injectShare,
    get user() { return user; }, get mode() { return mode; } };

  // Share/invite widget appears on every page that loads this script, no init needed.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectShare);
  else injectShare();
})();
