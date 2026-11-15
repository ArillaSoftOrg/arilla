-- Sohbet sonuc cevabi: INSAN DENETIMI ornegi. SALT OKUNUR.
--
-- Cikti: en yeni N cevap (varsayilan 50) icin sira no, sekme, otomatik dogrulayici sonucu, kullanici sorusu
-- (maskeli), cevap metni ve red kodlari. KULLANICI KIMLIGI, SOHBET KIMLIGI YOK.
-- Maske (basit, kusursuz DEGIL): e-posta, baglanti ve uzun rakam dizileri (telefon, kimlik) silinir.
-- Cikti denetciye (sahip) gider; baska yere kopyalanmadan once gozle kontrol edilir.
--
-- "auto_validated" otomatik dogrulayici sonucudur, insan onayi DEGILDIR. Karari insan yazar (correct /
-- unevidenced_claim / wrong / off_intent; bkz. docs/eval-data/chat-answer-pilot/*/README.md).
--
-- SINIR: cevabin dayandigi urun gercekleri (baslik/fiyat) SAKLANMAZ; payload 4 KB sinirinda ve migration
-- gerektirir. Denetci kartlari sorgu anindaki sonuclarla kiyaslar (fiyat degismis olabilir). Kalici cozum:
-- gercekleri ayri bir tabloda saklamak (migration + karar).
--
-- Calistirma:
--   ssh yusuf@<vps> "sudo -n docker exec -i arilla-postgres-1 sh -c 'psql -X -A -F , -q -U \"\$POSTGRES_USER\" -d \"\${POSTGRES_DB:-\$POSTGRES_USER}\"'" < infra/vps/reports/chat-answer-review-sample.sql
SET default_transaction_read_only = on;
SET statement_timeout = '25s';

WITH sample AS (
  SELECT a.id, a.conversation_id, a.seq, a.created_at, a.content AS answer_text,
         a.payload ->> 'answerTab' AS answer_tab,
         a.payload -> 'answer' ->> 'validated' AS auto_validated,
         COALESCE(a.payload -> 'answer' -> 'rejected', '[]'::jsonb)::text AS rejected_codes
    FROM chat_message a
   WHERE a.kind = 'notice' AND a.payload ? 'answer'
   ORDER BY a.id DESC
   LIMIT 50)
SELECT row_number() OVER (ORDER BY s.id DESC) AS n,
       s.created_at::date AS day,
       s.answer_tab,
       s.auto_validated,
       s.rejected_codes,
       regexp_replace(regexp_replace(regexp_replace(left(u.content, 300),
         '[[:alnum:]._%+-]+@[[:alnum:].-]+', '<eposta>', 'g'),
         'https?://[^[:space:]]+', '<baglanti>', 'g'),
         '[0-9][0-9 ().-]{6,}[0-9]', '<sayi>', 'g') AS question_masked,
       s.answer_text,
       '' AS human_verdict,
       '' AS human_notes
  FROM sample s
  LEFT JOIN chat_message u ON u.conversation_id = s.conversation_id AND u.seq = s.seq - 1 AND u.role = 'user'
 ORDER BY s.id DESC;
