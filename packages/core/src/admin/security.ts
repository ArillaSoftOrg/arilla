/**
 * Yönetim güvenlik olayları ve oturum kapatma (docs/decisions/0050).
 *
 * - Reddedilen yönetim erişimi ve sunucuda sonlandırılan yönetim oturumu
 *   denetim kaydına düşer: yetki yükseltme denemesi ve çalınmış çerezle
 *   gelen istek `/yonetim/denetim`'de görünür. Yol, IP, user agent, e-posta
 *   YAZILMAZ; yalnızca hesap kimliği, rol ve yetenek/neden.
 * - "Tüm oturumları kapat": kullanıcının kendisi (`/hesap`) ya da yönetici
 *   (`/yonetim/kullanicilar/[publicId]`, taze giriş). Acil durum için
 *   veritabanı betiği: `pnpm db:revoke-sessions` (docs/ops.md).
 */
import { appUser, type Database, session } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import type { UserRole } from "../auth/types.ts";
import { recordAdminEvent } from "./audit.ts";
import {
  type AdminActor,
  assertCapability,
  type Capability,
  hasCapability,
} from "./capabilities.ts";

/** Aynı hesap + yetenek için reddedilen erişim en fazla bu aralıkta bir kez yazılır. */
export const ACCESS_DENIED_DEDUPE_MINUTES = 10;

/**
 * Girişli ama yetkisiz hesabın yönetim isteği. Sayfa yenilemeleri ve
 * otomatik denemeler tabloyu şişirmesin diye hesap + yetenek başına
 * `ACCESS_DENIED_DEDUPE_MINUTES` dakikada bir satır (koşullu INSERT;
 * `admin_audit_event_actor_idx` ile tek indeks taraması).
 *
 * Next aynı istekte layout ile sayfayı EŞZAMANLI çizer; ikisi de yetki
 * kapısından geçer. Koşullu INSERT tek başına yarışı kaybeder (iki işlem de
 * "yok" görür), bu yüzden hesap + yetenek başına işlem kilidi alınır.
 */
export async function recordAccessDenied(
  db: Database,
  user: { id: number; role: UserRole },
  capability: Capability,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`access_denied:${user.id}:${capability}`}, 0))`,
    );
    await insertAccessDenied(tx, user, capability);
  });
}

async function insertAccessDenied(
  db: Pick<Database, "execute">,
  user: { id: number; role: UserRole },
  capability: Capability,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO admin_audit_event
      (actor_user_id, actor_role, action, target_type, target_id, after)
    SELECT ${user.id}, ${user.role}, 'security.access_denied', 'capability', ${capability},
           ${JSON.stringify({ outcome: "denied" })}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM admin_audit_event
       WHERE actor_user_id = ${user.id}
         AND action = 'security.access_denied'
         AND target_id = ${capability}
         AND created_at > now() - make_interval(mins => ${ACCESS_DENIED_DEDUPE_MINUTES})
    )
  `);
}

export type AdminSessionEndReason = "expired" | "idle";

/** Yönetim oturumu 12 saat / 30 dakika kuralıyla sunucuda sonlandırıldı. */
export async function recordAdminSessionEnded(
  db: Database,
  user: { id: number; role: UserRole },
  reason: AdminSessionEndReason,
): Promise<void> {
  await recordAdminEvent(db, {
    actor: { userId: user.id, role: user.role },
    action: "security.admin_session_ended",
    targetType: "app_user",
    targetId: user.id,
    after: { reason, outcome: "session_deleted" },
  });
}

/**
 * Kullanıcının kendi isteği: bu cihaz dahil bütün oturumları silinir.
 * Yönetim yetkili hesapta denetim satırı da yazılır (çalınmış oturum
 * şüphesi sonrası iz). `userId` yalnızca doğrulanmış oturumdan gelir.
 */
export async function revokeOwnSessions(
  db: Database,
  user: { id: number; role: UserRole },
): Promise<{ count: number }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(session)
      .where(eq(session.userId, user.id))
      .returning({ id: session.id });
    if (hasCapability(user.role, "admin.access")) {
      await recordAdminEvent(tx, {
        actor: { userId: user.id, role: user.role },
        action: "sessions.revoke_all",
        targetType: "app_user",
        targetId: user.id,
        after: { count: deleted.length, scope: "self", outcome: "applied" },
      });
    }
    return { count: deleted.length };
  });
}

export class SessionRevokeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRevokeValidationError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVOKE_REASON_MIN = 5;
const REVOKE_REASON_MAX = 300;

/**
 * Yöneticinin başka (ya da kendi) hesabın bütün oturumlarını kapatması:
 * ele geçirilmiş hesap şüphesi. Hesap bir sonraki istekte girişsiz kalır;
 * rol değişmez (rol düşürme ayrı, denetimli işlem: docs/ops.md).
 * Gerekçe zorunlu ve denetime yazılır.
 */
export async function revokeUserSessions(
  db: Database,
  actor: AdminActor,
  input: { publicId: unknown; reason: unknown },
): Promise<{ found: false } | { found: true; count: number }> {
  assertCapability(actor, "users.sessions.revoke");
  const publicId = typeof input.publicId === "string" ? input.publicId.trim().toLowerCase() : "";
  if (!UUID.test(publicId)) return { found: false };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < REVOKE_REASON_MIN || reason.length > REVOKE_REASON_MAX) {
    throw new SessionRevokeValidationError(
      `Gerekçe ${REVOKE_REASON_MIN}-${REVOKE_REASON_MAX} karakter olmalı.`,
    );
  }

  return db.transaction(async (tx) => {
    const target = (
      await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.publicId, publicId))
        .limit(1)
    )[0];
    if (!target) return { found: false } as const;

    const deleted = await tx
      .delete(session)
      .where(eq(session.userId, target.id))
      .returning({ id: session.id });
    await recordAdminEvent(tx, {
      actor,
      action: "sessions.revoke_all",
      targetType: "app_user",
      targetId: target.id,
      after: { count: deleted.length, scope: "admin", outcome: "applied" },
      reason,
    });
    return { found: true, count: deleted.length } as const;
  });
}
