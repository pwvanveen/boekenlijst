// Configuratie van Bladwijzer (repository: boekenlijst).
// Deze sleutels zijn bewust openbaar (zie architectuurdocument, "Aandachtspunten"):
// - Supabase: beveiliging via Row Level Security
// - Google Books: sleutel beperkt tot de Books API en tot https://pwvanveen.github.io/*
// Zet hier NOOIT de Supabase service_role-sleutel of wachtwoorden.
window.CONFIG = {
  SUPABASE_URL: 'https://qfcpyufnbzkeamylzllg.supabase.co',
  SUPABASE_KEY: 'sb_publishable_UaulzTwL8kUas_Zw2V-S1g_68o1EQUL',
  GOOGLE_BOOKS_KEY: 'AIzaSyCuoHhVs3LQTer5Iqj3IQ_tqPlBnCLab8c',
  REDIRECT_URL: 'https://pwvanveen.github.io/boekenlijst/'
};