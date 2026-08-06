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

  const treeFromServer = (t) => ({ id: t.id, x: t.x, z: t.z, name: t.name, msg: t.message, color: t.color, tier: t.tier, adopt: t.adopt, owner: t.owner });
  const starFromServer = (s) => ({ id: s.id, dx: s.dx, dy: s.dy, dz: s.dz, name: s.name, msg: s.message, tier: s.tier, owner: s.owner });

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
    return JSON.parse(localStorage.getItem('banjoSpiritTrees') || '[]');
  }
  async function addTree(t) {
    if (mode === 'live') {
      const d = await api('/api/trees', { method: 'POST', body: JSON.stringify({ x: t.x, z: t.z, name: t.name, message: t.msg, color: t.color, tier: t.tier, adopt: t.adopt }) });
      return treeFromServer(d.tree);
    }
    const arr = JSON.parse(localStorage.getItem('banjoSpiritTrees') || '[]');
    t.idx = arr.length; arr.push(t); localStorage.setItem('banjoSpiritTrees', JSON.stringify(arr)); return t;
  }
  async function getStars() {
    if (mode === 'live') { const d = await api('/api/stars'); return d.stars.map(starFromServer); }
    return JSON.parse(localStorage.getItem('banjoSpiritStars') || '[]');
  }
  async function addStar(s) {
    if (mode === 'live') {
      const d = await api('/api/stars', { method: 'POST', body: JSON.stringify({ dx: s.dx, dy: s.dy, dz: s.dz, name: s.name, message: s.msg, tier: s.tier }) });
      return starFromServer(d.star);
    }
    const arr = JSON.parse(localStorage.getItem('banjoSpiritStars') || '[]');
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

  window.BS = { init, getTrees, addTree, getStars, addStar, login, register, logout, ensureAuth,
    get user() { return user; }, get mode() { return mode; } };
})();
