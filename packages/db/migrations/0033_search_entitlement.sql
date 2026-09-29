-- 0033 — arama hakki: gunluk hak, bonus hak, harcama kaydi, davet (docs/decisions/0046)
--
-- Fotograf ve link aramasi (gercek saglayici maliyeti) artik Redis'teki
-- sabit pencereli sayactan degil, buradaki kalici haktan harcar. Metin
-- aramasi bu tablolara hic dokunmaz.
--
-- Degismezler MOTOR tarafindan zorlanir, kod incelemesine birakilmaz:
-- - `ai_quota_day.used` 0 ile `daily_limit` arasinda (CHECK).
-- - `bonus_account.balance` eksiye dusemez (CHECK). 100 tavani odul
--   yazan tek SQL ifadesinde uygulanir; tavan migration'siz degisebilsin.
-- - Kullanici basina en fazla bir `reserved` harcama (kismi UNIQUE indeks):
--   ayni anda tek pahali arama.
-- - Ayni istek anahtari iki kez harcanamaz (UNIQUE (user_id, request_key)).
-- - Ayni odul/iade iki kez yazilamaz (`bonus_ledger.idempotency_key` UNIQUE).
-- - Bir kullanici en fazla bir kez davet edilmis sayilir
--   (UNIQUE (invitee_user_id)); kendi kendini davet CHECK ile engellenir.
--
-- Gece sifirlama isi yok: gunluk satir `(user_id, day)` ile ilk kullanimda
-- acilir. `day` Europe/Istanbul takvim gunudur (zaman damgasi degil,
-- anahtar); uygulama onu SQL'de `(now() AT TIME ZONE 'Europe/Istanbul')::date`
-- ile hesaplar.
--
-- Hesap silme (docs/kvkk.md, 0046 madde 11): kullaniciya ait her satir
-- ON DELETE CASCADE ile gider. Davet edenin hesabi silinirse davet
-- satirindaki `inviter_user_id` NULL'a cekilir (davet edilenin kaydi onun
-- verisidir). Silme sonrasi saglayici kimligi ozeti TUTULMAZ.
--
-- `bonus_ledger` append-only (0010/0027 ile ayni gerekce): arilla_app
-- yalnizca SELECT + INSERT. Kullanici silindiginde CASCADE / SET NULL
-- referans eylemleri tablo sahibi yetkisiyle calisir, REVOKE onlari
-- engellemez (entegrasyon testi dogrular).
--
-- arilla_app yetkisi 0010'daki ALTER DEFAULT PRIVILEGES'ten gelir.
-- Geriye uyumlu: yeni tablolar + `app_user`'a nullable bir kolon.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS referral_code TEXT
    CHECK (referral_code IS NULL OR referral_code ~ '^[A-HJ-NP-Z2-9]{8}$');
CREATE UNIQUE INDEX IF NOT EXISTS app_user_referral_code_unique
    ON app_user (referral_code) WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_quota_day (
    user_id      BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    day          DATE        NOT NULL,
    -- Satir acildigi andaki limit; ortam degiskeni gun icinde degisirse o
    -- gunun hakki geriye donuk degismez.
    daily_limit  INTEGER     NOT NULL CHECK (daily_limit >= 0),
    used         INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day),
    CONSTRAINT ai_quota_day_used_within_limit CHECK (used >= 0 AND used <= daily_limit)
);

CREATE TABLE IF NOT EXISTS bonus_account (
    user_id     BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    balance     INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bonus_account_balance_non_negative CHECK (balance >= 0)
);

-- Pahali aramanin hak kaydi. `id` sunucuda uretilen arama kimligidir.
-- Durum makinesi: reserved -> settled | refunded; geri donus yok (uygulama
-- kosullu UPDATE ... WHERE state = 'reserved' kullanir).
CREATE TABLE IF NOT EXISTS ai_search_charge (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    operation        TEXT        NOT NULL CHECK (operation IN ('visual_search','link_search')),
    -- Istemcinin form basina urettigi opak anahtar; yalnizca kullanici
    -- icinde tekillestirme icindir, hicbir deger tasimaz.
    request_key      TEXT        NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 100),
    cost             INTEGER     NOT NULL CHECK (cost > 0),
    day              DATE        NOT NULL,
    from_daily       INTEGER     NOT NULL CHECK (from_daily >= 0),
    from_bonus       INTEGER     NOT NULL CHECK (from_bonus >= 0),
    state            TEXT        NOT NULL DEFAULT 'reserved'
                     CHECK (state IN ('reserved','settled','refunded')),
    image_upload_id  BIGINT      REFERENCES image_upload(id) ON DELETE SET NULL,
    link_request_id  UUID        REFERENCES link_resolution_request(id) ON DELETE SET NULL,
    -- Kararli kod: 'provider_error','provider_unavailable','internal_error',
    -- 'link_failed','link_stale','link_reused','queue_unavailable'
    refund_reason    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at     TIMESTAMPTZ,
    CONSTRAINT ai_search_charge_split CHECK (from_daily + from_bonus = cost),
    CONSTRAINT ai_search_charge_finalized CHECK ((state = 'reserved') = (finalized_at IS NULL)),
    CONSTRAINT ai_search_charge_refund_reason CHECK ((state = 'refunded') = (refund_reason IS NOT NULL)),
    CONSTRAINT ai_search_charge_ref_kind CHECK (
        (operation = 'visual_search' AND link_request_id IS NULL) OR
        (operation = 'link_search' AND image_upload_id IS NULL)
    ),
    CONSTRAINT ai_search_charge_request_key_unique UNIQUE (user_id, request_key)
);
-- Kullanici basina ayni anda tek pahali arama.
CREATE UNIQUE INDEX IF NOT EXISTS ai_search_charge_one_active
    ON ai_search_charge (user_id) WHERE state = 'reserved';
CREATE INDEX IF NOT EXISTS ai_search_charge_user_idx
    ON ai_search_charge (user_id, created_at DESC);
-- Gunluk supurme: askida kalan ayirmalar.
CREATE INDEX IF NOT EXISTS ai_search_charge_reserved_idx
    ON ai_search_charge (created_at) WHERE state = 'reserved';
-- Link durum sorgusundan harcamaya.
CREATE INDEX IF NOT EXISTS ai_search_charge_link_request_idx
    ON ai_search_charge (link_request_id) WHERE link_request_id IS NOT NULL;

-- Davet. `inviter_user_id` davet edenin hesabi silinince NULL olur;
-- davet edilenin hesabi silinince satir gider.
CREATE TABLE IF NOT EXISTS referral (
    id                    BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inviter_user_id       BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    invitee_user_id       BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','qualified')),
    qualifying_charge_id  UUID        REFERENCES ai_search_charge(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    qualified_at          TIMESTAMPTZ,
    CONSTRAINT referral_invitee_unique UNIQUE (invitee_user_id),
    CONSTRAINT referral_not_self CHECK (inviter_user_id IS DISTINCT FROM invitee_user_id),
    CONSTRAINT referral_qualified_at CHECK ((status = 'qualified') = (qualified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS referral_inviter_idx
    ON referral (inviter_user_id, created_at DESC) WHERE inviter_user_id IS NOT NULL;

-- Bonus defteri (append-only). Her bakiye degisikligi tam bir satir;
-- `idempotency_key` ayni odulun/iadenin ikinci kez yazilmasini engeller:
-- 'charge:<id>', 'refund:<id>', 'referral:<id>:inviter',
-- 'referral:<id>:invitee', 'feedback_first:<user_id>'.
CREATE TABLE IF NOT EXISTS bonus_ledger (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    delta            INTEGER     NOT NULL CHECK (delta <> 0),
    -- Tavan kirpmasindan onceki tutar (odullerde); iade/harcamada delta ile ayni.
    requested        INTEGER     NOT NULL CHECK (requested <> 0),
    balance_after    INTEGER     NOT NULL CHECK (balance_after >= 0),
    reason           TEXT        NOT NULL CHECK (reason IN (
                         'search_charge','search_refund','referral_inviter',
                         'referral_invitee','feedback_first','admin_grant','campaign')),
    idempotency_key  TEXT        NOT NULL,
    charge_id        UUID        REFERENCES ai_search_charge(id) ON DELETE CASCADE,
    referral_id      BIGINT      REFERENCES referral(id) ON DELETE SET NULL,
    actor_user_id    BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bonus_ledger_idempotency_key_unique UNIQUE (idempotency_key),
    CONSTRAINT bonus_ledger_sign CHECK ((reason = 'search_charge') = (delta < 0))
);
CREATE INDEX IF NOT EXISTS bonus_ledger_user_idx ON bonus_ledger (user_id, created_at DESC, id DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON bonus_ledger FROM arilla_app;
