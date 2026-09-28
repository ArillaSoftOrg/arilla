-- 0031 — erken erisim listesi
--
-- Lansman oncesi urun kapali; giris yapan normal kullanici listeye yazilir
-- ve basari ekranini gorur. Kullanici basina tek satir: PK = user_id, bu
-- yuzden esanli iki giris ikinci satiri olusturamaz (uygulama
-- `INSERT ... ON CONFLICT (user_id) DO NOTHING` kullanir).
--
-- Urun kapisi bu tabloya degil `PRODUCT_ACCESS` ortam bayragina ve role
-- bakar (packages/core/src/access/product-access.ts). Durum yalnizca
-- 'pending'; onay akisi gerekirse CHECK geriye uyumlu genisletilir.
--
-- Hesap silinince satir da silinir (ON DELETE CASCADE, docs/kvkk.md).
-- arilla_app yetkisi 0010'daki ALTER DEFAULT PRIVILEGES'ten gelir.
-- Geriye uyumlu: yalnizca yeni tablo ve indeks.

CREATE TABLE IF NOT EXISTS early_access (
    user_id     BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS early_access_created_idx ON early_access (created_at DESC);
