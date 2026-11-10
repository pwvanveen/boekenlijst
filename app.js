'use strict';

/* =========================================================
   Boekenlijst – fase 1 (MVP) + 2a (barcode scannen) + 2b (covers)
   + 2c (sorteren en filteren) + 2d (tabblad Delen)
   + 2e (delen als tekst, kopiëren, PDF / afdrukken)
   + 2f (naamgeving en iconen, B28/B29) + 2h (instellingen en thema, B32/B33)
   Inloggen (magic link), zoeken (Google Books → Open Library),
   toevoegen, status/datums, lijsten Bezig / Leeslijst / Gelezen per jaar,
   ISBN-barcode scannen met de camera (BarcodeDetector, met polyfill),
   covers trapsgewijs (Google → Open Library op ISBN → eigen foto, B18),
   sorteren en filteren per lijst via een icoon en een onderpaneel (B19, B20),
   tijdelijke deellijst samenstellen en opschonen (B22, B23),
   deellijst delen via het deelmenu, klembord of afdrukweergave (B24–B26).
   Naamgeving (B28): status 'wil_lezen' heet in de interface "Leeslijst", het
   tabblad 'zoeken' heet "Toevoegen". Interne waarden en opslagsleutels blijven.
   Iconen (B29): Tabler Icons (outline, MIT) als inline SVG-sprite in index.html.
   Instellingen (B32): tandwiel in de kopbalk opent het onderpaneel (modus
   'settings') met account, thema, uitloggen en versienummer.
   Thema (B33): Systeem / Licht / Donker per toestel in localStorage; een inline
   script in <head> zet data-theme vóór de eerste weergave.
   Kobo-import (fase 3a, B36–B39): CSV uit DB Browser for SQLite, alleen in de
   browser gelezen; voorvertoning, dubbelen, opslaan in batches, ongedaan maken.
   ========================================================= */

// Voor het vangnet in index.html: app.js is gestart
window.__appStarted = true;

// Polyfill voor BarcodeDetector (ZXing-WASM). Alleen geladen als de browser
// zelf geen BarcodeDetector met EAN-13 heeft. Versie vastgezet (B11).
const BARCODE_POLYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/es/ponyfill.js';

// Maximale wachttijd op het ophalen van de sessie bij het opstarten
const SESSION_TIMEOUT_MS = 10000;

// Eigen covers (B18): Supabase Storage-bucket en fotoformaat
const COVER_BUCKET = 'covers';
const COVER_MAX_W = 600;
const COVER_MAX_H = 1000;
const COVER_QUALITY = 0.8;
const COVER_MAX_BYTES = 1024 * 1024; // gelijk aan de bucketlimiet

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: {
    // 'implicit' zodat de inloglink ook werkt als de mail in een andere browser opent
    flowType: 'implicit',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

const STATUS = { wil_lezen: 'Leeslijst', bezig: 'Bezig', gelezen: 'Gelezen', gestopt: 'Gestopt' };
const SOURCE = { google: 'Google Books', openlibrary: 'Open Library', handmatig: 'handmatig', kobo: 'Kobo' };

const state = {
  user: null,
  books: [],
  booksLoaded: false, // eerste keer laden gelukt (Delen wacht hierop)
  results: [],
  lastQuery: '',
  editing: null,
  // Cover-wijziging in het open venster: { url } = gevonden via Open Library,
  // { blob, preview } = eigen foto (wordt pas bij Opslaan geüpload)
  coverDraft: null,
  openYears: new Set([String(new Date().getFullYear())]),
  // Fase 2c: per tabblad sortering + filters (views), en jaargroepen die je
  // tijdens filteren zelf hebt dichtgeklapt
  views: null,
  closedFiltered: new Set()
};

/* ---------- Hulpfuncties ---------- */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000) + 1;
}

function stars(n) {
  return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '';
}

// Lijnicoon uit de sprite in index.html (B29). Altijd decoratief: de knop
// zelf heeft tekst of een aria-label.
function icon(name, size = 20) {
  return `<svg class="i" width="${size}" height="${size}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

function authorsText(a) {
  return (a || []).join(', ');
}

// Melding onderin. Optioneel met actieknop: toast(tekst, { action, onAction, duration })
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.append(span);
  if (opts.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.action;
    btn.addEventListener('click', () => {
      clearTimeout(toast.timer);
      t.classList.remove('show', 'has-action');
      opts.onAction?.();
    });
    t.append(btn);
  }
  t.classList.toggle('has-action', !!opts.action);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show', 'has-action'), opts.duration || 2800);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

// NL-titels komen vaak binnen als "Titel / druk 1" (Google Books, Kobo)
function stripDruk(t) {
  return String(t ?? '').replace(/\s*\/\s*druk\s*\d+\s*$/i, '').trim();
}

function isIsbn(q) {
  const d = q.replace(/[-\s]/g, '');
  return /^(\d{9}[\dXx]|\d{13})$/.test(d) ? d.toUpperCase() : null;
}

/* ---------- Inloggen ---------- */

function showLoginMsg(text, isError = false) {
  const m = $('#login-msg');
  m.textContent = text;
  m.classList.toggle('error', isError);
}

async function initAuth() {
  // Foutmelding uit een verlopen/ongeldige inloglink tonen
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_description')) {
    showLoginMsg('Inloggen mislukt: ' + hash.get('error_description') + '. Vraag een nieuwe link aan.', true);
    history.replaceState(null, '', location.pathname);
  }

  sb.auth.onAuthStateChange((_event, session) => {
    // setTimeout: geen Supabase-aanroepen direct binnen deze callback
    setTimeout(() => setUser(session?.user ?? null), 0);
  });

  let data;
  try {
    ({ data } = await withTimeout(sb.auth.getSession(), SESSION_TIMEOUT_MS, 'time-out'));
  } catch (err) {
    console.error('Sessie ophalen mislukt:', err);
    // Intussen alsnog ingelogd via onAuthStateChange? Dan niets tonen.
    if (state.user) return;
    showStartError(err.message === 'time-out'
      ? 'De verbinding met de server duurt te lang. Controleer je internetverbinding en probeer opnieuw.'
      : 'Opstarten mislukt: ' + err.message);
    return;
  }
  setUser(data.session?.user ?? null);
}

function showStartError(text) {
  $('#view-loading').innerHTML = `<div class="card start-error">
      <p>${esc(text)}</p>
      <button type="button" class="primary" id="btn-retry">Opnieuw proberen</button>
    </div>`;
  $('#btn-retry').addEventListener('click', () => location.reload());
}

function setUser(user) {
  const changed = (user?.id ?? null) !== (state.user?.id ?? null);
  state.user = user;

  $('#view-loading').hidden = true;
  $('#view-login').hidden = !!user;
  $('#view-app').hidden = !user;
  $('#tabbar').hidden = !user;
  $('#btn-settings').hidden = !user;
  if (!user && sheet.open && sheet.mode === 'settings') closeSheet(); // elders uitgelogd
  if (!user && kobo.active) koboClose(); // importscherm (fase 3a)

  if (!changed) return;
  resetViews(); // filters leeg, sortering van deze gebruiker (B20)
  state.booksLoaded = false;
  loadShare();  // deellijst van déze gebruiker (B23)
  if (user) {
    loadBooks();
  } else {
    state.books = [];
    render();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  if (!email) return;
  const btn = $('#login-btn');
  btn.disabled = true;
  showLoginMsg('Bezig met versturen…');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: CONFIG.REDIRECT_URL }
  });
  btn.disabled = false;
  if (error) {
    showLoginMsg('Versturen mislukt: ' + error.message, true);
  } else {
    showLoginMsg('Controleer je mail en tik op de inloglink. Je kunt dit venster sluiten.');
  }
});

$('#btn-settings').addEventListener('click', () => openSettingsSheet());

/* ---------- Instellingen en thema (fase 2h, B32/B33) ---------- */

const THEME_KEY = 'boekenlijst.theme';
const THEME_COLOR = { light: '#f6f4ef', dark: '#161917' };
const THEMES = [
  ['system', 'Systeem', 'device-mobile'],
  ['light', 'Licht', 'sun'],
  ['dark', 'Donker', 'moon']
];

function getTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch (_) { /* geblokkeerd: standaard */ }
  return t === 'light' || t === 'dark' ? t : 'system';
}

// Zelfde werking als het inline script in <head>, maar dan tijdens gebruik
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  // Statusbalk: bij Systeem elke tag zijn eigen kleur (media), anders beide gelijk
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const ownColor = (m.getAttribute('media') || '').includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light;
    m.setAttribute('content', THEME_COLOR[t] || ownColor);
  });
}

function setTheme(t) {
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch (_) { /* geblokkeerd: geldt dan alleen tot herladen */ }
  applyTheme(t);
}

// Versienummer van deze levering = ?v= van app.js (staat in index.html)
function appVersion() {
  const src = document.querySelector('script[src*="app.js"]')?.getAttribute('src') || '';
  return new URLSearchParams(src.split('?')[1] || '').get('v') || '';
}

function openSettingsSheet() {
  if (sheet.open || !state.user) return;
  sheet.mode = 'settings';
  sheet.list = null;
  $('#sheet-title').textContent = 'Instellingen';
  $('#sheet-sub').textContent = '';
  $('#sheet-clear').hidden = true;
  $('#sheet-done').textContent = 'Sluiten';
  sheet.open = true;
  renderSettingsSheet();
  showSheetPanel();
}

function renderSettingsSheet() {
  const cur = getTheme();
  const v = appVersion();
  $('#sheet-body').innerHTML = `
    <h3>Account</h3>
    <p class="set-account">Ingelogd als
      <span class="set-email" title="${esc(state.user?.email ?? '')}">${esc(state.user?.email ?? '')}</span></p>
    <h3 id="set-theme">Thema</h3>
    <div class="theme-seg" role="radiogroup" aria-labelledby="set-theme">${
      THEMES.map(([val, label, ic]) =>
        `<button type="button" role="radio" aria-checked="${val === cur}" data-theme-choice="${val}">${icon(ic)}<span>${label}</span></button>`
      ).join('')}</div>
    <h3>Importeren</h3>
    <button type="button" class="btn-import" data-settings="import">${icon('file-import')}<span>Importeren van Kobo</span></button>
    <h3>Uitloggen</h3>
    <button type="button" class="btn-logout" data-settings="logout">${icon('logout')}<span>Uitloggen</span></button>
    ${v ? `<p class="set-version">Versie ${esc(v)}</p>` : ''}`;
}

async function onSettingsClick(e) {
  const choice = e.target.closest('[data-theme-choice]')?.dataset.themeChoice;
  if (choice) {
    setTheme(choice);
    $('#sheet-body').querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice));
    });
    return;
  }
  if (e.target.closest('[data-settings="import"]')) { koboOpen(); return; }
  if (e.target.closest('[data-settings="logout"]')) {
    const btn = e.target.closest('button');
    btn.disabled = true;
    const { error } = await sb.auth.signOut();
    btn.disabled = false;
    if (error) { toast('Uitloggen mislukt: ' + error.message); return; }
    closeSheet();
    showTab('bezig');
  }
}

/* ---------- Gegevens laden ---------- */

async function loadBooks() {
  const { data, error } = await sb.from('books').select('*').order('updated_at', { ascending: false });
  if (error) {
    toast('Laden mislukt: ' + error.message);
    return;
  }
  state.books = data || [];
  state.booksLoaded = true;
  render();
}

/* ---------- Tabbladen ---------- */

function showTab(tab) {
  if (scan.active) closeScanner();
  if (sheet.open) closeSheet();
  document.querySelectorAll('.tab').forEach((el) => { el.hidden = el.dataset.tab !== tab; });
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  if (tab === 'zoeken' && !state.results.length) setTimeout(() => $('#search-q').focus(), 50);
}

document.querySelectorAll('#tabbar button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- Weergave ---------- */

// Placeholder zonder cover: titel en auteur op een gekleurd "boekje".
// De kleur hangt af van de titel, dus blijft per boek gelijk.
function placeholderHtml(b) {
  const title = (b.title || '').trim() || 'Zonder titel';
  let h = 0;
  for (const c of title) h = (h * 31 + c.codePointAt(0)) % 360;
  const author = (b.authors || [])[0] || '';
  return `<div class="cover cover-empty" style="--hue:${h}" aria-hidden="true">
    <span class="ph-title">${esc(title)}</span>
    ${author ? `<span class="ph-author">${esc(author)}</span>` : ''}
  </div>`;
}

function coverHtml(b) {
  return b.cover_url
    ? `<img class="cover" src="${esc(b.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
         data-title="${esc(b.title || '')}" data-author="${esc((b.authors || [])[0] || '')}">`
    : placeholderHtml(b);
}

// Cover die niet laadt (link verlopen, bron weg) → placeholder i.p.v. kapot plaatje
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover')) return;
  const ph = document.createElement('div');
  ph.innerHTML = placeholderHtml({ title: img.dataset.title, authors: img.dataset.author ? [img.dataset.author] : [] });
  img.replaceWith(ph.firstElementChild);
}, true);

// Klein e-reader-icoon vooraan in de metaregel (fase 2i, B34)
const EREADER_MARK = `<span class="ereader-mark" role="img" aria-label="Op e-reader" title="Op e-reader">${icon('device-tablet', 16)}</span>`;

function bookLi(b, metaHtml = '') {
  // Alleen in Bezig, Leeslijst en Gelezen; de deellijst heeft een eigen opbouw
  if (b.ereader) metaHtml = EREADER_MARK + metaHtml;
  return `<li class="book" data-id="${esc(b.id)}">
    ${coverHtml(b)}
    <div class="info">
      <div class="title">${esc(b.title)}</div>
      <div class="authors">${esc(authorsText(b.authors))}</div>
      ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ''}
    </div>
  </li>`;
}

function emptyLi(text) {
  return `<li class="empty">${esc(text)}</li>`;
}

function metaRead(b) {
  const parts = [];
  if (b.date_finished) parts.push(esc(fmtDate(b.date_finished)));
  if (b.date_started && b.date_finished) {
    const d = daysBetween(b.date_started, b.date_finished);
    if (d > 0) parts.push(`${d} ${d === 1 ? 'dag' : 'dagen'}`);
  }
  if (b.pages) parts.push(`${b.pages} blz.`);
  if (b.rating) parts.push(`<span class="stars">${stars(b.rating)}</span>`);
  return parts.join(' · ');
}

const LIST_SEL = { bezig: '#list-bezig', wil_lezen: '#list-wil' };

// Boeken die in een tabblad thuishoren (zonder filters)
function baseBooks(list) {
  const statuses = LISTS[list].statuses;
  return state.books.filter((b) => statuses.includes(b.status));
}

function metaBezig(b) {
  return [
    b.date_started ? `Begonnen ${esc(fmtDate(b.date_started))}` : '',
    b.pages ? `${b.pages} blz.` : ''
  ].filter(Boolean).join(' · ');
}

function metaWil(b) {
  return [
    b.published_year ? esc(b.published_year) : '',
    b.pages ? `${b.pages} blz.` : ''
  ].filter(Boolean).join(' · ');
}

function noMatchHtml(list, tag = 'li') {
  return `<${tag} class="empty">Geen boeken die aan je filters voldoen.<br>
    <button type="button" class="link" data-action="clear-filters" data-list="${list}">Wissen</button></${tag}>`;
}

function render() {
  renderSimpleList('bezig', metaBezig,
    'Je bent nu niets aan het lezen. Voeg een boek toe via “Toevoegen”, of zet een boek uit je “Leeslijst” op Bezig.');
  renderSimpleList('wil_lezen', metaWil,
    'Je leeslijst is leeg. Voeg boeken toe via “Toevoegen”.');
  renderGelezen();
  renderShare();

  // Tellers in de tabbalk: altijd zonder filters
  const counts = {
    bezig: baseBooks('bezig').length,
    wil_lezen: baseBooks('wil_lezen').length,
    gelezen: state.books.filter((b) => b.status === 'gelezen').length
  };
  document.querySelectorAll('[data-count]').forEach((el) => {
    const n = counts[el.dataset.count];
    el.textContent = n ? String(n) : '';
  });

  if (sheet.open) updateSheetSummary();
}

function renderSimpleList(list, metaFn, emptyText) {
  const all = baseBooks(list);
  const shown = sortBooks(list, applyFilters(list, all));
  updateListChrome(list, all.length, shown.length);
  $(LIST_SEL[list]).innerHTML = !all.length
    ? emptyLi(emptyText)
    : shown.length ? shown.map((b) => bookLi(b, metaFn(b))).join('') : noMatchHtml(list);
}

function renderGelezen() {
  const list = 'gelezen';
  const all = baseBooks(list);
  const shown = applyFilters(list, all);
  const filtering = filtersActive(list);
  updateListChrome(list, all.length, shown.length);

  const read = shown.filter((b) => b.status === 'gelezen');
  const stopped = sortBooks(list, shown.filter((b) => b.status === 'gestopt'));

  const groups = new Map();
  for (const b of read) {
    const y = b.date_finished ? b.date_finished.slice(0, 4) : 'zonder';
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(b);
  }
  // Jaargroepen blijven: nieuwste jaar bovenaan, sortering geldt binnen elke groep
  const years = [...groups.keys()].sort((a, b) =>
    a === 'zonder' ? 1 : b === 'zonder' ? -1 : b.localeCompare(a));

  // Zonder filter: als geen enkel jaar openstaat, het meest recente openen.
  // Met filter: alle groepen met treffers open, tenzij je er zelf een dichtklapt.
  if (!filtering && years.length && !years.some((y) => state.openYears.has(y))) state.openYears.add(years[0]);
  const isOpen = (y) => (filtering ? !state.closedFiltered.has(y) : state.openYears.has(y));

  let html = '';
  if (!all.length) html = '<p class="empty">Nog geen gelezen boeken. Zet een boek op “Gelezen” om het hier te zien.</p>';
  else if (!shown.length) html = noMatchHtml(list, 'p');

  // Indeling: per jaar (standaard) of één lijst zonder jaargroepen
  const grouped = getView(list).sort.grouped !== false;
  document.querySelector('.tab[data-tab="gelezen"] h2').textContent = grouped ? 'Gelezen per jaar' : 'Gelezen';

  if (!grouped && read.length) {
    const items = sortBooks(list, read);
    const pages = items.reduce((s, b) => s + (b.pages || 0), 0);
    html += `<p class="flat-summary">${items.length} ${items.length === 1 ? 'boek' : 'boeken'}${pages ? ` · ${pages.toLocaleString('nl-NL')} blz.` : ''}</p>
      <ul class="booklist" id="gelezen-flat">${items.map((b) => bookLi(b, metaRead(b))).join('')}</ul>`;
  }

  for (const y of grouped ? years : []) {
    const items = sortBooks(list, groups.get(y));
    const pages = items.reduce((s, b) => s + (b.pages || 0), 0); // totalen van de gefilterde set
    const label = y === 'zonder' ? 'Zonder einddatum' : y;
    html += `<details class="year" data-year="${esc(y)}" ${isOpen(y) ? 'open' : ''}>
      <summary>
        <span class="year-label">${esc(label)}</span>
        <span class="year-stats">${items.length} ${items.length === 1 ? 'boek' : 'boeken'}${pages ? ` · ${pages.toLocaleString('nl-NL')} blz.` : ''}</span>
      </summary>
      <ul class="booklist">${items.map((b) => bookLi(b, metaRead(b))).join('')}</ul>
    </details>`;
  }

  if (stopped.length) {
    html += `<details class="year" data-year="gestopt" ${isOpen('gestopt') ? 'open' : ''}>
      <summary>
        <span class="year-label">Gestopt</span>
        <span class="year-stats">${stopped.length} ${stopped.length === 1 ? 'boek' : 'boeken'}</span>
      </summary>
      <ul class="booklist">${stopped.map((b) => bookLi(b, b.rating ? `<span class="stars">${stars(b.rating)}</span>` : '')).join('')}</ul>
    </details>`;
  }

  const el = $('#gelezen');
  el.innerHTML = html;
  el.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => {
    if (!d.isConnected) return; // oude weergave, al vervangen
    const y = d.dataset.year;
    if (filtersActive(list)) {
      if (d.open) state.closedFiltered.delete(y); else state.closedFiltered.add(y);
    } else if (d.open) state.openYears.add(y);
    else state.openYears.delete(y);
  }));
}

/* ---------- Sorteren en filteren (fase 2c, B19/B20) ---------- */

// Per tabblad: welke statussen erin staan en welk datumveld "datum" betekent
const LISTS = {
  bezig:     { title: 'Bezig',            statuses: ['bezig'],              dateField: 'date_started',  dateLabel: 'Startdatum' },
  wil_lezen: { title: 'Leeslijst',        statuses: ['wil_lezen'],          dateField: 'created_at',    dateLabel: 'Datum toegevoegd' },
  gelezen:   { title: 'Gelezen per jaar', statuses: ['gelezen', 'gestopt'], dateField: 'date_finished', dateLabel: 'Einddatum' }
};

const SORT_FIELDS = ['datum', 'titel', 'auteur', 'paginas', 'waardering'];
const SORT_LABEL = { titel: 'Titel', auteur: 'Auteur', paginas: "Pagina's", waardering: 'Waardering' };
// Richting die het meest voor de hand ligt bij het kiezen van een veld
const SORT_NATURAL_DIR = { datum: 'desc', titel: 'asc', auteur: 'asc', paginas: 'desc', waardering: 'desc' };
const SORT_DIR_LABEL = {
  datum:      { desc: 'Nieuwste eerst', asc: 'Oudste eerst' },
  titel:      { asc: 'A → Z', desc: 'Z → A' },
  auteur:     { asc: 'A → Z', desc: 'Z → A' },
  paginas:    { desc: 'Meeste eerst', asc: 'Minste eerst' },
  waardering: { desc: 'Hoogste eerst', asc: 'Laagste eerst' }
};
const DEFAULT_SORT = { field: 'datum', dir: 'desc' };
const UNKNOWN_LANG = '?';

const collator = new Intl.Collator('nl', { sensitivity: 'base' });

function emptyFilters() {
  return { text: '', author: '', rating: 0, lang: '', year: '', ereader: '' }; // ereader: '' / 'ja' / 'nee'
}

function newViews() {
  const v = {};
  for (const list of Object.keys(LISTS)) v[list] = { sort: loadSort(list), filters: emptyFilters() };
  return v;
}

function getView(list) {
  if (!state.views) state.views = newViews();
  return state.views[list];
}

// Bij een andere gebruiker (of uitloggen): filters leeg, sortering van die gebruiker
function resetViews() {
  state.views = newViews();
  state.closedFiltered.clear();
}

/* Sortering bewaren per gebruiker + lijst (B20). localStorage kan ontbreken of
   weigeren (privévenster, geblokkeerde opslag): dan gewoon de standaard. */
function sortStorageKey(list) {
  return `boekenlijst.sort.${state.user?.id || 'anon'}.${list}`;
}

function loadSort(list) {
  try {
    const v = JSON.parse(localStorage.getItem(sortStorageKey(list)) || 'null');
    if (v && SORT_FIELDS.includes(v.field) && (v.dir === 'asc' || v.dir === 'desc')) {
      return { field: v.field, dir: v.dir, grouped: v.grouped !== false };
    }
  } catch (_) { /* standaard gebruiken */ }
  return { ...DEFAULT_SORT, grouped: true }; // grouped: alleen gebruikt in Gelezen per jaar
}

function saveSort(list) {
  try { localStorage.setItem(sortStorageKey(list), JSON.stringify(getView(list).sort)); } catch (_) { /* niet erg */ }
}

// Hoofdletter- en accentongevoelig vergelijken: "Émile" → "emile"
function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/* Taalcodes gelijktrekken: Google geeft "nl"/"en", Open Library "dut"/"eng" (MARC). */
const LANG_ALIASES = {
  dut: 'nl', nld: 'nl', eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it',
  por: 'pt', swe: 'sv', dan: 'da', nor: 'no', nob: 'nb', nno: 'nn', fin: 'fi', ice: 'is', isl: 'is',
  fry: 'fy', fri: 'fy', afr: 'af', pol: 'pl', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', slv: 'sl',
  hun: 'hu', rum: 'ro', ron: 'ro', bul: 'bg', rus: 'ru', ukr: 'uk', gre: 'el', ell: 'el', tur: 'tr',
  ara: 'ar', heb: 'he', per: 'fa', fas: 'fa', hin: 'hi', chi: 'zh', zho: 'zh', jpn: 'ja', kor: 'ko',
  vie: 'vi', tha: 'th', ind: 'id', may: 'ms', msa: 'ms', lat: 'la', cat: 'ca', baq: 'eu', eus: 'eu',
  glg: 'gl', wel: 'cy', cym: 'cy', gle: 'ga', hrv: 'hr', srp: 'sr', est: 'et', lav: 'lv', lit: 'lt',
  epo: 'eo', ltz: 'lb',
  iw: 'he', in: 'id', ji: 'yi',          // oude ISO-codes (komen bij Google soms voor)
  und: null, zxx: null                    // onbepaald / geen taal → Onbekend
};

function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim().toLowerCase().split(/[-_]/)[0];
  if (Object.prototype.hasOwnProperty.call(LANG_ALIASES, c)) return LANG_ALIASES[c];
  return /^[a-z]{2,3}$/.test(c) ? c : null;
}

let langNames = null;
function langName(code) {
  if (!code || code === UNKNOWN_LANG) return 'Onbekend';
  let name = null;
  try {
    langNames = langNames || new Intl.DisplayNames(['nl'], { type: 'language' });
    name = langNames.of(code);
  } catch (_) { /* oude browser of ongeldige code */ }
  if (!name || name.toLowerCase() === code) return code.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function filtersActive(list) {
  const f = getView(list).filters;
  return !!(f.text.trim() || f.author || f.rating || f.lang || f.year || f.ereader);
}

// Alle filters combineren met EN
function applyFilters(list, books) {
  const f = getView(list).filters;
  const words = fold(f.text).split(/\s+/).filter(Boolean);
  return books.filter((b) => {
    if (words.length) {
      const hay = fold(`${b.title || ''} ${authorsText(b.authors)}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    if (f.author && !(b.authors || []).some((a) => fold(a) === f.author)) return false;
    if (f.rating && !(b.rating >= f.rating)) return false; // zonder waardering valt weg
    if (f.lang && (normalizeLang(b.language) || UNKNOWN_LANG) !== f.lang) return false;
    // Jaarfilter: alleen gelezen boeken uit dat jaar (Zonder einddatum en Gestopt vallen weg)
    if (f.year && !(b.status === 'gelezen' && (b.date_finished || '').slice(0, 4) === f.year)) return false;
    // E-reader (B34): wel / niet gemarkeerd
    if (f.ereader === 'ja' && !b.ereader) return false;
    if (f.ereader === 'nee' && b.ereader) return false;
    return true;
  });
}

function sortValue(list, field, b) {
  switch (field) {
    case 'datum':
      if (list === 'delen') return shareDate(b); // fase 2j: datum die bij het label hoort
      // Gestopte boeken hebben vaak geen einddatum: dan de startdatum
      if (list === 'gelezen' && b.status === 'gestopt') return b.date_finished || b.date_started;
      return b[LISTS[list].dateField];
    case 'titel': return b.title;
    case 'auteur': return (b.authors || [])[0];
    case 'paginas': return b.pages;
    case 'waardering': return b.rating;
    default: return null;
  }
}

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && !v.trim());
}

// sort: standaard de gekozen sortering van de lijst; Delen geeft de standaardsortering mee
function sortBooks(list, books, sort = getView(list).sort) {
  const { field, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;
  const isText = field === 'titel' || field === 'auteur';
  return [...books].sort((a, b) => {
    const va = sortValue(list, field, a);
    const vb = sortValue(list, field, b);
    const ea = isBlank(va);
    const eb = isBlank(vb);
    // Lege waarden altijd onderaan, ongeacht de richting
    if (ea !== eb) return ea ? 1 : -1;
    let c = 0;
    if (!ea) {
      if (isText) c = collator.compare(va, vb);
      else if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
      else c = va < vb ? -1 : va > vb ? 1 : 0; // datums als tekst (JJJJ-MM-DD)
    }
    if (c) return c * sign;
    // Gelijk: op titel, daarna vast op id (stabiele volgorde)
    return collator.compare(a.title || '', b.title || '') || String(a.id).localeCompare(String(b.id));
  });
}

// Wat er in déze lijst te kiezen valt
function filterOptions(list, books) {
  const f = getView(list).filters;

  const authors = new Map(); // gevouwen naam → weergave (eerste schrijfwijze)
  for (const b of books) {
    for (const a of b.authors || []) {
      const t = String(a).trim();
      if (t && !authors.has(fold(t))) authors.set(fold(t), t);
    }
  }
  if (f.author && !authors.has(f.author)) authors.set(f.author, f.author);

  const langs = new Map();
  for (const b of books) {
    const c = normalizeLang(b.language) || UNKNOWN_LANG;
    if (!langs.has(c)) langs.set(c, langName(c));
  }
  if (f.lang && !langs.has(f.lang)) langs.set(f.lang, langName(f.lang));

  const ratings = new Set(books.map((b) => b.rating || 0));

  const years = [...new Set(books
    .filter((b) => b.status === 'gelezen' && b.date_finished)
    .map((b) => b.date_finished.slice(0, 4)))];
  if (f.year && !years.includes(f.year)) years.push(f.year);
  years.sort((a, b) => b.localeCompare(a));
  const ereaderKinds = new Set(books.map((b) => !!b.ereader));
  const otherGroups = books.some((b) => b.status === 'gestopt' || (b.status === 'gelezen' && !b.date_finished));

  const byName = (a, b) => collator.compare(a[1], b[1]);
  return {
    authors: [...authors].sort(byName),
    langs: [...langs].sort((a, b) =>
      a[0] === UNKNOWN_LANG ? 1 : b[0] === UNKNOWN_LANG ? -1 : byName(a, b)),
    years,
    // Een filter alleen tonen als er iets te kiezen valt (of als hij aan staat)
    show: {
      author: authors.size >= 2 || !!f.author,
      rating: ratings.size >= 2 || !!f.rating,
      lang: langs.size >= 2 || !!f.lang,
      year: list === 'gelezen' && (years.length >= 2 || (years.length === 1 && otherGroups) || !!f.year),
      ereader: ereaderKinds.size >= 2 || !!f.ereader // alleen als de lijst beide soorten bevat
    }
  };
}

// Sorteericoon, stipje en regel "x van y boeken · Wissen" bij een lijst
function updateListChrome(list, total, shown) {
  const active = filtersActive(list);
  const btn = document.querySelector(`.sort-btn[data-sheet="${list}"]`);
  btn.hidden = total === 0;
  btn.classList.toggle('active', active);
  btn.querySelector('.sort-dot').hidden = !active;
  btn.setAttribute('aria-label', active ? 'Sorteren en filteren (filter actief)' : 'Sorteren en filteren');

  const bar = document.querySelector(`[data-filterbar="${list}"]`);
  bar.hidden = !active || total === 0;
  bar.innerHTML = bar.hidden ? '' : `${shown} van ${total} ${total === 1 ? 'boek' : 'boeken'} ·
    <button type="button" class="link" data-action="clear-filters" data-list="${list}">Wissen</button>`;
}

function setFilter(list, key, value) {
  getView(list).filters[key] = value;
  state.closedFiltered.clear(); // nieuwe filter: alle groepen met treffers weer open
  render();
}

function clearFilters(list) {
  getView(list).filters = emptyFilters();
  state.closedFiltered.clear();
  render();
  if (sheet.open && sheet.list === list) renderSheet();
}

document.addEventListener('click', (e) => {
  const clr = e.target.closest('[data-action="clear-filters"]');
  if (clr) { clearFilters(clr.dataset.list); return; }
  const sortBtn = e.target.closest('.sort-btn[data-sheet]');
  if (sortBtn) openSheet(sortBtn.dataset.sheet);
});

/* ---------- Onderpaneel ---------- */

// Eén onderpaneel voor drie doelen: sorteren/filteren (mode 'filter', fase 2c),
// het deelvenster van de deellijst (mode 'share', fase 2e) en de instellingen
// (mode 'settings', fase 2h)
const sheet = {
  open: false,
  mode: 'filter',
  list: null,
  pushedHistory: false,
  opener: null,
  hideTimer: null,
  drag: null
};
const sheetEl = $('#sheet');
const sheetBackdrop = $('#sheet-backdrop');

function chipsHtml(group, items, labelledBy, extraClass = '') {
  return `<div class="chips ${extraClass}" role="radiogroup" ${labelledBy ? `aria-labelledby="${labelledBy}"` : ''}>${
    items.map(([value, label, checked]) =>
      `<button type="button" role="radio" aria-checked="${checked}" data-group="${group}" data-value="${esc(value)}">${esc(label)}</button>`
    ).join('')}</div>`;
}

function renderSheet() {
  const list = sheet.list;
  const v = getView(list);
  const f = v.filters;
  const opts = filterOptions(list, baseBooks(list));

  const fields = SORT_FIELDS.map((k) => [k, k === 'datum' ? LISTS[list].dateLabel : SORT_LABEL[k], v.sort.field === k]);
  const dirLabels = SORT_DIR_LABEL[v.sort.field];
  const first = SORT_NATURAL_DIR[v.sort.field];
  const second = first === 'asc' ? 'desc' : 'asc';
  const dirs = [first, second].map((d) => [d, dirLabels[d], v.sort.dir === d]);

  let h = `<h3 id="sh-sort">Sorteren</h3>
    ${chipsHtml('sort-field', fields, 'sh-sort')}
    ${chipsHtml('sort-dir', dirs, 'sh-sort')}
    ${list === 'gelezen' ? `<label id="sh-group">Indeling</label>${chipsHtml('grouping', [
      ['jaar', 'Per jaar', v.sort.grouped !== false],
      ['lijst', 'Eén lijst', v.sort.grouped === false]
    ], 'sh-group')}` : ''}
    <h3>Filteren</h3>
    <label for="flt-text">Tekst</label>
    <input type="search" id="flt-text" value="${esc(f.text)}" placeholder="Zoek in titel of auteur"
           autocomplete="off" enterkeyhint="done">`;

  if (opts.show.author) {
    h += `<label for="flt-author">Auteur</label>
      <select id="flt-author" data-filter="author">
        <option value="">Alle auteurs</option>
        ${opts.authors.map(([k, name]) => `<option value="${esc(k)}" ${k === f.author ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>`;
  }
  if (opts.show.rating) {
    const r = [[0, 'Alle'], [1, '1+ ★'], [2, '2+ ★'], [3, '3+ ★'], [4, '4+ ★'], [5, '5 ★']]
      .map(([n, label]) => [n, label, f.rating === n]);
    h += `<label id="flt-rating-label">Waardering (minimaal)</label>${chipsHtml('rating', r, 'flt-rating-label', 'compact')}`;
  }
  if (opts.show.lang) {
    h += `<label for="flt-lang">Taal</label>
      <select id="flt-lang" data-filter="lang">
        <option value="">Alle talen</option>
        ${opts.langs.map(([c, name]) => `<option value="${esc(c)}" ${c === f.lang ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>`;
  }
  if (opts.show.year) {
    h += `<label for="flt-year">Jaar uitgelezen</label>
      <select id="flt-year" data-filter="year">
        <option value="">Alle jaren</option>
        ${opts.years.map((y) => `<option value="${esc(y)}" ${y === f.year ? 'selected' : ''}>${esc(y)}</option>`).join('')}
      </select>`;
  }

  if (opts.show.ereader) {
    const e = [['', 'Alle'], ['ja', 'Op e-reader'], ['nee', 'Niet op e-reader']]
      .map(([val, label]) => [val, label, f.ereader === val]);
    h += `<label id="flt-ereader-label">E-reader</label>${chipsHtml('ereader', e, 'flt-ereader-label')}`;
  }

  const body = $('#sheet-body');
  const scrollTop = body.scrollTop;
  body.innerHTML = h;
  body.scrollTop = scrollTop;
  updateSheetSummary();
}

// Aantallen in kop en knop bijwerken (zonder het paneel opnieuw op te bouwen)
function updateSheetSummary() {
  if (!sheet.open) return;
  if (sheet.mode === 'share') { updateShareSheet(); return; }
  if (sheet.mode === 'settings') return; // vaste inhoud, niets bij te werken
  if (sheet.mode === 'sharesort') { updateShareSortSheet(); return; }
  const list = sheet.list;
  const total = baseBooks(list).length;
  const n = applyFilters(list, baseBooks(list)).length;
  const active = filtersActive(list);
  $('#sheet-sub').textContent = active
    ? `${LISTS[list].title} · ${n} van ${total}`
    : LISTS[list].title;
  $('#sheet-done').textContent = `Toon ${n} ${n === 1 ? 'boek' : 'boeken'}`;
  $('#sheet-clear').disabled = !active;
}

function openSheet(list) {
  if (sheet.open) return;
  sheet.mode = 'filter';
  sheet.list = list;
  $('#sheet-title').textContent = 'Sorteren en filteren';
  $('#sheet-clear').hidden = false;
  sheet.open = true;
  renderSheet();
  showSheetPanel();
}

// Paneel tonen (gedeeld door beide modi): inhoud staat al klaar
function showSheetPanel() {
  clearTimeout(sheet.hideTimer);
  sheet.open = true;
  sheet.opener = document.activeElement;
  $('#sheet-body').scrollTop = 0;
  updateKeyboardOffset();
  sheetEl.style.transform = '';
  sheetEl.hidden = false;
  sheetBackdrop.hidden = false;
  void sheetEl.offsetHeight; // reflow, zodat de schuifanimatie start
  sheetEl.classList.add('open');
  sheetBackdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  sheetEl.focus({ preventScroll: true });

  // Android-terugknop sluit het paneel i.p.v. de app te verlaten
  history.pushState({ sheet: true }, '');
  sheet.pushedHistory = true;
}

// fromPopstate = gesloten via de terugknop
function closeSheet(fromPopstate = false) {
  if (!sheet.open) return;
  sheet.open = false;
  sheet.drag = null;
  if (sheetEl.contains(document.activeElement)) document.activeElement.blur(); // toetsenbord weg
  sheetEl.classList.remove('open', 'dragging');
  sheetEl.style.transform = '';
  sheetBackdrop.classList.remove('open');
  sheetBackdrop.style.opacity = '';
  document.body.style.overflow = '';
  sheet.hideTimer = setTimeout(() => {
    if (sheet.open) return;
    sheetEl.hidden = true;
    sheetBackdrop.hidden = true;
  }, 240);
  if (sheet.opener && sheet.opener.isConnected) {
    try { sheet.opener.focus({ preventScroll: true }); } catch (_) {}
  }
  if (sheet.pushedHistory) {
    sheet.pushedHistory = false;
    if (!fromPopstate) history.back();
  }
}

$('#sheet-done').addEventListener('click', () => closeSheet());
$('#sheet-clear').addEventListener('click', () => { if (sheet.mode === 'filter') clearFilters(sheet.list); });
sheetBackdrop.addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.open) closeSheet(); });
window.addEventListener('popstate', () => { if (sheet.open) closeSheet(true); });

$('#sheet-body').addEventListener('click', (e) => {
  if (sheet.mode === 'share') { onShareSheetClick(e); return; }
  if (sheet.mode === 'settings') { onSettingsClick(e); return; }
  if (sheet.mode === 'sharesort') { onShareSortClick(e); return; }
  const btn = e.target.closest('button[data-group]');
  if (!btn || !sheet.open) return;
  const list = sheet.list;
  const v = getView(list);
  const value = btn.dataset.value;
  if (btn.dataset.group === 'sort-field') {
    if (v.sort.field === value) return;
    v.sort = { ...v.sort, field: value, dir: SORT_NATURAL_DIR[value] };
    saveSort(list);
    render();
  } else if (btn.dataset.group === 'grouping') {
    v.sort.grouped = value === 'jaar';
    saveSort(list);
    render();
  } else if (btn.dataset.group === 'sort-dir') {
    v.sort.dir = value;
    saveSort(list);
    render();
  } else if (btn.dataset.group === 'rating') {
    setFilter(list, 'rating', Number(value));
  } else if (btn.dataset.group === 'ereader') {
    setFilter(list, 'ereader', value);
  }
  renderSheet();
});

$('#sheet-body').addEventListener('change', (e) => {
  if (sheet.mode !== 'filter') { if (sheet.mode === 'share') onShareSheetChange(e); return; }
  const key = e.target.dataset?.filter;
  if (key && sheet.open) setFilter(sheet.list, key, e.target.value);
});

$('#sheet-body').addEventListener('input', (e) => {
  if (sheet.mode !== 'filter') return;
  if (e.target.id === 'flt-text' && sheet.open) setFilter(sheet.list, 'text', e.target.value);
});

$('#sheet-body').addEventListener('keydown', (e) => {
  if (e.target.id === 'flt-text' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});

// Schermtoetsenbord: paneel boven het toetsenbord houden
function updateKeyboardOffset() {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  sheetEl.style.setProperty('--kb', kb + 'px');
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { if (sheet.open) updateKeyboardOffset(); });
  window.visualViewport.addEventListener('scroll', () => { if (sheet.open) updateKeyboardOffset(); });
}

// Veeg omlaag om te sluiten (vanaf de greep/kop, of in de inhoud als die bovenaan staat)
sheetEl.addEventListener('touchstart', (e) => {
  if (!sheet.open || e.touches.length !== 1) return;
  if (e.target.closest('input, select, textarea')) return;
  const body = $('#sheet-body');
  const inBody = body.contains(e.target);
  if (inBody && body.scrollTop > 0) return;
  sheet.drag = { y0: e.touches[0].clientY, t0: Date.now(), dy: 0, active: false };
}, { passive: true });

sheetEl.addEventListener('touchmove', (e) => {
  const d = sheet.drag;
  if (!d) return;
  d.dy = e.touches[0].clientY - d.y0;
  if (!d.active) {
    if (d.dy < -4) { sheet.drag = null; return; } // omhoog = gewoon scrollen
    if (d.dy < 8) return;
    d.active = true;
    sheetEl.classList.add('dragging');
  }
  e.preventDefault();
  const dy = Math.max(0, d.dy);
  sheetEl.style.transform = `translateY(${dy}px)`;
  sheetBackdrop.style.opacity = String(Math.max(0, 1 - dy / (sheetEl.offsetHeight || 1)));
}, { passive: false });

function endDrag() {
  const d = sheet.drag;
  sheet.drag = null;
  if (!d || !d.active) return;
  sheetEl.classList.remove('dragging');
  const fast = d.dy > 30 && d.dy / Math.max(1, Date.now() - d.t0) > 0.5;
  if (d.dy > Math.min(120, sheetEl.offsetHeight * 0.25) || fast) {
    closeSheet();
  } else {
    sheetEl.style.transform = '';
    sheetBackdrop.style.opacity = '';
  }
}
sheetEl.addEventListener('touchend', endDrag);
sheetEl.addEventListener('touchcancel', endDrag);

// Tik op een boek in een lijst → bewerken
document.addEventListener('click', (e) => {
  const li = e.target.closest('li.book[data-id]');
  if (!li) return;
  const b = state.books.find((x) => x.id === li.dataset.id);
  if (b) openDialog(b);
});

/* ---------- Delen (fase 2d, B22/B23) ----------
   Tijdelijke deellijst: samenstellen uit eigen boeken (stap 1) en opschonen
   (stap 2). Alleen boek-id's + keuzes op het toestel; verandert niets aan de
   echte lijsten. Daadwerkelijk delen volgt later (B24). */

const SHARE_SOURCES = ['bezig', 'wil_lezen', 'gelezen'];
const SHARE_UNDO_MS = 5000;

const share = {
  saved: null,   // { created_at, sources, years, book_ids } – years: null = alle jaren
  adding: false, // stap 1 vanuit "Aanvullen"
  draft: null,   // keuzes in stap 1: { sources: Set, years: Set | null }
  openNotes: new Set(), // uitgeklapte notities (alleen voor de weergave)
  warned: false  // melding "kan niet bewaren" al getoond
};

function shareKey() {
  return `boekenlijst.share.${state.user?.id || 'anon'}`;
}

// Deellijst van de huidige gebruiker laden (bij inloggen / andere gebruiker)
function loadShare() {
  share.saved = null;
  share.adding = false;
  share.draft = null;
  share.warned = false;
  share.openNotes.clear();
  if (!state.user) return;
  try {
    const v = JSON.parse(localStorage.getItem(shareKey()) || 'null');
    if (v && Array.isArray(v.book_ids)) {
      share.saved = {
        created_at: typeof v.created_at === 'string' ? v.created_at : new Date().toISOString(),
        sources: Array.isArray(v.sources) ? v.sources.filter((x) => SHARE_SOURCES.includes(x)) : [],
        years: Array.isArray(v.years) ? v.years.map(String) : null,
        stopped: v.stopped === true,   // Gestopt meegenomen (optie onder Gelezen)
        book_ids: [...new Set(v.book_ids.map(String))],
        // Volgorde (fase 2j, B35): { field, dir } of 'manual'. Ontbreekt bij een
        // deellijst van vóór 2j: wordt bij het eerste tonen de standaardvolgorde.
        sort: shareSortValid(v.sort) ? v.sort : null
      };
    }
  } catch (_) { /* geen of onleesbare deellijst: opnieuw beginnen */ }
}

// Opslag geblokkeerd → deellijst werkt alleen tijdens deze sessie (eenmalige melding)
function saveShare() {
  try {
    if (share.saved) localStorage.setItem(shareKey(), JSON.stringify(share.saved));
    else localStorage.removeItem(shareKey());
  } catch (_) {
    if (share.saved && !share.warned) {
      share.warned = true;
      toast('Je deellijst kan niet op dit toestel bewaard worden; hij blijft staan zolang de app open is.', { duration: 5000 });
    }
  }
}

const shareYear = (b) => (b.date_finished ? b.date_finished.slice(0, 4) : 'zonder');

// Jaren in Gelezen (nieuwste eerst) en of er boeken zonder einddatum zijn
function shareYearOptions() {
  const read = state.books.filter((b) => b.status === 'gelezen');
  const years = [...new Set(read.filter((b) => b.date_finished).map(shareYear))].sort((a, b) => b.localeCompare(a));
  return { years, zonder: read.some((b) => !b.date_finished) };
}

function shareSourceCount(src) {
  return state.books.filter((b) => b.status === src).length; // Gelezen zonder Gestopt
}

// Gestopte boeken kunnen mee via de optie "Gestopt" onder Gelezen
const shareStoppedCount = () => state.books.filter((b) => b.status === 'gestopt').length;
const shareSourceAvailable = (src) =>
  shareSourceCount(src) > 0 || (src === 'gelezen' && shareStoppedCount() > 0);

// Boeken die bij de keuzes in stap 1 horen
function shareChoiceInvalid(draft) {
  return !draft.sources.size ||
    (draft.sources.has('gelezen') && !!draft.years && !draft.years.size && !draft.stopped);
}

function shareCandidates(draft) {
  if (shareChoiceInvalid(draft)) return [];
  return state.books.filter((b) => {
    if (b.status === 'gestopt') return draft.sources.has('gelezen') && !!draft.stopped;
    if (!draft.sources.has(b.status)) return false;
    if (b.status !== 'gelezen') return true;
    return !draft.years || draft.years.has(shareYear(b));
  });
}

// Volgorde: Bezig → Leeslijst → Gelezen (nieuwste jaar eerst, zonder einddatum
// achteraan) → Gestopt; binnen elke groep de standaardsortering van die lijst
function shareOrdered(books) {
  const by = (st) => books.filter((b) => b.status === st);
  const out = [
    ...sortBooks('bezig', by('bezig'), DEFAULT_SORT),
    ...sortBooks('wil_lezen', by('wil_lezen'), DEFAULT_SORT)
  ];
  const read = by('gelezen');
  const years = [...new Set(read.map(shareYear))].sort((a, b) =>
    a === 'zonder' ? 1 : b === 'zonder' ? -1 : b.localeCompare(a));
  for (const y of years) out.push(...sortBooks('gelezen', read.filter((b) => shareYear(b) === y), DEFAULT_SORT));
  // Status intussen gewijzigd naar Gestopt: blijft staan, achteraan
  out.push(...sortBooks('gelezen', by('gestopt'), DEFAULT_SORT));
  return out;
}

function shareLabel(b) {
  switch (b.status) {
    case 'bezig': return 'Bezig';
    case 'wil_lezen': return 'Leeslijst';
    case 'gelezen': return b.date_finished ? `Gelezen ${shareYear(b)}` : 'Gelezen – zonder einddatum';
    default: return STATUS[b.status] || b.status;
  }
}

// Boeken in de deellijst die nog bestaan, in de volgorde van book_ids (B35);
// verwijderde boeken vallen stil weg
function shareBooks() {
  if (!share.saved) return [];
  shareMigrate();
  const byId = new Map(state.books.map((b) => [b.id, b]));
  return share.saved.book_ids.map((id) => byId.get(id)).filter(Boolean);
}

/* ---------- Deellijst sorteren (fase 2j, B35) ----------
   De volgorde van book_ids ís de volgorde. Een sortering kiezen herschikt
   book_ids; slepen ook (sort = 'manual', "Eigen volgorde"). */

const SHARE_SORT_FIELDS = ['bron', 'datum', 'titel', 'auteur', 'paginas', 'waardering'];
const SHARE_SORT_LABEL = { bron: 'Bron', datum: 'Datum', titel: 'Titel', auteur: 'Auteur', paginas: "Pagina's", waardering: 'Waardering' };
const SHARE_DEFAULT_SORT = { field: 'bron', dir: 'asc' };

function shareSortValid(v) {
  if (v === 'manual') return true;
  return !!v && SHARE_SORT_FIELDS.includes(v.field) && (v.dir === 'asc' || v.dir === 'desc');
}

// Datum die bij het label hoort: start (Bezig), toegevoegd (Leeslijst), einde (Gelezen/Gestopt)
function shareDate(b) {
  switch (b.status) {
    case 'bezig': return b.date_started;
    case 'wil_lezen': return b.created_at ? String(b.created_at).slice(0, 10) : null;
    case 'gestopt': return b.date_finished || b.date_started;
    default: return b.date_finished;
  }
}

// Boeken in de gekozen sortering (Bron = standaardvolgorde)
function shareSorted(books, sort) {
  if (sort.field === 'bron') return shareOrdered(books);
  return sortBooks('delen', books, sort);
}

// book_ids herschikken volgens de boeken in hun nieuwe volgorde. Id's van boeken
// die (nog) niet geladen zijn blijven achteraan staan, zodat er niets verdwijnt.
function shareSetOrder(books, sort) {
  const ids = books.map((b) => b.id);
  const known = new Set(ids);
  share.saved.book_ids = [...ids, ...share.saved.book_ids.filter((id) => !known.has(id))];
  share.saved.sort = sort;
}

// Deellijst van vóór 2j (zonder sort): eenmalig in de standaardvolgorde zetten
function shareMigrate() {
  if (!share.saved || share.saved.sort || !state.booksLoaded) return;
  const ids = new Set(share.saved.book_ids);
  shareSetOrder(shareOrdered(state.books.filter((b) => ids.has(b.id))), { ...SHARE_DEFAULT_SORT });
  saveShare();
}

function shareSortText(sort) {
  if (!sort || sort === 'manual') return 'Eigen volgorde';
  if (sort.field === 'bron') return 'Bron';
  const dirs = SORT_DIR_LABEL[sort.field];
  return `${SHARE_SORT_LABEL[sort.field]} · ${dirs[sort.dir]}`;
}

// Staat de deellijst (nog) precies in deze sortering?
function shareOrderMatches(sort) {
  if (!shareSortValid(sort) || sort === 'manual') return false;
  const now = shareBooks();
  const want = shareSorted(now, sort);
  return now.every((b, i) => b.id === want[i].id);
}

function applyShareSort(sort) {
  if (!share.saved) return;
  shareSetOrder(shareSorted(shareBooks(), sort), sort);
  saveShare();
  renderShare();
}

function newShareDraft() {
  if (!share.adding || !share.saved) return { sources: new Set(), years: null, stopped: false };
  // Aanvullen: eerdere keuzes, voor zover er nog iets te kiezen valt
  const { years: avail, zonder } = shareYearOptions();
  const sources = new Set(share.saved.sources.filter((x) => shareSourceAvailable(x)));
  const stopped = !!share.saved.stopped && shareStoppedCount() > 0;
  let years = null;
  if (share.saved.years) {
    years = new Set(share.saved.years.filter((y) => (y === 'zonder' ? zonder : avail.includes(y))));
    if (!years.size && !(stopped && !share.saved.years.length)) years = null; // alleen Gestopt gekozen: zo laten
  }
  return { sources, years, stopped };
}

function renderShare() {
  const el = $('#share');
  if (!el) return;
  if (!state.user) { el.innerHTML = ''; return; }
  if (!state.booksLoaded) { el.innerHTML = '<h2>Delen</h2><p class="empty">Laden…</p>'; return; }

  // Focus bewaren bij opnieuw opbouwen (toetsenbord/schermlezer)
  const focusKey = document.activeElement && el.contains(document.activeElement)
    ? document.activeElement.dataset.focus : null;

  if (!share.saved || share.adding) renderShareChoose(el);
  else renderShareList(el);

  if (focusKey) el.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

// Stap 1: bronnen (en jaren) kiezen
function renderShareChoose(el) {
  if (!share.draft) share.draft = newShareDraft();
  const d = share.draft;
  const adding = share.adding && !!share.saved;

  const sourceRows = SHARE_SOURCES.map((src) => {
    const n = shareSourceCount(src);
    const off = !shareSourceAvailable(src);
    if (off) d.sources.delete(src);
    return `<label class="share-source${off ? ' disabled' : ''}">
      <input type="checkbox" data-share-source="${src}" data-focus="src-${src}" ${d.sources.has(src) ? 'checked' : ''} ${off ? 'disabled' : ''}>
      <span>${esc(STATUS[src])}</span> <span class="n">(${n})</span>
    </label>`;
  }).join('');

  let yearsHtml = '';
  if (d.sources.has('gelezen')) {
    const { years, zonder } = shareYearOptions();
    const chip = (value, label, checked) =>
      `<button type="button" role="checkbox" aria-checked="${checked}" data-share-year="${esc(value)}" data-focus="year-${esc(value)}">${esc(label)}</button>`;
    yearsHtml = `<div class="share-years">
      <label id="share-years-label">Gelezen in</label>
      <div class="chips" role="group" aria-labelledby="share-years-label">
        ${chip('alle', 'Alle jaren', !d.years)}
        ${years.map((y) => chip(y, y, !!d.years?.has(y))).join('')}
        ${zonder ? chip('zonder', 'Zonder einddatum', !!d.years?.has('zonder')) : ''}
        ${shareStoppedCount() ? chip('gestopt', `Gestopt (${shareStoppedCount()})`, !!d.stopped) : ''}
      </div>
    </div>`;
  }

  // Voorvertoning
  const inList = new Set(share.saved?.book_ids || []);
  const cands = shareCandidates(d).filter((b) => !adding || !inList.has(b.id));
  const n = cands.length;
  let preview;
  if (!d.sources.size) preview = 'Kies minstens één lijst.';
  else if (shareChoiceInvalid(d)) preview = shareStoppedCount() ? 'Kies minstens één jaar of Gestopt.' : 'Kies minstens één jaar.';
  else if (adding) preview = n ? `${n} ${n === 1 ? 'boek' : 'boeken'} erbij` : 'Geen nieuwe boeken bij deze keuze.';
  else preview = `${n} ${n === 1 ? 'boek' : 'boeken'}`;

  const noBooks = SHARE_SOURCES.every((x) => shareSourceCount(x) === 0);

  el.innerHTML = `<h2>${adding ? 'Deellijst aanvullen' : 'Deellijst samenstellen'}</h2>
    <p class="share-intro">${adding
      ? 'Kies wat je wilt toevoegen. Boeken die al in je deellijst staan, komen er niet dubbel in.'
      : 'Kies uit welke lijsten je boeken wilt delen; daarna kun je de selectie opschonen. Je eigen lijsten veranderen niet.'}</p>
    ${noBooks ? '<p class="empty">Je hebt nog geen boeken om te delen. Voeg boeken toe via “Toevoegen”.</p>' : `
    <fieldset class="share-sources"><legend class="sr-only">Lijsten</legend>${sourceRows}</fieldset>
    ${yearsHtml}
    <div class="share-go">
      <p class="msg" id="share-preview" role="status">${esc(preview)}</p>
      <button type="button" class="primary" data-share-action="make" data-focus="make" ${n ? '' : 'disabled'}>${adding ? 'Toevoegen aan deellijst' : 'Lijst samenstellen'}</button>
      ${adding ? '<button type="button" data-share-action="cancel-add" data-focus="cancel-add">Terug naar deellijst</button>' : ''}
    </div>`}`;
}

// Stap 2: deellijst opschonen
function renderShareList(el) {
  const books = shareBooks();
  const n = books.length;
  const made = fmtDate(share.saved.created_at.slice(0, 10)) || '';

  const order = shareSortText(share.saved.sort);
  el.innerHTML = `<div class="list-head">
      <h2>Deellijst · ${n} ${n === 1 ? 'boek' : 'boeken'}</h2>
      ${n > 1 ? `<button type="button" class="sort-btn" data-share-action="sort" data-focus="sort"
          aria-label="Sorteren (nu: ${esc(order)})" title="Sorteren">${icon('adjustments-horizontal', 22)}</button>` : ''}
    </div>
    <p class="share-sub">Samengesteld op ${esc(made)} · alleen op dit toestel${n > 1
      ? `<br><span class="share-order">Volgorde: ${esc(order)}</span>` : ''}</p>
    ${n ? `<button type="button" class="primary share-send" data-share-action="send" data-focus="send">${icon('share')}<span>Delen…</span></button>` : ''}
    ${n ? `<ul class="booklist share-list">${books.map((b) => `<li class="book share-item" data-share-id="${esc(b.id)}">
        ${coverHtml(b)}
        <div class="info">
          <div class="title">${esc(b.title)}</div>
          <div class="authors">${esc(authorsText(b.authors))}</div>
          <div class="share-meta"><span class="share-label">${esc(shareLabel(b))}</span>${shareMeta(b)}</div>
          ${b.notes ? `<p class="share-note${share.openNotes.has(b.id) ? ' open' : ''}" data-share-note="${esc(b.id)}"
               role="button" tabindex="0" aria-expanded="${share.openNotes.has(b.id)}">${esc(b.notes)}</p>` : ''}
        </div>
        <div class="share-tools">
          <button type="button" class="share-remove" data-share-remove="${esc(b.id)}" data-focus="rm-${esc(b.id)}"
                  aria-label="“${esc(b.title)}” uit de deellijst halen" title="Uit de deellijst halen">${icon('x')}</button>
          ${n > 1 ? `<button type="button" class="share-grip" data-share-grip="${esc(b.id)}" data-focus="grip-${esc(b.id)}"
                  aria-label="Verplaatsen" aria-description="Sleep, of gebruik de pijltjestoetsen omhoog en omlaag"
                  title="Verplaatsen">${icon('grip-vertical')}</button>` : ''}
        </div>
      </li>`).join('')}</ul>`
    : '<p class="empty">Je deellijst is leeg.</p>'}
    <div class="share-actions">
      <button type="button" data-share-action="add" data-focus="add">Aanvullen</button>
      <button type="button" ${n ? '' : 'class="primary"'} data-share-action="reset" data-focus="reset">Opnieuw beginnen</button>
    </div>`;
}

// Bladzijdes en waardering naast het label (lege waarden weggelaten)
function shareMeta(b) {
  const parts = [];
  if (b.pages) parts.push(`${b.pages} blz.`);
  if (b.rating) parts.push(`<span class="stars" aria-label="${b.rating} van 5 sterren">${stars(b.rating)}</span>`);
  return parts.length ? ` <span class="meta">${parts.join(' · ')}</span>` : '';
}

function shareMake() {
  const d = share.draft;
  if (!d) return;
  const adding = share.adding && !!share.saved;
  const inList = new Set(share.saved?.book_ids || []);
  const add = shareOrdered(shareCandidates(d).filter((b) => !inList.has(b.id))).map((b) => b.id);
  if (!add.length) return;
  const choices = { sources: SHARE_SOURCES.filter((x) => d.sources.has(x)), years: d.years ? [...d.years] : null, stopped: !!d.stopped };
  if (adding) {
    shareMigrate();
    // Nieuwe boeken onderaan, in de standaardvolgorde (B35). Klopt de gekozen
    // sortering daarna niet meer, dan is het voortaan "Eigen volgorde".
    const prev = share.saved.sort;
    share.saved = { ...share.saved, ...choices, book_ids: [...share.saved.book_ids, ...add] };
    share.saved.sort = shareOrderMatches(prev) ? prev : 'manual';
  } else {
    share.saved = { created_at: new Date().toISOString(), ...choices, book_ids: add, sort: { ...SHARE_DEFAULT_SORT } };
  }
  share.adding = false;
  share.draft = null;
  saveShare();
  renderShare();
  window.scrollTo(0, 0);
  if (adding) toast(`${add.length} ${add.length === 1 ? 'boek' : 'boeken'} toegevoegd aan je deellijst`);
}

function shareRemove(id) {
  const saved = share.saved;
  if (!saved) return;
  const idx = saved.book_ids.indexOf(id);
  if (idx < 0) return;
  const b = state.books.find((x) => x.id === id);
  saved.book_ids.splice(idx, 1);
  saveShare();
  renderShare();
  toast(`“${b?.title || 'Boek'}” uit de deellijst`, {
    action: 'Ongedaan maken',
    duration: SHARE_UNDO_MS,
    onAction: () => {
      // Alleen als het nog dezelfde deellijst is (niet opnieuw begonnen / andere gebruiker)
      if (share.saved !== saved || saved.book_ids.includes(id)) return;
      saved.book_ids.splice(Math.min(idx, saved.book_ids.length), 0, id);
      saveShare();
      renderShare();
    }
  });
}

function shareReset() {
  const hasBooks = shareBooks().length > 0;
  if (hasBooks && !confirm('Deellijst wissen en opnieuw beginnen? Je eigen lijsten veranderen niet.')) return;
  share.saved = null;
  share.adding = false;
  share.draft = null;
  saveShare();
  renderShare();
  window.scrollTo(0, 0);
}

function toggleShareNote(note) {
  const id = note.dataset.shareNote;
  const open = !share.openNotes.has(id);
  if (open) share.openNotes.add(id); else share.openNotes.delete(id);
  note.classList.toggle('open', open);
  note.setAttribute('aria-expanded', String(open));
}

$('#share').addEventListener('keydown', (e) => {
  const note = e.target.closest?.('[data-share-note]');
  if (note && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleShareNote(note); }
});

$('#share').addEventListener('change', (e) => {
  const src = e.target.dataset?.shareSource;
  if (!src || !share.draft) return;
  if (e.target.checked) share.draft.sources.add(src); else share.draft.sources.delete(src);
  renderShare();
});

$('#share').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-share-remove]');
  if (rm) { shareRemove(rm.dataset.shareRemove); return; }

  // Tik op een notitie: in- of uitklappen (lange notities tonen eerst 3 regels)
  const note = e.target.closest('[data-share-note]');
  if (note) { toggleShareNote(note); return; }

  const yr = e.target.closest('[data-share-year]');
  if (yr && share.draft) {
    const y = yr.dataset.shareYear;
    const d = share.draft;
    if (y === 'gestopt') {
      d.stopped = !d.stopped;               // los van de jaren aan/uit
    } else if (y === 'alle') {
      d.years = null;                       // Alle jaren (standaard)
    } else {
      if (!d.years) d.years = new Set();    // van "Alle" naar losse jaren
      if (d.years.has(y)) d.years.delete(y); else d.years.add(y);
    }
    renderShare();
    return;
  }

  const act = e.target.closest('[data-share-action]')?.dataset.shareAction;
  if (act === 'make') shareMake();
  else if (act === 'add') { share.adding = true; share.draft = null; renderShare(); window.scrollTo(0, 0); }
  else if (act === 'cancel-add') { share.adding = false; share.draft = null; renderShare(); }
  else if (act === 'reset') shareReset();
  else if (act === 'send') openShareSheet();
  else if (act === 'sort') openShareSortSheet();
});

/* ---------- Delen als tekst, kopiëren, PDF / afdrukken (fase 2e, B24–B26) ----------
   Eén deelvenster (het onderpaneel in mode 'share') met twee schakelaars en
   drie acties. Tekst en PDF komen uit dezelfde inhoud (shareContent), dus in
   dezelfde volgorde en met dezelfde labels als de deellijst. Geen library,
   geen nieuwe afhankelijkheden, geen databasewijziging. */

const PRINT_COVER_WAIT_MS = 5000;

const shareOut = {
  notes: true,   // Notities tonen (tekst én PDF) – niet bewaard, elke keer aan
  covers: true,  // Covers tonen (alleen PDF)
  busy: false    // PDF wordt voorbereid / deelmenu is open
};

function fmtLongDate(d) {
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Deellijst in de schermvolgorde (fase 2j, B35): één lijst, geen groepskoppen;
// elk boek draagt zijn eigen label
function shareContent() {
  const books = shareBooks();
  return { books, count: books.length };
}

const boeken = (n) => `${n} ${n === 1 ? 'boek' : 'boeken'}`;

// Notitie opschonen: regelafbrekingen behouden, lege regels en spaties aan de randen weg
function noteLines(notes) {
  return String(notes || '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.trim()).filter(Boolean);
}

// Platte tekst voor het deelmenu en het klembord (B26)
function shareText({ notes = shareOut.notes } = {}) {
  const { books, count } = shareContent();
  const out = [`Boekenlijst – ${fmtLongDate(new Date())} (${boeken(count)})`, ''];
  books.forEach((b, i) => {
    if (i > 0) out.push(''); // lege regel tussen boeken: rustiger in berichten-apps
    const authors = authorsText(b.authors);
    const extra = [shareLabel(b)];
    if (b.pages) extra.push(`${b.pages} blz.`);
    if (b.rating) extra.push(stars(b.rating));
    out.push(`• ${(b.title || '').trim() || 'Zonder titel'}${authors ? ` – ${authors}` : ''} (${extra.join(', ')})`);
    if (notes) for (const l of noteLines(b.notes)) out.push(`  ${l}`);
  });
  return out.join('\n');
}

/* --- Deelvenster --- */

function openShareSheet() {
  if (sheet.open || !shareBooks().length) return;
  shareOut.notes = true;
  shareOut.covers = true;
  sheet.mode = 'share';
  sheet.list = null;
  $('#sheet-title').textContent = 'Deellijst delen';
  $('#sheet-clear').hidden = true;
  sheet.open = true;
  renderShareSheet();
  showSheetPanel();
}

function renderShareSheet() {
  const sw = (key, label, hint) => `<label class="switch-row">
      <span class="switch-text"><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</span>
      <input type="checkbox" role="switch" class="switch" data-share-opt="${key}" ${shareOut[key] ? 'checked' : ''}>
    </label>`;
  const canShare = typeof navigator.share === 'function';
  $('#sheet-body').innerHTML = `
    <div class="switches">
      ${sw('notes', 'Notities tonen', 'Je notities zijn persoonlijk; zet ze uit als je met anderen deelt.')}
      ${sw('covers', 'Covers tonen', 'Alleen bij PDF / afdrukken')}
    </div>
    <div class="share-out-actions">
      <button type="button" class="primary" data-share-out="app">${icon('share')}<span>Delen via app</span></button>
      <button type="button" data-share-out="print">${icon('printer')}<span>PDF / afdrukken</span></button>
      <button type="button" class="link" data-share-out="copy">${icon('copy', 18)}<span>Kopiëren</span></button>
    </div>
    ${canShare ? '' : '<p class="meta share-out-hint">Deze browser heeft geen deelmenu; “Delen via app” kopieert de lijst naar het klembord.</p>'}`;
  updateShareSheet();
}

function updateShareSheet() {
  const n = shareBooks().length;
  if (!n) { closeSheet(); return; } // deellijst intussen leeg (bijv. andere gebruiker)
  $('#sheet-sub').textContent = boeken(n);
  $('#sheet-done').textContent = 'Sluiten';
  $('#sheet-body').querySelectorAll('[data-share-out]').forEach((b) => { b.disabled = shareOut.busy; });
}

function onShareSheetChange(e) {
  const key = e.target.dataset?.shareOpt;
  if (key) shareOut[key] = e.target.checked;
}

function onShareSheetClick(e) {
  const act = e.target.closest('[data-share-out]')?.dataset.shareOut;
  if (!act || shareOut.busy) return;
  if (act === 'app') shareViaApp();
  else if (act === 'copy') shareCopy();
  else if (act === 'print') sharePrint();
}

/* --- Deellijst sorteren: onderpaneel in mode 'sharesort' (fase 2j, B35) ---
   Alleen het sorteerdeel, geen filters. Een keuze herschikt de deellijst direct;
   het paneel blijft open, zodat je nog van richting kunt wisselen. */

function openShareSortSheet() {
  if (sheet.open || shareBooks().length < 2) return;
  sheet.mode = 'sharesort';
  sheet.list = null;
  $('#sheet-title').textContent = 'Deellijst sorteren';
  $('#sheet-clear').hidden = true;
  sheet.open = true;
  renderShareSortSheet();
  showSheetPanel();
}

function renderShareSortSheet() {
  const cur = share.saved?.sort;
  const manual = !shareSortValid(cur) || cur === 'manual';
  const fieldOf = manual ? null : cur.field;
  const fields = SHARE_SORT_FIELDS.map((k) => [k, SHARE_SORT_LABEL[k], k === fieldOf]);
  let h = `<h3 id="sh-share-sort">Sorteren</h3>${chipsHtml('share-sort-field', fields, 'sh-share-sort')}`;
  if (fieldOf && fieldOf !== 'bron') {
    const first = SORT_NATURAL_DIR[fieldOf];
    const second = first === 'asc' ? 'desc' : 'asc';
    h += chipsHtml('share-sort-dir', [first, second].map((d) => [d, SORT_DIR_LABEL[fieldOf][d], cur.dir === d]), 'sh-share-sort');
  }
  h += `<p class="meta share-sort-hint">${manual
    ? 'Nu: eigen volgorde. Een sortering kiezen vervangt die.'
    : fieldOf === 'bron'
      ? 'Bron: Bezig, Leeslijst, Gelezen (nieuwste jaar eerst); binnen elke groep nieuwste eerst.'
      : fieldOf === 'datum'
        ? 'Datum: start bij Bezig, toegevoegd bij Leeslijst, einde bij Gelezen.'
        : ''} Slepen kan met de greep rechts bij elk boek.</p>`;
  $('#sheet-body').innerHTML = h;
  updateShareSortSheet();
}

function updateShareSortSheet() {
  const n = shareBooks().length;
  if (n < 2) { closeSheet(); return; }
  $('#sheet-sub').textContent = boeken(n);
  $('#sheet-done').textContent = 'Klaar';
}

function onShareSortClick(e) {
  const btn = e.target.closest('button[data-group]');
  if (!btn || !sheet.open || !share.saved) return;
  const cur = share.saved.sort;
  const value = btn.dataset.value;
  let next;
  if (btn.dataset.group === 'share-sort-field') {
    if (shareSortValid(cur) && cur !== 'manual' && cur.field === value) return;
    next = { field: value, dir: value === 'bron' ? 'asc' : SORT_NATURAL_DIR[value] };
  } else if (btn.dataset.group === 'share-sort-dir') {
    if (!shareSortValid(cur) || cur === 'manual' || cur.dir === value) return;
    next = { field: cur.field, dir: value };
  } else return;
  applyShareSort(next);
  renderShareSortSheet();
}

/* --- Slepen met de greep (fase 2j, B35): eigen implementatie met Pointer Events ---
   Alleen de greep start het slepen (touch-action: none op de greep); scrollen
   over de rest van de lijst blijft gewoon werken. Het boek volgt de vinger,
   de andere boeken schuiven opzij; bij de rand scrolt de pagina mee. */

const SHARE_EDGE = 72;        // px vanaf de rand waarbinnen de lijst meescrolt
const SHARE_SCROLL_MAX = 18;  // px per frame bij de rand

const shareDrag = { d: null };

function shareDragStart(e, grip) {
  if (shareDrag.d || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const li = grip.closest('li.share-item');
  const ul = li?.parentElement;
  if (!li || !ul) return;
  e.preventDefault();
  const items = [...ul.children];
  const from = items.indexOf(li);
  const sy = window.scrollY;
  // Posities in paginacoördinaten (los van het scrollen tijdens het slepen)
  const rects = items.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top + sy, h: r.height }; });
  const gap = items.length > 1 ? rects[1].top - (rects[0].top + rects[0].h) : 8;
  shareDrag.d = {
    li, ul, items, from, to: from, rects, gap,
    pointerId: e.pointerId, y0: e.clientY + sy, y: e.clientY,
    raf: 0, moved: false
  };
  try { grip.setPointerCapture(e.pointerId); } catch (_) {}
  li.classList.add('dragging');
  ul.classList.add('drag-active');
  try { navigator.vibrate?.(15); } catch (_) {}
  shareDrag.d.raf = requestAnimationFrame(shareDragFrame);
}

function shareDragMove(e) {
  const d = shareDrag.d;
  if (!d || e.pointerId !== d.pointerId) return;
  e.preventDefault();
  d.y = e.clientY;
  d.moved = true;
}

// Elk frame: rand-scroll, positie van het boek en van de andere boeken
function shareDragFrame() {
  const d = shareDrag.d;
  if (!d) return;
  const top = ($('.topbar')?.getBoundingClientRect().bottom || 0);
  const bottom = ($('#tabbar') && !$('#tabbar').hidden ? $('#tabbar').getBoundingClientRect().top : window.innerHeight);
  let step = 0;
  if (d.y < top + SHARE_EDGE) step = -Math.ceil(SHARE_SCROLL_MAX * Math.min(1, (top + SHARE_EDGE - d.y) / SHARE_EDGE));
  else if (d.y > bottom - SHARE_EDGE) step = Math.ceil(SHARE_SCROLL_MAX * Math.min(1, (d.y - (bottom - SHARE_EDGE)) / SHARE_EDGE));
  if (step) window.scrollBy(0, step);

  const sy = window.scrollY;
  const dy = d.y + sy - d.y0;
  // Niet boven het eerste of onder het laatste boek uit
  const self = d.rects[d.from];
  const minDy = d.rects[0].top - self.top;
  const last = d.rects[d.rects.length - 1];
  const maxDy = last.top + last.h - (self.top + self.h);
  const cdy = Math.max(minDy, Math.min(maxDy, dy));
  d.li.style.transform = `translateY(${cdy}px)`;

  // Nieuwe plek. Boeken zijn niet even hoog (notities), dus: omhoog telt de
  // bovenrand van het gesleepte boek, omlaag de onderrand, tegen het midden van de rest
  const upper = self.top + cdy;
  const lower = upper + self.h;
  let to = d.from;
  d.rects.forEach((r, i) => {
    const m = r.top + r.h / 2;
    if (i < d.from && upper < m) to--;
    else if (i > d.from && lower > m) to++;
  });
  if (to !== d.to) {
    d.to = to;
    const shift = self.h + d.gap;
    d.items.forEach((el, i) => {
      if (i === d.from) return;
      let t = 0;
      if (d.from < i && i <= to) t = -shift;
      else if (to <= i && i < d.from) t = shift;
      el.style.transform = t ? `translateY(${t}px)` : '';
    });
  }
  d.raf = requestAnimationFrame(shareDragFrame);
}

function shareDragEnd(e, cancel = false) {
  const d = shareDrag.d;
  if (!d || (e && e.pointerId !== d.pointerId)) return;
  shareDrag.d = null;
  cancelAnimationFrame(d.raf);
  d.ul.classList.remove('drag-active');
  d.li.classList.remove('dragging');
  d.items.forEach((el) => { el.style.transform = ''; });
  if (cancel || d.to === d.from) return;
  shareMove(d.li.dataset.shareId, d.to);
}

// Boek naar plek "to" (index in de getoonde lijst) → eigen volgorde
function shareMove(id, to) {
  const books = shareBooks();
  const from = books.findIndex((b) => b.id === id);
  if (from < 0 || to === from || to < 0 || to >= books.length) return;
  const [b] = books.splice(from, 1);
  books.splice(to, 0, b);
  shareSetOrder(books, 'manual');
  saveShare();
  renderShare();
}

$('#share').addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('[data-share-grip]');
  if (grip) shareDragStart(e, grip);
});
$('#share').addEventListener('pointermove', shareDragMove, { passive: false });
$('#share').addEventListener('pointerup', (e) => shareDragEnd(e));
$('#share').addEventListener('pointercancel', (e) => shareDragEnd(e, true));
$('#share').addEventListener('lostpointercapture', (e) => shareDragEnd(e));
// Geen contextmenu/tekstselectie bij lang drukken op de greep
$('#share').addEventListener('contextmenu', (e) => { if (e.target.closest('[data-share-grip]')) e.preventDefault(); });
// Slepen stoppen als de app naar de achtergrond gaat of van tabblad wisselt
document.addEventListener('visibilitychange', () => { if (document.hidden) shareDragEnd(null, true); });

// Toetsenbord: pijltje omhoog/omlaag op de greep verplaatst één plek
$('#share').addEventListener('keydown', (e) => {
  const grip = e.target.closest?.('[data-share-grip]');
  if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const id = grip.dataset.shareGrip;
  const idx = shareBooks().findIndex((b) => b.id === id);
  shareMove(id, idx + (e.key === 'ArrowUp' ? -1 : 1));
});

/* --- Delen via app (Web Share API) en kopiëren --- */

// Moet direct vanuit de tik worden aangeroepen (vereiste van de browser)
function shareViaApp() {
  const text = shareText();
  if (typeof navigator.share !== 'function') {
    copyText(text, 'Lijst gekopieerd – plak hem in een app naar keuze');
    return;
  }
  let p;
  try {
    p = navigator.share({ title: 'Boekenlijst', text });
  } catch (err) {
    copyText(text, 'Lijst gekopieerd – plak hem in een app naar keuze');
    return;
  }
  shareOut.busy = true;
  updateShareSheet();
  Promise.resolve(p).then(() => {
    shareOut.busy = false;
    closeSheet();
  }, (err) => {
    shareOut.busy = false;
    if (sheet.open && sheet.mode === 'share') updateShareSheet();
    if (err && err.name === 'AbortError') return; // zelf geannuleerd: stil
    copyText(text, 'Lijst gekopieerd – plak hem in een app naar keuze');
  });
}

function shareCopy() {
  copyText(shareText(), 'Lijst gekopieerd – plak hem in een app naar keuze');
}

// Klembord: eerst de moderne API, anders de oude manier via een tekstvak
async function copyText(text, okMsg) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (_) { /* valt terug op execCommand */ }
  if (!ok) ok = legacyCopy(text);
  if (ok) {
    if (sheet.open && sheet.mode === 'share') closeSheet();
    toast(okMsg, { duration: 3500 });
  } else {
    toast('Kopiëren is niet gelukt. Probeer “PDF / afdrukken”.', { duration: 4500 });
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.append(ta);
  const prevFocus = document.activeElement;
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  try { prevFocus?.focus?.({ preventScroll: true }); } catch (_) {}
  return ok;
}

/* --- PDF / afdrukken (afdrukweergave van de browser, B25) --- */

// Afdrukinhoud opbouwen in #print (alleen zichtbaar in @media print)
function buildPrint({ notes = shareOut.notes, covers = shareOut.covers } = {}) {
  const { books, count } = shareContent();
  const made = share.saved ? fmtLongDate(new Date(share.saved.created_at)) : fmtLongDate(new Date());
  const book = (b) => {
    const meta = [`<span class="p-label">${esc(shareLabel(b))}</span>`];
    if (b.pages) meta.push(`${b.pages} blz.`);
    if (b.rating) meta.push(`<span class="p-stars">${stars(b.rating)}</span>`);
    const lines = notes ? noteLines(b.notes) : [];
    return `<div class="p-book${covers ? '' : ' no-cover'}">
      ${covers ? (b.cover_url
        ? `<img class="p-cover" src="${esc(b.cover_url)}" alt="" referrerpolicy="no-referrer"
             data-title="${esc(b.title || '')}" data-author="${esc((b.authors || [])[0] || '')}">`
        : printPlaceholder(b)) : ''}
      <div class="p-info">
        <div class="p-title">${esc((b.title || '').trim() || 'Zonder titel')}</div>
        ${b.authors?.length ? `<div class="p-authors">${esc(authorsText(b.authors))}</div>` : ''}
        <div class="p-meta">${meta.join(' · ')}</div>
        ${lines.length ? `<div class="p-note">${lines.map(esc).join('<br>')}</div>` : ''}
      </div>
    </div>`;
  };
  // Eén doorlopende lijst in de schermvolgorde, label per boek (B35)
  $('#print').innerHTML = `<h1>Boekenlijst</h1>
    <p class="p-sub">Samengesteld op ${esc(made)} · ${boeken(count)}</p>
    <section class="p-group">${books.map(book).join('')}</section>`;
}

function printPlaceholder(b) {
  const title = (b.title || '').trim() || 'Zonder titel';
  let h = 0;
  for (const c of title) h = (h * 31 + c.codePointAt(0)) % 360;
  const author = (b.authors || [])[0] || '';
  return `<div class="p-cover p-ph" style="--hue:${h}"><span class="ph-title">${esc(title)}</span>${
    author ? `<span class="ph-author">${esc(author)}</span>` : ''}</div>`;
}

// Wachten tot de covers geladen zijn (max. PRINT_COVER_WAIT_MS); niet geladen → placeholder
function waitForPrintCovers() {
  const imgs = [...$('#print').querySelectorAll('img.p-cover')];
  const one = (img) => new Promise((resolve) => {
    if (img.complete) { resolve(); return; }
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
  return Promise.race([
    Promise.all(imgs.map(one)),
    new Promise((r) => setTimeout(r, PRINT_COVER_WAIT_MS))
  ]).then(() => {
    for (const img of imgs) {
      if (img.isConnected && !(img.complete && img.naturalWidth > 0)) {
        const t = document.createElement('div');
        t.innerHTML = printPlaceholder({ title: img.dataset.title, authors: img.dataset.author ? [img.dataset.author] : [] });
        img.replaceWith(t.firstElementChild);
      }
    }
  });
}

// armed: afdrukken gestart via de knop. Alleen dan toont de afdrukweergave de
// deellijst; zelf Ctrl+P of "Afdrukken" uit het menu geeft de gewone pagina.
// De klasse blijft na afloop staan (Android meldt afterprint soms al terwijl
// het afdrukvoorbeeld nog wordt opgebouwd); de volgende beforeprint ruimt op.
const printTitle = { saved: null, armed: false };

function restoreTitle() {
  if (printTitle.saved !== null) {
    document.title = printTitle.saved;
    printTitle.saved = null;
  }
}
window.addEventListener('beforeprint', () => {
  if (!printTitle.armed) document.body.classList.remove('print-share');
});
window.addEventListener('afterprint', () => {
  printTitle.armed = false;
  restoreTitle();
});

async function sharePrint() {
  if (!shareBooks().length) return;
  shareOut.busy = true;
  const opts = { notes: shareOut.notes, covers: shareOut.covers };
  buildPrint(opts);
  closeSheet();
  if (opts.covers && $('#print').querySelector('img.p-cover')) {
    toast('PDF voorbereiden…', { duration: PRINT_COVER_WAIT_MS + 1000 });
    await waitForPrintCovers();
  }
  shareOut.busy = false;
  toast.timer && clearTimeout(toast.timer);
  $('#toast').classList.remove('show', 'has-action');
  // Standaard bestandsnaam bij "Opslaan als PDF"
  if (printTitle.saved === null) printTitle.saved = document.title;
  document.title = `Boekenlijst ${fmtLongDate(new Date())}`;
  document.body.classList.add('print-share');
  printTitle.armed = true;
  try {
    window.print();
  } catch (err) {
    printTitle.armed = false;
    document.body.classList.remove('print-share');
    restoreTitle();
    toast('Afdrukken is niet gelukt: ' + (err?.message || err));
  }
}

/* ---------- Zoeken ---------- */

async function searchGoogle(q) {
  const isbn = isIsbn(q);
  const query = isbn ? `isbn:${isbn}` : q;
  const url = 'https://www.googleapis.com/books/v1/volumes?' + new URLSearchParams({
    q: query, maxResults: '20', printType: 'books', key: CONFIG.GOOGLE_BOOKS_KEY
  });
  // Volledig paginaadres als referer meesturen: de API-sleutel is beperkt tot
  // https://pwvanveen.github.io/boekenlijst/…; standaard stuurt de browser
  // cross-origin alleen "https://pwvanveen.github.io/" mee → 403 van Google.
  const r = await fetch(url, { referrerPolicy: 'no-referrer-when-downgrade' });
  if (!r.ok) {
    let reason = '';
    try { reason = (await r.json())?.error?.message || ''; } catch (_) {}
    const err = new Error(`Google Books gaf status ${r.status}${reason ? ': ' + reason : ''}`);
    err.status = r.status; // fase 3b: 403/429 = limiet → stoppen
    throw err;
  }
  const j = await r.json();
  return (j.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const isbnFound = (ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10') || {}).identifier || null;
    let cover = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
    if (cover) cover = cover.replace(/^http:/, 'https:').replace('&edge=curl', '');
    return {
      isbn: isbnFound,
      title: stripDruk(v.title || '(zonder titel)') || '(zonder titel)',
      authors: v.authors || null,
      pages: v.pageCount || null,
      publisher: v.publisher || null,
      published_year: parseInt((v.publishedDate || '').slice(0, 4), 10) || null,
      language: v.language || null,
      cover_url: cover,
      source: 'google',
      external_id: it.id
    };
  });
}

async function searchOpenLibrary(q) {
  const isbn = isIsbn(q);
  const params = new URLSearchParams({
    limit: '20',
    fields: 'key,title,author_name,number_of_pages_median,publisher,first_publish_year,language,isbn,cover_i'
  });
  if (isbn) params.set('isbn', isbn); else params.set('q', q);
  const r = await fetch('https://openlibrary.org/search.json?' + params);
  if (!r.ok) throw new Error('Open Library gaf status ' + r.status);
  const j = await r.json();
  return (j.docs || []).map((d) => ({
    isbn: isbn || (d.isbn || []).find((x) => x.length === 13) || (d.isbn || [])[0] || null,
    title: d.title || '(zonder titel)',
    authors: d.author_name || null,
    pages: d.number_of_pages_median || null,
    publisher: (d.publisher || [])[0] || null,
    published_year: d.first_publish_year || null,
    language: (d.language || [])[0] || null,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    source: 'openlibrary',
    external_id: d.key || null
  }));
}

async function runSearch(q, forceOpenLibrary = false) {
  state.lastQuery = q;
  $('#search-status').textContent = 'Zoeken…';
  $('#search-status').classList.remove('error');
  $('#results').innerHTML = '';
  $('#search-extra').innerHTML = '';

  let results = [];
  let via = 'openlibrary';
  state.googleError = null;
  try {
    if (!forceOpenLibrary) {
      try {
        results = await searchGoogle(q);
        via = 'google';
      } catch (err) {
        console.warn('Google Books mislukt, val terug op Open Library:', err);
        state.googleError = err.message;
      }
    }
    if (!results.length) {
      via = 'openlibrary';
      results = await searchOpenLibrary(q);
    }
  } catch (err) {
    console.error(err);
    $('#search-status').textContent = 'Zoeken mislukt. Controleer je internetverbinding en probeer opnieuw.';
    $('#search-status').classList.add('error');
    renderSearchExtra(null);
    return { ok: false, results: [], via: null };
  }

  state.results = results;
  renderResults(via);
  return { ok: true, results, via };
}

function findExisting(r) {
  return state.books.find((b) =>
    (r.external_id && b.external_id === r.external_id) || (r.isbn && b.isbn && b.isbn === r.isbn));
}

function renderResults(via) {
  const results = state.results;
  $('#search-status').textContent = (results.length
    ? `${results.length} ${results.length === 1 ? 'resultaat' : 'resultaten'} via ${SOURCE[via]}`
    : 'Niets gevonden.')
    + (state.googleError ? ` (Google Books niet bereikbaar: ${state.googleError})` : '');

  $('#results').innerHTML = results.map((r, i) => {
    const existing = findExisting(r);
    const meta = [r.published_year, r.pages ? `${r.pages} blz.` : '', r.publisher].filter(Boolean).map(esc).join(' · ');
    return `<li class="result" data-idx="${i}">
      ${coverHtml(r)}
      <div class="info">
        <div class="title">${esc(r.title)}</div>
        <div class="authors">${esc(authorsText(r.authors))}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${existing ? `<span class="badge">In je lijst: ${esc(STATUS[existing.status])}</span>` : ''}
      </div>
    </li>`;
  }).join('');

  renderSearchExtra(via);
}

function renderSearchExtra(via) {
  const extra = $('#search-extra');
  extra.innerHTML = '';
  if (via === 'google') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Niet gevonden? Zoek in Open Library';
    b.addEventListener('click', () => runSearch(state.lastQuery, true));
    extra.appendChild(b);
  }
  const m = document.createElement('button');
  m.type = 'button';
  m.textContent = 'Handmatig toevoegen';
  m.addEventListener('click', () => {
    const q = state.lastQuery;
    const isbn = q ? isIsbn(q) : null;
    openDialog({ title: isbn ? '' : q, isbn, source: 'handmatig', status: 'wil_lezen' });
  });
  extra.appendChild(m);
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-q').value.trim();
  if (!q) return;
  $('#search-q').blur(); // toetsenbord wegklappen op de telefoon
  runSearch(q);
});

$('#results').addEventListener('click', (e) => {
  const li = e.target.closest('li.result');
  if (!li) return;
  const r = state.results[Number(li.dataset.idx)];
  if (!r) return;
  const existing = findExisting(r);
  openDialog(existing || { ...r, status: 'wil_lezen' });
});

/* ---------- Covers (fase 2b, B18) ---------- */

const olCoverCache = new Map(); // isbn → Promise<url|null>

// Stap 2 van de cover-trap: Open Library-cover op ISBN. Met ?default=false geeft
// Open Library een 404 als er geen cover is; dat vangen we op met een Image.
function probeOpenLibraryCover(isbn) {
  if (!isbn) return Promise.resolve(null);
  if (olCoverCache.has(isbn)) return olCoverCache.get(isbn);
  const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-M.jpg?default=false`;
  const p = new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const timer = setTimeout(() => { img.onload = img.onerror = null; resolve(null); }, 8000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 1 ? url : null); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
  // Mislukte poging (bijv. time-out) niet blijvend onthouden
  p.then((u) => { if (!u) olCoverCache.delete(isbn); });
  olCoverCache.set(isbn, p);
  return p;
}

// Foto verkleinen in de browser: max. ~600 px breed, JPEG (doel ≈ 100 KB)
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto kon niet worden gelezen')); };
    img.src = url;
  });
}

async function resizePhoto(file) {
  const img = await loadImage(file); // Chrome draait de foto zelf goed (EXIF)
  const scale = Math.min(1, COVER_MAX_W / img.naturalWidth, COVER_MAX_H / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparante delen (bijv. PNG) niet zwart
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const toBlob = (q) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
  let blob = await toBlob(COVER_QUALITY);
  if (blob && blob.size > COVER_MAX_BYTES) blob = await toBlob(0.6);
  if (!blob) throw new Error('Foto kon niet worden omgezet');
  if (blob.size > COVER_MAX_BYTES) throw new Error('Foto is te groot');
  return blob;
}

function isOwnCover(url) {
  return typeof url === 'string' && url.includes(`/storage/v1/object/public/${COVER_BUCKET}/`);
}

function coverPath(book) {
  return `${book.user_id}/${book.id}.jpg`;
}

async function uploadCover(book, blob) {
  const path = coverPath(book);
  const { error } = await sb.storage.from(COVER_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: 'image/jpeg',
    cacheControl: '3600'
  });
  if (error) throw error;
  const { data } = sb.storage.from(COVER_BUCKET).getPublicUrl(path);
  // ?v= zorgt dat een vervangen cover niet uit de cache komt
  return `${data.publicUrl}?v=${Date.now()}`;
}

function clearCoverDraft() {
  if (state.coverDraft?.preview) URL.revokeObjectURL(state.coverDraft.preview);
  state.coverDraft = null;
}

// Cover in het venster tonen, rekening houdend met een nog niet opgeslagen wijziging
function renderDialogCover() {
  const b = state.editing;
  if (!b) return;
  const d = state.coverDraft;
  const shown = d?.preview || d?.url || b.cover_url || null;
  $('#dlg-cover').innerHTML = coverHtml({ ...b, cover_url: shown });
  $('#btn-photo').innerHTML = icon('camera', 18) + `<span>${shown ? 'Cover vervangen' : 'Foto van cover maken'}</span>`;
  $('#photo-msg').textContent = d?.blob
    ? 'Nieuwe foto – wordt bewaard bij Opslaan.'
    : d?.url ? 'Cover gevonden via Open Library – wordt bewaard bij Opslaan.' : '';
}

// Boek zonder cover maar met ISBN: Open Library proberen (stap 2 van de trap)
async function tryOpenLibraryForDialog(book) {
  if (book.cover_url || !book.isbn) return;
  const url = await probeOpenLibraryCover(book.isbn);
  // Venster intussen dicht, ander boek, of al een eigen foto? Dan niets doen.
  if (!url || state.editing !== book || !dlg.open || state.coverDraft) return;
  state.coverDraft = { url };
  renderDialogCover();
}

$('#btn-photo').addEventListener('click', () => $('#f-photo').click());

$('#f-photo').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // zelfde bestand opnieuw kiezen moet ook werken
  if (!file || !state.editing) return;
  const book = state.editing;
  $('#photo-msg').textContent = 'Foto verwerken…';
  try {
    const blob = await resizePhoto(file);
    if (state.editing !== book) return;
    clearCoverDraft();
    state.coverDraft = { blob, preview: URL.createObjectURL(blob) };
    renderDialogCover();
  } catch (err) {
    console.error('Foto verwerken mislukt:', err);
    $('#photo-msg').textContent = '';
    toast('Foto verwerken mislukt: ' + err.message);
  }
});

/* ---------- Toevoegen / bewerken ---------- */

const dlg = $('#dlg');

function updateDateVisibility() {
  $('#f-dates').hidden = $('#f-status').value === 'wil_lezen';
}

// Statuskeuze bij toevoegen (B17): drie knoppen die de status-select aansturen
function syncQuickStatus() {
  const s = $('#f-status').value;
  document.querySelectorAll('#f-status-quick button').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.status === s)));
}

$('#f-status-quick').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  $('#f-status').value = btn.dataset.status;
  // Zelfde gedrag als bij de select: datums alvast invullen (B9)
  $('#f-status').dispatchEvent(new Event('change'));
});

function openDialog(book) {
  clearCoverDraft();
  state.editing = book;
  const isNew = !book.id;

  $('#dlg-heading').textContent = isNew ? 'Boek toevoegen' : 'Boek bewerken';
  renderDialogCover();
  $('#dlg-meta').textContent = [
    book.publisher,
    book.published_year,
    book.isbn ? 'ISBN ' + book.isbn : null,
    book.source ? 'bron: ' + SOURCE[book.source] : null
  ].filter(Boolean).join(' · ');

  $('#f-title').value = book.title || '';
  $('#f-authors').value = authorsText(book.authors);
  $('#f-pages').value = book.pages || '';
  $('#f-status').value = book.status || 'wil_lezen';
  $('#f-start').value = book.date_started || '';
  $('#f-finish').value = book.date_finished || '';
  $('#f-rating').value = book.rating ? String(book.rating) : '';
  $('#f-notes').value = book.notes || '';
  $('#f-ereader').checked = !!book.ereader;
  $('#dlg-delete').hidden = isNew;
  $('#dlg-save').disabled = false;
  // Nieuw boek: status kiezen met knoppen; bestaand boek: gewone keuzelijst (incl. Gestopt)
  $('#f-status-quick-wrap').hidden = !isNew;
  $('#f-status-wrap').hidden = isNew;
  syncQuickStatus();
  updateDateVisibility();

  dlg.showModal();
  tryOpenLibraryForDialog(book);
}

dlg.addEventListener('close', () => {
  clearCoverDraft();
  $('#photo-msg').textContent = '';
});

// Bij statuswissel datums alvast invullen met vandaag
$('#f-status').addEventListener('change', () => {
  const s = $('#f-status').value;
  if (s === 'bezig' && !$('#f-start').value) $('#f-start').value = today();
  if (s === 'gelezen' && !$('#f-finish').value) $('#f-finish').value = today();
  syncQuickStatus();
  updateDateVisibility();
});

$('#dlg-cancel').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

function tabForStatus(s) {
  return s === 'gestopt' ? 'gelezen' : s;
}

$('#book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = state.editing;
  if (!b) return;

  const title = $('#f-title').value.trim();
  if (!title) { toast('Vul een titel in'); $('#f-title').focus(); return; }

  const status = $('#f-status').value;
  const start = $('#f-start').value || null;
  const finish = $('#f-finish').value || null;
  if (start && finish && finish < start) { toast('De einddatum ligt vóór de startdatum'); return; }

  const pagesNum = parseInt($('#f-pages').value, 10);
  const authors = $('#f-authors').value.split(',').map((s) => s.trim()).filter(Boolean);

  const fields = {
    title,
    authors: authors.length ? authors : null,
    pages: Number.isFinite(pagesNum) && pagesNum > 0 ? pagesNum : null,
    status,
    date_started: start,
    date_finished: finish,
    rating: parseInt($('#f-rating').value, 10) || null,
    notes: $('#f-notes').value.trim() || null,
    ereader: $('#f-ereader').checked // fase 2i (B34); kolom moet bestaan in Supabase
  };

  // Open Library-cover die in het venster is gevonden meteen meenemen
  const draft = state.coverDraft;
  if (draft?.url && !draft.blob) fields.cover_url = draft.url;

  $('#dlg-save').disabled = true;
  let res;
  if (b.id) {
    res = await sb.from('books')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', b.id).select().single();
  } else {
    res = await sb.from('books').insert({
      isbn: b.isbn ?? null,
      publisher: b.publisher ?? null,
      published_year: b.published_year ?? null,
      language: b.language ?? null,
      cover_url: b.cover_url ?? null,
      source: b.source ?? 'handmatig',
      external_id: b.external_id ?? null,
      ...fields
    }).select().single();
  }

  if (res.error) {
    $('#dlg-save').disabled = false;
    toast('Opslaan mislukt: ' + res.error.message);
    return;
  }

  let saved = res.data;
  let photoError = null;

  // Eigen foto: pas uploaden als het boek een id heeft (B18)
  if (draft?.blob) {
    try {
      const url = await uploadCover(saved, draft.blob);
      const upd = await sb.from('books')
        .update({ cover_url: url, updated_at: new Date().toISOString() })
        .eq('id', saved.id).select().single();
      if (upd.error) throw upd.error;
      saved = upd.data;
    } catch (err) {
      console.error('Cover uploaden mislukt:', err);
      photoError = err.message || String(err);
    }
  }
  $('#dlg-save').disabled = false;
  const idx = state.books.findIndex((x) => x.id === saved.id);
  if (idx >= 0) state.books[idx] = saved; else state.books.unshift(saved);

  dlg.close();
  render();
  if (state.results.length) renderResults(state.results[0]?.source || 'google');

  if (photoError) {
    toast('Boek opgeslagen, maar de foto niet: ' + photoError);
  } else {
    // Valt het boek buiten de actieve filter van zijn lijst? Dan even melden.
    const tab = tabForStatus(status);
    const hidden = filtersActive(tab) && !applyFilters(tab, [saved]).length ? ' – valt buiten je filter' : '';
    toast((!b.id ? `Toegevoegd aan “${STATUS[status]}”` : 'Opgeslagen') + hidden);
  }
  if (!b.id || b.status !== status) {
    if (status === 'gelezen' && finish) state.openYears.add(finish.slice(0, 4));
    showTab(tabForStatus(status));
  }
});

$('#dlg-delete').addEventListener('click', async () => {
  const b = state.editing;
  if (!b?.id) return;
  if (!confirm(`“${b.title}” verwijderen? Dit kan niet ongedaan worden gemaakt.`)) return;
  const { error } = await sb.from('books').delete().eq('id', b.id);
  if (error) { toast('Verwijderen mislukt: ' + error.message); return; }
  // Eigen cover-foto ook weggooien (best effort; mislukken is geen probleem)
  if (isOwnCover(b.cover_url)) {
    sb.storage.from(COVER_BUCKET).remove([coverPath(b)])
      .then(({ error: e }) => { if (e) console.warn('Cover verwijderen mislukt:', e); })
      .catch((e) => console.warn('Cover verwijderen mislukt:', e));
  }
  state.books = state.books.filter((x) => x.id !== b.id);
  dlg.close();
  render();
  if (state.results.length) renderResults(state.results[0]?.source || 'google');
  toast('Verwijderd');
});

/* ---------- Barcode scannen (fase 2a) ---------- */

const scan = {
  active: false,     // scanscherm open
  session: 0,        // telt op bij elke opening; oude, late camera-antwoorden worden genegeerd
  stream: null,
  track: null,
  timer: null,
  busy: false,
  torchOn: false,
  pushedHistory: false,
  detector: null     // hergebruikt tussen scans
};

// Geldig ISBN-13 als EAN-13: 978/979 + geldig controlecijfer
function isValidIsbnBarcode(code) {
  if (!/^97[89]\d{10}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

async function getDetector() {
  if (scan.detector) return scan.detector;
  // 1) Native detector (Android/Chrome via Google Play Services)
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('ean_13')) {
        scan.detector = new window.BarcodeDetector({ formats: ['ean_13'] });
        return scan.detector;
      }
    } catch (err) {
      console.warn('Native BarcodeDetector niet bruikbaar, polyfill wordt geladen:', err);
    }
  }
  // 2) Polyfill alleen als de native detector ontbreekt of geen EAN-13 kent
  const mod = await import(BARCODE_POLYFILL_URL);
  scan.detector = new mod.BarcodeDetector({ formats: ['ean_13'] });
  return scan.detector;
}

function setScanHint(text, isError = false) {
  const h = $('#scan-hint');
  h.textContent = text;
  h.classList.toggle('error', isError);
}

function cameraErrorText(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Geen toestemming voor de camera. Tik op het slotje naast het webadres → Rechten (of Site-instellingen) → Camera → Toestaan, en probeer opnieuw.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Geen camera gevonden op dit apparaat.';
    case 'NotReadableError':
    case 'AbortError':
      return 'De camera is niet beschikbaar. Mogelijk gebruikt een andere app hem; sluit die en probeer opnieuw.';
    default:
      return 'De camera kon niet worden gestart' + (err?.message ? ': ' + err.message : '.');
  }
}

async function openScanner() {
  if (scan.active) return;
  const session = ++scan.session;
  scan.active = true;
  scan.torchOn = false;
  $('#scan-torch').hidden = true;
  setTorchButton(false);
  $('#scan-cancel').textContent = 'Annuleren';
  $('#scanner').classList.remove('has-error');
  setScanHint('Camera starten…');
  $('#scanner').hidden = false;
  document.body.style.overflow = 'hidden';

  // Terugknop van Android sluit het scanscherm i.p.v. de app te verlaten
  history.pushState({ scanner: true }, '');
  scan.pushedHistory = true;

  if (!navigator.mediaDevices?.getUserMedia) {
    showScanError('Deze browser geeft geen toegang tot de camera. Gebruik Chrome en open de app via https.');
    return;
  }

  // Camera en detector tegelijk voorbereiden
  const cameraPromise = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
  });

  try {
    await getDetector();
  } catch (err) {
    console.error('Scanner laden mislukt:', err);
    // Camera die intussen toch start meteen weer uitzetten
    cameraPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    if (session === scan.session && scan.active) {
      showScanError('De scanner kon niet worden geladen. Controleer je internetverbinding en probeer opnieuw.');
    }
    return;
  }

  let stream;
  try {
    stream = await cameraPromise;
  } catch (err) {
    console.error('Camera starten mislukt:', err);
    if (session === scan.session && scan.active) showScanError(cameraErrorText(err));
    return;
  }

  // Inmiddels geannuleerd? Camera direct weer uit.
  if (session !== scan.session || !scan.active) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  scan.stream = stream;
  scan.track = stream.getVideoTracks()[0] || null;
  const video = $('#scan-video');
  video.srcObject = stream;
  try { await video.play(); } catch (_) { /* autoplay+muted volstaat meestal */ }

  // Zaklamp en continu scherpstellen alleen als de camera dat ondersteunt
  const caps = scan.track?.getCapabilities ? scan.track.getCapabilities() : {};
  if (caps.torch) $('#scan-torch').hidden = false;
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }

  setScanHint('Richt de camera op de streepjescode achterop het boek');
  scanLoop(session);
}

function scanLoop(session) {
  if (session !== scan.session || !scan.active) return;
  scan.timer = setTimeout(async () => {
    if (session !== scan.session || !scan.active) return;
    const video = $('#scan-video');
    if (!scan.busy && video.readyState >= 2 && video.videoWidth) {
      scan.busy = true;
      try {
        const codes = await scan.detector.detect(video);
        if (session !== scan.session || !scan.active) return;
        // Alleen geldige ISBN's; andere codes (bijv. prijsbarcode) negeren en doorscannen
        const hit = codes.map((c) => (c.rawValue || '').trim()).find(isValidIsbnBarcode);
        if (hit) { onBarcode(hit); return; }
      } catch (err) {
        console.warn('Detectie mislukt (wordt opnieuw geprobeerd):', err);
      } finally {
        scan.busy = false;
      }
    }
    scanLoop(session);
  }, 150);
}

function showScanError(text) {
  stopCamera();
  $('#scanner').classList.add('has-error');
  setScanHint(text, true);
  $('#scan-torch').hidden = true;
  $('#scan-cancel').textContent = 'Sluiten';
}

// Camera en detectielus stoppen (scanscherm blijft staan)
function stopCamera() {
  clearTimeout(scan.timer);
  scan.timer = null;
  if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
  scan.stream = null;
  scan.track = null;
  const video = $('#scan-video');
  video.pause();
  video.srcObject = null;
}

// Scanscherm sluiten. fromPopstate = gesloten via de terugknop.
function closeScanner(fromPopstate = false) {
  if (!scan.active) return;
  scan.active = false;
  scan.session++;
  stopCamera();
  $('#scanner').hidden = true;
  document.body.style.overflow = '';
  if (scan.pushedHistory) {
    scan.pushedHistory = false;
    if (!fromPopstate) history.back();
  }
}

async function onBarcode(isbn) {
  if (navigator.vibrate) { try { navigator.vibrate(80); } catch (_) {} }
  closeScanner();

  showTab('zoeken');
  $('#search-q').value = isbn;

  // Staat dit ISBN al in de lijst? Dan direct het bestaande boek openen
  // (zoekresultaten worden op de achtergrond gewoon getoond, met label).
  const own = state.books.find((b) => b.isbn === isbn);
  if (own) {
    toast('Dit boek staat al in je lijst');
    openDialog(own);
    runSearch(isbn);
    return;
  }

  const res = await runSearch(isbn);
  if (!res.ok) return; // foutmelding staat al bij de zoekresultaten

  if (!res.results.length) {
    toast('Geen gegevens gevonden – vul ze zelf in');
    openDialog({ title: '', isbn, source: 'handmatig', status: 'wil_lezen' });
    return;
  }

  // Bestaand boek (zelfde ISBN of external_id)? Dat openen.
  const existing = res.results.map(findExisting).find(Boolean);
  if (existing) { toast('Dit boek staat al in je lijst'); openDialog(existing); return; }

  // Eén resultaat: meteen het toevoegvenster. Meer: de gebruiker kiest uit de lijst.
  if (res.results.length === 1) openDialog({ ...res.results[0], isbn: res.results[0].isbn || isbn, status: 'wil_lezen' });
}

$('#btn-scan').addEventListener('click', openScanner);
$('#scan-cancel').addEventListener('click', () => closeScanner());

// Zaklampknop: icoon toont de stand (uit = bulb-off, aan = bulb), plus aria-pressed
function setTorchButton(on) {
  const btn = $('#scan-torch');
  btn.setAttribute('aria-pressed', String(on));
  btn.innerHTML = icon(on ? 'bulb' : 'bulb-off') + '<span>Zaklamp</span>';
}

$('#scan-torch').addEventListener('click', async () => {
  if (!scan.track) return;
  const on = !scan.torchOn;
  try {
    await scan.track.applyConstraints({ advanced: [{ torch: on }] });
    scan.torchOn = on;
    setTorchButton(on);
  } catch (err) {
    console.warn('Zaklamp schakelen mislukt:', err);
    toast('Zaklamp werkt niet op deze camera');
    $('#scan-torch').hidden = true;
  }
});

// Terugknop
window.addEventListener('popstate', () => { if (scan.active) closeScanner(true); });
// App naar de achtergrond, ander tabblad, scherm uit → camera altijd stoppen
document.addEventListener('visibilitychange', () => { if (document.hidden && scan.active) closeScanner(); });
window.addEventListener('pagehide', () => { if (scan.active) closeScanner(); });

/* ---------- Importeren van Kobo (fase 3a, B36–B39) ----------
   Paul maakt zelf een CSV met DB Browser for SQLite uit een kopie van
   KoboReader.sqlite (vaste query, hieronder). Het bestand wordt alleen hier in
   de browser gelezen (eigen kleine CSV-lezer, geen library) en niet geüpload;
   alleen de boeken die je kiest, komen in Supabase. Volledig scherm met drie
   stappen: 1 bestand, 2 voorvertoning, 3 opslaan en resultaat. */

const KOBO_QUERY = `SELECT Title AS titel, Attribution AS auteur, ISBN AS isbn,
       Publisher AS uitgever, Language AS taal,
       ReadStatus AS status, ___PercentRead AS procent,
       DateLastRead AS laatst_gelezen
FROM content
WHERE ContentType = 6 AND ReadStatus > 0
ORDER BY DateLastRead DESC;`;

// Kolommen op naam (hoofdletterongevoelig): Nederlandse namen uit de query én
// de originele Kobo-namen. Alleen titel is verplicht; andere kolommen negeren we.
const KOBO_COLUMNS = {
  titel: ['titel', 'title'],
  auteur: ['auteur', 'auteurs', 'attribution'],
  isbn: ['isbn'],
  uitgever: ['uitgever', 'publisher'],
  taal: ['taal', 'language'],
  status: ['status', 'readstatus'],
  procent: ['procent', '___percentread', 'percentread'],
  laatst_gelezen: ['laatst_gelezen', 'datelastread']
};

const KOBO_BATCH = 50;                     // max. boeken per insert (spec 3a)
const KOBO_MAX_BYTES = 20 * 1024 * 1024;   // ruim; de CSV is normaal enkele kB
const KOBO_STATUS_CHOICES = [              // volgorde van de keuzeknoppen (spec 3a)
  ['gelezen', 'Gelezen', 'circle-check'],
  ['bezig', 'Bezig', 'book-2'],
  ['gestopt', 'Gestopt', 'player-stop'],
  ['wil_lezen', 'Leeslijst', 'bookmark']
];

const kobo = {
  active: false,
  step: 1,          // 1 = bestand, 2 = voorvertoning, 3 = opslaan/resultaat
  depth: 0,         // aantal eigen items in de browsergeschiedenis (terugknop)
  ignorePop: 0,     // zoveel popstate-meldingen komen van onszelf
  fileName: '',
  error: '',
  rows: [],         // vertaalde regels uit het bestand (na samenvoegen)
  info: null,       // { merged, empty }
  saving: false,
  progress: null,   // { done, total }
  result: null,     // { addedIds, filled, failed, lastError }
  undone: false,
  undoing: false,
  enrich: null      // covers en gegevens ophalen (fase 3b), zie koboEnrichStart
};

/* --- CSV lezen --- */

// UTF-8 (BOM wordt genegeerd); geen geldige UTF-8 → Windows-1252 als terugval
function koboDecode(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) { text = new TextDecoder('windows-1252').decode(buf); }
  return text.replace(/^﻿/, '');
}

// Scheidingsteken uit de kopregel: wat het vaakst voorkomt van ; , en tab
function csvDelimiter(text) {
  const end = text.search(/[\r\n]/);
  const head = (end < 0 ? text : text.slice(0, end)).replace(/"[^"]*"/g, '');
  const counts = [';', ',', '\t'].map((d) => [d, head.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

// CSV-regels: velden tussen aanhalingstekens mogen het scheidingsteken,
// aanhalingstekens ("") en regeleinden bevatten. \r\n, \n en \r als regeleinde.
function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && !field.trim()) { field = ''; quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row);
      row = []; field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new Error('Het bestand kon niet worden gelezen: een aanhalingsteken is niet afgesloten.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/* --- Vertaling per regel (B37) --- */

function koboNum(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

function isbn10Valid(s) {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return s.indexOf('X') < 0 || s.indexOf('X') === 9 ? sum % 11 === 0 : false;
}

function isbn10to13(s) {
  const base = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 ? 3 : 1);
  return base + ((10 - (sum % 10)) % 10);
}

// Alleen een echt ISBN: 978/979 met kloppend controlecijfer, of een geldig
// ISBN-10 (omgezet naar 13). Kobo-codes (urn:uuid:…, 123…) → null.
function koboIsbn(raw) {
  const s = String(raw ?? '').trim().replace(/^(urn:)?isbn:?\s*/i, '').replace(/[-\s]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) return isValidIsbnBarcode(s) ? s : null;
  if (/^\d{9}[\dX]$/.test(s) && isbn10Valid(s)) return isbn10to13(s);
  return null;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function validYmd(y, m, d) {
  const dt = new Date(Number(y), Number(m) - 1, Number(d), 12);
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return null;
  return ymd(dt);
}

// "laatst gelezen" → lokale datum JJJJ-MM-DD. ISO met of zonder Z, offset of
// milliseconden; zonder tijdzone = UTC (zo slaat Kobo het op). Terugval:
// dd-mm-jjjj (als iemand de CSV eerst in Excel heeft geopend).
function koboDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const [, y, mo, d, h, mi, sec, tz] = m;
    if (!validYmd(y, mo, d)) return null;
    if (h === undefined) return validYmd(y, mo, d);
    let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec || 0));
    if (tz && tz.toUpperCase() !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.replace(/\D/g, '');
      ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
    }
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? null : ymd(dt);
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);
  return m ? validYmd(m[3], m[2], m[1]) : null;
}

// Vergelijken op titel/auteur: kleine letters, zonder accenten, " / druk N",
// leestekens en dubbele spaties (B38)
function koboNorm(s) {
  return fold(stripDruk(s)).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function koboTitleKey(title, authors) {
  const t = koboNorm(title);
  return t ? `${t}|${koboNorm((authors || [])[0] || '')}` : null;
}

function koboRow(get) {
  const title = stripDruk(get('titel'));
  if (!title) return null;
  const raw = get('isbn');
  const percent = koboNum(get('procent'));
  const status = koboNum(get('status'));
  return {
    title,
    authors: get('auteur').split(',').map((a) => a.trim()).filter(Boolean),
    isbn: koboIsbn(raw),
    externalId: raw ? 'kobo:' + raw : null,
    publisher: get('uitgever') || null,
    language: normalizeLang(get('taal')),
    lastRead: koboDate(get('laatst_gelezen')),
    percent,
    finished: status === 2 || (percent !== null && percent >= 100)
  };
}

// Hele bestand → regels. Gooit een Error met een Nederlandse melding.
function koboParse(text) {
  if (!text.trim()) throw new Error('Het bestand is leeg.');
  if (text.startsWith('SQLite format 3')) {
    throw new Error('Dit is het Kobo-databasebestand zelf. Maak eerst met DB Browser for SQLite en de query hierboven een CSV-bestand en kies dat.');
  }
  const table = parseCsv(text, csvDelimiter(text));
  if (!table.length) throw new Error('Het bestand is leeg.');
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(KOBO_COLUMNS)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  if (col.titel === undefined) {
    throw new Error('Geen kolom “titel” gevonden. Is dit de CSV uit de query hierboven (met kopregel)?');
  }
  let empty = 0;
  const rows = [];
  for (const r of table.slice(1)) {
    const row = koboRow((key) => (col[key] === undefined ? '' : String(r[col[key]] ?? '').trim()));
    if (row) rows.push(row); else empty++;
  }
  if (!rows.length) throw new Error('Het bestand bevat geen boeken.');
  const merged = koboMergeRows(rows);
  return { rows: merged, info: { merged: rows.length - merged.length, empty } };
}

// Dubbele regels binnen het bestand (zelfde ISBN, Kobo-code of titel + eerste
// auteur) → één regel: de meest recent gelezen, aangevuld met lege velden.
// Blijft op de plek van de eerste regel (volgorde zoals in het bestand).
function koboMergeRows(rows) {
  const out = [];
  const byKey = new Map();
  const keysOf = (r) => [
    r.isbn && 'i:' + r.isbn,
    r.externalId && 'e:' + r.externalId,
    koboTitleKey(r.title, r.authors) && 't:' + koboTitleKey(r.title, r.authors)
  ].filter(Boolean);
  for (const r of rows) {
    const keys = keysOf(r);
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!hit) {
      out.push(r);
      keys.forEach((k) => byKey.set(k, r));
      continue;
    }
    const newer = (r.lastRead || '') > (hit.lastRead || '');
    const [base, other] = newer ? [r, hit] : [hit, r];
    const m = { ...base };
    for (const f of ['isbn', 'externalId', 'publisher', 'language', 'lastRead', 'percent']) {
      if (m[f] === null || m[f] === undefined) m[f] = other[f];
    }
    if (!m.authors.length) m.authors = other.authors;
    m.finished = base.finished || other.finished;
    Object.assign(hit, m); // zelfde object, zelfde plek
    keysOf(hit).concat(keys).forEach((k) => byKey.set(k, hit));
  }
  return out;
}

// Staat dit boek al in de lijst? Volgorde: ISBN → Kobo-code → titel + eerste auteur (B38)
function koboIndex() {
  const isbn = new Map();
  const ext = new Map();
  const ta = new Map();
  for (const b of state.books) {
    if (b.isbn && !isbn.has(b.isbn)) isbn.set(b.isbn, b);
    if (b.external_id && !ext.has(b.external_id)) ext.set(b.external_id, b);
    const k = koboTitleKey(b.title, b.authors);
    if (k && !ta.has(k)) ta.set(k, b);
  }
  return (r) => (r.isbn && isbn.get(r.isbn))
    || (r.externalId && ext.get(r.externalId))
    || ta.get(koboTitleKey(r.title, r.authors))
    || null;
}

// Voorstel voor half gelezen boeken: Bezig als je er < 3 maanden geleden in las
function koboRecent(lastRead) {
  if (!lastRead) return false;
  const limit = new Date();
  limit.setMonth(limit.getMonth() - 3);
  return lastRead >= ymd(limit);
}

// Regels klaarzetten voor de voorvertoning (keuzes met standaardwaarden)
function koboPrepare(rows) {
  const find = koboIndex();
  return rows.map((r, i) => ({
    ...r,
    k: i,
    existing: find(r),
    checked: r.finished,
    status: r.finished ? 'gelezen' : koboRecent(r.lastRead) ? 'bezig' : 'gestopt',
    action: 'skip',   // dubbel boek: 'skip' (Overslaan) of 'fill' (Aanvullen)
    saved: null       // 'done' / 'failed'
  }));
}

/* --- Wat er wordt opgeslagen --- */

function koboInsertFields(r) {
  const withEnd = r.status === 'gelezen' || r.status === 'gestopt';
  return {
    title: r.title,
    authors: r.authors.length ? r.authors : null,
    isbn: r.isbn,
    publisher: r.publisher,
    language: r.language,
    status: r.status,
    date_started: null,
    date_finished: withEnd ? r.lastRead : null,
    ereader: true,
    source: 'kobo',
    external_id: r.externalId
  };
}

// Aanvullen (B38): alleen lege velden; status, datums, sterren, notities en
// cover nooit overschrijven. Einddatum alleen bij Gelezen/Gestopt, zonder
// einddatum, en niet vóór een bestaande startdatum.
function koboFillFields(r, b) {
  const f = {};
  if (!b.ereader) f.ereader = true;
  if (!b.isbn && r.isbn) f.isbn = r.isbn;
  if (!b.language && r.language) f.language = r.language;
  if (!b.publisher && r.publisher) f.publisher = r.publisher;
  if ((b.status === 'gelezen' || b.status === 'gestopt') && !b.date_finished && r.lastRead
      && (!b.date_started || r.lastRead >= b.date_started)) {
    f.date_finished = r.lastRead;
  }
  return f;
}

const koboNew = () => kobo.rows.filter((r) => !r.existing);
const koboChosen = () => kobo.rows.filter((r) => (r.existing ? r.action === 'fill' : r.checked));

/* --- Scherm openen, sluiten en terugknop --- */

function koboOpen() {
  if (kobo.active || !state.user) return;
  Object.assign(kobo, {
    active: true, step: 1, depth: 0, ignorePop: 0, fileName: '', error: '', rows: [], info: null,
    saving: false, progress: null, result: null, undone: false, undoing: false, enrich: null
  });
  // Komt uit Instellingen: het history-item van het onderpaneel overnemen,
  // anders zou history.back() van het paneel ons eigen item weghalen.
  if (sheet.open && sheet.pushedHistory) {
    sheet.pushedHistory = false;
    closeSheet();
    sheetEl.hidden = true;        // meteen weg, geen schuifanimatie achter het scherm
    sheetBackdrop.hidden = true;
    history.replaceState({ kobo: 1 }, '');
  } else {
    if (sheet.open) closeSheet();
    history.pushState({ kobo: 1 }, '');
  }
  kobo.depth = 1;
  $('#kobo').hidden = false;
  document.body.style.overflow = 'hidden';
  koboRender();
  $('#kobo-back').focus({ preventScroll: true });
}

// Sluiten en de eigen history-items opruimen. Bij de terugknop heeft popstate
// er al één weggehaald (depth is dan al verlaagd).
function koboClose() {
  if (!kobo.active) return;
  koboEnrichStop(); // scherm sluiten = ophalen stoppen (B40)
  kobo.active = false;
  $('#kobo').hidden = true;
  $('#kobo-body').innerHTML = '';
  $('#kobo-foot').hidden = true;
  document.body.style.overflow = '';
  const n = kobo.depth;
  kobo.depth = 0;
  kobo.rows = [];
  if (n > 0) history.go(-n);
}

// Kopbalkknop, terugknop van Android en Escape: stap 2 → stap 1, anders sluiten
function koboBack() {
  if (!kobo.active) return;
  if (kobo.saving || kobo.undoing) { toast('Even wachten tot het opslaan klaar is'); return; }
  if (kobo.step === 2) { history.back(); return; } // popstate doet de rest
  koboClose();
}

window.addEventListener('popstate', () => {
  if (!kobo.active) return;
  if (kobo.ignorePop > 0) { kobo.ignorePop--; return; }
  kobo.depth = Math.max(0, kobo.depth - 1);
  if (kobo.saving || kobo.undoing) {
    // Tijdens opslaan niet weg: item terugzetten
    history.pushState({ kobo: kobo.step }, '');
    kobo.depth++;
    toast('Even wachten tot het opslaan klaar is');
    return;
  }
  if (kobo.step === 2 && kobo.depth >= 1) {
    kobo.step = 1;
    kobo.error = '';
    koboRender();
    return;
  }
  koboClose();
});

$('#kobo-back').addEventListener('click', koboBack);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !kobo.active || dlg.open) return;
  e.preventDefault();
  koboBack();
});

/* --- Bestand kiezen --- */

$('#kobo-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // zelfde bestand opnieuw kiezen moet ook werken
  if (!file || !kobo.active) return;
  let parsed;
  try {
    if (!state.booksLoaded) throw new Error('Je boeken zijn nog niet geladen. Probeer het zo opnieuw.');
    if (file.size > KOBO_MAX_BYTES) throw new Error('Dit bestand is erg groot. Kies de CSV die je met de query hebt gemaakt.');
    parsed = koboParse(koboDecode(await file.arrayBuffer()));
  } catch (err) {
    console.warn('Kobo-bestand lezen mislukt:', err);
    koboShowError(err.message || 'Het bestand kon niet worden gelezen.');
    return;
  }
  if (!kobo.active) return;
  kobo.fileName = file.name;
  kobo.error = '';
  kobo.rows = koboPrepare(parsed.rows);
  kobo.info = parsed.info;
  if (kobo.step !== 2) {
    history.pushState({ kobo: 2 }, '');
    kobo.depth++;
  }
  kobo.step = 2;
  koboRender();
  $('#kobo-body').scrollTop = 0;
});

// Fout bij inlezen: altijd terug naar stap 1 met de melding
function koboShowError(msg) {
  if (!kobo.active) return;
  if (kobo.step === 2) {
    kobo.ignorePop++;
    kobo.depth = Math.max(1, kobo.depth - 1);
    history.back();
  }
  kobo.step = 1;
  kobo.error = msg;
  kobo.rows = [];
  koboRender();
  $('#kobo-error')?.scrollIntoView({ block: 'center' });
}

/* --- Weergave --- */

function koboRender() {
  const body = $('#kobo-body');
  const foot = $('#kobo-foot');
  const back = $('#kobo-back');
  const label = kobo.step === 2 ? 'Terug' : 'Sluiten';
  back.setAttribute('aria-label', label);
  back.title = label;
  back.disabled = kobo.saving || kobo.undoing;
  if (kobo.step === 1) body.innerHTML = koboStep1Html();
  else if (kobo.step === 2) body.innerHTML = koboStep2Html();
  else body.innerHTML = koboStep3Html();
  foot.hidden = kobo.step !== 2;
  if (kobo.step === 2) koboUpdateFoot();
}

function koboStep1Html() {
  return `<div class="kobo-inner">
    <p class="kobo-step-label">Stap 1 van 3 · Bestand</p>
    <p class="kobo-intro">Lees de boeken van je Kobo in. Dat gaat via een CSV-bestand dat je zelf op de computer maakt:</p>
    <ol class="kobo-howto">
      <li>Sluit de Kobo met de USB-kabel aan op de computer.</li>
      <li>Kopieer het bestand <code>KoboReader.sqlite</code> uit de map <code>.kobo</code> naar je computer. Die map is verborgen: zet het tonen van verborgen bestanden aan.</li>
      <li>Open de <strong>kopie</strong> in DB Browser for SQLite en ga naar het tabblad <strong>SQL uitvoeren</strong>.</li>
      <li>Plak de query hieronder en voer hem uit.</li>
      <li>Sla het resultaat op als CSV-bestand (Exporteren naar CSV).</li>
    </ol>
    <div class="kobo-query-head">
      <span id="kobo-query-label">Query</span>
      <button type="button" class="kobo-copy" data-kobo="copy">${icon('copy', 18)}<span>Query kopiëren</span></button>
    </div>
    <pre class="kobo-query" aria-labelledby="kobo-query-label"><code>${esc(KOBO_QUERY)}</code></pre>
    <button type="button" class="primary kobo-pickfile" data-kobo="pick">${icon('file-import')}<span>CSV-bestand kiezen</span></button>
    <p class="kobo-privacy">Het bestand blijft op dit toestel; alleen de boeken die je importeert, worden opgeslagen.</p>
    ${kobo.error ? `<p class="msg error kobo-error" id="kobo-error" role="alert">${esc(kobo.error)}</p>` : ''}
  </div>`;
}

function koboStep2Html() {
  const rows = kobo.rows;
  const dups = rows.filter((r) => r.existing).length;
  const finished = rows.filter((r) => r.finished).length;
  const extra = [];
  if (kobo.info?.merged) extra.push(`${kobo.info.merged} dubbele ${kobo.info.merged === 1 ? 'regel' : 'regels'} samengevoegd`);
  if (kobo.info?.empty) extra.push(`${kobo.info.empty} ${kobo.info.empty === 1 ? 'regel' : 'regels'} zonder titel overgeslagen`);
  const hasNew = rows.length > dups;
  return `<div class="kobo-inner">
    <p class="kobo-step-label">Stap 2 van 3 · Kiezen</p>
    <div class="kobo-file">
      <span class="kobo-file-name" title="${esc(kobo.fileName)}">${esc(kobo.fileName)}</span>
      <button type="button" class="link" data-kobo="pick">Ander bestand kiezen</button>
    </div>
    <p class="kobo-summary">${boeken(rows.length)} gevonden · ${finished} uitgelezen · ${dups} ${dups === 1 ? 'staat' : 'staan'} al in je lijst</p>
    ${extra.length ? `<p class="kobo-summary-extra">${esc(extra.join(' · '))}</p>` : ''}
    ${hasNew ? `<div class="kobo-quick" role="group" aria-label="Snel kiezen">
      <span>Kies:</span>
      <button type="button" data-kobo-quick="finished">Alle uitgelezen</button>
      <button type="button" data-kobo-quick="all">Alles</button>
      <button type="button" data-kobo-quick="none">Niets</button>
    </div>` : ''}
    <p class="kobo-hint">Titel en auteur pas je na de import aan via het boek zelf.</p>
    <ul class="kobo-list">${rows.map(koboItemHtml).join('')}</ul>
  </div>`;
}

function koboReadText(r) {
  const parts = [r.finished ? 'Uitgelezen' : r.percent !== null ? `${Math.round(r.percent)}%` : 'Niet uitgelezen'];
  if (r.lastRead) parts.push(`laatst gelezen ${fmtDate(r.lastRead)}`);
  return parts.join(' · ');
}

function koboItemHtml(r) {
  const info = `${placeholderHtml(r)}
    <span class="info">
      <span class="title">${esc(r.title)}</span>
      ${r.authors.length ? `<span class="authors">${esc(authorsText(r.authors))}</span>` : ''}
      <span class="meta">${esc(koboReadText(r))}</span>
      ${!r.isbn ? '<span class="kobo-tag">Geen ISBN</span>' : ''}
    </span>`;

  if (r.existing) {
    const st = STATUS[r.existing.status] || r.existing.status;
    return `<li class="kobo-item dup" data-k="${r.k}">
      <div class="kobo-pick"><span class="kobo-dup-ico" aria-hidden="true">${icon('copy', 18)}</span>${info}</div>
      <p class="kobo-dup-label">Staat al in je lijst (${esc(st)})</p>
      <div class="chips kobo-dup-choice" role="radiogroup" aria-label="“${esc(r.title)}”: overslaan of aanvullen">
        <button type="button" role="radio" aria-checked="${r.action === 'skip'}" data-kobo-action="skip" data-k="${r.k}">Overslaan</button>
        <button type="button" role="radio" aria-checked="${r.action === 'fill'}" data-kobo-action="fill" data-k="${r.k}">Aanvullen</button>
      </div>
    </li>`;
  }

  return `<li class="kobo-item${r.checked ? '' : ' off'}" data-k="${r.k}">
    <label class="kobo-pick">
      <input type="checkbox" data-kobo-check="${r.k}" ${r.checked ? 'checked' : ''}>
      ${info}
    </label>
    ${r.checked ? `<div class="segmented kobo-status" role="radiogroup" aria-label="“${esc(r.title)}” importeren als">${
      KOBO_STATUS_CHOICES.map(([val, label, ic]) =>
        `<button type="button" role="radio" aria-checked="${r.status === val}" data-kobo-status="${val}" data-k="${r.k}">${icon(ic, 18)}<span>${label}</span></button>`
      ).join('')}</div>` : ''}
  </li>`;
}

function koboUpdateFoot() {
  const n = koboNew().filter((r) => r.checked).length;
  const m = kobo.rows.filter((r) => r.existing && r.action === 'fill').length;
  const parts = [];
  if (n) parts.push(`${boeken(n)} importeren`);
  if (m) parts.push(`${m} aanvullen`);
  $('#kobo-foot').innerHTML = `<button type="button" class="primary" data-kobo="save" ${parts.length ? '' : 'disabled'}>${
    parts.length ? esc(parts.join(' · ')) : 'Niets gekozen'}</button>`;
}

function koboStep3Html() {
  if (kobo.saving || !kobo.result) {
    const p = kobo.progress || { done: 0, total: 0 };
    return `<div class="kobo-inner">
      <p class="kobo-step-label">Stap 3 van 3 · Opslaan</p>
      <p class="kobo-progress-text" role="status">Opslaan… ${p.done}/${p.total}</p>
      <progress class="kobo-progress" max="${p.total || 1}" value="${p.done}"></progress>
      <p class="kobo-hint">Laat dit scherm open tot het opslaan klaar is.</p>
    </div>`;
  }
  const res = kobo.result;
  const added = res.addedIds.length;
  const failed = res.failed;
  const skipped = kobo.rows.filter((r) => (r.existing ? r.action === 'skip' : !r.checked)).length;
  let html = `<div class="kobo-inner">
    <p class="kobo-step-label">Stap 3 van 3 · Resultaat</p>
    <h2>${kobo.undone ? 'Import ongedaan gemaakt' : failed ? 'Gedeeltelijk gelukt' : 'Klaar'}</h2>`;
  if (kobo.undone) {
    html += `<p class="kobo-result">${boeken(added)} weer verwijderd${res.filled ? ` · ${res.filled} aangevuld (blijven zo)` : ''}</p>`;
  } else {
    html += `<p class="kobo-result">${added} toegevoegd · ${res.filled} aangevuld · ${skipped} overgeslagen</p>`;
    if (failed) {
      html += `<p class="msg error" role="alert">${failed} niet gelukt${res.lastError ? `: ${esc(res.lastError)}` : ''}. Wat wel gelukt is, blijft bewaard.</p>
        <button type="button" class="kobo-wide" data-kobo="retry">Opnieuw proberen</button>`;
    }
    html += koboEnrichHtml();
  }
  html += `<div class="kobo-done-actions">
      <button type="button" class="primary" data-kobo="done">Klaar</button>
      ${added && !kobo.undone ? `<button type="button" data-kobo="undo" ${kobo.undoing ? 'disabled' : ''}>Import ongedaan maken</button>` : ''}
    </div>
  </div>`;
  return html;
}

/* --- Bediening --- */

$('#kobo-body').addEventListener('click', (e) => {
  const act = e.target.closest('[data-kobo]')?.dataset.kobo;
  if (act === 'pick') { $('#kobo-file').click(); return; }
  if (act === 'copy') { koboCopyQuery(); return; }
  if (act === 'retry') { koboSave(); return; }
  if (act === 'undo') { koboUndo(); return; }
  if (act === 'done') { koboDone(); return; }
  if (act === 'enrich') { koboEnrichStart(); return; }
  if (act === 'enrich-stop') { koboEnrichStop(); return; }

  const quick = e.target.closest('[data-kobo-quick]')?.dataset.koboQuick;
  if (quick) {
    for (const r of koboNew()) r.checked = quick === 'all' || (quick === 'finished' && r.finished);
    $('#kobo-body').querySelector('.kobo-list').innerHTML = kobo.rows.map(koboItemHtml).join('');
    koboUpdateFoot();
    return;
  }

  const st = e.target.closest('[data-kobo-status]');
  if (st) {
    const r = kobo.rows[Number(st.dataset.k)];
    r.status = st.dataset.koboStatus;
    st.parentElement.querySelectorAll('[data-kobo-status]').forEach((b) =>
      b.setAttribute('aria-checked', String(b === st)));
    return;
  }

  const ac = e.target.closest('[data-kobo-action]');
  if (ac) {
    const r = kobo.rows[Number(ac.dataset.k)];
    r.action = ac.dataset.koboAction;
    ac.parentElement.querySelectorAll('[data-kobo-action]').forEach((b) =>
      b.setAttribute('aria-checked', String(b === ac)));
    koboUpdateFoot();
  }
});

$('#kobo-body').addEventListener('change', (e) => {
  const k = e.target.dataset?.koboCheck;
  if (k === undefined) return;
  const r = kobo.rows[Number(k)];
  r.checked = e.target.checked;
  const li = e.target.closest('li.kobo-item');
  li.outerHTML = koboItemHtml(r);
  $('#kobo-body').querySelector(`[data-kobo-check="${k}"]`)?.focus({ preventScroll: true });
  koboUpdateFoot();
});

$('#kobo-foot').addEventListener('click', (e) => {
  if (e.target.closest('[data-kobo="save"]')) koboSave();
});

function koboCopyQuery() {
  const done = (ok) => toast(ok ? 'Query gekopieerd' : 'Kopiëren lukte niet; selecteer de query en kopieer hem zelf.');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(KOBO_QUERY).then(() => done(true), () => done(legacyCopy(KOBO_QUERY)));
  } else {
    done(legacyCopy(KOBO_QUERY));
  }
}

/* --- Opslaan (stap 3) --- */

async function koboSave() {
  if (kobo.saving) return;
  await koboEnrichStop(true); // Opnieuw proberen tijdens het ophalen
  if (kobo.saving || !kobo.active) return;
  const jobs = koboChosen().filter((r) => r.saved !== 'done');
  if (!jobs.length && !kobo.result) return;
  if (kobo.step === 2) history.replaceState({ kobo: 3 }, ''); // terug vanuit 3 = sluiten
  kobo.step = 3;
  kobo.saving = true;
  kobo.result = kobo.result || { addedIds: [], filled: 0, failed: 0, lastError: '' };
  kobo.result.failed = 0;
  kobo.result.lastError = '';
  const total = koboChosen().length;
  kobo.progress = { done: total - jobs.length, total };
  koboRender();

  const step = () => {
    const t = kobo.progress;
    const txt = $('#kobo-body .kobo-progress-text');
    if (txt) txt.textContent = `Opslaan… ${t.done}/${t.total}`;
    const bar = $('#kobo-body .kobo-progress');
    if (bar) bar.value = t.done;
  };

  const fail = (rows, err) => {
    rows.forEach((r) => { r.saved = 'failed'; });
    kobo.result.failed += rows.length;
    kobo.result.lastError = err?.message || String(err || 'onbekende fout');
    console.error('Kobo-import: opslaan mislukt:', err);
  };

  // Nieuwe boeken: één insert per batch van max. 50
  const inserts = jobs.filter((r) => !r.existing);
  for (let i = 0; i < inserts.length; i += KOBO_BATCH) {
    const batch = inserts.slice(i, i + KOBO_BATCH);
    try {
      const { data, error } = await sb.from('books').insert(batch.map(koboInsertFields)).select();
      if (error) throw error;
      const saved = data || [];
      batch.forEach((r, j) => { r.saved = 'done'; r.id = saved[j]?.id; });
      for (const b of saved) {
        kobo.result.addedIds.push(b.id);
        state.books.unshift(b);
      }
      kobo.progress.done += batch.length;
    } catch (err) {
      fail(batch, err);
    }
    step();
    render();
  }

  // Aanvullingen: per boek, alleen de gewijzigde velden
  for (const r of jobs.filter((x) => x.existing)) {
    const b = state.books.find((x) => x.id === r.existing.id) || r.existing;
    const fields = koboFillFields(r, b);
    try {
      if (Object.keys(fields).length) {
        const { data, error } = await sb.from('books')
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq('id', b.id).select().single();
        if (error) throw error;
        const idx = state.books.findIndex((x) => x.id === data.id);
        if (idx >= 0) state.books[idx] = data;
        r.existing = data;
      }
      r.saved = 'done';
      kobo.result.filled++;
      kobo.progress.done++;
    } catch (err) {
      fail([r], err);
    }
    step();
  }

  kobo.saving = false;
  render();
  if (kobo.active) koboRender();
  koboEnrichStart(); // direct covers en gegevens ophalen (fase 3b, B40)
}

function koboDone() {
  const years = kobo.undone ? [] : kobo.rows
    .filter((r) => r.saved === 'done' && !r.existing && r.status === 'gelezen' && r.lastRead)
    .map((r) => r.lastRead.slice(0, 4));
  koboClose();
  if (years.length) state.openYears.add(years.sort().pop()); // meest recente jaar openklappen
  showTab('gelezen');
  render();
}

// Alleen de zojuist toegevoegde boeken verwijderen; aanvullingen blijven (B39)
async function koboUndo() {
  const ids = kobo.result?.addedIds || [];
  if (!ids.length || kobo.undoing || kobo.undone) return;
  if (!confirm(`De ${boeken(ids.length)} die je net hebt toegevoegd weer verwijderen?`
    + (kobo.result.filled ? ' Aangevulde boeken blijven zoals ze nu zijn.' : ''))) return;
  kobo.undoing = true;
  koboRender();
  await koboEnrichStop(true); // niet meer bijwerken wat we gaan verwijderen
  koboRender();
  const removed = [];
  let error = null;
  for (let i = 0; i < ids.length; i += KOBO_BATCH) {
    const chunk = ids.slice(i, i + KOBO_BATCH);
    try {
      const res = await sb.from('books').delete().in('id', chunk);
      if (res.error) throw res.error;
      removed.push(...chunk);
    } catch (err) {
      error = err;
      break;
    }
  }
  const gone = new Set(removed);
  state.books = state.books.filter((b) => !gone.has(b.id));
  kobo.result.addedIds = ids.filter((id) => !gone.has(id));
  kobo.undoing = false;
  if (error) {
    console.error('Kobo-import ongedaan maken mislukt:', error);
    toast(`Ongedaan maken lukte maar deels (${removed.length} van ${ids.length}): ${error.message || error}`, { duration: 5000 });
  } else {
    kobo.undone = true;
    kobo.result.addedIds = ids; // voor de tekst "x weer verwijderd"
    toast('Import ongedaan gemaakt');
  }
  render();
  if (kobo.active) koboRender();
}

/* --- Covers en gegevens ophalen (fase 3b, B40) ---
   Na het opslaan (en via de knop "Covers en gegevens ophalen" zolang het
   importscherm open is): voor elk toegevoegd of aangevuld boek met een geldig
   ISBN Google Books op isbn: (bestaande zoekroute), één aanvraag per ~300 ms.
   Alleen lege velden worden gevuld. Geen cover bij Google → Open Library-cover
   op ISBN (bestaande route). Boeken zonder ISBN: niets (geen zoeken op titel).
   Elk boek wordt direct na het ophalen bewaard; stoppen of sluiten verliest
   dus niets. Google-fout → stoppen met melding, geen eindeloze herhaling. */

const ENRICH_GAP_MS = 300;                  // tussen twee Google-aanvragen (B40)
const ENRICH_FIELDS = ['cover_url', 'pages', 'publisher', 'published_year', 'language'];
const OL_COVER_LIMIT = 90;                  // Open Library: ca. 100 per 5 minuten
const OL_COVER_WINDOW_MS = 5 * 60 * 1000;
const olCoverTimes = [];                    // tijdstippen van Open Library-aanvragen

const isEmpty = (v) => v === null || v === undefined || v === '';

// Boeken van deze import: toegevoegd + aangevuld (in de huidige stand)
function koboImportBooks() {
  const ids = new Set(kobo.result?.addedIds || []);
  for (const r of kobo.rows) if (r.existing && r.saved === 'done') ids.add(r.existing.id);
  return state.books.filter((b) => ids.has(b.id));
}

// Geldig ISBN-13 van een boek (ISBN-10 omgezet), anders null
const enrichIsbn = (b) => koboIsbn(b.isbn);

function koboEnrichCandidates() {
  const done = kobo.enrich?.done || new Map();
  return koboImportBooks()
    .filter((b) => enrichIsbn(b) && ENRICH_FIELDS.some((f) => isEmpty(b[f])) && done.get(b.id) !== 'done')
    .map((b) => b.id);
}

// Google Books op ISBN; alleen een resultaat met hetzelfde ISBN telt
// (geen foute koppelingen). Gooit door bij een fout van Google.
async function googleByIsbn(isbn) {
  const results = await searchGoogle(isbn);
  return results.find((r) => r.isbn && koboIsbn(r.isbn) === isbn) || null;
}

function olCoverBudget() {
  const now = Date.now();
  while (olCoverTimes.length && now - olCoverTimes[0] > OL_COVER_WINDOW_MS) olCoverTimes.shift();
  return olCoverTimes.length < OL_COVER_LIMIT;
}

function enrichErrorText(err) {
  const st = err?.status;
  const msg = String(err?.message || err || '');
  if (st === 403 || st === 429 || /quota|rate ?limit|limit exceeded/i.test(msg)) {
    return 'Google Books weigert op dit moment meer aanvragen (limiet bereikt). Later opnieuw proberen.';
  }
  return `Google Books gaf een fout (${msg || 'geen verbinding'}). Later opnieuw proberen.`;
}

function koboEnrichStart() {
  if (!kobo.active || kobo.saving || kobo.undoing || kobo.undone || !kobo.result) return;
  const e = kobo.enrich || (kobo.enrich = {
    running: false, stopReq: false, loop: null, wake: null,
    done: new Map(),   // boek-id → 'done' (afgehandeld) of 'retry' (Open Library-limiet)
    pos: 0, total: 0, covers: 0, pages: 0, ran: false,
    stopped: false, error: '', olLimited: false, lastGoogle: 0
  });
  if (e.running) return;
  const list = koboEnrichCandidates();
  Object.assign(e, { stopReq: false, stopped: false, error: '', olLimited: false, pos: 0, total: list.length });
  if (!list.length) { e.ran = true; koboRender(); return; }
  e.running = true;
  koboRender();
  e.loop = koboEnrichLoop(e, list).catch((err) => {
    console.error('Gegevens ophalen mislukt:', err);
    e.error = 'Er ging iets mis: ' + (err?.message || err) + '. Later opnieuw proberen.';
  }).finally(() => {
    e.running = false;
    e.ran = true;
    e.wake = null;
    if (e.stopReq && !e.error) e.stopped = true;
    if (kobo.active && kobo.enrich === e && !kobo.undoing) koboRender();
  });
}

// Stoppen. wait = wachten tot de lus echt klaar is (vóór ongedaan maken/opnieuw opslaan)
function koboEnrichStop(wait = false) {
  const e = kobo.enrich;
  if (!e?.running) return Promise.resolve();
  e.stopReq = true;
  e.wake?.();
  return wait ? e.loop : Promise.resolve();
}

// Wachten dat door Stoppen kan worden onderbroken
function enrichSleep(e, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { e.wake = null; resolve(); }, ms);
    e.wake = () => { clearTimeout(t); e.wake = null; resolve(); };
  });
}

async function koboEnrichLoop(e, list) {
  const alive = () => !e.stopReq && kobo.active && kobo.enrich === e;
  for (const id of list) {
    if (!alive()) return;
    let b = state.books.find((x) => x.id === id);
    const isbn = b && enrichIsbn(b);
    if (!b || !isbn) { e.pos++; koboEnrichProgress(); continue; } // intussen verwijderd

    const wait = e.lastGoogle + ENRICH_GAP_MS - Date.now();
    if (wait > 0) await enrichSleep(e, wait);
    if (!alive()) return;
    e.lastGoogle = Date.now();

    let g;
    try {
      g = await googleByIsbn(isbn);
    } catch (err) {
      console.warn('Google Books (gegevens ophalen):', err);
      e.error = enrichErrorText(err);
      e.stopReq = true;
      return;
    }
    if (!alive()) return;

    b = state.books.find((x) => x.id === id) || b; // actuele stand
    const fields = {};
    if (g) {
      if (isEmpty(b.cover_url) && g.cover_url) fields.cover_url = g.cover_url;
      if (isEmpty(b.pages) && g.pages) fields.pages = g.pages;
      if (isEmpty(b.publisher) && g.publisher) fields.publisher = g.publisher;
      if (isEmpty(b.published_year) && g.published_year) fields.published_year = g.published_year;
      if (isEmpty(b.language) && g.language) fields.language = g.language;
    }
    let status = 'done';
    if (isEmpty(b.cover_url) && !fields.cover_url) {
      if (olCoverBudget()) {
        olCoverTimes.push(Date.now());
        const url = await probeOpenLibraryCover(isbn);
        if (!alive()) return;
        if (url) fields.cover_url = url;
      } else {
        status = 'retry';           // later nog eens Open Library proberen
        e.olLimited = true;
      }
    }

    if (Object.keys(fields).length) {
      try {
        const { data, error } = await sb.from('books')
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq('id', id).select().single();
        if (error) throw error;
        const idx = state.books.findIndex((x) => x.id === id);
        if (idx >= 0) state.books[idx] = data;
        const r = kobo.rows.find((x) => x.existing?.id === id);
        if (r) r.existing = data;
      } catch (err) {
        console.error('Gegevens bewaren mislukt:', err);
        e.error = `Bewaren mislukt (${err?.message || err}). Wat al is opgehaald, blijft bewaard. Later opnieuw proberen.`;
        e.stopReq = true;
        return;
      }
      if (fields.cover_url) e.covers++;
      if (fields.pages) e.pages++;
      render();
    }
    e.done.set(id, status);
    e.pos++;
    koboEnrichProgress();
  }
}

function koboEnrichProgress() {
  const e = kobo.enrich;
  if (!e || !kobo.active) return;
  const txt = $('#kobo-enrich-text');
  if (txt) txt.textContent = `Gegevens ophalen ${e.pos}/${e.total}`;
  const bar = $('#kobo-enrich-bar');
  if (bar) bar.value = e.pos;
}

function koboEnrichHtml() {
  const e = kobo.enrich;
  const books = koboImportBooks();
  if (!books.length) return '';
  if (e?.running) {
    return `<div class="kobo-enrich">
      <h3>Covers en gegevens</h3>
      <p class="kobo-progress-text" id="kobo-enrich-text" role="status">Gegevens ophalen ${e.pos}/${e.total}</p>
      <progress class="kobo-progress" id="kobo-enrich-bar" max="${e.total || 1}" value="${e.pos}"></progress>
      <button type="button" class="kobo-wide" data-kobo="enrich-stop" ${e.stopReq ? 'disabled' : ''}>${icon('player-stop', 18)}<span>Stoppen</span></button>
      <p class="kobo-hint">Wat al is opgehaald, wordt direct bewaard.</p>
    </div>`;
  }
  if (kobo.undoing) return '';
  const noCover = books.filter((b) => isEmpty(b.cover_url));
  const noIsbn = noCover.filter((b) => !enrichIsbn(b)).length;
  const left = koboEnrichCandidates().length;
  let html = '<div class="kobo-enrich"><h3>Covers en gegevens</h3>';
  if (e?.ran) {
    html += `<p class="kobo-enrich-sum" role="status">${e.covers} ${e.covers === 1 ? 'cover' : 'covers'} gevonden · ${noCover.length} zonder cover</p>`;
    if (e.pages) html += `<p class="kobo-hint">Bladzijdes aangevuld bij ${boeken(e.pages)}.</p>`;
    if (e.error) html += `<p class="msg error" role="alert">${esc(e.error)}</p>`;
    else if (e.stopped) html += '<p class="kobo-hint">Gestopt. Wat al is opgehaald, blijft bewaard.</p>';
    if (e.olLimited) html += '<p class="kobo-hint">Open Library heeft een limiet per 5 minuten; probeer het straks nog eens voor de overige covers.</p>';
  }
  if (noIsbn) {
    html += `<p class="kobo-hint">${noIsbn === 1 ? '1 boek' : `${noIsbn} boeken`} zonder ISBN: cover aanvullen via bewerken of met een eigen foto.</p>`;
  }
  if (left) {
    html += `<button type="button" class="kobo-wide" data-kobo="enrich">${icon('refresh', 18)}<span>Covers en gegevens ophalen</span></button>`;
  }
  return html + '</div>';
}


/* ---------- Start ---------- */

showTab('bezig');
initAuth();