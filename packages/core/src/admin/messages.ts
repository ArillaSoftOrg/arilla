/**
 * Yönetim gelen kutusu (`/yonetim/mesajlar`, karar 0061): `/iletisim` ve
 * `/geri-bildirim` gönderileri, yeniden eskiye. Salt okunur: yanıtlama ve
 * durum değiştirme bu sürümde yok.
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
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
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

export interface InboxFilter {
  kind?: FeedbackKind;
  category?: string;
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
