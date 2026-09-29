/**
 * Ticari e-postanın TEK gönderim yolu (docs/decisions/0046). Özellik ve
 * kampanya kodu taşıyıcıyı doğrudan çağırmaz; bunu çağırır. İleride toplu
 * kampanya da alıcı başına bu fonksiyonu çağırır — kapı tekrar yazılmaz.
 *
 * Sıra:
 * 1. Ortam kapısı (`MARKETING_EMAIL_MODE`); `off` iken veritabanına bile
 *    gidilmez.
 * 2. Kilitli işlemde uygunluk kararı + gönderim kaydı talebi. Abonelik
 *    iptali aynı kilidi aldığı için iptal işlendikten sonra hiçbir talep eski
 *    rızayı göremez. `(campaign_key, email_hash)` tekil: yeniden deneme
 *    ikinci e-posta üretmez, yalnızca `failed` kayıt yeniden denenir.
 * 3. Gönderim işlem DIŞINDA (SMTP beklerken kilit tutulmaz); sonuç kayda
 *    yazılır. Sağlayıcı hatası fırlatılmaz, `failed` + hata kodu döner —
 *    adres, token ve sağlayıcı mesajı loglanmaz.
 */
import { type Database, marketingEmailSend } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import { requireAppUrl } from "../config/app-url.ts";
import { LEGAL_IDENTITY } from "../config/legal-identity.ts";
import { toEmailDeliveryError } from "../email/delivery-error.ts";
import { escapeHtml } from "../email/escape-html.ts";
import type { EmailContent, EmailTransport } from "../email/send.ts";
import { getSmtpTransport } from "../email/transport.ts";
import {
  decideMarketingEligibility,
  type IneligibleReason,
  loadMarketingFacts,
  lockMarketingSubject,
} from "./eligibility.ts";
import { type MarketingPolicy, marketingPolicyFromEnv } from "./policy.ts";
import { generateUnsubscribeToken, unsubscribeUrls } from "./unsubscribe.ts";

const CAMPAIGN_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface MarketingEmailRequest {
  /** Sunucu tarafında belirlenen alıcı; istemci girdisi değildir. */
  userId: number;
  /** Kampanya kimliği (ör. `launch-2026-10`); alıcı başına tek gönderim anahtarı. */
  campaignKey: string;
  content: EmailContent;
}

export type MarketingSendResult =
  | { status: "sent" }
  | { status: "skipped"; reason: IneligibleReason | "already_sent" | "in_flight" }
  | { status: "failed"; code: string };

export interface MarketingSendDeps {
  policy?: MarketingPolicy;
  transport?: EmailTransport;
  appUrl?: string;
}

export function buildMarketingFooter(
  appUrl: string,
  unsubscribePageUrl: string,
): { text: string; html: string } {
  const identity = [
    LEGAL_IDENTITY.legalEntityName,
    LEGAL_IDENTITY.legalAddress,
    LEGAL_IDENTITY.supportEmail,
  ].filter((part): part is string => Boolean(part?.trim()));
  const lines = [
    "Bu e-postayı, pazarlama e-postası almaya izin verdiğin için aldın.",
    `Almak istemiyorsan tek tıkla ayrılabilirsin: ${unsubscribePageUrl}`,
    `İletişim tercihlerini hesabından da değiştirebilirsin: ${appUrl}/hesap`,
    ...(identity.length > 0 ? [identity.join(" · ")] : []),
  ];
  const safeUnsub = escapeHtml(unsubscribePageUrl);
  const safeAccount = escapeHtml(`${appUrl}/hesap`);
  return {
    text: `\n\n--\n${lines.join("\n")}`,
    html: [
      '<hr><p style="font-size:12px">',
      "Bu e-postayı, pazarlama e-postası almaya izin verdiğin için aldın.<br>",
      `<a href="${safeUnsub}">E-posta listesinden ayrıl</a> · `,
      `<a href="${safeAccount}">İletişim tercihlerin</a>`,
      identity.length > 0 ? `<br>${escapeHtml(identity.join(" · "))}` : "",
      "</p>",
    ].join(""),
  };
}

type Claim =
  | { kind: "skip"; result: MarketingSendResult }
  | { kind: "send"; sendId: number; email: string; rawToken: string };

export async function sendMarketingEmail(
  db: Database,
  request: MarketingEmailRequest,
  deps: MarketingSendDeps = {},
): Promise<MarketingSendResult> {
  const policy = deps.policy ?? marketingPolicyFromEnv();
  if (policy.mode === "off") return { status: "skipped", reason: "disabled" };
  if (!CAMPAIGN_KEY.test(request.campaignKey)) {
    throw new Error("campaignKey gecersiz: kucuk harf, rakam, nokta, tire, alt cizgi (<=64).");
  }
  if (!policy.from) throw new Error("Pazarlama gondericisi (from) tanimsiz.");
  const appUrl = deps.appUrl ?? requireAppUrl();

  const claim: Claim = await db.transaction(async (tx) => {
    await lockMarketingSubject(tx, { userId: request.userId });
    const decision = decideMarketingEligibility(
      await loadMarketingFacts(tx, request.userId),
      policy,
    );
    if (!decision.eligible) {
      return { kind: "skip", result: { status: "skipped", reason: decision.reason } };
    }
    await lockMarketingSubject(tx, { emailHash: decision.emailHash });

    const existing = (
      await tx
        .select({ id: marketingEmailSend.id, status: marketingEmailSend.status })
        .from(marketingEmailSend)
        .where(
          and(
            eq(marketingEmailSend.campaignKey, request.campaignKey),
            eq(marketingEmailSend.emailHash, decision.emailHash),
          ),
        )
        .limit(1)
    )[0];
    if (existing?.status === "sent") {
      return { kind: "skip", result: { status: "skipped", reason: "already_sent" } };
    }
    if (existing?.status === "pending") {
      return { kind: "skip", result: { status: "skipped", reason: "in_flight" } };
    }

    const token = generateUnsubscribeToken();
    let sendId: number;
    if (existing) {
      await tx
        .update(marketingEmailSend)
        .set({
          status: "pending",
          errorCode: null,
          userId: decision.userId,
          consentId: decision.consentId,
          unsubscribeTokenHash: token.hash,
          updatedAt: new Date(),
        })
        .where(eq(marketingEmailSend.id, existing.id));
      sendId = existing.id;
    } else {
      const inserted = await tx
        .insert(marketingEmailSend)
        .values({
          campaignKey: request.campaignKey,
          userId: decision.userId,
          emailHash: decision.emailHash,
          consentId: decision.consentId,
          unsubscribeTokenHash: token.hash,
        })
        .returning({ id: marketingEmailSend.id });
      sendId = inserted[0]?.id as number;
    }
    return { kind: "send", sendId, email: decision.email, rawToken: token.raw };
  });

  if (claim.kind === "skip") return claim.result;

  const urls = unsubscribeUrls(appUrl, claim.rawToken);
  const footer = buildMarketingFooter(appUrl, urls.page);
  try {
    await (deps.transport ?? getSmtpTransport()).sendMail({
      from: policy.from,
      to: claim.email,
      ...(policy.replyTo ? { replyTo: policy.replyTo } : {}),
      subject: request.content.subject,
      text: `${request.content.text}${footer.text}`,
      html: `${request.content.html}${footer.html}`,
      headers: {
        // RFC 2369 + RFC 8058: posta istemcisinin "abonelikten çık" düğmesi.
        "List-Unsubscribe": `<${urls.oneClick}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  } catch (error) {
    const code = toEmailDeliveryError(error).code;
    await db
      .update(marketingEmailSend)
      .set({ status: "failed", errorCode: code, updatedAt: new Date() })
      .where(eq(marketingEmailSend.id, claim.sendId));
    return { status: "failed", code };
  }

  const now = new Date();
  await db
    .update(marketingEmailSend)
    .set({ status: "sent", sentAt: now, updatedAt: now })
    .where(eq(marketingEmailSend.id, claim.sendId));
  return { status: "sent" };
}
