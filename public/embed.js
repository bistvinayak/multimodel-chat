/* Chat box for a published assistant. Paste one script tag on your site:
   <script src="https://YOUR-APP/embed.js" data-assistant="ID" data-key="KEY" async></script> */
(function () {
  var s = document.currentScript; if (!s) return;
  var id = s.getAttribute('data-assistant'), key = s.getAttribute('data-key'); if (!id || !key) return;
  var base = s.src.replace(/\/embed\.js(\?.*)?$/, '');
  var title = s.getAttribute('data-title') || 'Ask us anything';
  var color = s.getAttribute('data-color') || '#4f6bed';
  var host = document.createElement('div'); document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>*{box-sizing:border-box;font-family:system-ui,sans-serif}' +
    '.b{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:' + color + ';color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000}' +
    '.p{position:fixed;right:20px;bottom:88px;width:340px;max-width:calc(100vw - 24px);height:460px;max-height:calc(100vh - 110px);background:#fff;color:#1a1a1a;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}' +
    '.p.o{display:flex}.h{background:' + color + ';color:#fff;padding:12px 14px;font-weight:600}' +
    '.m{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.45}' +
    '.u,.a{padding:8px 10px;border-radius:10px;max-width:88%;white-space:pre-wrap}.u{align-self:flex-end;background:' + color + ';color:#fff}.a{background:#f1f2f5}' +
    '.s{font-size:11px;color:#666;margin-top:4px}.f{display:flex;gap:6px;border-top:1px solid #e3e3e8;padding:8px}' +
    'input{flex:1;border:1px solid #ccd;border-radius:8px;padding:8px;font-size:14px}.f button{border:0;background:' + color + ';color:#fff;border-radius:8px;padding:0 12px;cursor:pointer}' +
    '.r{font-size:12px;margin-top:4px}.r button{border:0;background:none;cursor:pointer;font-size:14px}</style>' +
    '<button class="b" aria-label="Open chat">💬</button><div class="p" role="dialog" aria-label="' + title.replace(/"/g, '') + '"><div class="h"></div><div class="m"></div>' +
    '<form class="f"><input placeholder="Type your question" maxlength="500" aria-label="Your question"><button>Send</button></form></div>';
  root.querySelector('.h').textContent = title;
  var panel = root.querySelector('.p'), msgs = root.querySelector('.m'), input = root.querySelector('input');
  function add(cls, text) { var d = document.createElement('div'); d.className = cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  function post(path, body) {
    return fetch(base + '/pub/rag/' + id + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RAG-Key': key }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); });
  }
  root.querySelector('.b').onclick = function () { panel.classList.toggle('o'); if (panel.classList.contains('o')) { if (!msgs.children.length) add('a', 'Hi! Ask me about our business.'); input.focus(); } };
  root.querySelector('form').onsubmit = function (e) {
    e.preventDefault(); var q = input.value.trim(); if (!q) return; input.value = ''; add('u', q);
    var wait = add('a', '…');
    post('query', { question: q }).then(function (r) {
      wait.textContent = r.answer.replace(/\s?\[\d+\]/g, '');
      if (r.sources && r.sources.length) { var s = document.createElement('div'); s.className = 's'; s.textContent = 'From: ' + r.sources.map(function (x) { return x.doc; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', '); wait.appendChild(s); }
      var rate = document.createElement('div'); rate.className = 'r';
      [['👍', 1], ['👎', -1]].forEach(function (p) { var b = document.createElement('button'); b.textContent = p[0]; b.onclick = function () { post('feedback', { query_id: r.query_id, rating: p[1] }); rate.textContent = 'Thanks!'; }; rate.appendChild(b); });
      wait.appendChild(rate);
    }).catch(function (err) { wait.textContent = err.message; });
  };
})();
