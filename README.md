<p align="center">
  <img src="icons/icon-192.png" width="96" height="96" alt="Bladwijzer-logo">
</p>

<h1 align="center">Bladwijzer</h1>

<p align="center">
  Een persoonlijke boekenlijst voor op je telefoon: wat je leest, wat je gelezen hebt en wat je nog wilt lezen.<br>
  Gemaakt voor Sophie.
</p>

<p align="center">
  <a href="https://pwvanveen.github.io/boekenlijst/"><b>Open de app</b></a>
</p>

---

## Wat kan Bladwijzer?

- **Drie lijsten**: *Bezig*, *Leeslijst* en *Gelezen*. Gelezen boeken staan per jaar gegroepeerd, met aantal boeken, bladzijdes en leestijd. Boeken die je niet uitleest, zet je op *Gestopt*.
- **Boeken toevoegen**: zoeken op titel, auteur of ISBN, of de **barcode scannen** met de camera. Titel, auteur, bladzijdes, uitgever en cover worden automatisch opgehaald. Handmatig toevoegen kan ook.
- **Covers**: automatisch via Google Books of Open Library, of maak zelf een foto van de cover.
- **Sorteren en filteren**: op datum, titel, auteur, bladzijdes en waardering; filteren op tekst, auteur, waardering, taal, jaar en e-reader.
- **Waardering en notities** per boek, plus start- en einddatum.
- **E-reader-markering**: geef aan dat je een boek op je e-reader hebt gelezen.
- **Kobo-import**: lees je gelezen boeken van een Kobo-e-reader in één keer in, met voorvertoning, herkenning van dubbele boeken en automatisch ophalen van covers.
- **Boekentips delen**: stel een tijdelijke lijst samen, sorteer of sleep de boeken in je eigen volgorde, en deel hem als tekst (WhatsApp, mail, …) of als PDF.
- **Eigen instellingen**: gebruikersnaam ("Bladwijzer van …", "Boekentips van …") en een licht, donker of systeemthema.
- **Werkt als app**: zet hem op je beginscherm; op Android opent hij zonder adresbalk.
- **Meerdere gebruikers**: iedereen logt in met een link per e-mail en ziet alleen zijn eigen boeken.

## Techniek

| Onderdeel | Keuze |
|---|---|
| Frontend | Eén pagina in gewone HTML, CSS en JavaScript, zonder build-stap of framework |
| Hosting | GitHub Pages |
| Database en inloggen | [Supabase](https://supabase.com) (Postgres, Auth met magic link, Storage voor eigen coverfoto's) |
| Boekgegevens | [Google Books API](https://developers.google.com/books) met [Open Library](https://openlibrary.org/developers/api) als terugval |
| Barcode scannen | Ingebouwde `BarcodeDetector` van de browser, met [`barcode-detector`](https://github.com/Sec-ant/barcode-detector) als terugval |
| Iconen | [Tabler Icons](https://tabler.io/icons) (MIT-licentie), als inline SVG |
| App-weergave | Web app manifest (installeerbaar), geen service worker |

Alles draait op gratis abonnementen.

### Bestanden

```
index.html            pagina, schermen en iconen
style.css             opmaak (mobile-first, licht en donker thema, afdrukweergave)
app.js                alle logica
config.js             Supabase-adres en -sleutel, Google Books-sleutel, inlog-URL
manifest.webmanifest  naam, kleuren en iconen voor het beginscherm
icons/                app-icoon (SVG-bron en PNG's)
```

## Zelf opzetten

Wil je een eigen exemplaar draaien? Dat kan in ongeveer een half uur.

### 1. Supabase

Maak een (gratis) project aan, bij voorkeur in een EU-regio, en voer in de **SQL Editor** uit:

```sql
create table public.books (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  isbn           text,
  title          text not null,
  authors        text[],
  pages          int,
  publisher      text,
  published_year int,
  language       text,
  cover_url      text,
  status         text not null default 'wil_lezen'
                 check (status in ('wil_lezen','bezig','gelezen','gestopt')),
  date_started   date,
  date_finished  date,
  rating         smallint check (rating between 1 and 5),
  notes          text,
  source         text constraint books_source_check
                 check (source in ('google','openlibrary','handmatig','kobo')),
  external_id    text,
  ereader        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.books enable row level security;

create policy "eigen boeken" on public.books
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index books_user_status_idx on public.books (user_id, status);
create index books_user_finished_idx on public.books (user_id, date_finished);

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.books to authenticated;
```

Voor eigen coverfoto's: maak in **Storage** een bucket `covers` aan (public, max. 1 MB, alleen `image/jpeg` en `image/webp`) en sta lezen, schrijven, wijzigen en verwijderen alleen toe in de eigen map:

```sql
create policy "covers eigen map lezen" on storage.objects for select to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "covers eigen map schrijven" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "covers eigen map wijzigen" on storage.objects for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "covers eigen map verwijderen" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
```

Zet daarna onder **Authentication → URL Configuration** de *Site URL* en *Redirect URLs* op het adres van je GitHub Pages-site. Wil je niet dat vreemden een account kunnen maken, zet dan *Allow new users to sign up* uit en nodig gebruikers uit via *Authentication → Users → Invite user*.

### 2. Google Books

Maak in Google Cloud een project, schakel de **Books API** in en maak een API-sleutel. Beperk die sleutel tot alleen de Books API en tot je eigen website (HTTP-referrer). Facturering is niet nodig: de Books API is gratis (standaard 1.000 aanvragen per dag).

### 3. GitHub Pages

Fork of kopieer deze repository, vul `config.js` in met je eigen Supabase-adres, *publishable key*, Google-sleutel en inlog-URL, en zet GitHub Pages aan (*Settings → Pages → Deploy from a branch → `main` / root*).

> **Over de sleutels in `config.js`**: die zijn bewust openbaar, want de app draait volledig in de browser. De beveiliging zit in Row Level Security (Supabase) en in de beperkingen op de Google-sleutel. Zet **nooit** de Supabase `service_role`-sleutel of een wachtwoord in deze repository.

## Kobo-import

Kobo heeft geen eigen exportfunctie. Zo haal je je gelezen boeken binnen:

1. Sluit je Kobo via USB aan op je computer en maak een **kopie** van `.kobo/KoboReader.sqlite` (de map is verborgen).
2. Open de kopie in [DB Browser for SQLite](https://sqlitebrowser.org).
3. Voer de query uit die de app toont onder **Instellingen → Importeren van Kobo**, en sla het resultaat op als CSV.
4. Kies het CSV-bestand in de app, controleer de voorvertoning en importeer.

Het bestand wordt alleen in je eigen browser gelezen en nergens naartoe gestuurd. Deel het volledige Kobo-bestand niet: daarin staan ook je accountgegevens en notities.

## Goed om te weten

- De app is getest op **Android** (Chrome). Op een iPhone werken de meeste functies, maar inloggen vanuit een snelkoppeling op het beginscherm kan mislukken.
- Na een nieuwe versie zie je onder **Instellingen** welk versienummer je gebruikt. Zie je nog een oude versie, ververs dan de pagina.
- Deellijst, sortering en thema worden op het toestel bewaard; boeken en gebruikersnaam in je account.

## Dankwoord

Iconen: [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT-licentie). Boekgegevens en covers: [Google Books](https://books.google.com) en [Open Library](https://openlibrary.org).
