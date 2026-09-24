-- 0019 — metin aramasi icin katlanmis baslik trigram indeksi
-- (docs/decisions/0029)
--
-- Arama artik token duzeyinde aday kapisi uyguluyor: sorgu ve baslik ayni
-- sekilde katlanir (Turkce kucuk harf + ASCII: ı->i, ş->s ...) ve bas isim
-- `strict_word_similarity` ile eslesmeli. Bu hesap her urun icin yapilirsa
-- 4 bin urunde 200-650 ms, 400 bin urunde onlarca saniye. Bu indeks bas isim
-- icin `<<%` operatoruyle (strict word similarity, varsayilan esik 0.5)
-- aday kumesini daraltir; pahali hesap yalnizca adaylarda calisir.
--
-- Ifade packages/core/src/search/text-match.ts `foldedTitleExpr` ile BIREBIR
-- ayni olmali — aksi halde planlayici indeksi kullanmaz. translate ve lower
-- IMMUTABLE oldugu icin ifade indekslenebilir.
--
-- Yalnizca ekleme: hicbir kolon/satir degismez, geri alinmasi DROP INDEX.

CREATE INDEX product_title_fold_trgm ON product
    USING gin (lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
