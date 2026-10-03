-- 0043 — form / anket merkezi (docs/decisions/0058)
--
-- Yonetici `/yonetim/formlar`'dan form olusturur, `/anket/<slug>` ile
-- yayinlar. Geri bildirimden (0032) ayridir: geri bildirim kullanicinin
-- kendiliginden yazdigi mesaj, form bizim sordugumuz yapilandirilmis sorular.
--
-- Model (normalize; secenek bazli dagilim SQL ile sayilir):
--   form -> form_question -> form_question_option
--   form_response -> form_answer (secenek cevabi = option_id, metin = text_value)
--   form_skip: onboarding'de "Simdilik gec" (tamamlandi SAYILMAZ)
--
-- Degismezler MOTOR tarafindan zorlanir:
-- - Tek yanitli formda giris yapmis kullanici en fazla bir yanit verir:
--   `single_response` yanit aninda formdan kopyalanir, kismi UNIQUE indeks
--   ikinci satiri reddeder (cift tik ve yaris durumu dahil).
-- - Ayni anda en fazla bir yayinda onboarding formu vardir (kismi UNIQUE).
-- - Onboarding formu anonim olamaz (kullaniciya baglidir).
-- - Cevap satiri ya secenek ya metin tasir, ikisi birden degil.
--
-- Kisisel veri: yanit `user_id` ile hesaba baglanir; hesap silinince
-- yanitlar, cevaplar ve atlama kayitlari silinir (ON DELETE CASCADE,
-- docs/kvkk.md "silme gercek olmalidir"). Anonim yanitta kimlik yoktur;
-- IP saklanmaz (oran siniri Redis'te ozetle).
--
-- Yetki: arilla_app 0010'daki varsayilan yetkiden SELECT/INSERT/UPDATE/DELETE
-- alir. anon/authenticated 0042'den beri varsayilan yetki ALMAZ (Data API).
--
-- Ilk onboarding formu bu migration'da veri olarak eklenir (slug
-- `seni-taniyalim`); slug zaten varsa hicbir sey yapilmaz (tekrar
-- calistirilabilir). Geriye uyumlu: yalnizca yeni tablolar ve indeksler.

CREATE TABLE IF NOT EXISTS form (
    id                        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug                      TEXT        NOT NULL UNIQUE
                                CHECK (char_length(slug) BETWEEN 3 AND 80
                                       AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title                     TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    description               TEXT        CHECK (description IS NULL OR char_length(description) <= 2000),
    status                    TEXT        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'published', 'closed')),
    audience                  TEXT        NOT NULL DEFAULT 'public'
                                CHECK (audience IN ('public', 'authenticated', 'early_access')),
    kind                      TEXT        NOT NULL DEFAULT 'survey'
                                CHECK (kind IN ('survey', 'onboarding')),
    allow_skip                BOOLEAN     NOT NULL DEFAULT false,
    allow_multiple_responses  BOOLEAN     NOT NULL DEFAULT false,
    starts_at                 TIMESTAMPTZ,
    ends_at                   TIMESTAMPTZ,
    created_by                BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    updated_by                BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    published_at              TIMESTAMPTZ,
    closed_at                 TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT form_window_order CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT form_onboarding_needs_user CHECK (kind <> 'onboarding' OR audience <> 'public')
);

CREATE UNIQUE INDEX IF NOT EXISTS form_one_published_onboarding
    ON form (kind) WHERE kind = 'onboarding' AND status = 'published';
CREATE INDEX IF NOT EXISTS form_created_idx ON form (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS form_question (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    form_id      BIGINT      NOT NULL REFERENCES form(id) ON DELETE CASCADE,
    label        TEXT        NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 300),
    description  TEXT        CHECK (description IS NULL OR char_length(description) <= 1000),
    type         TEXT        NOT NULL
                   CHECK (type IN ('single_choice', 'multiple_choice', 'short_text', 'long_text')),
    required     BOOLEAN     NOT NULL DEFAULT false,
    sort_order   INTEGER     NOT NULL CHECK (sort_order >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (form_id, sort_order)
);

CREATE TABLE IF NOT EXISTS form_question_option (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id  BIGINT      NOT NULL REFERENCES form_question(id) ON DELETE CASCADE,
    label        TEXT        NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
    sort_order   INTEGER     NOT NULL CHECK (sort_order >= 0),
    UNIQUE (question_id, sort_order)
);

CREATE TABLE IF NOT EXISTS form_response (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    form_id          BIGINT      NOT NULL REFERENCES form(id) ON DELETE CASCADE,
    user_id          BIGINT      REFERENCES app_user(id) ON DELETE CASCADE,
    -- Yanit anindaki `NOT form.allow_multiple_responses`; tek yanit indeksi icin.
    single_response  BOOLEAN     NOT NULL,
    source           TEXT        CHECK (source IS NULL OR source IN ('link', 'onboarding', 'account')),
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS form_response_single_user
    ON form_response (form_id, user_id) WHERE single_response AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS form_response_form_idx ON form_response (form_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS form_response_user_idx ON form_response (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS form_answer (
    id           BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    response_id  BIGINT  NOT NULL REFERENCES form_response(id) ON DELETE CASCADE,
    question_id  BIGINT  NOT NULL REFERENCES form_question(id) ON DELETE CASCADE,
    option_id    BIGINT  REFERENCES form_question_option(id) ON DELETE CASCADE,
    text_value   TEXT    CHECK (text_value IS NULL OR char_length(text_value) BETWEEN 1 AND 5000),
    CONSTRAINT form_answer_one_value CHECK ((option_id IS NULL) <> (text_value IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS form_answer_option_once
    ON form_answer (response_id, question_id, option_id) WHERE option_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS form_answer_text_once
    ON form_answer (response_id, question_id) WHERE option_id IS NULL;
CREATE INDEX IF NOT EXISTS form_answer_question_idx ON form_answer (question_id);
CREATE INDEX IF NOT EXISTS form_answer_option_idx ON form_answer (option_id) WHERE option_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS form_skip (
    form_id     BIGINT      NOT NULL REFERENCES form(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    skipped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (form_id, user_id)
);
CREATE INDEX IF NOT EXISTS form_skip_user_idx ON form_skip (user_id);

-- Ilk onboarding formu. Slug varsa (tekrar calistirma) dokunulmaz.
DO $$
DECLARE
    v_form  BIGINT;
    v_q     BIGINT;
    q       RECORD;
    opt     TEXT;
    i       INTEGER;
BEGIN
    INSERT INTO form (slug, title, description, status, audience, kind,
                      allow_skip, allow_multiple_responses, published_at)
    VALUES ('seni-taniyalim',
            'Seni biraz daha tanıyalım',
            'Birkaç kısa soru. Cevapların, ürünü ihtiyaçlarına göre geliştirmemize yardımcı olur. İstersen şimdilik geçebilir, daha sonra Hesabım sayfasından doldurabilirsin.',
            'published', 'early_access', 'onboarding', true, false, now())
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO v_form;

    IF v_form IS NULL THEN
        RETURN;
    END IF;

    FOR q IN
        SELECT * FROM (VALUES
            (0, 'Bizi nereden keşfettin?', 'single_choice', true,
                ARRAY['Instagram', 'TikTok', 'YouTube', 'Google', 'Arkadaş / tanıdık', 'Diğer']),
            (1, 'Platformu en çok ne için kullanmak istiyorsun?', 'single_choice', true,
                ARRAY['En uygun fiyatı bulmak', 'Fiyatları karşılaştırmak', 'Ürün araştırmak',
                      'Benzer ürünleri keşfetmek', 'Fiyat düşüşlerini takip etmek', 'Diğer']),
            (2, 'İnternetten ne sıklıkla alışveriş yapıyorsun?', 'single_choice', true,
                ARRAY['Haftada birkaç kez', 'Haftada yaklaşık bir kez', 'Ayda birkaç kez',
                      'Ayda bir veya daha az']),
            (3, 'Ürün araştırırken seni en çok ne zorluyor?', 'long_text', false, ARRAY[]::TEXT[]),
            (4, 'Platformda özellikle görmek istediğin bir özellik var mı?', 'long_text', false, ARRAY[]::TEXT[])
        ) AS t(sort_order, label, type, required, options)
    LOOP
        INSERT INTO form_question (form_id, label, type, required, sort_order)
        VALUES (v_form, q.label, q.type, q.required, q.sort_order)
        RETURNING id INTO v_q;

        i := 0;
        FOREACH opt IN ARRAY q.options LOOP
            INSERT INTO form_question_option (question_id, label, sort_order) VALUES (v_q, opt, i);
            i := i + 1;
        END LOOP;
    END LOOP;
END
$$;
