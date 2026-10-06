-- 0046 — kullanilmayan iki uygulama yetkisinin geri alinmasi (en az yetki)
-- (docs/decisions/0059)
--
-- Uretim yetki denetimi (salt okunur) `arilla_app`'in iki fazla genis yetkisini
-- gosterdi; ikisi de 0010'un genel `GRANT ... ON ALL TABLES` / varsayilan
-- yetkilerinden geliyor ve hicbir calisma yolu kullanmiyor:
--
-- 1. `api_usage` DELETE: depoda calisma zamaninda `api_usage` silen kod yok.
--    Yazanlar yalnizca INSERT (gorsel embedding, sorgu yorumlama toplu isi,
--    Python `services/ingest/db/usage.py`) ve hesap silmedeki UPDATE
--    (`user_id` NULL'a cekilir, `packages/core/src/account/delete-account.ts`).
--    Testlerdeki temizlik sahip rolle calisir. Maliyet kaydi silinemez olmali.
-- 2. `query_interpretation` UPDATE: tabloyu guncelleyen kod yok; toplu is
--    `ON CONFLICT DO NOTHING` ile yazar, 90 gunluk saklama DELETE kullanir.
--
-- KORUNANLAR (geri alinmaz): `api_usage` SELECT/INSERT/UPDATE (gunluk tavan
-- sayimi, muhasebe, hesap silmede kimliksizlestirme); `query_interpretation`
-- SELECT/INSERT/DELETE (okuma yolu, toplu is, 90 gunluk saklama).
--
-- Tekrar calistirilabilir: REVOKE idempotenttir. Geriye uyumlu: kolon ya da
-- tablo degismez. `pnpm db:verify` iki yasagi ve korunan yetkileri sinar.

REVOKE DELETE ON api_usage FROM arilla_app;
REVOKE UPDATE ON query_interpretation FROM arilla_app;
