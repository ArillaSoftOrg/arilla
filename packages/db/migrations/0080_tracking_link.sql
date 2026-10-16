-- kind: schema
-- 0080 — takip baglantilari (karar 0115)
--
-- YALNIZCA EKLEME. Yeni tablolar; mevcut hicbir sey degismez.
--
-- tracking_link:            yonetimden olusturulan kisa baglanti (manicepte.com/<slug>).
--                           Slug olusturulduktan sonra DEGISMEZ (basili/paylasilmis baglanti
--                           kirilmasin). Silinmez, yalnizca pasife alinir.
-- tracking_link_click_hour: saat basina tiklama SAYACI. IP, User-Agent, oturum, cerez ya da
--                           herhangi bir kisi tanimlayicisi YOKTUR (CLAUDE.md kural 8 kapsami
--                           disi: hedef kendi alan adimizdir, merchant'a cikis degildir).
--                           Gunluk gorunum bu tablodan sorguda toplanir (Europe/Istanbul).

CREATE TABLE tracking_link (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    -- Kucuk harf ASCII, rakam, tire; 1-40 karakter; tire ile baslayip bitmez.
    -- Rezerve sistem yollari kodda (ve testte gercek rota klasorlerinden) denetlenir.
    slug        TEXT        NOT NULL
                CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
    -- Mutlak https adresi ya da kokten baslayan yol (`/`, `/trendler/x`). `//` ve `\` yok.
    -- Izinli alan adlari (yalniz ManiCepte) kodda dogrulanir; veritabani sekli korur.
    target_url  TEXT        NOT NULL
                CHECK (char_length(target_url) <= 2000
                       AND target_url !~ '[[:space:][:cntrl:][.backslash.]]'
                       AND (target_url ~ '^https://[^/?#]+' OR target_url ~ '^/([^/]|$)')),
    -- Serbest metin degil: kucuk harf/rakam/tire/alt cizgi. utm_source / utm_campaign olarak
    -- hedefe eklenir (Umami ve GA4 kampanya ayrimi icin).
    source      TEXT        CHECK (source IS NULL OR source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    campaign    TEXT        CHECK (campaign IS NULL OR campaign ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by  BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tracking_link_slug_uniq UNIQUE (slug)
);
CREATE INDEX tracking_link_created_idx ON tracking_link (created_at DESC, id DESC);

CREATE TABLE tracking_link_click_hour (
    link_id  BIGINT      NOT NULL REFERENCES tracking_link(id),
    -- UTC saat basi (`date_trunc('hour', now())`).
    hour     TIMESTAMPTZ NOT NULL CHECK (hour = date_trunc('hour', hour)),
    clicks   INTEGER     NOT NULL CHECK (clicks >= 0),
    PRIMARY KEY (link_id, hour)
);
CREATE INDEX tracking_link_click_hour_time_idx ON tracking_link_click_hour (hour);

-- Baglanti silinmez (pasife alinir); sayac satirlari toplu temizlik disinda silinmez.
REVOKE DELETE, TRUNCATE ON tracking_link FROM arilla_app;
REVOKE TRUNCATE ON tracking_link_click_hour FROM arilla_app;
