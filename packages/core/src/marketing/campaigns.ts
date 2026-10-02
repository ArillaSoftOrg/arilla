/**
 * `/yonetim/kampanyalar` (docs/decisions/0048). Kampanya taslağı, test
 * gönderimi, gerçek gönderimin başlatılması ve iptal. Her fonksiyon
 * `marketing.manage` yeteneğini KENDİSİ denetler (web katmanı da ister);
 * her mutasyon denetim kaydını aynı işlemde yazar.
 *
 * Denetim kaydına girmeyenler: gövde, konu, test alıcısının adresi, alıcı
 * listesi, sağlayıcı yanıtı. Yalnızca sürüm, uzunluk, sayı ve durum.
 *
 * Çift gönderim koruması kod incelemesine değil motora verildi:
 * - Başlatma `SELECT ... FOR UPDATE` + `status = 'draft'` kontrolüyle tek
 *   işlemde: ikinci istek (çift tık, yeniden deneme, ikinci yönetici)
 *   kampanyayı `sending` bulur ve hiçbir şey yapmaz.
 * - Teslim satırları `UNIQUE (campaign_id, user_id)` + `ON CONFLICT DO NOTHING`.
 * - Yönetici onayladığı içerik sürümünü (`expectedContentVersion`) gönderir;
 *   arada içerik değiştiyse başlatma reddedilir. O sürümün test gönderimi
 *   yapılmamışsa da reddedilir.
 */
import {
  adminAuditEvent,
  appUser,
  type Database,
  type MarketingCampaignStatus,
  marketingCampaign,
  marketingCampaignDelivery,
} from "@arilla/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { maskEmail, recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { requireAppUrl } from "../config/app-url.ts";
import { toEmailDeliveryError } from "../email/delivery-error.ts";
import { getSmtpTransport } from "../email/transport.ts";
import { bulkSendBlockMessage, marketingEmailConfigFromEnv } from "./config.ts";
import {
  type CampaignContentInput,
  CampaignValidationError,
  renderMarketingEmail,
  validateCampaignContent,
} from "./content.ts";
import { recipientClassificationSql } from "./eligibility.ts";
import type { MarketingTransport } from "./process.ts";

export { CampaignValidationError };

/** Yönetici başına saatte en fazla test gönderimi (denetim kaydından sayılır). */
export const TEST_SENDS_PER_HOUR = 10;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requirePublicId(value: unknown): string {
  if (typeof value !== "string" || !UUID_SHAPE.test(value)) {
    throw new CampaignValidationError("Geçersiz kampanya.");
  }
  return value.toLowerCase();
}

function requireVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CampaignValidationError("Geçersiz içerik sürümü. Sayfayı yenile.");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Okuma
// ---------------------------------------------------------------------------

export interface DeliveryCounts {
  total: number;
  pending: number;
  sending: number;
  /** Sağlayıcı kabul etti. "Teslim edildi" değil. */
  sent: number;
  failed: number;
  skipped: number;
}

export interface CampaignListRow {
  publicId: string;
  title: string;
  subject: string;
  status: MarketingCampaignStatus;
  createdAt: Date;
  creatorLabel: string | null;
  sendStartedAt: Date | null;
  completedAt: Date | null;
  recipientCount: number | null;
  counts: DeliveryCounts;
}

const COUNTS_SQL = sql`
  count(d.id)::int AS total,
  count(d.id) FILTER (WHERE d.state = 'pending')::int AS pending,
  count(d.id) FILTER (WHERE d.state = 'sending')::int AS sending,
  count(d.id) FILTER (WHERE d.state = 'sent')::int AS sent,
  count(d.id) FILTER (WHERE d.state = 'failed')::int AS failed,
  count(d.id) FILTER (WHERE d.state = 'skipped')::int AS skipped
`;

type CountRow = Record<keyof DeliveryCounts, number>;

function toCounts(row: CountRow): DeliveryCounts {
  return {
    total: row.total,
    pending: row.pending,
    sending: row.sending,
    sent: row.sent,
    failed: row.failed,
    skipped: row.skipped,
  };
}

export const CAMPAIGN_PAGE_SIZE = 50;

export async function listCampaigns(
  db: Database,
  actor: AdminActor,
  page = 1,
): Promise<{ rows: CampaignListRow[]; hasNext: boolean }> {
  assertCapability(actor, "marketing.manage");
  const safePage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1000) : 1;
  const result = await db.execute<
    CountRow & {
      public_id: string;
      title: string;
      subject: string;
      status: MarketingCampaignStatus;
      created_at: string;
      creator_email: string | null;
      created_by: string | null;
      send_started_at: string | null;
      completed_at: string | null;
      recipient_count: number | null;
    }
  >(sql`
    SELECT c.public_id, c.title, c.subject, c.status, c.created_at, c.created_by,
           u.email AS creator_email, c.send_started_at, c.completed_at, c.recipient_count,
           ${COUNTS_SQL}
      FROM marketing_campaign c
      LEFT JOIN app_user u ON u.id = c.created_by
      LEFT JOIN marketing_campaign_delivery d ON d.campaign_id = c.id
     GROUP BY c.id, u.email
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${CAMPAIGN_PAGE_SIZE + 1} OFFSET ${(safePage - 1) * CAMPAIGN_PAGE_SIZE}
  `);
  const rows = result.rows.slice(0, CAMPAIGN_PAGE_SIZE).map((row) => ({
    publicId: row.public_id,
    title: row.title,
    subject: row.subject,
    status: row.status,
    createdAt: new Date(row.created_at),
    creatorLabel: maskEmail(row.creator_email) ?? (row.created_by ? `#${row.created_by}` : null),
    sendStartedAt: row.send_started_at ? new Date(row.send_started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    recipientCount: row.recipient_count,
    counts: toCounts(row),
  }));
  return { rows, hasNext: result.rows.length > CAMPAIGN_PAGE_SIZE };
}

export interface CampaignFailureSample {
  deliveryId: number;
  /** Maskeli: `a***@alan.com`; hesap silinmişse `null`. */
  recipientLabel: string | null;
  userPublicId: string | null;
  state: "failed" | "skipped";
  code: string;
  updatedAt: Date;
}

export interface CampaignDetail {
  id: number;
  publicId: string;
  title: string;
  subject: string;
  body: string;
  status: MarketingCampaignStatus;
  contentVersion: number;
  testedVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
  creatorLabel: string | null;
  sendStartedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  recipientCount: number | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  counts: DeliveryCounts;
  /** Son 20 başarısız/atlanan teslim; adresler maskeli. */
  problems: CampaignFailureSample[];
}

export async function getCampaign(
  db: Database,
  actor: AdminActor,
  publicIdInput: unknown,
): Promise<CampaignDetail | null> {
  assertCapability(actor, "marketing.manage");
  if (typeof publicIdInput !== "string" || !UUID_SHAPE.test(publicIdInput)) return null;
  const publicId = publicIdInput.toLowerCase();

  const row = (
    await db
      .select({ campaign: marketingCampaign, creatorEmail: appUser.email })
      .from(marketingCampaign)
      .leftJoin(appUser, eq(appUser.id, marketingCampaign.createdBy))
      .where(eq(marketingCampaign.publicId, publicId))
      .limit(1)
  )[0];
  if (!row) return null;
  const c = row.campaign;

  const counts = await db.execute<CountRow>(sql`
    SELECT ${COUNTS_SQL} FROM marketing_campaign_delivery d WHERE d.campaign_id = ${c.id}
  `);
  const problems = await db.execute<{
    id: string;
    email: string | null;
    user_public_id: string | null;
    state: "failed" | "skipped";
    code: string;
    updated_at: string;
  }>(sql`
    SELECT d.id, u.email, u.public_id AS user_public_id, d.state,
           coalesce(d.failure_code, d.skip_reason) AS code, d.updated_at
      FROM marketing_campaign_delivery d
      LEFT JOIN app_user u ON u.id = d.user_id
     WHERE d.campaign_id = ${c.id} AND d.state IN ('failed', 'skipped')
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT 20
  `);

  return {
    id: c.id,
    publicId: c.publicId,
    title: c.title,
    subject: c.subject,
    body: c.body,
    status: c.status,
    contentVersion: c.contentVersion,
    testedVersion: c.testedVersion,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    creatorLabel: maskEmail(row.creatorEmail) ?? (c.createdBy ? `#${c.createdBy}` : null),
    sendStartedAt: c.sendStartedAt,
    completedAt: c.completedAt,
    cancelledAt: c.cancelledAt,
    recipientCount: c.recipientCount,
    lastErrorCode: c.lastErrorCode,
    lastErrorAt: c.lastErrorAt,
    counts: toCounts(
      counts.rows[0] ?? { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 },
    ),
    problems: problems.rows.map((p) => ({
      deliveryId: Number(p.id),
      recipientLabel: maskEmail(p.email),
      userPublicId: p.user_public_id,
      state: p.state,
      code: p.code,
      updatedAt: new Date(p.updated_at),
    })),
  };
}

/** Yönetim önizlemesi: gerçek gönderimle aynı şablon, kişiye özel bağlantı olmadan. */
export function renderCampaignPreview(
  campaign: Pick<CampaignDetail, "subject" | "body">,
  brand: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { subject: string; html: string; text: string } {
  return renderMarketingEmail({
    subject: campaign.subject,
    body: campaign.body,
    brand,
    appUrl: requireAppUrl(env),
    unsubscribeUrl: null,
    test: false,
  });
}

// ---------------------------------------------------------------------------
// Taslak
// ---------------------------------------------------------------------------

export async function createCampaignDraft(
  db: Database,
  actor: AdminActor,
  input: CampaignContentInput,
): Promise<{ publicId: string }> {
  assertCapability(actor, "marketing.manage");
  const content = validateCampaignContent(input);
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(marketingCampaign)
      .values({ ...content, createdBy: actor.userId, updatedBy: actor.userId })
      .returning({ id: marketingCampaign.id, publicId: marketingCampaign.publicId });
    const created = inserted[0];
    if (!created) throw new Error("kampanya olusturulamadi");
    await recordAdminEvent(tx, {
      actor,
      action: "marketing.campaign_create",
      targetType: "marketing_campaign",
      targetId: created.id,
      after: {
        contentVersion: 1,
        subjectLength: content.subject.length,
        bodyLength: content.body.length,
      },
    });
    return { publicId: created.publicId };
  });
}

export interface UpdateCampaignInput extends CampaignContentInput {
  publicId: unknown;
  expectedContentVersion: unknown;
}

export type UpdateCampaignResult =
  | { status: "updated"; contentVersion: number }
  | { status: "unchanged"; contentVersion: number }
  | { status: "not_found" };

export async function updateCampaignDraft(
  db: Database,
  actor: AdminActor,
  input: UpdateCampaignInput,
): Promise<UpdateCampaignResult> {
  assertCapability(actor, "marketing.manage");
  const publicId = requirePublicId(input.publicId);
  const expected = requireVersion(input.expectedContentVersion);
  const content = validateCampaignContent(input);

  return db.transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(marketingCampaign)
        .where(eq(marketingCampaign.publicId, publicId))
        .for("update")
    )[0];
    if (!current) return { status: "not_found" } as const;
    if (current.status !== "draft") {
      throw new CampaignValidationError(
        "Gönderimi başlamış ya da iptal edilmiş kampanya düzenlenemez.",
      );
    }
    if (current.contentVersion !== expected) {
      throw new CampaignValidationError(
        "Kampanya bu arada değişti. Sayfayı yenileyip yeniden düzenle.",
      );
    }
    const messageChanged = current.subject !== content.subject || current.body !== content.body;
    const titleChanged = current.title !== content.title;
    if (!messageChanged && !titleChanged) {
      return { status: "unchanged", contentVersion: current.contentVersion } as const;
    }
    // Yalnızca ileti (konu/gövde) değişince sürüm artar: eski test geçersizleşir.
    const contentVersion = messageChanged ? current.contentVersion + 1 : current.contentVersion;
    await tx
      .update(marketingCampaign)
      .set({ ...content, contentVersion, updatedBy: actor.userId, updatedAt: new Date() })
      .where(and(eq(marketingCampaign.id, current.id), eq(marketingCampaign.status, "draft")));
    await recordAdminEvent(tx, {
      actor,
      action: "marketing.campaign_update",
      targetType: "marketing_campaign",
      targetId: current.id,
      before: { contentVersion: current.contentVersion },
      after: {
        contentVersion,
        titleChanged,
        subjectLength: content.subject.length,
        bodyLength: content.body.length,
      },
    });
    return { status: "updated", contentVersion } as const;
  });
}

// ---------------------------------------------------------------------------
// Test gönderimi
// ---------------------------------------------------------------------------

export interface SendTestInput {
  publicId: unknown;
  expectedContentVersion: unknown;
  recipient: unknown;
}

export type SendTestResult =
  | { status: "sent"; contentVersion: number }
  | { status: "not_found" }
  | { status: "rate_limited" }
  | { status: "failed"; code: string };

function normalizeTestRecipient(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    email.length === 0 ||
    email.length > 254 ||
    !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)
  ) {
    throw new CampaignValidationError("Geçerli bir test e-posta adresi yaz.");
  }
  return email;
}

/**
 * Yöneticinin yazdığı TEK adrese, "Test:" önekli ve test uyarılı ileti.
 * Kampanya alıcısı sayılmaz: teslim satırı açmaz, sayaçları değiştirmez,
 * pazarlama rızası aramaz (açık yönetici talebi). İptal bağlantısı
 * kişiye özel değildir ve çalışmaz. Hız sınırı denetim kaydından
 * (`marketing.test_send`) sayılır; Redis gerekmez, deneme de sayılır.
 */
export async function sendCampaignTest(
  db: Database,
  actor: AdminActor,
  input: SendTestInput,
  deps: {
    brand: string;
    transport?: MarketingTransport;
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<SendTestResult> {
  assertCapability(actor, "marketing.manage");
  const publicId = requirePublicId(input.publicId);
  const expected = requireVersion(input.expectedContentVersion);
  const recipient = normalizeTestRecipient(input.recipient);
  const env = deps.env ?? process.env;

  let config: ReturnType<typeof marketingEmailConfigFromEnv>;
  let appUrl: string;
  try {
    config = marketingEmailConfigFromEnv(env);
    appUrl = requireAppUrl(env);
  } catch {
    // `MarketingConfigError` ya da `APP_URL` eksik; değer döndürülmez.
    return { status: "failed", code: "ECONFIG" };
  }

  const claim = await db.transaction(async (tx) => {
    // Aynı yöneticinin eşzamanlı test istekleri sırayla sayılır.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`marketing_test:${actor.userId}`}, 0))`,
    );
    const campaign = (
      await tx
        .select({
          id: marketingCampaign.id,
          status: marketingCampaign.status,
          subject: marketingCampaign.subject,
          body: marketingCampaign.body,
          contentVersion: marketingCampaign.contentVersion,
        })
        .from(marketingCampaign)
        .where(eq(marketingCampaign.publicId, publicId))
        .limit(1)
    )[0];
    if (!campaign) return { kind: "not_found" } as const;
    if (campaign.status !== "draft") {
      throw new CampaignValidationError("Test gönderimi yalnızca taslak kampanyada yapılır.");
    }
    if (campaign.contentVersion !== expected) {
      throw new CampaignValidationError("Kampanya bu arada değişti. Sayfayı yenile.");
    }

    const recent = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(adminAuditEvent)
      .where(
        and(
          eq(adminAuditEvent.actorUserId, actor.userId),
          eq(adminAuditEvent.action, "marketing.test_send"),
          gt(adminAuditEvent.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    if ((recent[0]?.n ?? 0) >= TEST_SENDS_PER_HOUR) return { kind: "rate_limited" } as const;

    const self = (
      await tx.select({ email: appUser.email }).from(appUser).where(eq(appUser.id, actor.userId))
    )[0];
    await recordAdminEvent(tx, {
      actor,
      action: "marketing.test_send",
      targetType: "marketing_campaign",
      targetId: campaign.id,
      // Adres YAZILMAZ; yalnızca kendi adresine mi gönderildiği.
      after: {
        contentVersion: campaign.contentVersion,
        recipientIsSelf: self?.email?.toLowerCase() === recipient,
      },
    });
    return { kind: "send", campaign } as const;
  });

  if (claim.kind === "not_found") return { status: "not_found" };
  if (claim.kind === "rate_limited") return { status: "rate_limited" };

  const content = renderMarketingEmail({
    subject: claim.campaign.subject,
    body: claim.campaign.body,
    brand: deps.brand,
    appUrl,
    unsubscribeUrl: null,
    test: true,
  });
  try {
    await (deps.transport ?? getSmtpTransport()).sendMail({
      from: config.from,
      to: recipient,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      ...content,
    });
  } catch (error) {
    const code = toEmailDeliveryError(error).code;
    console.error(`[pazarlama] test gonderilemedi: ${code}`);
    return { status: "failed", code };
  }

  // Bu sürüm test edildi; arada içerik değiştiyse işaretlenmez.
  await db
    .update(marketingCampaign)
    .set({ testedVersion: claim.campaign.contentVersion })
    .where(
      and(
        eq(marketingCampaign.id, claim.campaign.id),
        eq(marketingCampaign.contentVersion, claim.campaign.contentVersion),
        eq(marketingCampaign.status, "draft"),
      ),
    );
  return { status: "sent", contentVersion: claim.campaign.contentVersion };
}

// ---------------------------------------------------------------------------
// Gerçek gönderim
// ---------------------------------------------------------------------------

export interface StartSendInput {
  publicId: unknown;
  expectedContentVersion: unknown;
  /** Onay penceresindeki "gerçek alıcılara gidecek" kutusu. */
  confirmed: unknown;
}

export type StartSendResult =
  | { status: "started"; campaignId: number; recipientCount: number }
  /** Zaten başlamış/bitmiş/iptal: hiçbir şey yapılmadı (çift tık, yeniden deneme). */
  | { status: "already_started"; campaignId: number; campaignStatus: MarketingCampaignStatus }
  | { status: "not_found" };

export async function startCampaignSend(
  db: Database,
  actor: AdminActor,
  input: StartSendInput,
  deps: { env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<StartSendResult> {
  assertCapability(actor, "marketing.manage");
  const publicId = requirePublicId(input.publicId);
  const expected = requireVersion(input.expectedContentVersion);
  if (input.confirmed !== true) {
    throw new CampaignValidationError("Gönderimi onaylamak için kutuyu işaretle.");
  }

  let config: ReturnType<typeof marketingEmailConfigFromEnv>;
  try {
    config = marketingEmailConfigFromEnv(deps.env ?? process.env);
  } catch {
    throw new CampaignValidationError("E-posta yapılandırması eksik; gönderim başlatılamaz.");
  }
  if (!config.bulkSendAllowed) {
    throw new CampaignValidationError(
      bulkSendBlockMessage(config.bulkSendBlock ?? "non_production_remote_smtp"),
    );
  }

  return db.transaction(async (tx) => {
    const campaign = (
      await tx
        .select()
        .from(marketingCampaign)
        .where(eq(marketingCampaign.publicId, publicId))
        .for("update")
    )[0];
    if (!campaign) return { status: "not_found" } as const;
    if (campaign.status !== "draft") {
      return {
        status: "already_started",
        campaignId: campaign.id,
        campaignStatus: campaign.status,
      } as const;
    }
    if (campaign.contentVersion !== expected) {
      throw new CampaignValidationError(
        "Kampanya bu arada değişti. Sayfayı yenileyip yeniden gözden geçir.",
      );
    }
    if (campaign.testedVersion !== campaign.contentVersion) {
      throw new CampaignValidationError("Önce bu sürümün test gönderimini yap ve sonucu incele.");
    }

    // O anki uygun alıcılar; her biri gönderim anında YENİDEN denetlenir.
    const inserted = await tx.execute(sql`
      INSERT INTO marketing_campaign_delivery (campaign_id, user_id)
      SELECT ${campaign.id}, r.user_id
        FROM (${recipientClassificationSql()}) r
       WHERE r.reason = 'eligible'
       ORDER BY r.user_id
      ON CONFLICT (campaign_id, user_id) DO NOTHING
    `);
    const recipientCount = inserted.rowCount ?? 0;
    const now = new Date();
    // Alıcı yoksa kampanya hemen sonuçlanır (işlemci beklemez).
    const emptyCampaign = recipientCount === 0;
    await tx
      .update(marketingCampaign)
      .set({
        status: emptyCampaign ? "completed" : "sending",
        sendStartedAt: now,
        completedAt: emptyCampaign ? now : null,
        sendRequestedBy: actor.userId,
        recipientCount,
        updatedAt: now,
      })
      .where(and(eq(marketingCampaign.id, campaign.id), eq(marketingCampaign.status, "draft")));
    await recordAdminEvent(tx, {
      actor,
      action: "marketing.send_start",
      targetType: "marketing_campaign",
      targetId: campaign.id,
      before: { status: "draft" },
      after: {
        status: emptyCampaign ? "completed" : "sending",
        contentVersion: campaign.contentVersion,
        recipientCount,
      },
    });
    return { status: "started", campaignId: campaign.id, recipientCount } as const;
  });
}

/** Yönetim ekranındaki "sonraki partiyi işle" için iç kimlik. */
export async function campaignIdForProcessing(
  db: Database,
  actor: AdminActor,
  publicIdInput: unknown,
): Promise<number | null> {
  assertCapability(actor, "marketing.manage");
  const publicId = requirePublicId(publicIdInput);
  const row = (
    await db
      .select({ id: marketingCampaign.id })
      .from(marketingCampaign)
      .where(and(eq(marketingCampaign.publicId, publicId), eq(marketingCampaign.status, "sending")))
      .limit(1)
  )[0];
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// İptal
// ---------------------------------------------------------------------------

export type CancelCampaignResult =
  | { status: "cancelled"; skipped: number }
  | { status: "not_cancellable"; campaignStatus: MarketingCampaignStatus }
  | { status: "not_found" };

/**
 * Taslak ya da gönderilen kampanyayı durdurur. Bekleyen teslimler
 * `skipped (cancelled)` olur. O anda sağlayıcıya verilmekte olan ileti
 * (`sending`, satır kilitli) tamamlanır — geri çağrılamaz.
 */
export async function cancelCampaign(
  db: Database,
  actor: AdminActor,
  publicIdInput: unknown,
): Promise<CancelCampaignResult> {
  assertCapability(actor, "marketing.manage");
  const publicId = requirePublicId(publicIdInput);
  return db.transaction(async (tx) => {
    const campaign = (
      await tx
        .select({ id: marketingCampaign.id, status: marketingCampaign.status })
        .from(marketingCampaign)
        .where(eq(marketingCampaign.publicId, publicId))
        .for("update")
    )[0];
    if (!campaign) return { status: "not_found" } as const;
    if (campaign.status !== "draft" && campaign.status !== "sending") {
      return { status: "not_cancellable", campaignStatus: campaign.status } as const;
    }
    const now = new Date();
    const skipped = await tx
      .update(marketingCampaignDelivery)
      .set({ state: "skipped", skipReason: "cancelled", updatedAt: now })
      .where(
        and(
          eq(marketingCampaignDelivery.campaignId, campaign.id),
          eq(marketingCampaignDelivery.state, "pending"),
        ),
      )
      .returning({ id: marketingCampaignDelivery.id });
    await tx
      .update(marketingCampaign)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(eq(marketingCampaign.id, campaign.id));
    await recordAdminEvent(tx, {
      actor,
      action: "marketing.campaign_cancel",
      targetType: "marketing_campaign",
      targetId: campaign.id,
      before: { status: campaign.status },
      after: { status: "cancelled", skippedPending: skipped.length },
    });
    return { status: "cancelled", skipped: skipped.length } as const;
  });
}
