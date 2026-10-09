/**
 * Yönetim gelen kutusu (`/yonetim/mesajlar`, karar 0061): `/iletisim` ve
 * `/geri-bildirim` gönderileri, yeniden eskiye. Yanıt e-postayla verilir.
 * Karar 0086: mevcut `status`/`priority` kolonlarıyla triyaj (`messages.triage`);
 * sorumlu kişi kolonu YOK (migration gerekir), kimin değiştirdiği denetimde.
 *
 * Gönderiler ad, e-posta ve serbest metin içerir: yalnızca `messages.read`
 * (yönetici). Her liste görüntülemesi aynı istekte `messages.list_view`
 * olarak denetime yazılır; denetim kaydına içerik, ad ya da e-posta değil
 * yalnızca filtre ADLARI ve sonuç sayısı gider.
 */
import {
  appUser,
  CONTACT_CATEGORIES,
  type Database,
  FEEDBACK_CATEGORIES,
  type FeedbackKind,
  feedback,
} from "@arilla/db";
import { and, desc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";
import { recordAdminEvent } from "./audit.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const INBOX_PAGE_SIZE = 50;

export const INBOX_KINDS: readonly FeedbackKind[] = ["contact", "feedback"];

/** Her iki türün kategorileri (filtre listesi; tekrarlar tekilleştirilir). */
export const INBOX_CATEGORIES: readonly string[] = [
  ...new Set<string>([...CONTACT_CATEGORIES, ...FEEDBACK_CATEGORIES]),
];

export function isInboxKind(value: unknown): value is FeedbackKind {
  return typeof value === "string" && (INBOX_KINDS as readonly string[]).includes(value);
}

export function isInboxCategory(value: unknown): value is string {
  return typeof value === "string" && INBOX_CATEGORIES.includes(value);
}

/** `feedback_status_check` ile aynı değerler. */
export const INBOX_STATUSES = ["new", "reviewing", "planned", "resolved", "rejected"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
/** `feedback_priority_check`; `null` = atanmamış. */
export const INBOX_PRIORITIES = ["low", "medium", "high"] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

export function isInboxStatus(value: unknown): value is InboxStatus {
  return typeof value === "string" && (INBOX_STATUSES as readonly string[]).includes(value);
}

export function isInboxPriority(value: unknown): value is InboxPriority {
  return typeof value === "string" && (INBOX_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Güvenli geçişler: yeni → incelemede/planlandı/çözüldü/reddedildi; kapanmış
 * (çözüldü/reddedildi) mesaj ancak "incelemede"ye geri açılır. Aynı duruma
 * geçiş değişiklik sayılmaz.
 */
const INBOX_TRANSITIONS: Readonly<Record<InboxStatus, readonly InboxStatus[]>> = {
  new: ["reviewing", "planned", "resolved", "rejected"],
  reviewing: ["planned", "resolved", "rejected"],
  planned: ["reviewing", "resolved", "rejected"],
  resolved: ["reviewing"],
  rejected: ["reviewing"],
};

export function allowedInboxTransitions(from: InboxStatus): readonly InboxStatus[] {
  return INBOX_TRANSITIONS[from];
}

export interface InboxFilter {
  kind?: FeedbackKind;
  category?: string;
  status?: InboxStatus;
  /** `"none"`: önceliği atanmamış. */
  priority?: InboxPriority | "none";
  /** Bu kimlikten KÜÇÜK olanlar (daha eski sayfa). */
  beforeId?: number;
}

export interface InboxMessage {
  id: number;
  kind: FeedbackKind;
  category: string;
  name: string | null;
  email: string | null;
  subject: string;
  message: string;
  priority: string | null;
  status: InboxStatus;
  createdAt: Date;
  /** Girişli gönderimde hesabın public kimliği (yönetimde bağlantı); anonimde null. */
  accountPublicId: string | null;
}

export interface InboxPage {
  rows: InboxMessage[];
  /** Daha eski kayıt varsa sonraki sayfanın `beforeId`'si. */
  nextBeforeId: number | null;
}

export async function listInboxMessages(
  db: Database,
  actor: AdminActor,
  filter: InboxFilter = {},
): Promise<InboxPage> {
  assertCapability(actor, "messages.read");

  const conditions: SQL[] = [];
  if (filter.kind) conditions.push(eq(feedback.kind, filter.kind));
  if (filter.category) conditions.push(eq(feedback.category, filter.category as never));
  if (filter.status) conditions.push(eq(feedback.status, filter.status));
  if (filter.priority === "none") conditions.push(isNull(feedback.priority));
  else if (filter.priority) conditions.push(eq(feedback.priority, filter.priority));
  if (filter.beforeId) conditions.push(lt(feedback.id, filter.beforeId));

  const fetched = await db
    .select({
      id: feedback.id,
      kind: feedback.kind,
      category: feedback.category,
      name: feedback.name,
      email: feedback.email,
      subject: feedback.title,
      message: feedback.message,
      priority: feedback.priority,
      status: feedback.status,
      createdAt: feedback.createdAt,
      userId: feedback.userId,
    })
    .from(feedback)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(feedback.id))
    .limit(INBOX_PAGE_SIZE + 1);

  const hasMore = fetched.length > INBOX_PAGE_SIZE;
  const page = hasMore ? fetched.slice(0, INBOX_PAGE_SIZE) : fetched;

  const userIds = [...new Set(page.flatMap((row) => (row.userId === null ? [] : [row.userId])))];
  const accounts = userIds.length
    ? await db
        .select({ id: appUser.id, publicId: appUser.publicId })
        .from(appUser)
        .where(inArray(appUser.id, userIds))
    : [];
  const publicIds = new Map(accounts.map((row) => [row.id, row.publicId]));

  await recordAdminEvent(db, {
    actor,
    action: "messages.list_view",
    targetType: "feedback",
    targetId: "-",
    after: {
      filters: [
        filter.kind ? "kind" : null,
        filter.category ? "category" : null,
        filter.status ? "status" : null,
        filter.priority ? "priority" : null,
        filter.beforeId ? "page" : null,
      ].filter((name): name is string => name !== null),
      results: page.length,
    },
  });

  return {
    rows: page.map(({ userId, ...row }) => ({
      ...row,
      accountPublicId: userId === null ? null : (publicIds.get(userId) ?? null),
    })),
    nextBeforeId: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export class InboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxValidationError";
  }
}

export type InboxMutationResult =
  | { status: "updated" }
  | { status: "unchanged" }
  | { status: "not_found" }
  | { status: "conflict" };

function requireMessageId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new InboxValidationError("Geçersiz mesaj.");
}

/**
 * Durum değişikliği (karar 0086): yalnızca izinli geçiş, beklenen eski durum
 * tutmazsa `conflict`. Satır kilidi + denetim AYNI işlemde; denetime yalnızca
 * durum değerleri gider (içerik, ad, e-posta asla).
 */
export async function setInboxMessageStatus(
  db: Database,
  actor: AdminActor,
  input: { messageId: unknown; next: unknown; expectedStatus: unknown },
): Promise<InboxMutationResult> {
  assertCapability(actor, "messages.triage");
  const id = requireMessageId(input.messageId);
  if (!isInboxStatus(input.next) || !isInboxStatus(input.expectedStatus)) {
    throw new InboxValidationError("Geçersiz durum.");
  }
  if (!INBOX_TRANSITIONS[input.expectedStatus].includes(input.next)) {
    throw new InboxValidationError("Bu durum geçişine izin verilmiyor.");
  }
  const next = input.next;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: feedback.status })
      .from(feedback)
      .where(eq(feedback.id, id))
      .for("update");
    const current = rows[0];
    if (!current) return { status: "not_found" };
    if (current.status !== input.expectedStatus) return { status: "conflict" };
    await tx
      .update(feedback)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(feedback.id, id));
    await recordAdminEvent(tx, {
      actor,
      action: "messages.status_change",
      targetType: "feedback",
      targetId: id,
      before: { status: current.status },
      after: { status: next },
    });
    return { status: "updated" };
  });
}

export async function setInboxMessagePriority(
  db: Database,
  actor: AdminActor,
  input: { messageId: unknown; priority: unknown },
): Promise<InboxMutationResult> {
  assertCapability(actor, "messages.triage");
  const id = requireMessageId(input.messageId);
  if (input.priority !== null && !isInboxPriority(input.priority)) {
    throw new InboxValidationError("Geçersiz öncelik.");
  }
  const priority = input.priority as InboxPriority | null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ priority: feedback.priority })
      .from(feedback)
      .where(eq(feedback.id, id))
      .for("update");
    const current = rows[0];
    if (!current) return { status: "not_found" };
    if ((current.priority ?? null) === priority) return { status: "unchanged" };
    await tx.update(feedback).set({ priority, updatedAt: new Date() }).where(eq(feedback.id, id));
    await recordAdminEvent(tx, {
      actor,
      action: "messages.priority_change",
      targetType: "feedback",
      targetId: id,
      before: { priority: current.priority ?? null },
      after: { priority },
    });
    return { status: "updated" };
  });
}
