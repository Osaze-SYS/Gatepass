const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (kobo) => (kobo === 0 ? 'Free' : '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 }));
const nairaZero = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const fmtDate = (iso) => new Date(iso).toLocaleString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtShort = (iso) => new Date(iso).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayParts = (iso) => { const d = new Date(iso); return { day: d.getDate(), mon: d.toLocaleString('en-NG', { month: 'short' }) }; };
// "Remember me" keeps the login in localStorage (it survives closing the browser). Without it the login lives in sessionStorage and is forgotten when the browser closes.
const getToken = () => sessionStorage.getItem('gp_token') || localStorage.getItem('gp_token');
const getName = () => sessionStorage.getItem('gp_name') || localStorage.getItem('gp_name') || '';
const setSession = (token, name, remember) => {
  clearSession();
  const store = remember ? localStorage : sessionStorage;
  store.setItem('gp_token', token); store.setItem('gp_name', name);
};
const clearSession = () => { for (const s of [localStorage, sessionStorage]) { s.removeItem('gp_token'); s.removeItem('gp_name'); } };
const CATEGORY_LIST = ['Music', 'Tech', 'Business', 'Faith', 'Sports', 'Education', 'Food & Drink', 'Arts', 'Community', 'Other'];

async function api(path, body, method) {
  const headers = { 'Content-Type': 'application/json' };
  if (getToken()) headers.Authorization = 'Bearer ' + getToken();
  const res = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again.'); e.status = res.status; e.data = data; throw e; }
  return data;
}

// Cover picture, or a colourful placeholder when the organizer has not added one yet.
function cover(imageId, category, title) {
  if (imageId) return `<img src="/api/images/${imageId}" alt="${esc(title || '')}" loading="lazy">`;
  const hue = (Math.max(0, CATEGORY_LIST.indexOf(category)) * 47 + 215) % 360;
  return `<div class="ph" style="--h:${hue}"><span>${esc(category || 'Event')}</span></div>`;
}

function toast(message, type) {
  let box = document.querySelector('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div'); t.className = 'toast ' + (type || ''); t.textContent = message; box.append(t);
  setTimeout(() => t.remove(), 4500);
}

// Friendly replacement for confirm()/prompt(). Resolves to { ok, reason }.
function confirmDialog({ title, text, confirmLabel = 'Confirm', danger = false, askReason = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      ${askReason ? '<div class="field"><label for="dlg-reason">Reason (optional)</label><input id="dlg-reason" maxlength="200"></div>' : ''}
      <div class="row" style="justify-content:flex-end"><button class="btn secondary" value="no">Cancel</button><button class="btn ${danger ? 'danger' : ''}" value="yes">${esc(confirmLabel)}</button></div>`;
    document.body.append(d);
    d.addEventListener('click', (e) => { const v = e.target.closest('button')?.value; if (v) { d.dataset.v = v; d.close(); } });
    d.addEventListener('close', () => { resolve({ ok: d.dataset.v === 'yes', reason: d.querySelector('#dlg-reason')?.value || '' }); d.remove(); });
    d.showModal();
  });
}

// Shrinks a photo in the browser so uploads stay small and fast.
async function resizeImage(file, maxWidth = 1600) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPG, PNG or WebP picture.');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

const ICON = {
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#1d4ed8" d="M4 8a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3v4.2a3.8 3.8 0 0 0 0 7.6V24a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-4.2a3.8 3.8 0 0 0 0-7.6z"/><path stroke="#fff" stroke-width="2" stroke-dasharray="2 3" d="M20 7v18"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
};

(function chrome() {
  const here = location.pathname;
  const link = (href, label, extra = '') => `<a href="${href}" class="${here === href ? 'active' : ''} ${extra}">${label}</a>`;
  const header = document.querySelector('#top');
  if (header) {
    header.className = 'site-header';
    header.innerHTML = `<div class="container"><a class="brand" href="/">${ICON.logo}Gatepass</a>
      <button class="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nav">
        <svg class="bars" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        <svg class="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <nav class="nav" id="nav" aria-label="Main">${link('/', 'Browse events')}${getToken() ? link('/organizer.html', 'Dashboard') + link('/scan.html', 'Scan tickets', 'hide-sm') : link('/organizer.html', 'For organizers')}</nav></div>`;

    // Mobile menu: opens from the hamburger, closes on a link, Escape, an outside tap, or a wider screen.
    const toggle = header.querySelector('.nav-toggle'), nav = header.querySelector('#nav');
    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    document.addEventListener('click', (e) => { if (!header.contains(e.target)) setOpen(false); });
    const wide = window.matchMedia && window.matchMedia('(min-width: 48.01rem)');
    if (wide && wide.addEventListener) wide.addEventListener('change', (e) => { if (e.matches) setOpen(false); });
  }
  document.body.insertAdjacentHTML('beforeend', `<footer class="site-footer"><div class="container row spread"><span>© ${new Date().getFullYear()} Gatepass. Tickets for events people love.</span><span>Secure payments · Instant QR tickets</span></div></footer>`);
})();
