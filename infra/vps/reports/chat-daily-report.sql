-- Sohbet gunluk gozlem raporu. SALT OKUNUR, YALNIZCA TOPLULASTIRMA:
-- mesaj icerigi, sorgu metni, kullanici kimligi ya da model cevabi DONMEZ (yalnizca sayilar ve sabit kodlar).
--
-- Calistirma (VPS, root gerekmez; yusuf + sudo -n):
--   ssh yusuf@<vps> "sudo -n docker exec -i arilla-postgres-1 sh -c 'psql -X -q -U \"\$POSTGRES_USER\" -d \"\${POSTGRES_DB:-\$POSTGRES_USER}\"'" < infra/vps/reports/chat-daily-report.sql
--
-- Dikkat:
-- * "validated" otomatik dogrulayici sonucudur; insan onayi DEGILDIR.
-- * Gecikme: kullanici mesaji ile asistan cevabi arasindaki sure (kuyruk + model + arama dahil), saniye.
-- * api_usage.units yalniz toplam token'dir (girdi/cikti ayrimi yok); maliyet tahmini ARALIKTIR, kesin degildir.
-- * Gemini satirlarinda cost_micros 0 ise LLM_COST_TRY_PER_USD ortam degiskeni bos olabilir (llm/pricing.ts).
SET default_transaction_read_only = on;
SET statement_timeout = '25s';

\echo == A. etkinlik, son 24 saat
SELECT (SELECT count(*) FROM conversation WHERE created_at > now() - interval '24 hours') AS conversations_created,
       (SELECT count(DISTINCT user_id) FROM conversation WHERE created_at > now() - interval '24 hours') AS distinct_users,
       (SELECT count(*) FROM chat_message WHERE role = 'user' AND created_at > now() - interval '24 hours') AS user_msgs,
       (SELECT count(*) FROM chat_message WHERE role = 'assistant' AND created_at > now() - interval '24 hours') AS assistant_msgs;

\echo == B. asistan sonuclari 24 saat (tur, kaynak, yedek nedeni kodu)
SELECT kind, COALESCE(payload ->> 'source', '-') AS source, COALESCE(payload ->> 'fallbackReason', '-') AS fallback_reason, count(*)
  FROM chat_message WHERE role = 'assistant' AND created_at > now() - interval '24 hours'
 GROUP BY 1, 2, 3 ORDER BY 4 DESC;

\echo == C. sonuc cevaplari (answer): dogrulandi / kaynak / sekme
SELECT '24h' AS win, payload -> 'answer' ->> 'validated' AS validated, payload ->> 'source' AS source, payload ->> 'answerTab' AS tab, count(*)
  FROM chat_message WHERE kind = 'notice' AND payload ? 'answer' AND created_at > now() - interval '24 hours' GROUP BY 1, 2, 3, 4
UNION ALL
SELECT '7d', payload -> 'answer' ->> 'validated', payload ->> 'source', payload ->> 'answerTab', count(*)
  FROM chat_message WHERE kind = 'notice' AND payload ? 'answer' AND created_at > now() - interval '7 days' GROUP BY 1, 2, 3, 4;

\echo == D. red nedeni kodlari, 7 gun (paragraf duzeyi)
SELECT r AS reason, count(*)
  FROM chat_message m, LATERAL jsonb_array_elements_text(COALESCE(m.payload -> 'answer' -> 'rejected', '[]'::jsonb)) r
 WHERE m.kind = 'notice' AND m.created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;

\echo == E. tur gecikmesi (s)
WITH turns AS (
  SELECT a.created_at - u.created_at AS d, a.created_at
    FROM chat_message a JOIN chat_message u ON u.conversation_id = a.conversation_id AND u.seq = a.seq - 1 AND u.role = 'user'
   WHERE a.role = 'assistant')
SELECT '24h' AS win, count(*) AS n,
       round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY d))::numeric, 1) AS p50_s,
       round(extract(epoch FROM percentile_cont(0.95) WITHIN GROUP (ORDER BY d))::numeric, 1) AS p95_s,
       round(extract(epoch FROM max(d))::numeric, 1) AS max_s
  FROM turns WHERE created_at > now() - interval '24 hours'
UNION ALL
SELECT '7d', count(*),
       round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY d))::numeric, 1),
       round(extract(epoch FROM percentile_cont(0.95) WITHIN GROUP (ORDER BY d))::numeric, 1),
       round(extract(epoch FROM max(d))::numeric, 1)
  FROM turns WHERE created_at > now() - interval '7 days';

\echo == F. Gemini api_usage: cagri, token, fiyatlanmamis (cost_micros = 0 ve onbellek degil)
SELECT w.win, u.operation, count(*) AS calls, sum(u.units) AS tokens, round(avg(u.units)) AS avg_tokens,
       count(*) FILTER (WHERE u.cost_micros = 0 AND NOT u.cache_hit) AS unpriced
  FROM (VALUES ('24h', interval '24 hours'), ('7d', interval '7 days')) AS w(win, span)
  JOIN api_usage u ON u.created_at > now() - w.span AND u.model_version LIKE 'gemini%'
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo == G. tahmini maliyet ARALIGI (USD): girdi 0,25 / cikti 1,50 USD per 1M token (llm/pricing.ts kurali); cikti payi %5-%25
WITH t AS (SELECT w.win, sum(u.units)::numeric AS tokens
             FROM (VALUES ('24h', interval '24 hours'), ('7d', interval '7 days')) AS w(win, span)
             JOIN api_usage u ON u.created_at > now() - w.span AND u.model_version LIKE 'gemini%'
            GROUP BY 1)
SELECT win, tokens,
       round((tokens * (0.95 * 0.25 + 0.05 * 1.50) / 1e6), 4) AS usd_low,
       round((tokens * (0.885 * 0.25 + 0.115 * 1.50) / 1e6), 4) AS usd_mid,
       round((tokens * (0.75 * 0.25 + 0.25 * 1.50) / 1e6), 4) AS usd_high
  FROM t ORDER BY win;

\echo == H. geri bildirim, 7 gun (sonuc oyu / aciklama oyu)
SELECT 'result' AS t, helpful, count(*) FROM chat_result_feedback WHERE created_at > now() - interval '7 days' GROUP BY 2
UNION ALL
SELECT 'explanation', helpful, count(*) FROM chat_explanation_feedback WHERE created_at > now() - interval '7 days' GROUP BY 2;

\echo == I. gunluk asistan mesaji, 7 gun
SELECT created_at::date AS day, count(*) FROM chat_message WHERE role = 'assistant' AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1 DESC;

\echo == J. 5 dakikadan uzun takili sohbet
SELECT count(*) AS stuck_conversations FROM conversation WHERE processing_until IS NOT NULL AND processing_until < now() - interval '5 minutes';
