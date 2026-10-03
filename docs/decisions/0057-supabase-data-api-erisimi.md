# 0057 — Supabase Data API erişiminin kapatılması

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

Production denetiminde (2026-10-03) Supabase Data API'nin açık olduğu ve
`public` şemasını sunduğu görüldü. Supabase'in varsayılan yetkileri
nedeniyle 58 tablonun hepsinde (`app_user`, `session` dahil) `anon` ve
`authenticated` rolleri tam yetkiliydi; RLS yoktu. Publishable anahtarı olan
herkes tabloları HTTP üzerinden okuyup yazabilirdi.

## Karar

1. **Kod Data API kullanmaz.** Denetim: Supabase istemci paketi, `createClient`,
   `/rest/v1`, `/graphql/v1`, publishable/anon ya da service role anahtarı
   kaynakta ve canlı bundle'da yok. Veritabanına tek yol sunucudaki
   `arilla_app` bağlantısıdır (0010, 0049).
2. **Yetki migration ile geri alınır** (`0042_revoke_data_api_access.sql`),
   panelde elle değil: tablolar, sequence'lar ve migration rolünün sahibi
   olduğu fonksiyonlar `anon`/`authenticated`'den geri alınır; migration
   rolünün varsayılan yetkileri de kapatılır, yeni tablolar otomatik açılmaz.
   Roller yalnızca Supabase'de vardır; yerel/CI'da migration hiçbir şey
   yapmaz. Tekrar çalıştırılabilir.
3. **RLS policy yazılmaz.** İstemciye açık tablo yoktur; yetkisi olmayan rol
   için policy anlamsızdır (deny-by-default yetkiyle sağlanır). Bir tablo
   ileride istemciye açılırsa: RLS + açık policy + asgari GRANT + test, ayrı
   kararla.
4. **Dokunulmayanlar:** `arilla_app` yetkileri, `service_role` (gizli
   anahtar; kodda yok, Supabase panel araçları kullanır), şema USAGE,
   `supabase_admin`'e ait eklenti fonksiyonları (pgvector, pg_trgm — saf
   hesaplama; `postgres` geri alamaz) ve Supabase'in kendi şemaları.

## Reddedilen alternatifler

- **Panelde tek seferlik REVOKE:** depoda izi kalmaz, yeni ortamda unutulur,
  varsayılan yetkiler yeni tabloları yeniden açar.
- **Data API'yi panelden kapatmak tek başına:** ayar sessizce geri açılabilir;
  yetki yine açık kalır. Ek savunma olarak kapatılabilir, yetkinin yerine
  geçmez.
- **Her tabloya RLS + boş policy:** uyarıyı susturur ama modeli
  karmaşıklaştırır; yetki zaten yoktur.
