// The Moon Book sign-up box: posts the email, says what happens next, never reloads the page.
(function () {
  Array.prototype.forEach.call(document.querySelectorAll('.mb-form'), function (form) {
    var input = form.querySelector('input[type=email]'), btn = form.querySelector('button'),
        msg = form.querySelector('.mb-msg'), trap = form.querySelector('input[name=website]');
    function send() {
      var email = (input.value || '').trim();
      if (!email) { msg.textContent = 'Put your email in first.'; input.focus(); return; }
      btn.disabled = true; btn.textContent = 'Signing up…'; msg.textContent = '';
      fetch('/api/moon-book/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, website: trap ? trap.value : '' })
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          msg.textContent = res.ok ? res.d.message : (res.d.error || 'That did not go through. Try again in a minute.');
          if (res.ok) input.value = '';
        })
        .catch(function () { msg.textContent = 'That did not go through. Check the signal and try again.'; })
        .then(function () { btn.disabled = false; btn.textContent = 'Sign up'; });
    }
    btn.addEventListener('click', function (e) { e.preventDefault(); send(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  });
})();
