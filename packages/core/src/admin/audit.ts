/**
 * Yönetim denetim kaydı (`admin_audit_event`, migration 0027, docs/decisions/0039).
 *
 * `recordAdminEvent` mutasyonla AYNI işlem (`tx`) içinde çağrılır: kayıt
 * yazılamazsa değişiklik de geri alınır, kayıtsız değişiklik olmaz.
 *
 * Yalnızca güvenlik/denetim olayı. İşletim olayı (`ingest_run`), hata ya da
 * analitik buraya yazılmaz. `before`/`after` çağıranın seçtiği, hassas
 * olmayan alanlardır — parola, token, çerez, IP, e-posta asla.
 */
import { adminAuditEvent, appUser, type Database } from "@arilla/db";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export type AdminAction =
  | "matching.approve"
  | "matching.reject"
  | "lexicon.create"
  | "lexicon.update"
  | "lexicon.delete";

export type AdminTargetType = "match_candidate" | "lexicon";

export type AuditValue = string | number | boolean | null | AuditValue[];

export interface AdminEventInput {
  actor: AdminActor;
  action: AdminAction;
  targetType: AdminTargetType;
  targetId: number | string;
  before?: Record<string, AuditValue> | null;
  after?: Record<string, AuditValue> | null;
  reason?: string | null;
}

export async function recordAdminEvent(
  tx: Pick<Database, "insert">,
  input: AdminEventInput,
): Promise<void> {
  await tx.insert(adminAuditEvent).values({
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: String(input.targetId),
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
  });
}

export const AUDIT_PAGE_SIZE_MAX = 100;
const AUDIT_PAGE_SIZE_DEFAULT = 50;

export interface AdminEventFilter {
  action?: string;
  targetType?: string;
  targetId?: string;
  actorUserId?: number;
  /**
   * Önceki sayfanın son `id`'si. İmleç yalnızca `id`: identity artan olduğu
   * için sıra `created_at` ile aynıdır, ve `timestamptz` mikrosaniyesi JS
   * `Date`'e (milisaniye) sığmadığından zaman imleci satır atlayabilirdi.
   */
  beforeId?: number;
  pageSize?: number;
}

export interface AdminEventRow {
  id: number;
  createdAt: Date;
  actorUserId: number;
  actorRole: string;
  /** Maskeli: `a***@gmail.com`. E-postasız hesapta `#<id>`. */
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface AdminEventPage {
  rows: AdminEventRow[];
  /** Sonraki sayfanın `beforeId`'si; yoksa son sayfa. COUNT çalıştırılmaz. */
  nextBeforeId: number | null;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** `/yonetim/denetim`. Kişisel veri erişimi değil ama yine de yalnızca `audit.read`. */
export async function listAdminEvents(
  db: Database,
  actor: AdminActor,
  filter: AdminEventFilter = {},
): Promise<AdminEventPage> {
  assertCapability(actor, "audit.read");

  const pageSize = Math.min(
    Math.max(1, Math.trunc(filter.pageSize ?? AUDIT_PAGE_SIZE_DEFAULT)),
    AUDIT_PAGE_SIZE_MAX,
  );

  const conditions: SQL[] = [];
  if (filter.action) conditions.push(eq(adminAuditEvent.action, filter.action));
  if (filter.targetType) conditions.push(eq(adminAuditEvent.targetType, filter.targetType));
  if (filter.targetId) conditions.push(eq(adminAuditEvent.targetId, filter.targetId));
  if (filter.actorUserId !== undefined) {
    conditions.push(eq(adminAuditEvent.actorUserId, filter.actorUserId));
  }
  if (filter.beforeId !== undefined) conditions.push(lt(adminAuditEvent.id, filter.beforeId));

  const rows = await db
    .select({
      id: adminAuditEvent.id,
      createdAt: adminAuditEvent.createdAt,
      actorUserId: adminAuditEvent.actorUserId,
      actorRole: adminAuditEvent.actorRole,
      actorEmail: appUser.email,
      action: adminAuditEvent.action,
      targetType: adminAuditEvent.targetType,
      targetId: adminAuditEvent.targetId,
      before: adminAuditEvent.before,
      after: adminAuditEvent.after,
      reason: adminAuditEvent.reason,
    })
    .from(adminAuditEvent)
    .innerJoin(appUser, eq(appUser.id, adminAuditEvent.actorUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(adminAuditEvent.id))
    .limit(pageSize + 1);

  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    rows: page.map(({ actorEmail, ...row }) => ({
      ...row,
      actorLabel: maskEmail(actorEmail) ?? `#${row.actorUserId}`,
    })),
    nextBeforeId: rows.length > pageSize && last ? last.id : null,
  };
}
