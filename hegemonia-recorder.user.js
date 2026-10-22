// ==UserScript==
// @name         Hegemonia Recorder
// @namespace    hegemonia-bot
// @version      1.1.0
// @description  Records the game's API requests (URL, body, reply) straight into the Hegemonia Bot database on Supabase so the bot can be developed from them. Tokens are stripped before sending; the account token is only shown in the panel for you to copy.
// @match        https://hegemonia.gg/*
// @match        https://*.hegemonia.gg/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/alielzahed49-art/hegemoniarecorder/main/hegemonia-recorder.user.js
// @downloadURL  https://raw.githubusercontent.com/alielzahed49-art/hegemoniarecorder/main/hegemonia-recorder.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__hgRec) return;
  window.__hgRec = true;

  // insert-only table: this key can add rows to hegemonia_inbox and nothing else (it can not read anything back)
  var SUPABASE = 'https://pzbboqtplowfmfyuejzt.supabase.co/rest/v1/hegemonia_inbox';
  var PUBLISHABLE_KEY = 'sb_publishable_LmXyBua-RkD-rn5l7aDcWQ_FqKEc-D5';
  var HOST_SUFFIX = 'hegemonia.gg';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  var L = {
    ar: { title: 'مسجّل هيجيمونيا', on: 'بيسجّل ويبعت ✓', off: 'متوقف', err: 'مقدرتش أبعت — هحاول تاني', sent: 'اتبعت', copy: 'نسخ التوكن', copied: 'اتنسخ ✓', no_token: 'لسه ملقيتش توكن — سجّل دخول',
          pause: '⏸ إيقاف التسجيل', resume: '▶ تشغيل التسجيل', send: '📨 ابعت دلوقتي', hide: '🙈 إخفاء (اضغط مطوّل ٣ ثواني على مكان فاضي لإظهاره)' },
    en: { title: 'Hegemonia Recorder', on: 'Recording and sending ✓', off: 'Paused', err: 'Could not send — will retry', sent: 'sent', copy: 'Copy token', copied: 'Copied ✓', no_token: 'No token yet — log in',
          pause: '⏸ Pause recording', resume: '▶ Resume recording', send: '📨 Send now', hide: '🙈 Hide (long-press an empty spot for 3 s to bring it back)' },
    tr: { title: 'Hegemonia Kaydedici', on: 'Kaydediyor ve gönderiyor ✓', off: 'Duraklatıldı', err: 'Gönderilemedi — tekrar denenecek', sent: 'gönderildi', copy: 'Token\'ı kopyala', copied: 'Kopyalandı ✓', no_token: 'Henüz token yok — giriş yap',
          pause: '⏸ Kaydı duraklat', resume: '▶ Kaydı sürdür', send: '📨 Şimdi gönder', hide: '🙈 Gizle (geri getirmek için boş bir yere 3 sn bas)' }
  };
  function lang() { var l = lsGet('hgrec_lang') || (navigator.language || 'en').slice(0, 2); return L[l] ? l : 'en'; }
  function tx(k) { return L[lang()][k] || L.en[k]; }

  // ---------------------------------------------------------------- what is recorded
  var JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  var AUTH_NAME = /^(authorization|x-[a-z-]*(token|auth|session)[a-z-]*|token|access-token)$/i;
  // only the game's own API (play.hegemonia.gg/api/...): page files, fonts, cdn, version files and the analytics/log calls are skipped
  var IMPORTANT = /^\/api\//;
  var SKIP = /\/(cdn|cdn-cgi|web-assets|k9x)\/|\.(png|jpe?g|gif|webp|svg|ico|css|js|map|woff2?|ttf|otf|wasm|txt|mp3|mp4)(\?|$)/i;
  var token = '', authHeader = '';
  var buf = [], timer = null, sentCount = Number(lsGet('hgrec_sent') || 0), state = 'on', seenGet = {};
  var SID = Math.random().toString(36).slice(2, 10);

  function paused() { return lsGet('hgrec_paused') === '1'; }
  function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function scrub(s) {
    if (s == null) return null;
    s = String(s);
    if (token) s = s.split(token).join('[token]');
    return s.replace(JWT, '[token]').replace(/("(password|pass|pwd|secret|refreshToken|refresh_token|accessToken|access_token|token)"\s*:\s*")[^"]*"/gi, '$1[hidden]"');
  }
  function isGame(u) {
    try { var h = new URL(u, location.href).hostname.toLowerCase(); return h === HOST_SUFFIX || h.slice(-HOST_SUFFIX.length - 1) === '.' + HOST_SUFFIX; }
    catch (e) { return false; }
  }
  // https://api.hegemonia.gg/players/123/skills?x=1 -> api.hegemonia.gg/players/{id}/skills (one API-map row per endpoint)
  function shapeOf(u) {
    try { var x = new URL(u); return x.host + x.pathname.replace(/\/(\d+|[0-9a-f]{8,}|[0-9a-f-]{36})(?=\/|$)/gi, '/{id}'); }
    catch (e) { return u; }
  }
  function seeAuth(name, value) {
    if (!name || !value || !AUTH_NAME.test(name)) return;
    var v = String(value).trim().replace(/^(Bearer|Token|JWT)\s+/i, '');
    if (v.length < 16 || /^(null|undefined)$/i.test(v)) return;
    token = v; authHeader = String(name);
    paint();
  }
  function headersOf(h, cb) {
    if (!h) return;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function (v, k) { cb(k, v); }); return; }
      if (Array.isArray(h)) { h.forEach(function (p) { cb(p[0], p[1]); }); return; }
      Object.keys(h).forEach(function (k) { cb(k, h[k]); });
    } catch (e) {}
  }
  function bodyText(b) {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
    if (typeof FormData !== 'undefined' && b instanceof FormData) return '[formdata]';
    var n = b && (b.byteLength || b.size || (b.buffer && b.buffer.byteLength));
    return '[binary' + (n ? ' ' + n + ' bytes' : '') + ']';
  }

  function record(method, url, status, req, res) {
    if (paused() || SKIP.test(url)) return;
    var abs, path;
    try { var u = new URL(url, location.href); abs = u.href; path = u.pathname; } catch (e) { return; }
    if (!IMPORTANT.test(path)) return;
    if (method === 'GET') {  // the game polls some endpoints: one sample every 8 s is enough
      var k = abs.split('?')[0];
      if (seenGet[k] && Date.now() - seenGet[k] < 8000) return;
      seenGet[k] = Date.now();
    }
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) return;
    buf.push({
      sid: SID, method: method, url: clip(abs, 2000), shape: clip(shapeOf(abs), 500), status: status || 0,
      req: req == null ? null : clip(scrub(req), 5900), res: res == null ? null : clip(scrub(res), 19900),
      page: clip(location.pathname + location.hash, 200), auth_header: authHeader ? clip(authHeader, 60) : null
    });
    if (buf.length > 300) buf.shift();
    if (buf.length >= 15) flush(); else if (!timer) timer = setTimeout(flush, 4000);
    paint();
  }

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  function flush() {
    timer = null;
    if (!buf.length || !origFetch) return;
    var batch = buf.splice(0, buf.length);
    origFetch(SUPABASE, {
      method: 'POST', mode: 'cors', credentials: 'omit', keepalive: batch.length < 20,
      headers: { 'apikey': PUBLISHABLE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(batch)
    }).then(function (r) {
      if (r.ok) { sentCount += batch.length; lsSet('hgrec_sent', String(sentCount)); state = 'on'; }
      else { state = 'err'; if (r.status >= 500 || r.status === 429) buf = batch.concat(buf).slice(-300); }
      paint();
    }, function () { state = 'err'; buf = batch.concat(buf).slice(-300); paint(); });
  }

  // ---------------------------------------------------------------- hooks
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = '', method = 'GET', req = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
        method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (isGame(url)) {
          headersOf(init && init.headers, seeAuth);
          if (input && input.headers) headersOf(input.headers, seeAuth);
          req = bodyText(init && init.body);
        }
      } catch (e) {}
      var p = origFetch.apply(this, arguments);
      if (!isGame(url)) return p;
      p.then(function (resp) {
        try {
          var ct = (resp.headers && resp.headers.get('content-type')) || '';
          if (!/json|text/i.test(ct)) { record(method, url, resp.status, req, null); return; }
          resp.clone().text().then(function (text) { record(method, url, resp.status, req, text); }, function () {});
        } catch (e) {}
      }, function () {});
      return p;
    };
  }
  try {
    var xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send, xSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__hg = { method: String(m || 'GET').toUpperCase(), url: String(u || '') }; return xOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (this.__hg && isGame(this.__hg.url)) seeAuth(k, v); } catch (e) {}
      return xSet.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (b) {
      var info = this.__hg, xhr = this;
      if (info && isGame(info.url)) {
        var req = bodyText(b);
        xhr.addEventListener('loadend', function () {
          var text = null;
          try { text = (xhr.responseType === '' || xhr.responseType === 'text') ? xhr.responseText : null; } catch (e) {}
          record(info.method, info.url, xhr.status, req, text);
        });
      }
      return xSend.apply(this, arguments);
    };
  } catch (e) {}

  // ---------------------------------------------------------------- badge + panel
  var ui, dot, panel;
  function paint() {
    if (!dot) return;
    dot.style.background = paused() ? '#6b7280' : (state === 'err' ? '#f59e0b' : '#ef4444');
    dot.textContent = buf.length ? String(Math.min(buf.length, 99)) : 'REC';
    if (panel && !panel.hidden) fill();
  }
  function button(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'display:block;width:100%;margin:6px 0 0;padding:8px 10px;border-radius:10px;border:1px solid #2a3042;background:#1b2030;color:#e8eaf1;font:600 13px system-ui,sans-serif;cursor:pointer;text-align:start;';
    b.onclick = function (e) { e.stopPropagation(); fn(b); };
    return b;
  }
  function fill() {
    panel.innerHTML = '';
    panel.dir = lang() === 'ar' ? 'rtl' : 'ltr';
    var h = document.createElement('div');
    h.style.cssText = 'font:800 14px system-ui,sans-serif;color:#e9bd63;margin-bottom:4px;';
    h.textContent = '🎙️ ' + tx('title');
    var s = document.createElement('div');
    s.style.cssText = 'font:500 12px system-ui,sans-serif;color:#cfd3dd;';
    s.textContent = (paused() ? tx('off') : (state === 'err' ? tx('err') : tx('on'))) + ' · ' + sentCount + ' ' + tx('sent');
    panel.appendChild(h); panel.appendChild(s);
    panel.appendChild(button(paused() ? tx('resume') : tx('pause'), function () { lsSet('hgrec_paused', paused() ? null : '1'); paint(); }));
    panel.appendChild(button(tx('send'), function () { flush(); }));
    panel.appendChild(button('🔑 ' + (token ? tx('copy') : tx('no_token')), function (b) {
      if (!token) return;
      var done = function () { b.textContent = '✓ ' + tx('copied'); };
      if (navigator.clipboard) navigator.clipboard.writeText(token).then(done, function () { prompt('', token); });
      else prompt('', token);
    }));
    var langs = document.createElement('div');
    langs.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    ['ar', 'en', 'tr'].forEach(function (l) {
      var b = document.createElement('button');
      b.textContent = l.toUpperCase();
      b.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:1px solid ' + (l === lang() ? '#d4a24c' : '#2a3042') + ';background:#151924;color:#e8eaf1;font:700 12px system-ui;cursor:pointer;';
      b.onclick = function (e) { e.stopPropagation(); lsSet('hgrec_lang', l); fill(); };
      langs.appendChild(b);
    });
    panel.appendChild(langs);
    panel.appendChild(button(tx('hide'), function () { lsSet('hgrec_hidden', '1'); ui.style.display = 'none'; }));
  }
  function mount() {
    if (ui || !document.body) return;
    ui = document.createElement('div');
    ui.style.cssText = 'position:fixed;inset-inline-end:10px;bottom:110px;z-index:2147483646;';
    dot = document.createElement('div');
    dot.style.cssText = 'min-width:34px;height:26px;padding:0 6px;border-radius:13px;opacity:.85;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer;display:grid;place-items:center;font:800 11px system-ui;color:#fff;';
    panel = document.createElement('div');
    panel.hidden = true;
    panel.style.cssText = 'position:absolute;bottom:34px;inset-inline-end:0;width:250px;padding:12px;border-radius:14px;background:#10131a;border:1px solid #2a3042;box-shadow:0 10px 30px rgba(0,0,0,.6);';
    dot.onclick = function (e) { e.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) fill(); };
    document.addEventListener('click', function (e) { if (!panel.hidden && !ui.contains(e.target)) panel.hidden = true; }, true);
    ui.appendChild(panel); ui.appendChild(dot);
    document.body.appendChild(ui);
    if (lsGet('hgrec_hidden') === '1') ui.style.display = 'none';
    var pressT = null;
    document.addEventListener('pointerdown', function (e) { if (e.target === document.body || e.target === document.documentElement) pressT = setTimeout(function () { lsSet('hgrec_hidden', null); ui.style.display = ''; }, 3000); });
    document.addEventListener('pointerup', function () { clearTimeout(pressT); });
    paint();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
})();
