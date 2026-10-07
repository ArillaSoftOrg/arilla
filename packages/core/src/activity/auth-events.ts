/**
 * Giriş/çıkış geçmişi (`auth_event`, 0036, docs/decisions/0049 §4).
 *
 * Hizmet/güvenlik sınıfıdır: analitik rızası gerekmez ve rıza kararından
 * etkilenmez. Satırda yalnızca tür, sağlayıcı, oturum kimliği ve kaba bağlam
 * (cihaz sınıfı, tarayıcı ailesi, ülke kodu) bulunur. IP, ham user agent,
 * token, istek başlığı ya da gövdesi YAZILMAZ.
 *
 * Girişte çağıran işlemin (`createSessionForUser`) içinde çalışır: oturum
 * açılamazsa olay da yazılmaz.
 */
import type { AuthEventKind, AuthEventProvider, Database } from "@arilla/db";
import { authEvent } from "@arilla/db";
import { sql } from "drizzle-orm";
import { EMPTY_REQUEST_CONTEXT, type RequestContext } from "./request-context.ts";
import { upsertSignInSummary } from "./summary.ts";

type Executor = Pick<Database, "insert" | "execute">;

export interface SignInEventInput {
  userId: number;
  provider: AuthEventProvider;
  /** Hesap bu işlemde mi açıldı. `sign_up` yalnızca o zaman yazılır. */
  isNewUser: boolean;
  sessionId: string;
  context?: RequestContext;
  at?: Date;
}

/**
 * `sign_up` (yalnızca yeni hesapta) + `sign_in` + özet güncellemesi.
 * Eşzamanlı ilk giriş yarışında `auth_event_one_sign_up` kısmi benzersiz
 * indeksi ikinci kayıt satırını engeller. Bu yüzden ekleme `ON CONFLICT
 * DO NOTHING` ile yapılır ve kaybeden işlem hata vermez.
 */
export async function recordSignIn(db: Executor, input: SignInEventInput): Promise<void> {
  const context = input.context ?? EMPTY_REQUEST_CONTEXT;
  const at = input.at ?? new Date();
  if (input.isNewUser) {
    await db.execute(sql`
      INSERT INTO auth_event (user_id, kind, provider, session_id, device_class, browser_family, country_code, created_at)
      VALUES (${input.userId}, 'sign_up', ${input.provider}, ${input.sessionId},
              ${context.deviceClass}, ${context.browserFamily}, ${context.countryCode}, ${at})
      ON CONFLICT (user_id) WHERE kind = 'sign_up' DO NOTHING
    `);
  }
  await db.insert(authEvent).values({
    userId: input.userId,
    kind: "sign_in",
    provider: input.provider,
    sessionId: input.sessionId,
    deviceClass: context.deviceClass,
    browserFamily: context.browserFamily,
    countryCode: context.countryCode,
    createdAt: at,
  });
  await upsertSignInSummary(db, { userId: input.userId, at, context });
}

export type SessionEndKind = Extract<AuthEventKind, "sign_out" | "session_revoked">;

/** Oturum sonu: kullanıcı çıkışı (`sign_out`) ya da sunucunun sonlandırması (`session_revoked`). */
export async function recordSessionEnd(
  db: Pick<Database, "insert">,
  input: { userId: number; sessionId: string; kind: SessionEndKind; at?: Date },
): Promise<void> {
  await db.insert(authEvent).values({
    userId: input.userId,
    kind: input.kind,
    sessionId: input.sessionId,
    createdAt: input.at ?? new Date(),
  });
}
