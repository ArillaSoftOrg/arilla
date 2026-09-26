-- 0026 — varyant fiyat olaylari (docs/decisions/0037)
--
-- `price_point` teklif duzeyindedir ve teklifin EN UCUZ varyantinin fiyatini
-- tasir; cok boyutlu bir teklifte (Korendy 60 ml + 100 ml) hangi gun hangi
-- boyutun fiyati oldugu hic kaydedilmez. Boyut secili fiyat gecmisi (0033) bu
-- yuzden cok boyutlu teklifler icin kurulamiyordu.
--
-- `variant_stock_event` ile ayni desen: satir yalnizca DEGISIMDE (ve ilk
-- gorulmede) yazilir; gunluk seri "son olay <= gun sonu" ile kurulur, teklifin
-- o gun gorulup gorulmedigi `price_point`tan okunur. Fiyat = varyantin etkin
-- fiyati (`price_override`, yoksa teklif fiyati).
--
-- Append-only (CLAUDE.md kural 4 ile ayni gerekce): arilla_app yalnizca
-- SELECT + INSERT. Geriye uyumlu: yeni tablo, mevcut hicbir sey degismez.
-- Gecmise donuk doldurma YAPILMAZ: eski gunlerin varyant fiyati bilinmiyor.

CREATE TABLE variant_price_event (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    variant_id  BIGINT      NOT NULL REFERENCES offer_variant(id) ON DELETE CASCADE,
    price       BIGINT      NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX variant_price_event_idx ON variant_price_event (variant_id, observed_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON variant_price_event FROM arilla_app;
