'use strict';

/* =========================================================
   Boekenlijst – fase 1 (MVP) + 2a (barcode scannen) + 2b (covers)
   + 2c (sorteren en filteren) + 2d (tabblad Delen)
   Inloggen (magic link), zoeken (Google Books → Open Library),
   toevoegen, status/datums, lijsten Bezig / Wil lezen / Gelezen per jaar,
   ISBN-barcode scannen met de camera (BarcodeDetector, met polyfill),
   covers trapsgewijs (Google → Open Library op ISBN → eigen foto, B18),
   sorteren en filteren per lijst via ⇅ en een onderpaneel (B19, B20),
   tijdelijke deellijst samenstellen en opschonen (B22, B23).
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

const STATUS = { wil_lezen: 'Wil lezen', bezig: 'Bezig', gelezen: 'Gelezen', gestopt: 'Gestopt' };
const SOURCE = { google: 'Google Books', openlibrary: 'Open Library', handmatig: 'handmatig' };

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
  $('#btn-logout').hidden = !user;
  $('#user-email').textContent = user?.email ?? '';

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

$('#btn-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  showTab('bezig');
});

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

function bookLi(b, metaHtml = '') {
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
    'Je bent nu niets aan het lezen. Zoek een boek via “Zoeken”, of zet een boek uit “Wil lezen” op Bezig.');
  renderSimpleList('wil_lezen', metaWil,
    'Je verlanglijst is leeg. Voeg boeken toe via “Zoeken”.');
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
  wil_lezen: { title: 'Wil lezen',        statuses: ['wil_lezen'],          dateField: 'created_at',    dateLabel: 'Datum toegevoegd' },
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
  return { text: '', author: '', rating: 0, lang: '', year: '' };
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
  return !!(f.text.trim() || f.author || f.rating || f.lang || f.year);
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
    return true;
  });
}

function sortValue(list, field, b) {
  switch (field) {
    case 'datum':
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
      year: list === 'gelezen' && (years.length >= 2 || (years.length === 1 && otherGroups) || !!f.year)
    }
  };
}

// ⇅-icoon, stipje en regel "x van y boeken · Wissen" bij een lijst
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

const sheet = {
  open: false,
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

  const body = $('#sheet-body');
  const scrollTop = body.scrollTop;
  body.innerHTML = h;
  body.scrollTop = scrollTop;
  updateSheetSummary();
}

// Aantallen in kop en knop bijwerken (zonder het paneel opnieuw op te bouwen)
function updateSheetSummary() {
  if (!sheet.open) return;
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
  clearTimeout(sheet.hideTimer);
  sheet.open = true;
  sheet.list = list;
  sheet.opener = document.activeElement;
  renderSheet();
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
$('#sheet-clear').addEventListener('click', () => clearFilters(sheet.list));
sheetBackdrop.addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.open) closeSheet(); });
window.addEventListener('popstate', () => { if (sheet.open) closeSheet(true); });

$('#sheet-body').addEventListener('click', (e) => {
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
  }
  renderSheet();
});

$('#sheet-body').addEventListener('change', (e) => {
  const key = e.target.dataset?.filter;
  if (key && sheet.open) setFilter(sheet.list, key, e.target.value);
});

$('#sheet-body').addEventListener('input', (e) => {
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
  if (!state.user) return;
  try {
    const v = JSON.parse(localStorage.getItem(shareKey()) || 'null');
    if (v && Array.isArray(v.book_ids)) {
      share.saved = {
        created_at: typeof v.created_at === 'string' ? v.created_at : new Date().toISOString(),
        sources: Array.isArray(v.sources) ? v.sources.filter((x) => SHARE_SOURCES.includes(x)) : [],
        years: Array.isArray(v.years) ? v.years.map(String) : null,
        book_ids: [...new Set(v.book_ids.map(String))]
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

// Boeken die bij de keuzes in stap 1 horen
function shareChoiceInvalid(draft) {
  return !draft.sources.size || (draft.sources.has('gelezen') && !!draft.years && !draft.years.size);
}

function shareCandidates(draft) {
  if (shareChoiceInvalid(draft)) return [];
  return state.books.filter((b) => {
    if (!draft.sources.has(b.status)) return false;
    if (b.status !== 'gelezen') return true;
    return !draft.years || draft.years.has(shareYear(b));
  });
}

// Volgorde: Bezig → Wil lezen → Gelezen (nieuwste jaar eerst, zonder einddatum
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
    case 'wil_lezen': return 'Wil lezen';
    case 'gelezen': return b.date_finished ? `Gelezen ${shareYear(b)}` : 'Gelezen – zonder einddatum';
    default: return STATUS[b.status] || b.status;
  }
}

// Boeken in de deellijst die nog bestaan (verwijderde boeken vallen stil weg)
function shareBooks() {
  if (!share.saved) return [];
  const ids = new Set(share.saved.book_ids);
  return shareOrdered(state.books.filter((b) => ids.has(b.id)));
}

function newShareDraft() {
  const counts = Object.fromEntries(SHARE_SOURCES.map((x) => [x, shareSourceCount(x)]));
  if (!share.adding || !share.saved) return { sources: new Set(), years: null };
  // Aanvullen: eerdere keuzes, voor zover er nog iets te kiezen valt
  const { years: avail, zonder } = shareYearOptions();
  const sources = new Set(share.saved.sources.filter((x) => counts[x] > 0));
  let years = null;
  if (share.saved.years) {
    years = new Set(share.saved.years.filter((y) => (y === 'zonder' ? zonder : avail.includes(y))));
    if (!years.size) years = null;
  }
  return { sources, years };
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
    const off = n === 0;
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
      </div>
    </div>`;
  }

  // Voorvertoning
  const inList = new Set(share.saved?.book_ids || []);
  const cands = shareCandidates(d).filter((b) => !adding || !inList.has(b.id));
  const n = cands.length;
  let preview;
  if (!d.sources.size) preview = 'Kies minstens één lijst.';
  else if (shareChoiceInvalid(d)) preview = 'Kies minstens één jaar.';
  else if (adding) preview = n ? `${n} ${n === 1 ? 'boek' : 'boeken'} erbij` : 'Geen nieuwe boeken bij deze keuze.';
  else preview = `${n} ${n === 1 ? 'boek' : 'boeken'}`;

  const noBooks = SHARE_SOURCES.every((x) => shareSourceCount(x) === 0);

  el.innerHTML = `<h2>${adding ? 'Deellijst aanvullen' : 'Deellijst samenstellen'}</h2>
    <p class="share-intro">${adding
      ? 'Kies wat je wilt toevoegen. Boeken die al in je deellijst staan, komen er niet dubbel in.'
      : 'Kies uit welke lijsten je boeken wilt delen; daarna kun je de selectie opschonen. Je eigen lijsten veranderen niet.'}</p>
    ${noBooks ? '<p class="empty">Je hebt nog geen boeken om te delen. Voeg boeken toe via “Zoeken”.</p>' : `
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

  el.innerHTML = `<h2>Deellijst · ${n} ${n === 1 ? 'boek' : 'boeken'}</h2>
    <p class="share-sub">Samengesteld op ${esc(made)} · alleen op dit toestel</p>
    ${n ? `<ul class="booklist share-list">${books.map((b) => `<li class="book share-item" data-share-id="${esc(b.id)}">
        ${coverHtml(b)}
        <div class="info">
          <div class="title">${esc(b.title)}</div>
          <div class="authors">${esc(authorsText(b.authors))}</div>
          <span class="share-label">${esc(shareLabel(b))}</span>
        </div>
        <button type="button" class="share-remove" data-share-remove="${esc(b.id)}" data-focus="rm-${esc(b.id)}"
                aria-label="“${esc(b.title)}” uit de deellijst halen" title="Uit de deellijst halen">✕</button>
      </li>`).join('')}</ul>`
    : '<p class="empty">Je deellijst is leeg.</p>'}
    <div class="share-actions">
      <button type="button" data-share-action="add" data-focus="add">Aanvullen</button>
      <button type="button" ${n ? '' : 'class="primary"'} data-share-action="reset" data-focus="reset">Opnieuw beginnen</button>
    </div>`;
}

function shareMake() {
  const d = share.draft;
  if (!d) return;
  const adding = share.adding && !!share.saved;
  const inList = new Set(share.saved?.book_ids || []);
  const add = shareOrdered(shareCandidates(d).filter((b) => !inList.has(b.id))).map((b) => b.id);
  if (!add.length) return;
  const choices = { sources: SHARE_SOURCES.filter((x) => d.sources.has(x)), years: d.years ? [...d.years] : null };
  if (adding) {
    share.saved = { ...share.saved, ...choices, book_ids: [...share.saved.book_ids, ...add] };
  } else {
    share.saved = { created_at: new Date().toISOString(), ...choices, book_ids: add };
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

$('#share').addEventListener('change', (e) => {
  const src = e.target.dataset?.shareSource;
  if (!src || !share.draft) return;
  if (e.target.checked) share.draft.sources.add(src); else share.draft.sources.delete(src);
  renderShare();
});

$('#share').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-share-remove]');
  if (rm) { shareRemove(rm.dataset.shareRemove); return; }

  const yr = e.target.closest('[data-share-year]');
  if (yr && share.draft) {
    const y = yr.dataset.shareYear;
    const d = share.draft;
    if (y === 'alle') {
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
});

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
    throw new Error(`Google Books gaf status ${r.status}${reason ? ': ' + reason : ''}`);
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
      // NL-titels komen vaak binnen als "Titel / druk 1"
      title: (v.title || '(zonder titel)').replace(/\s*\/\s*druk\s*\d+\s*$/i, ''),
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
  $('#btn-photo').textContent = shown ? '📷 Cover vervangen' : '📷 Foto van cover maken';
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
    notes: $('#f-notes').value.trim() || null
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
  $('#scan-torch').setAttribute('aria-pressed', 'false');
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

$('#scan-torch').addEventListener('click', async () => {
  if (!scan.track) return;
  const on = !scan.torchOn;
  try {
    await scan.track.applyConstraints({ advanced: [{ torch: on }] });
    scan.torchOn = on;
    $('#scan-torch').setAttribute('aria-pressed', String(on));
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

/* ---------- Start ---------- */

showTab('bezig');
initAuth();