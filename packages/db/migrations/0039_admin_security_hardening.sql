-- 0039 — yonetim guvenligi sertlestirme (docs/decisions/0050)
--
-- 1. ROL DEGISIKLIGI DENETIMI, MOTORDA. `app_user.role` her degistiginde
--    (ve 'user' disi rolle hesap acildiginda) ayni islemde
--    `admin_audit_event`'e `users.role_change` satiri yazilir. Kod yolu,
--    betik ya da elle SQL fark etmez: tetikleyiciyi yalnizca tablo sahibi
--    kaldirabilir, `arilla_app` kaldiramaz. Islem geri alinirsa kayit da
--    geri alinir; satir varsa degisiklik UYGULANMISTIR (`outcome: applied`).
--
--    Aktor istege bagli oturum ayarlarindan okunur (`set-role.ts` ve
--    `revoke-sessions.ts` doldurur):
--      arilla.audit_actor_user_id, arilla.audit_actor_role, arilla.audit_reason
--    Ayar yoksa aktor NULL, rol 'db'. Ayar sahte olabilir; bu yuzden
--    baglanan veritabani rolu (`session_user`) ayrica `after.dbRole`'e
--    yazilir — uygulama rolunden yapilan bir rol yukseltmesi boyle gorunur.
--    Kisisel veri yok: yalnizca hesap kimligi ve rol adlari.
--
-- 2. SILME POLITIKASI. `admin_audit_event.actor_user_id` ve
--    `match_candidate.reviewed_by` CASCADE'siz FK idi: kaydi olan hesap
--    silinemiyordu (hesap silme 500). Yeni kural:
--    - Yetkili (moderator/admin) hesap KENDINI silemez; once rolu dusurulur
--      (o da bu tetikleyiciyle denetlenir). Kural core'da
--      (`deleteAccount`), cunku hata mesaji kullaniciya doner.
--    - Rolu 'user' olan hesap silinince denetim satirlari KALIR; yalnizca
--      aktor baglantisi NULL olur (`actor_role`, eylem, hedef, zaman
--      korunur). Referans eylemi tablo sahibi yetkisiyle calisir; append-only
--      REVOKE'u (0027) uygulama rolu icin aynen gecerli.
--
-- 3. GERI DOLDURMA. Tetikleyiciden once atanmis her yetkili hesap icin bir
--    `users.role_change` satiri (`outcome: backfill`). Tekrar kosulursa
--    ikinci satir yazilmaz.
--
-- Geriye uyumlu (kural 14): kolon silinmez; NOT NULL kaldirilir, FK
-- eylemi degisir, tetikleyici eklenir. Eski kod her zaman aktor yazar.

ALTER TABLE admin_audit_event ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_actor_user_id_fkey;
ALTER TABLE admin_audit_event
    ADD CONSTRAINT admin_audit_event_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES app_user(id) ON DELETE SET NULL;

ALTER TABLE match_candidate DROP CONSTRAINT IF EXISTS match_candidate_reviewed_by_fkey;
ALTER TABLE match_candidate
    ADD CONSTRAINT match_candidate_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES app_user(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE match_candidate VALIDATE CONSTRAINT match_candidate_reviewed_by_fkey;

CREATE OR REPLACE FUNCTION audit_app_user_role_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_id   BIGINT := NULLIF(current_setting('arilla.audit_actor_user_id', true), '')::BIGINT;
    v_actor_role TEXT   := COALESCE(NULLIF(current_setting('arilla.audit_actor_role', true), ''), 'db');
    v_reason     TEXT   := NULLIF(current_setting('arilla.audit_reason', true), '');
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.role = 'user' THEN
        RETURN NEW;
    END IF;

    INSERT INTO admin_audit_event
        (actor_user_id, actor_role, action, target_type, target_id, before, after, reason)
    VALUES (
        v_actor_id,
        left(v_actor_role, 40),
        'users.role_change',
        'app_user',
        NEW.id::TEXT,
        CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('role', OLD.role) END,
        jsonb_build_object('role', NEW.role, 'outcome', 'applied', 'dbRole', session_user::TEXT),
        left(v_reason, 500)
    );
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS app_user_role_change_audit ON app_user;
CREATE TRIGGER app_user_role_change_audit
    AFTER INSERT OR UPDATE OF role ON app_user
    FOR EACH ROW EXECUTE FUNCTION audit_app_user_role_change();

INSERT INTO admin_audit_event
    (actor_user_id, actor_role, action, target_type, target_id, before, after, reason)
SELECT NULL, 'migration', 'users.role_change', 'app_user', u.id::TEXT, NULL,
       jsonb_build_object('role', u.role, 'outcome', 'backfill'),
       '0039: rol, denetim tetikleyicisinden once atanmis'
FROM app_user u
WHERE u.role <> 'user'
  AND NOT EXISTS (
      SELECT 1 FROM admin_audit_event e
      WHERE e.action = 'users.role_change'
        AND e.target_type = 'app_user'
        AND e.target_id = u.id::TEXT
  );
