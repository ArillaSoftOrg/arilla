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
import {
  adminAuditEvent,
  appUser,
  type Database,
  form,
  lexicon,
  marketingCampaign,
  matchCandidate,
  merchant,
} from "@arilla/db";
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export type AdminAction =
  | "matching.approve"
  | "matching.reject"
  | "lexicon.create"
  | "lexicon.update"
  | "lexicon.delete"
  | "merchant.activate"
  | "merchant.deactivate"
  /** Kişisel veriye erişim: aranan değer YAZILMAZ, yalnızca yöntem ve bulunan hesap. */
  | "users.lookup"
  /** Kısmi arama: yalnızca yöntem, sayfa ve sonuç sayısı; aranan değer YAZILMAZ. */
  | "users.search"
  | "users.view"
  /**
   * Özet kullanıcı listesi sayfası (karar 0049 §1b). Yalnızca kullanılan
   * filtrelerin ADLARI, sıralama, yön ve sonuç sayısı; filtre değeri YAZILMAZ.
   */
  | "users.list"
  /** Hassas ayrıntı sekmesi (Aktivite, Oturumlar, Aramalar, Affiliate): yalnızca sekme adı. */
  | "users.view_tab"
  /** Tam iletişim bilgisi gösterimi (0049 §2): yalnızca alan adı (`email` | `phone`), değer ASLA. */
  | "users.reveal_contact"
  /**
   * Rol değişikliği. Arayüzden yapılmaz (0039); yalnızca yerel `pnpm
   * db:set-role` betiği ya da üretimde elle SQL yazar (`actor_role = "cli"`).
   */
  | "users.role_change"
  /**
   * Pazarlama e-postası (karar 0048). Gövde, konu, test adresi ve alıcı
   * listesi YAZILMAZ; yalnızca sürüm, uzunluk, sayı ve durum.
   */
  | "marketing.campaign_create"
  | "marketing.campaign_update"
  | "marketing.test_send"
  | "marketing.send_start"
  | "marketing.campaign_cancel"
  /**
   * Form / anket merkezi (karar 0058). Soru metni, cevap ve kullanici
   * YAZILMAZ; yalnizca tur, hedef kitle, durum ve sayilar.
   * `forms.results_view`: sonuc ekrani goruntulendi (yanitlar hesaba bagli olabilir).
   */
  | "forms.create"
  | "forms.update"
  | "forms.publish"
  | "forms.close"
  | "forms.results_view"
  /**
   * Gelen kutusu (karar 0061): liste görüntülendi. Mesaj, ad, e-posta
   * YAZILMAZ; yalnızca kullanılan filtrelerin ADLARI ve sonuç sayısı.
   */
  | "messages.list_view"
  /**
   * Sohbet geri bildirimi (karar 0079): ozet/liste goruntulendi (`list_view`) ya da tek
   * oy ayrintisi acildi (`view`). Yorum, neden metni ve sohbet icerigi YAZILMAZ; yalnizca
   * filtre ADLARI ve sonuc sayisi.
   */
  | "chat_feedback.list_view"
  | "chat_feedback.view"
  /**
   * Erken erişim sayacı (karar 0065): platform dışı başvuru sayısı elle
   * değişti. `before.offPlatformCount` / `after.offPlatformCount`; gerekçe
   * `reason`; kişisel veri YAZILMAZ.
   */
  | "early_access.counter_set"
  /**
   * Güvenlik olayları (karar 0050). Kişisel veri, yol, IP, token YAZILMAZ.
   * - `security.access_denied`: girişli ama yetkisiz hesabın yönetim isteği;
   *   hedef istenen yetenek. Hesap + yetenek başına 10 dakikada bir satır.
   * - `security.admin_session_ended`: yönetim oturumu 12 saat / 30 dk
   *   kuralıyla sunucuda sonlandırıldı (`after.reason`).
   * - `sessions.revoke_all`: hesabın tüm oturumları kapatıldı (kendisi,
   *   bir yönetici ya da acil durum betiği); `after.count`.
   */
  | "security.access_denied"
  | "security.admin_session_ended"
  | "sessions.revoke_all";

export type AdminTargetType =
  | "match_candidate"
  | "lexicon"
  | "merchant"
  | "app_user"
  | "marketing_campaign"
  | "form"
  /** Gelen kutusu (`feedback` tablosu; liste görüntüleme, hedef kimliği "-"). */
  | "feedback"
  /** Sohbet geri bildirimi (`chat_result_feedback`; liste hedefi "-", ayrinti mesaj kimligi). */
  | "chat_feedback"
  /** Erken erişim sayacı (tek satır, hedef kimliği "1"). */
  | "early_access_counter"
  /** `security.access_denied` hedefi: istenen yetenek adı. */
  | "capability";

/** Filtre ve bağlantı için bilinen hedef türleri. */
export const AUDIT_TARGET_TYPES: readonly AdminTargetType[] = [
  "match_candidate",
  "lexicon",
  "merchant",
  "app_user",
  "marketing_campaign",
  "form",
  "feedback",
  "chat_feedback",
  "early_access_counter",
  "capability",
];

export function isAuditTargetType(value: unknown): value is AdminTargetType {
  return typeof value === "string" && (AUDIT_TARGET_TYPES as readonly string[]).includes(value);
}

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
  /** NULL: aktör hesabı silinmiş ya da aktörsüz veritabanı oturumu (0039). */
  actorUserId: number | null;
  actorRole: string;
  /**
   * Maskeli: `a***@gmail.com`. E-postasız hesapta `#<id>`, aktörsüz satırda
   * `ACTOR_LABEL_NONE`.
   */
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string;
  /**
   * Hedefin okunur etiketi ve (varsa) yönetim sayfası (karar 0051). Kişisel
   * veri YOK: hesap "hesap #id" olarak etiketlenir. Hedef silinmişse `href` null.
   */
  target: { label: string; href: string | null };
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface AdminEventPage {
  rows: AdminEventRow[];
  /** Sonraki sayfanın `beforeId`'si; yoksa son sayfa. COUNT çalıştırılmaz. */
  nextBeforeId: number | null;
}

/** Aktörü olmayan satırın etiketi (silinmiş hesap ya da veritabanı/betik). */
export const ACTOR_LABEL_NONE = "kayıtlı hesap yok";

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
    // LEFT: aktörü silinmiş (0039 SET NULL) ya da aktörsüz satır da görünür.
    .leftJoin(appUser, eq(appUser.id, adminAuditEvent.actorUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(adminAuditEvent.id))
    .limit(pageSize + 1);

  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  const targets = await resolveAuditTargets(db, page);
  return {
    rows: page.map(({ actorEmail, ...row }) => ({
      ...row,
      actorLabel:
        maskEmail(actorEmail) ??
        (row.actorUserId === null ? ACTOR_LABEL_NONE : `#${row.actorUserId}`),
      target: targets.get(`${row.targetType}:${row.targetId}`) ?? {
        label: `${row.targetType} #${row.targetId}`,
        href: null,
      },
    })),
    nextBeforeId: rows.length > pageSize && last ? last.id : null,
  };
}

function numericIds(rows: { targetType: string; targetId: string }[], type: string): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.targetType !== type || !/^\d{1,15}$/.test(row.targetId)) continue;
    const id = Number(row.targetId);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * Sayfadaki hedefleri tür başına TEK sorguyla çözer (en fazla sayfa boyu kadar
 * kimlik). Bağlantılar yalnızca denetim kaydını görebilen yöneticinin zaten
 * açabildiği sayfalara gider; hedef sayfa yetkiyi ayrıca ister.
 */
async function resolveAuditTargets(
  db: Database,
  rows: { targetType: string; targetId: string }[],
): Promise<Map<string, { label: string; href: string | null }>> {
  const out = new Map<string, { label: string; href: string | null }>();
  const merchantIds = numericIds(rows, "merchant");
  const userIds = numericIds(rows, "app_user");
  const campaignIds = numericIds(rows, "marketing_campaign");
  const lexiconIds = numericIds(rows, "lexicon");
  const candidateIds = numericIds(rows, "match_candidate");
  const formIds = numericIds(rows, "form");

  const [merchants, users, campaigns, lexicons, candidates, forms] = await Promise.all([
    merchantIds.length
      ? db
          .select({ id: merchant.id, slug: merchant.slug, name: merchant.name })
          .from(merchant)
          .where(inArray(merchant.id, merchantIds))
      : [],
    userIds.length
      ? db
          .select({ id: appUser.id, publicId: appUser.publicId })
          .from(appUser)
          .where(inArray(appUser.id, userIds))
      : [],
    campaignIds.length
      ? db
          .select({
            id: marketingCampaign.id,
            publicId: marketingCampaign.publicId,
            title: marketingCampaign.title,
          })
          .from(marketingCampaign)
          .where(inArray(marketingCampaign.id, campaignIds))
      : [],
    lexiconIds.length
      ? db
          .select({ id: lexicon.id, surface: lexicon.surface, kind: lexicon.kind })
          .from(lexicon)
          .where(inArray(lexicon.id, lexiconIds))
      : [],
    candidateIds.length
      ? db
          .select({ id: matchCandidate.id, productId: matchCandidate.productId })
          .from(matchCandidate)
          .where(inArray(matchCandidate.id, candidateIds))
      : [],
    formIds.length
      ? db.select({ id: form.id, title: form.title }).from(form).where(inArray(form.id, formIds))
      : [],
  ]);

  for (const row of merchants) {
    out.set(`merchant:${row.id}`, {
      label: row.name,
      href: `/yonetim/magazalar/${encodeURIComponent(row.slug)}`,
    });
  }
  for (const row of users) {
    out.set(`app_user:${row.id}`, {
      label: `hesap #${row.id}`,
      href: `/yonetim/kullanicilar/${row.publicId}`,
    });
  }
  for (const row of campaigns) {
    out.set(`marketing_campaign:${row.id}`, {
      label: row.title,
      href: `/yonetim/kampanyalar/${row.publicId}`,
    });
  }
  for (const row of lexicons) {
    out.set(`lexicon:${row.id}`, {
      label: `${row.kind}: ${row.surface}`,
      href: `/yonetim/sozluk?tur=${encodeURIComponent(row.kind)}&q=${encodeURIComponent(row.surface)}`,
    });
  }
  for (const row of candidates) {
    out.set(`match_candidate:${row.id}`, {
      label: `aday #${row.id} → ürün #${row.productId}`,
      href: `/yonetim/katalog/urunler/${row.productId}`,
    });
  }
  for (const row of forms) {
    out.set(`form:${row.id}`, { label: row.title, href: `/yonetim/formlar/${row.id}` });
  }
  for (const row of rows) {
    if (row.targetType === "capability") {
      out.set(`capability:${row.targetId}`, { label: `yetenek ${row.targetId}`, href: null });
    }
    if (row.targetType === "feedback") {
      out.set(`feedback:${row.targetId}`, { label: "gelen kutusu", href: "/yonetim/mesajlar" });
    }
  }
  return out;
}
