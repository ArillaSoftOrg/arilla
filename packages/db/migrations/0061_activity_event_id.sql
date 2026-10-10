-- 0061 — davranissal olaylara event_id ve schema_version (docs/decisions/0100)
--
-- user_activity_event: tekrarlanan yazimlari (yeniden deneme, cift istek) kullanici
-- bazinda tekillestiren `event_id` ve olay bicimini versiyonlayan `schema_version`.
--
-- schema_version = 1: eski bicim (event_id yok). Mevcut tum satirlar ve migration ile
--                     kod dagitimi arasinda eski kodun yazdigi satirlar bu degerde kalir.
-- schema_version = 2: event_id zorunlu; yeni yazici (packages/core/src/activity/record.ts).
--
-- Yalnizca ekleme: `event_id` nullable (eski satirlar uydurma kimlik almaz, veri
-- tasinmaz, tablo yeniden yazilmaz); `schema_version` sabit varsayilanli (hizli ekleme).
-- Yeni kisisel veri alani yok: ikisi de rastgele/turetilmis teknik degerdir.
-- UPDATE yetkisi acilmaz; idempotency INSERT ... ON CONFLICT DO NOTHING ile saglanir.
-- Geri alma: once kod geri alinir; kolonlar zararsiz kalabilir.

ALTER TABLE user_activity_event
    ADD COLUMN IF NOT EXISTS event_id       UUID,
    ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE user_activity_event
    ADD CONSTRAINT user_activity_event_schema_version_check
        CHECK (schema_version >= 1),
    ADD CONSTRAINT user_activity_event_event_id_required
        CHECK (schema_version < 2 OR event_id IS NOT NULL);

-- Kullanici kapsamli: baska kullanicinin kimligiyle carpisma/sizinti olmaz.
-- NULL'lar (eski satirlar) birbirinden farklidir; cakisma sayilmaz.
CREATE UNIQUE INDEX IF NOT EXISTS user_activity_event_user_event_id_uidx
    ON user_activity_event (user_id, event_id);
