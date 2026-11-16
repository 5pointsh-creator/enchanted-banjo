// "Invite the family": one sheet, used by the candles, the moon lights and the lanterns.
// It never sends anything itself and never touches anybody's contacts - it writes the words
// and opens the visitor's own Messages, WhatsApp, Facebook or email with them already in,
// so the invitation comes from them, which is the only kind anybody opens.
(function () {
  // Shown only on a preview (?invite=preview) until it goes live; the flag sticks for the visit.
  var on = false;
  try {
    if (/[?&]invite=preview\b/.test(location.search)) sessionStorage.setItem('bsInvite', '1');
    on = sessionStorage.getItem('bsInvite') === '1';
  } catch (e) { on = /[?&]invite=preview\b/.test(location.search); }

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var css =
    '.bsi-wrap{position:fixed;inset:0;z-index:100;display:flex;align-items:flex-end;justify-content:center;' +
      'background:rgba(6,3,12,.72);backdrop-filter:blur(3px);font-family:"Segoe UI",system-ui,sans-serif}' +
    '@media(min-width:620px){.bsi-wrap{align-items:center}}' +
    '.bsi{width:100%;max-width:440px;max-height:92vh;overflow:auto;background:#1b1029;color:#efe6ff;' +
      'border:1px solid rgba(170,130,255,.3);border-radius:18px 18px 0 0;padding:20px 18px 18px;box-shadow:0 -10px 40px rgba(0,0,0,.5)}' +
    '@media(min-width:620px){.bsi{border-radius:18px}}' +
    '.bsi h3{margin:0 0 4px;font-size:19px;color:#fff}' +
    '.bsi .sub{margin:0 0 10px;font-size:13px;color:#b9a8e0;line-height:1.5}' +
    '.bsi .opt{display:block;width:100%;text-align:left;border:1px solid rgba(170,130,255,.28);border-radius:12px;' +
      'padding:10px 12px;margin-top:8px;font:inherit;font-size:14px;line-height:1.5;color:#efe6ff;background:rgba(40,24,64,.6);cursor:pointer}' +
    '.bsi .opt.on{border-color:#e7c26a;box-shadow:0 0 0 1px #e7c26a inset}' +
    '.bsi textarea{width:100%;box-sizing:border-box;margin-top:10px;min-height:86px;border-radius:12px;border:1px solid rgba(170,130,255,.35);' +
      'background:#120a1d;color:#fff;font:inherit;font-size:14px;line-height:1.5;padding:10px 12px;resize:vertical}' +
    '.bsi .lnk{font-size:12px;color:#9d8fc4;margin-top:6px;word-break:break-all}' +
    '.bsi .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}' +
    '.bsi .grid a,.bsi .grid button{display:block;text-align:center;border-radius:11px;padding:12px 6px;font:inherit;font-size:14.5px;' +
      'font-weight:600;color:#fff;text-decoration:none;border:0;cursor:pointer}' +
    '.bsi .sms{background:#2f9b4f}.bsi .wa{background:#1fa855}.bsi .fb{background:#3b63c4}.bsi .em{background:#7b5bc9}' +
    '.bsi .cp{grid-column:1/3;background:transparent!important;border:1px solid rgba(170,130,255,.45)!important;color:#d6c6ff!important}' +
    '.bsi .nat{grid-column:1/3;background:linear-gradient(180deg,#e7c26a,#c79a3b)!important;color:#2a1a05!important}' +
    '.bsi .close{display:block;margin:12px auto 0;background:none;border:0;color:#9d8fc4;font:inherit;font-size:14px;cursor:pointer;text-decoration:underline}';

  function open(o) {
    if (!document.getElementById('bsi-css')) {
      var st = document.createElement('style'); st.id = 'bsi-css'; st.textContent = css; document.head.appendChild(st);
    }
    var wrap = document.createElement('div'); wrap.className = 'bsi-wrap';
    var msgs = o.messages || [];
    wrap.innerHTML = '<div class="bsi" role="dialog" aria-label="' + esc(o.heading) + '">' +
      '<h3>' + esc(o.heading) + '</h3>' +
      '<p class="sub">' + esc(o.intro || 'Pick a message. You can change any word, then choose how to send it.') + '</p>' +
      msgs.map(function (m, i) { return '<button type="button" class="opt' + (i ? '' : ' on') + '" data-i="' + i + '">' + esc(m) + '</button>'; }).join('') +
      '<textarea aria-label="Your message"></textarea>' +
      '<div class="lnk">The link goes on the end: ' + esc(o.link) + '</div>' +
      '<div class="grid">' +
        (navigator.share ? '<button type="button" class="nat">📤 Send it…</button>' : '') +
        '<a class="sms" data-k="sms">💬 Text</a><a class="wa" data-k="wa" target="_blank" rel="noopener">WhatsApp</a>' +
        '<a class="fb" data-k="fb" target="_blank" rel="noopener">Facebook</a><a class="em" data-k="em">✉️ Email</a>' +
        '<button type="button" class="cp">🔗 Copy the message and link</button>' +
      '</div>' +
      '<button type="button" class="close">Close</button></div>';
    document.body.appendChild(wrap);
    var ta = wrap.querySelector('textarea');
    ta.value = msgs[0] || '';
    var full = function () { return ta.value.trim() + ' ' + o.link; };
    function wire() {
      var body = encodeURIComponent(full());
      wrap.querySelector('[data-k=sms]').href = 'sms:?&body=' + body;
      wrap.querySelector('[data-k=wa]').href = 'https://wa.me/?text=' + body;
      wrap.querySelector('[data-k=fb]').href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(o.link);
      wrap.querySelector('[data-k=em]').href = 'mailto:?subject=' + encodeURIComponent(o.subject || o.heading) + '&body=' + body;
    }
    wire();
    ta.addEventListener('input', wire);
    Array.prototype.forEach.call(wrap.querySelectorAll('.opt'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(wrap.querySelectorAll('.opt'), function (x) { x.classList.remove('on'); });
        b.classList.add('on'); ta.value = msgs[+b.getAttribute('data-i')]; wire();
      });
    });
    var nat = wrap.querySelector('.nat');
    if (nat) nat.onclick = function () { navigator.share({ title: o.subject || o.heading, text: ta.value.trim(), url: o.link }).catch(function () {}); };
    var cp = wrap.querySelector('.cp');
    cp.onclick = function () {
      var t = full();
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
        function () { cp.textContent = '✓ Copied - paste it anywhere'; },
        function () { window.prompt('Copy this:', t); });
    };
    var close = function () { wrap.remove(); };
    wrap.querySelector('.close').onclick = close;
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
  }

  window.BSInvite = { on: on, open: open };
})();
