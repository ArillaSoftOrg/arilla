/**
 * `/geri-bildirim` gonderimi (docs/decisions/0045). Tek yazma yolu; tarayici
 * tabloya dogrudan yazmaz, veritabaninda public INSERT politikasi yoktur.
 *
 * Sira: oturum (cagiran verir) -> dogrulama -> oran siniri -> INSERT.
 *
 * - `user` yalnizca sunucudaki oturumdan gelir. Formdaki her `user_id`
 *   benzeri alan dogrulamada bilinmeyen alan olarak reddedilir.
 * - Girisli: `user_id` + hesap e-postasi, `source = early_access`.
 *   Anonim: `user_id = NULL`, istege bagli e-posta, `source = public`.
 * - Hata ayrintisi (SQL, Redis, yigin izi) cagirana ve kayitlara gitmez:
 *   yalnizca sabit bir durum doner, logda yalnizca hata kodu yer alir.
 *   Geri bildirim metni ve e-posta asla loglanmaz.
 */
import { type Database, feedback } from "@arilla/db";
import type { FixedWindowCounter } from "../auth/rate-limit.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import { consumeFeedbackQuota } from "./rate-limit.ts";
import { type FeedbackField, type FeedbackFieldError, validateFeedback } from "./validate.ts";

export interface FeedbackAuthor {
  id: number;
  email: string | null;
}

export type SubmitFeedbackResult =
  | { status: "ok" }
  | {
      status: "invalid";
      fieldErrors: Partial<Record<FeedbackField, FeedbackFieldError>>;
      formError?: "malformed" | "too_large";
    }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/** Postgres/Redis hata kodu (orn. `23514`); mesaj ya da deger icermez. */
function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/i.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

export async function submitFeedback(
  db: Pick<Database, "insert">,
  input: {
    fields: Iterable<[string, unknown]>;
    user: FeedbackAuthor | null;
    ip: string | null;
  },
  increment?: FixedWindowCounter,
): Promise<SubmitFeedbackResult> {
  const { user } = input;
  const validation = validateFeedback(input.fields, { authenticated: user !== null });
  if (!validation.ok) {
    return validation.formError
      ? { status: "invalid", fieldErrors: validation.fieldErrors, formError: validation.formError }
      : { status: "invalid", fieldErrors: validation.fieldErrors };
  }

  try {
    const allowed = await consumeFeedbackQuota(
      { userId: user?.id ?? null, ip: input.ip },
      increment,
    );
    if (!allowed) return { status: "rate_limited" };
  } catch (error) {
    if (isRedisUnavailableError(error)) {
      console.error("[feedback] rate limit unavailable");
      return { status: "unavailable" };
    }
    throw error;
  }

  const value = validation.value;
  try {
    await db.insert(feedback).values({
      userId: user?.id ?? null,
      email: user ? user.email : value.email,
      category: value.category,
      title: value.title,
      message: value.message,
      priority: value.priority,
      source: user ? "early_access" : "public",
    });
  } catch (error) {
    console.error(`[feedback] insert failed: ${errorCode(error)}`);
    return { status: "unavailable" };
  }
  return { status: "ok" };
}
