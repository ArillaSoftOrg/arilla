/**
 * Kampanya teslim işlemcisi (docs/decisions/0048). Tek web isteğinde
 * binlerce ileti gönderilmez: her çağrı SINIRLI bir parti işler (ileti
 * sayısı + süre bütçesi) ve döner. Sürekliliği kalıcı durum sağlar
 * (`marketing_campaign_delivery`); çağıran cron (`/api/cron/marketing-
 * campaigns`, GitHub Actions) ya da yöneticinin "sonraki partiyi işle"
 * düğmesidir. Tarayıcının açık kalması gerekmez.
 *
 * Teslim başına adımlar:
 * 1. Kısa işlemde bir `pending` satır `FOR UPDATE SKIP LOCKED` ile alınır
 *    (iki işlemci aynı satırı alamaz).
 * 2. Aynı işlemde, abonelik iptaliyle AYNI kullanıcı kilidi altında, alıcı
 *    `classifyRecipient` ile yeniden sınıflandırılır. Uygun değilse
 *    `skipped`; adres o anki `app_user.email`'den okunur.
 * 3. Satır `sending` olur (deneme sayısı artar, iptal token özeti yazılır),
 *    işlem kapanır. SMTP beklerken kilit tutulmaz.
 * 4. Gönderilir. Başarı → `sent` (`WHERE state = 'sending'`). Hata →
 *    `classifySendError`: geçici + hak varsa `pending` (geri çekilmeli),
 *    yapılandırma → satır tüketilmeden `pending`e döner ve iş durur, diğer
 *    her şey → `failed`.
 *
 * En fazla bir kez: başarıdan sonra kayıt yazılamazsa (süreç öldü) satır
 * `sending`te kalır; `staleSendingMs` sonra `unknown_outcome` ile kapanır,
 * YENİDEN GÖNDERİLMEZ. `sent` bir satır hiçbir yoldan `pending`e dönmez.
 *
 * "Gönderildi" = sağlayıcı SMTP'de kabul etti. Teslim edildi DEMEK DEĞİLDİR;
 * bounce/şikâyet olayları henüz işlenmiyor (karar 0048 "Açık").
 */
import { randomUUID } from "node:crypto";
import { type Database, marketingCampaign, marketingCampaignDelivery } from "@arilla/db";
import { and, eq, sql } from "drizzle-orm";
import type { Transporter } from "nodemailer";
import { requireAppUrl } from "../config/app-url.ts";
import { getSmtpTransport } from "../email/transport.ts";
import {
  MarketingConfigError,
  type MarketingEmailConfig,
  marketingEmailConfigFromEnv,
} from "./config.ts";
import { renderMarketingEmail } from "./content.ts";
import { classifyRecipient } from "./eligibility.ts";
import { classifySendError, retryDelayMs } from "./send-error.ts";
import {
  generateUnsubscribeToken,
  marketingConsentLockSql,
  unsubscribeUrls,
} from "./unsubscribe.ts";

/** Testlerde sahte taşıyıcı verilebilsin diye yalnızca kullanılan yüzey. */
export type MarketingTransport = Pick<Transporter, "sendMail">;

type Env = Readonly<Record<string, string | undefined>>;

export interface ProcessCampaignsOptions {
  /** Yayındaki marka adı (web `SITE_BRAND`). */
  brand: string;
  /** Yalnızca bu kampanya (iç `id`); yoksa `sending` durumundaki tümü. */
  campaignId?: number;
  transport?: MarketingTransport;
  env?: Env;
  /** Test kancaları. */
  sleep?: (ms: number) => Promise<void>;
  config?: Partial<MarketingEmailConfig>;
}

export type ProcessStop =
  | "idle"
  | "batch_limit"
  | "time_budget"
  | "configuration_error"
  | "bulk_send_disabled";

export interface ProcessCampaignsResult {
  sent: number;
  failed: number;
  skipped: number;
  retryScheduled: number;
  /** Askıda kalıp `unknown_outcome` ile kapatılan teslimler. */
  recoveredStale: number;
  /** Bu çağrıda sonuçlanan kampanyalar. */
  finalized: number;
  stoppedBy: ProcessStop;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function scopeSql(campaignId: number | undefined, column: string) {
  return campaignId === undefined ? sql`` : sql`AND ${sql.raw(column)} = ${campaignId}`;
}

async function markCampaignError(
  db: Database,
  campaignId: number | undefined,
  code: "configuration_error" | "bulk_send_disabled",
): Promise<void> {
  await db
    .update(marketingCampaign)
    .set({ lastErrorCode: code, lastErrorAt: new Date() })
    .where(
      and(
        eq(marketingCampaign.status, "sending"),
        campaignId === undefined ? undefined : eq(marketingCampaign.id, campaignId),
      ),
    );
}

async function recoverStaleSends(
  db: Database,
  campaignId: number | undefined,
  staleMs: number,
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE marketing_campaign_delivery
       SET state = 'failed', failure_code = 'unknown_outcome', updated_at = now()
     WHERE state = 'sending'
       AND claimed_at < now() - make_interval(secs => ${staleMs / 1000})
       ${scopeSql(campaignId, "campaign_id")}
  `);
  return result.rowCount ?? 0;
}

type Claim =
  | { kind: "none" }
  | { kind: "skipped" }
  | {
      kind: "send";
      deliveryId: number;
      attemptCount: number;
      email: string;
      subject: string;
      body: string;
      rawToken: string;
    };

async function claimNext(db: Database, campaignId: number | undefined): Promise<Claim> {
  return db.transaction(async (tx) => {
    const picked = await tx.execute<{
      id: string;
      user_id: string | null;
      attempt_count: number;
      subject: string;
      body: string;
    }>(sql`
      SELECT d.id, d.user_id, d.attempt_count, c.subject, c.body
        FROM marketing_campaign_delivery d
        JOIN marketing_campaign c ON c.id = d.campaign_id
       WHERE c.status = 'sending'
         AND d.state = 'pending'
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
         ${scopeSql(campaignId, "d.campaign_id")}
       ORDER BY d.campaign_id, d.id
       LIMIT 1
       FOR UPDATE OF d SKIP LOCKED
    `);
    const row = picked.rows[0];
    if (!row) return { kind: "none" };
    const deliveryId = Number(row.id);

    if (row.user_id === null) {
      await tx
        .update(marketingCampaignDelivery)
        .set({ state: "skipped", skipReason: "account_deleted", updatedAt: new Date() })
        .where(eq(marketingCampaignDelivery.id, deliveryId));
      return { kind: "skipped" };
    }
    const userId = Number(row.user_id);

    // Abonelik iptaliyle aynı kilit: iptal işlendiyse burada görülür.
    await tx.execute(marketingConsentLockSql(userId));
    const recipient = await classifyRecipient(tx, userId);
    if (recipient.reason !== "eligible") {
      await tx
        .update(marketingCampaignDelivery)
        .set({
          state: "skipped",
          skipReason: recipient.reason === "no_user" ? "account_deleted" : "not_eligible",
          updatedAt: new Date(),
        })
        .where(eq(marketingCampaignDelivery.id, deliveryId));
      return { kind: "skipped" };
    }

    const token = generateUnsubscribeToken();
    const attemptCount = row.attempt_count + 1;
    await tx
      .update(marketingCampaignDelivery)
      .set({
        state: "sending",
        claimedAt: new Date(),
        attemptCount,
        nextAttemptAt: null,
        unsubscribeTokenHash: token.hash,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(marketingCampaignDelivery.id, deliveryId),
          eq(marketingCampaignDelivery.state, "pending"),
        ),
      );
    return {
      kind: "send",
      deliveryId,
      attemptCount,
      email: recipient.email,
      subject: row.subject,
      body: row.body,
      rawToken: token.raw,
    };
  });
}

/** Message-ID alan adı: gönderen adresinin alanı. */
function messageIdDomain(from: string): string {
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from;
  return address.split("@")[1]?.trim().toLowerCase() || "localhost";
}

async function finalizeCampaigns(db: Database, campaignId: number | undefined): Promise<number> {
  const result = await db.execute(sql`
    UPDATE marketing_campaign c
       SET status = CASE
             WHEN s.sent = 0 AND s.failed > 0 THEN 'failed'
             WHEN s.failed > 0 THEN 'partially_failed'
             ELSE 'completed'
           END,
           completed_at = now(),
           updated_at = now()
      FROM (
        SELECT campaign_id,
               count(*) FILTER (WHERE state = 'sent') AS sent,
               count(*) FILTER (WHERE state = 'failed') AS failed,
               count(*) FILTER (WHERE state IN ('pending', 'sending')) AS open
          FROM marketing_campaign_delivery
         GROUP BY campaign_id
      ) s
     WHERE c.id = s.campaign_id
       AND c.status = 'sending'
       AND s.open = 0
       ${scopeSql(campaignId, "c.id")}
  `);
  return result.rowCount ?? 0;
}

export async function processMarketingCampaigns(
  db: Database,
  options: ProcessCampaignsOptions,
): Promise<ProcessCampaignsResult> {
  const env = options.env ?? process.env;
  const sleep = options.sleep ?? defaultSleep;
  const result: ProcessCampaignsResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    retryScheduled: 0,
    recoveredStale: 0,
    finalized: 0,
    stoppedBy: "idle",
  };

  // Yapılandırma döngüden ÖNCE: eksikse hiçbir teslim tüketilmez, kampanya
  // `sending`te kalır ve yönetim ekranı hata kodunu gösterir.
  let config: MarketingEmailConfig;
  let appUrl: string;
  try {
    config = { ...marketingEmailConfigFromEnv(env), ...options.config };
    appUrl = requireAppUrl(env);
  } catch (error) {
    // `MarketingConfigError` ya da `APP_URL` eksik. Mesaj değer içermez ama
    // yine de yalnızca adı loglanır.
    await markCampaignError(db, options.campaignId, "configuration_error");
    console.error(
      `[pazarlama] yapilandirma eksik, kampanya islenmedi: ${error instanceof MarketingConfigError ? error.name : "APP_URL"}`,
    );
    result.stoppedBy = "configuration_error";
    return result;
  }
  if (!config.bulkSendAllowed) {
    await markCampaignError(db, options.campaignId, "bulk_send_disabled");
    result.stoppedBy = "bulk_send_disabled";
    return result;
  }

  result.recoveredStale = await recoverStaleSends(db, options.campaignId, config.staleSendingMs);
  await db
    .update(marketingCampaign)
    .set({ lastErrorCode: null, lastErrorAt: null })
    .where(
      and(
        eq(marketingCampaign.status, "sending"),
        options.campaignId === undefined ? undefined : eq(marketingCampaign.id, options.campaignId),
      ),
    );

  const transport = options.transport ?? getSmtpTransport();
  const domain = messageIdDomain(config.from);
  const startedAt = Date.now();
  let attempted = 0;

  while (true) {
    if (attempted >= config.batchSize) {
      result.stoppedBy = "batch_limit";
      break;
    }
    if (Date.now() - startedAt >= config.timeBudgetMs) {
      result.stoppedBy = "time_budget";
      break;
    }

    const claim = await claimNext(db, options.campaignId);
    if (claim.kind === "none") {
      result.stoppedBy = "idle";
      break;
    }
    if (claim.kind === "skipped") {
      result.skipped++;
      continue;
    }

    if (attempted > 0 && config.sendIntervalMs > 0) await sleep(config.sendIntervalMs);
    attempted++;

    const urls = unsubscribeUrls(appUrl, claim.rawToken);
    const content = renderMarketingEmail({
      subject: claim.subject,
      body: claim.body,
      brand: options.brand,
      appUrl,
      unsubscribeUrl: urls.page,
      test: false,
    });
    const messageId = `<mc-${randomUUID()}@${domain}>`;

    try {
      await transport.sendMail({
        from: config.from,
        to: claim.email,
        ...(config.replyTo ? { replyTo: config.replyTo } : {}),
        subject: content.subject,
        text: content.text,
        html: content.html,
        messageId,
        headers: {
          // RFC 2369 + RFC 8058: posta istemcisinin "abonelikten çık" düğmesi.
          "List-Unsubscribe": `<${urls.oneClick}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
    } catch (error) {
      const outcome = classifySendError(error);
      const base = { updatedAt: new Date(), providerErrorCode: outcome.providerCode };
      const where = and(
        eq(marketingCampaignDelivery.id, claim.deliveryId),
        eq(marketingCampaignDelivery.state, "sending"),
      );
      // Yalnızca hata kodu loglanır; adres ve sağlayıcı mesajı loga girmez.
      console.error(`[pazarlama] gonderilemedi: ${outcome.providerCode}`);

      if (outcome.kind === "configuration") {
        // Teslim tüketilmez: deneme geri alınır, iş durur.
        await db
          .update(marketingCampaignDelivery)
          .set({
            ...base,
            state: "pending",
            attemptCount: claim.attemptCount - 1,
            claimedAt: null,
            unsubscribeTokenHash: null,
          })
          .where(where);
        await markCampaignError(db, options.campaignId, "configuration_error");
        result.stoppedBy = "configuration_error";
        break;
      }
      if (outcome.kind === "retryable" && claim.attemptCount < config.maxAttempts) {
        await db
          .update(marketingCampaignDelivery)
          .set({
            ...base,
            state: "pending",
            claimedAt: null,
            unsubscribeTokenHash: null,
            nextAttemptAt: new Date(Date.now() + retryDelayMs(claim.attemptCount)),
          })
          .where(where);
        result.retryScheduled++;
        continue;
      }
      await db
        .update(marketingCampaignDelivery)
        .set({
          ...base,
          state: "failed",
          failureCode: outcome.kind === "retryable" ? "temporary_error" : outcome.failureCode,
        })
        .where(where);
      result.failed++;
      continue;
    }

    await db
      .update(marketingCampaignDelivery)
      .set({
        state: "sent",
        sentAt: new Date(),
        providerMessageId: messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(marketingCampaignDelivery.id, claim.deliveryId),
          eq(marketingCampaignDelivery.state, "sending"),
        ),
      );
    result.sent++;
  }

  result.finalized = await finalizeCampaigns(db, options.campaignId);
  return result;
}
