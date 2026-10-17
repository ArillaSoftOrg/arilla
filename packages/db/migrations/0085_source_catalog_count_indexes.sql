-- kind: concurrent
-- 0085 — kaynak ilani urunleri ve fiyatli kesif kayitlari icin sayim indeksleri (karar 0130)
--
-- Yonetim panelindeki Hepsiburada katalog hunisi ve `catalog_build status` mağaza basina
-- urunleri yayin durumu/neden bazinda sayar. `product_source_key_uniq` kimlik onde
-- oldugundan magaza filtresine yaramaz; bu indeks olmadan sayim milyonlarca AliExpress
-- urununu tarar. Yalnizca kaynak ilani urunlerini kapsar (cozumleyici/Shopify urunleri disarida).
CREATE INDEX CONCURRENTLY IF NOT EXISTS product_source_state_idx
    ON product (source_merchant_id, publication_state, hold_reason)
    WHERE source_merchant_id IS NOT NULL;

-- Kesif defteri yuz milyon satira buyuyebilir; fiyat durumu bilinen (fiyatli/dogrulanmis/
-- bayat) satirlar azinliktir. Panel fiyatsiz sayiyi tahminden, digerlerini bu indeksten sayar.
CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_discovery_priced_idx
    ON catalog_discovery (source, price_state)
    WHERE price_state <> 'unpriced';
