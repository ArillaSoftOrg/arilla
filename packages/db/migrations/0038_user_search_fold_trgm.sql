-- 0038 — yonetim kullanici aramasi icin katlanmis ad/e-posta trigram
-- indeksleri (docs/decisions/0049 §1a)
--
-- `searchUsers` (packages/core/src/admin/users.ts) ad ve e-posta ICINDE,
-- Turkce katlamali `LIKE '%...%'` arar. Indeks olmadan her satirda katlama
-- hesaplanir ve `app_user` + `user_identity` tam taranir. Olcum (yerel,
-- 200 bin kullanici, 140 bin kimlik; EXPLAIN ANALYZE):
--
--   | Sorgu                         | Once    | Sonra   |
--   | ----------------------------- | ------- | ------- |
--   | seyrek terim (tek hesap)      | 778 ms  | 6 ms    |
--   | ad ("ayse isik 1999")         | ~780 ms | 1,5 ms  |
--   | cok yaygin terim ("gmail")    | 130 ms  | 250 ms  |
--   | 2 karakter (trigram yok)      | ~800 ms | 500 ms  |
--
-- Sorgu tarafi dort indeks dostu alt sorgunun UNION'ina cevrildi (OR + EXISTS
-- planlayicinin indeksi kullanmasini engelliyordu). Cok yaygin terimde
-- eslesen on binlerce satir siralandigi icin sure biraz artar ama sinirli
-- kalir; aramaya ayrica statement_timeout uygulanir.
--
-- Ifadeler packages/core/src/search/text-match.ts `foldedTextExpr` ile
-- BIREBIR ayni olmali (0019 ile ayni katlama); aksi halde planlayici
-- indeksi kullanmaz. translate ve lower IMMUTABLE.
--
-- Migration'lar islem icinde calisir; CONCURRENTLY kullanilamaz. Tablolar
-- buyukse indeksler once elle `CREATE INDEX CONCURRENTLY` ile acilir,
-- migration `IF NOT EXISTS` sayesinde bos gecer (0030 deseni).
-- Yalnizca ekleme; geri alinmasi DROP INDEX.

CREATE INDEX IF NOT EXISTS app_user_display_name_fold_trgm ON app_user
    USING gin (lower(translate(display_name, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS app_user_email_fold_trgm ON app_user
    USING gin (lower(translate(email, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS user_identity_email_fold_trgm ON user_identity
    USING gin (lower(translate(email, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS user_identity_display_name_fold_trgm ON user_identity
    USING gin (lower(translate(display_name, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
