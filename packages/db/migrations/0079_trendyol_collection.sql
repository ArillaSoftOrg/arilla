-- kind: schema
-- 0079 — Trendyol: yonetici tarayicisindan katalog toplama (karar 0118, 0117 altyapisi)
--
-- GERIYE UYUMLU (yeni satir/kolon, CHECK yalniz genisletilir). 0070'in (karar 0117, Hepsiburada) kota defteri, kapsam birimi ve ara deposu
-- AYNEN kullanilir; burada yalnizca:
--   1) `trendyol` kaynak politikasi (KAPALI gelir),
--   2) kapsam birimi sayfa turleri (urun / liste sayfasi) 0073'te zaten var; burada DEGISMEZ,
--   3) ara depoya Trendyol'un gerektirdigi NULL'a izin veren alanlar
--      (coklu gorsel, renk grubu, varyant kimligi, kosullu sepet fiyati). Ana satici adi ve
--      varyant etiketi 0070'te (`seller_name`, `variant_label`) zaten var.
-- Mevcut satirlar ve Hepsiburada akisi degismez.
--
-- Numara: 0072-0075 main'de, 0076/0077 acik yurt disi urun dalina, 0078 Hepsiburada urun
-- tavanina ayrildi. 0075 (karar 0124) kota tetikleyicisi bu kaynagi da baglar: hacim kotasi
-- tanimsiz (NULL), 7 gun / ayda 4 kosu kurali `collection_source_reported_scope` ile korunur.

-- ---------------------------------------------------------------------------
-- 1) KAYNAK POLITIKASI: kota tetikleyicisi (0070) aynen uygulanir; 0070'in
--    `collection_source_reported_scope` CHECK'i (>= 7 gun, ayda <= 4, ilk yukleme muaf degil)
--    bu satiri da baglar. Ilk yukleme ve guncelleme 500'er sayfa.
-- ---------------------------------------------------------------------------
INSERT INTO collection_source
    (source, merchant_slug, min_interval_days, max_runs_per_month, run_window_days,
     initial_max_requests, refresh_max_requests, enabled, permission_basis, permission_note)
VALUES
    ('trendyol', 'trendyol', 7, 4, 6, 500, 500, FALSE, 'written_email_reported',
     'Kullanici beyani (15 Ekim 2026): Trendyol''dan yazili izin e-postasi alindi; belge paylasilmadi, '
     || 'sistemde yok ve incelenmedi. Resmi API ve CORS yok; yonetici tarayicisinda acilan sayfadan ek ag '
     || 'istegi olmadan okuma. En az 7 gun arayla, takvim ayinda en fazla 4 guncelleme; ilk yukleme dahil.')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) ARA DEPO: Trendyol alanlari (hepsi NULL olabilir; Hepsiburada yazmaz).
-- ---------------------------------------------------------------------------
ALTER TABLE catalog_intake_record
    -- En fazla 6 https gorsel (offer_image siniri, karar 0073). image_url ilk gorseldir.
    ADD COLUMN image_urls JSONB
        CHECK (image_urls IS NULL OR (jsonb_typeof(image_urls) = 'array'
                                      AND jsonb_array_length(image_urls) BETWEEN 1 AND 6)),
    -- Renk grubu (Trendyol productGroupId/groupId). Renk = ayri urun kimligi (contentId).
    ADD COLUMN group_external_id TEXT
        CHECK (group_external_id IS NULL OR group_external_id ~ '^[0-9]{1,20}$'),
    -- Fiyatin ait oldugu beden/varyant (fiyat bedene gore degisebilir).
    ADD COLUMN variant_external_id TEXT
        CHECK (variant_external_id IS NULL OR variant_external_id ~ '^[0-9A-Za-z_-]{1,100}$'),
    -- Sepette uygulanan KOSULLU fiyat ("Sepette %X"). SATIS FIYATI DEGILDIR; price_minor'a
    -- ve price_point'a girmez, yalnizca bilgi olarak tasinir.
    ADD COLUMN basket_price_minor BIGINT
        CHECK (basket_price_minor IS NULL OR basket_price_minor > 0),
    -- Kaydin okundugu sayfa turu (kapsam ve guven ayrimi).
    ADD COLUMN source_page TEXT
        CHECK (source_page IS NULL OR source_page IN ('search_page', 'product_page', 'listing_page'));
