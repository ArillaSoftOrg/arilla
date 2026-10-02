/**
 * `user_activity_summary` yazıcısı (0036, docs/decisions/0049 §11). Kullanıcı
 * başına tek satır; yönetim listesi olay tablolarında COUNT yapmasın diye.
 *
 * Geçmiş uydurulmaz:
 * - Satır ilk olayda açılır; eski hesaplar için toplu doldurma yoktur.
 * - `sign_in_count` yalnızca `service_counters_since`'ten bu yana sayar;
 *   eski girişler bilinmiyor kalır.
 * - Analitik sayaçları yalnızca rızalı olayla artar ve
 *   `analytics_counters_since`'ten bu yana sayar. Rıza geri alınınca NULL olur.
 * - `first_sign_in_at` her durumda `app_user.created_at`'tir: hesap yalnızca
 *   başarılı bir girişin işleminde açılır, yani bu tahmin değil kayıttır.
 *
 * Her yazım tek bir `INSERT ... ON CONFLICT DO UPDATE` ifadesidir; eşzamanlı
 * istekler satırı ikiye bölemez ve sayaç kaybetmez.
 */
import type { ActivityEventKind, Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import type { RequestContext } from "./request-context.ts";

type Executor = Pick<Database, "execute">;

/** `last_active_at` en fazla bu sıklıkta yazılır (sıcak yolda gereksiz yazma yok). */
export const LAST_ACTIVE_THROTTLE_MS = 15 * 60 * 1000;

export async function upsertSignInSummary(
  db: Executor,
  input: { userId: number; at: Date; context: RequestContext },
): Promise<void> {
  const { userId, at, context } = input;
  await db.execute(sql`
    INSERT INTO user_activity_summary AS s (
      user_id, first_sign_in_at, last_sign_in_at, last_active_at,
      sign_in_count, service_counters_since,
      last_device_class, last_browser_family, last_country_code, updated_at
    )
    SELECT u.id, u.created_at, ${at}, ${at}, 1, ${at},
           ${context.deviceClass}, ${context.browserFamily}, ${context.countryCode}, now()
      FROM app_user u WHERE u.id = ${userId}
    ON CONFLICT (user_id) DO UPDATE SET
      first_sign_in_at = COALESCE(s.first_sign_in_at, EXCLUDED.first_sign_in_at),
      last_sign_in_at = GREATEST(s.last_sign_in_at, EXCLUDED.last_sign_in_at),
      last_active_at = GREATEST(s.last_active_at, EXCLUDED.last_active_at),
      sign_in_count = COALESCE(s.sign_in_count, 0) + 1,
      service_counters_since = COALESCE(s.service_counters_since, EXCLUDED.service_counters_since),
      last_device_class = COALESCE(EXCLUDED.last_device_class, s.last_device_class),
      last_browser_family = COALESCE(EXCLUDED.last_browser_family, s.last_browser_family),
      last_country_code = COALESCE(EXCLUDED.last_country_code, s.last_country_code),
      updated_at = now()
  `);
}

/**
 * Oturum doğrulamasında çağrılır. Bu oturumun önceki kullanımı eşikten
 * yeniyse hiç sorgu atılmaz. Atılırsa koşullu upsert yalnızca kayıt
 * eşikten eskiyse yazar. Eşzamanlı istekler en fazla bir kez yazar ve değer
 * geriye gitmez.
 */
export function shouldTouchLastActive(previousUse: Date | null, now: Date): boolean {
  if (!previousUse) return true;
  return now.getTime() - previousUse.getTime() >= LAST_ACTIVE_THROTTLE_MS;
}

export async function touchLastActive(
  db: Executor,
  input: { userId: number; previousUse: Date | null; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!shouldTouchLastActive(input.previousUse, now)) return false;
  const threshold = new Date(now.getTime() - LAST_ACTIVE_THROTTLE_MS);
  await db.execute(sql`
    INSERT INTO user_activity_summary AS s (user_id, last_active_at, updated_at)
    VALUES (${input.userId}, ${now}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      last_active_at = EXCLUDED.last_active_at,
      updated_at = now()
    WHERE s.last_active_at IS NULL OR s.last_active_at < ${threshold}
  `);
  return true;
}

/** Rızalı bir analitik olayıyla AYNI işlemde çağrılır (`record.ts`). */
export async function incrementAnalyticsCounter(
  db: Executor,
  input: { userId: number; kind: ActivityEventKind; at: Date },
): Promise<void> {
  const search = input.kind === "search_submitted" ? 1 : 0;
  const view = input.kind === "product_viewed" ? 1 : 0;
  const exit = input.kind === "merchant_exit" ? 1 : 0;
  const lastSearch = search ? input.at : null;
  await db.execute(sql`
    INSERT INTO user_activity_summary AS s (
      user_id, search_count, product_view_count, merchant_exit_count,
      last_search_at, analytics_counters_since, updated_at
    )
    VALUES (${input.userId}, ${search}, ${view}, ${exit}, ${lastSearch}, ${input.at}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      search_count = COALESCE(s.search_count, 0) + EXCLUDED.search_count,
      product_view_count = COALESCE(s.product_view_count, 0) + EXCLUDED.product_view_count,
      merchant_exit_count = COALESCE(s.merchant_exit_count, 0) + EXCLUDED.merchant_exit_count,
      last_search_at = COALESCE(GREATEST(s.last_search_at, EXCLUDED.last_search_at),
                                s.last_search_at, EXCLUDED.last_search_at),
      analytics_counters_since = COALESCE(s.analytics_counters_since, EXCLUDED.analytics_counters_since),
      updated_at = now()
  `);
}

/**
 * Analitik rızası geri alındı (0049 §8). Kullanıcının kişiye bağlı analitik
 * geçmişi silinir ve analitik sayaçları NULL'a çekilir. Hizmet/güvenlik
 * alanlarına dokunulmaz. Rıza satırıyla AYNI işlemde çağrılır. İdempotenttir.
 */
export async function clearAnalyticsData(
  db: Executor,
  userId: number,
): Promise<{ eventsDeleted: number }> {
  const deleted = await db.execute(sql`
    DELETE FROM user_activity_event WHERE user_id = ${userId}
  `);
  await db.execute(sql`
    UPDATE user_activity_summary
       SET search_count = NULL, product_view_count = NULL, merchant_exit_count = NULL,
           last_search_at = NULL, analytics_counters_since = NULL, updated_at = now()
     WHERE user_id = ${userId}
       AND analytics_counters_since IS NOT NULL
  `);
  return { eventsDeleted: deleted.rowCount ?? 0 };
}
