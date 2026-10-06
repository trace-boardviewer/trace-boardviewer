/* TRACE Boardviewer site — theme toggle, release data, captions, gallery lightbox. English only. No network calls except the site's own JSON files. */
(function () {
  'use strict';
  var root = document.documentElement;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: ignore */ } }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }

  // English only.
  root.setAttribute('lang', 'en');

  // Theme: stored > system.
  var theme = get('trace.theme'); if (theme) root.setAttribute('data-theme', theme);
  each('[data-theme-btn]', function (b) {
    b.addEventListener('click', function () {
      var cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      var next = cur === 'light' ? 'dark' : 'light'; root.setAttribute('data-theme', next); set('trace.theme', next);
    });
  });

  // Release data (static JSON committed with the site; updated by the release process).
  // "version" is a bare semver, "status" the release state ("unreleased" | "released"), "statusText" an optional label shown on the page.
  // File names and URLs are used only when they look like a file name / an https URL, so a stray value can never break the commands shown.
  var SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  var FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function httpsUrl(u) { return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }
  function text(sel, value) { each(sel, function (e) { e.textContent = value; }); }
  function show(sel, on) { each(sel, function (e) { e.hidden = !on; }); }
  function enableLink(sel, url) { if (!url) return; each(sel, function (e) { e.setAttribute('href', url); e.removeAttribute('aria-disabled'); e.removeAttribute('role'); }); }
  function statusLabel(rel) {
    if (typeof rel.statusText === 'string' && rel.statusText) return rel.statusText;
    if (rel.status === 'unreleased') return 'not released yet';
    return '';
  }
  fetch('release.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (rel) {
    var win = rel.windows || {}, mac = rel.macos || {};
    var version = SEMVER.test(rel.version || '') ? rel.version : '';
    var winFile = FILENAME.test(win.file || '') ? win.file : '';
    var macFile = FILENAME.test(mac.file || '') ? mac.file : '';
    var winUrl = httpsUrl(win.url), macUrl = httpsUrl(mac.url);
    if (version) text('[data-rel="version"]', version);
    if (winFile) text('[data-rel="win-name"]', winFile);
    enableLink('[data-rel="win-url"]', winUrl);
    text('[data-rel="win-sha"]', win.sha256 || '—'); show('[data-rel="win-sha-item"]', !!win.sha256);
    text('[data-rel="win-size"]', win.bytes ? fmtBytes(win.bytes) : '—'); show('[data-rel="win-size"]', !!win.bytes);
    text('[data-rel="date"]', rel.date || '—'); show('[data-rel="date"]', !!rel.date);
    var status = statusLabel(rel);
    text('[data-rel="status"]', status); show('[data-rel="status"]', !!status && !winUrl);
    enableLink('[data-rel="mac-url"]', macUrl);
    text('[data-rel="mac-name"]', macFile && macUrl ? macFile : 'No macOS download yet');
    if (macFile) text('[data-rel="mac-file"]', macFile);
    text('[data-rel="mac-sha"]', mac.sha256 || '—'); show('[data-rel="mac-sha-item"]', !!mac.sha256);
    text('[data-rel="mac-size"]', mac.bytes ? fmtBytes(mac.bytes) : '—'); show('[data-rel="mac-size"]', !!mac.bytes);
    show('[data-rel="mac-hash-cmd"]', !!(macFile && macUrl));
    each('[data-rel="releases"]', function (e) { var u = httpsUrl(rel.releasesUrl); if (u) e.setAttribute('href', u); });
    // A meta line whose items are all hidden is hidden as a whole.
    each('p.meta', function (p) { if (p.querySelector('.item')) p.hidden = !p.querySelector('.item:not([hidden])'); });
  }).catch(function () { /* keep the static placeholders */ });

  // Screenshot provenance captions (build hash, sample file, licence) from a static JSON written by the media lane.
  if (document.querySelector('[data-cap]')) {
    fetch('assets/img/captions.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (caps) {
      each('[data-cap]', function (e) { var c = caps[e.getAttribute('data-cap')]; if (c) e.textContent = c; });
    }).catch(function () { /* captions stay empty until the media lane writes them */ });
  }

  // Gallery lightbox: a modal <dialog> opened from the thumbnail buttons (click, Enter or Space), closed by Esc, the close button
  // or a click anywhere; the focus moves to the close button (the only control, so Tab stays on it) and returns to the thumbnail afterwards.
  var lb = document.querySelector('.lightbox');
  if (lb) {
    var lbImg = lb.querySelector('img'), lbCap = lb.querySelector('.lightbox-cap'), lbClose = lb.querySelector('.lightbox-close');
    var opener = null;
    var native = typeof lb.showModal === 'function';
    var isOpen = function () { return lb.hasAttribute('open'); };
    var onClosed = function () { lbImg.removeAttribute('src'); lbImg.alt = ''; if (opener) { opener.focus(); opener = null; } };
    var openLightbox = function (btn) {
      var thumb = btn.querySelector('img'); if (!thumb || isOpen()) return;
      var fig = btn.parentNode, fc = fig && fig.querySelector ? fig.querySelector('figcaption') : null;
      lbImg.src = thumb.getAttribute('data-full') || thumb.src; lbImg.alt = thumb.alt;
      if (lbCap) lbCap.textContent = fc && fc.firstChild && fc.firstChild.nodeType === 3 ? fc.firstChild.textContent : thumb.alt;
      opener = btn;
      if (native) lb.showModal(); else lb.setAttribute('open', '');
      if (lbClose) lbClose.focus();
    };
    var closeLightbox = function () {
      if (!isOpen()) return;
      if (native) lb.close(); else { lb.removeAttribute('open'); onClosed(); }
    };
    each('.gallery .shot', function (b) { b.addEventListener('click', function () { openLightbox(b); }); });
    lb.addEventListener('click', function () { closeLightbox(); });
    lb.addEventListener('close', onClosed);
    lb.addEventListener('keydown', function (e) { if (e.key === 'Tab' && lbClose) { e.preventDefault(); lbClose.focus(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen() && !native) closeLightbox(); });
  }
})();
