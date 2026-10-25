-- kind: concurrent
-- 0093 — kaldırılma takibi için kısmi indeks (karar 0140)
--
-- Tam taramada görülen satırlardan yalnızca sağlıklı olmayanları (`missing`, `removed` ya da
-- sayaç > 0) bulmak için. Sağlıklı satırlar indekse girmez; indeks küçük kalır ve tam tablo
-- taraması yapılmaz. CONCURRENTLY: tabloyu kilitlemez (karar 0125).
CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_discovery_unhealthy_idx
    ON catalog_discovery (source)
    WHERE presence <> 'present' OR missed_scans <> 0;
