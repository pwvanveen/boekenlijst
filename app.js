'use strict';

/* =========================================================
   Boekenlijst – fase 1 (MVP)
   Inloggen (magic link), zoeken (Google Books → Open Library),
   toevoegen, status/datums, lijsten Bezig / Wil lezen / Gelezen per jaar.
   ========================================================= */

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
  results: [],
  lastQuery: '',
  editing: null,
  openYears: new Set([String(new Date().getFullYear())])
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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
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

  const { data } = await sb.auth.getSession();
  setUser(data.session?.user ?? null);
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
  render();
}

/* ---------- Tabbladen ---------- */

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((el) => { el.hidden = el.dataset.tab !== tab; });
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  if (tab === 'zoeken' && !state.results.length) setTimeout(() => $('#search-q').focus(), 50);
}

document.querySelectorAll('#tabbar button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- Weergave ---------- */

function coverHtml(b) {
  return b.cover_url
    ? `<img class="cover" src="${esc(b.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="cover cover-empty">${esc((b.title || '?').trim().charAt(0).toUpperCase())}</div>`;
}

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

function render() {
  const by = (s) => state.books.filter((b) => b.status === s);

  const bezig = by('bezig').sort((a, b) => (b.date_started || '').localeCompare(a.date_started || ''));
  $('#list-bezig').innerHTML = bezig.length
    ? bezig.map((b) => bookLi(b, [
        b.date_started ? `Begonnen ${esc(fmtDate(b.date_started))}` : '',
        b.pages ? `${b.pages} blz.` : ''
      ].filter(Boolean).join(' · '))).join('')
    : emptyLi('Je bent nu niets aan het lezen. Zoek een boek via “Zoeken”, of zet een boek uit “Wil lezen” op Bezig.');

  const wil = by('wil_lezen').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  $('#list-wil').innerHTML = wil.length
    ? wil.map((b) => bookLi(b, [
        b.published_year ? esc(b.published_year) : '',
        b.pages ? `${b.pages} blz.` : ''
      ].filter(Boolean).join(' · '))).join('')
    : emptyLi('Je verlanglijst is leeg. Voeg boeken toe via “Zoeken”.');

  renderGelezen(by('gelezen'), by('gestopt'));

  const counts = { bezig: bezig.length, wil_lezen: wil.length, gelezen: by('gelezen').length };
  document.querySelectorAll('[data-count]').forEach((el) => {
    const n = counts[el.dataset.count];
    el.textContent = n ? String(n) : '';
  });
}

function renderGelezen(read, stopped) {
  const groups = new Map();
  for (const b of read) {
    const y = b.date_finished ? b.date_finished.slice(0, 4) : 'zonder';
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(b);
  }
  const years = [...groups.keys()].sort((a, b) =>
    a === 'zonder' ? 1 : b === 'zonder' ? -1 : b.localeCompare(a));

  // Als geen enkel jaar openstaat, het meest recente openen
  if (years.length && !years.some((y) => state.openYears.has(y))) state.openYears.add(years[0]);

  let html = read.length ? '' : '<p class="empty">Nog geen gelezen boeken. Zet een boek op “Gelezen” om het hier te zien.</p>';

  for (const y of years) {
    const list = groups.get(y).sort((a, b) => (b.date_finished || '').localeCompare(a.date_finished || ''));
    const pages = list.reduce((s, b) => s + (b.pages || 0), 0);
    const label = y === 'zonder' ? 'Zonder einddatum' : y;
    html += `<details class="year" data-year="${esc(y)}" ${state.openYears.has(y) ? 'open' : ''}>
      <summary>
        <span class="year-label">${esc(label)}</span>
        <span class="year-stats">${list.length} ${list.length === 1 ? 'boek' : 'boeken'}${pages ? ` · ${pages.toLocaleString('nl-NL')} blz.` : ''}</span>
      </summary>
      <ul class="booklist">${list.map((b) => bookLi(b, metaRead(b))).join('')}</ul>
    </details>`;
  }

  if (stopped.length) {
    html += `<details class="year" data-year="gestopt" ${state.openYears.has('gestopt') ? 'open' : ''}>
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
    if (d.open) state.openYears.add(d.dataset.year);
    else state.openYears.delete(d.dataset.year);
  }));
}

// Tik op een boek in een lijst → bewerken
document.addEventListener('click', (e) => {
  const li = e.target.closest('li.book[data-id]');
  if (!li) return;
  const b = state.books.find((x) => x.id === li.dataset.id);
  if (b) openDialog(b);
});

/* ---------- Zoeken ---------- */

async function searchGoogle(q) {
  const isbn = isIsbn(q);
  const query = isbn ? `isbn:${isbn}` : q;
  const url = 'https://www.googleapis.com/books/v1/volumes?' + new URLSearchParams({
    q: query, maxResults: '20', printType: 'books', key: CONFIG.GOOGLE_BOOKS_KEY
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google Books gaf status ' + r.status);
  const j = await r.json();
  return (j.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const isbnFound = (ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10') || {}).identifier || null;
    let cover = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
    if (cover) cover = cover.replace(/^http:/, 'https:').replace('&edge=curl', '');
    return {
      isbn: isbnFound,
      title: v.title || '(zonder titel)',
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
  try {
    if (!forceOpenLibrary) {
      try {
        results = await searchGoogle(q);
        via = 'google';
      } catch (err) {
        console.warn('Google Books mislukt, val terug op Open Library:', err);
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
    return;
  }

  state.results = results;
  renderResults(via);
}

function findExisting(r) {
  return state.books.find((b) =>
    (r.external_id && b.external_id === r.external_id) || (r.isbn && b.isbn && b.isbn === r.isbn));
}

function renderResults(via) {
  const results = state.results;
  $('#search-status').textContent = results.length
    ? `${results.length} ${results.length === 1 ? 'resultaat' : 'resultaten'} via ${SOURCE[via]}`
    : 'Niets gevonden.';

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

/* ---------- Toevoegen / bewerken ---------- */

const dlg = $('#dlg');

function updateDateVisibility() {
  $('#f-dates').hidden = $('#f-status').value === 'wil_lezen';
}

function openDialog(book) {
  state.editing = book;
  const isNew = !book.id;

  $('#dlg-heading').textContent = isNew ? 'Boek toevoegen' : 'Boek bewerken';
  $('#dlg-cover').innerHTML = coverHtml(book);
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
  updateDateVisibility();

  dlg.showModal();
}

// Bij statuswissel datums alvast invullen met vandaag
$('#f-status').addEventListener('change', () => {
  const s = $('#f-status').value;
  if (s === 'bezig' && !$('#f-start').value) $('#f-start').value = today();
  if (s === 'gelezen' && !$('#f-finish').value) $('#f-finish').value = today();
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
  $('#dlg-save').disabled = false;

  if (res.error) {
    toast('Opslaan mislukt: ' + res.error.message);
    return;
  }

  const saved = res.data;
  const idx = state.books.findIndex((x) => x.id === saved.id);
  if (idx >= 0) state.books[idx] = saved; else state.books.unshift(saved);

  dlg.close();
  render();
  if (state.results.length) renderResults(state.results[0]?.source || 'google');

  if (!b.id) {
    toast(`Toegevoegd aan “${STATUS[status]}”`);
  } else {
    toast('Opgeslagen');
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
  state.books = state.books.filter((x) => x.id !== b.id);
  dlg.close();
  render();
  if (state.results.length) renderResults(state.results[0]?.source || 'google');
  toast('Verwijderd');
});

/* ---------- Start ---------- */

showTab('bezig');
initAuth();