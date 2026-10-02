/**
 * Kampanya içeriği: doğrulama ve e-posta gövdesi üretimi (saf, docs/decisions/0048).
 *
 * Gövde HTML DEĞİLDİR. Yönetici düz metin yazar: boş satır paragraf, tek
 * satır sonu `<br>`, `https://` ile başlayan adres bağlantı olur. Her parça
 * `escapeHtml`'den geçer; yöneticinin yazdığı `<script>`, `<a href=
 * "javascript:...">` ya da öznitelik metin olarak görünür, çalışmaz. Renk
 * yok (CLAUDE.md: koda renk gömülmez); posta istemcisinin varsayılanları.
 *
 * Her pazarlama iletisinin altbilgisi sabittir ve yönetici değiştiremez:
 * neden alındığı, abonelikten çıkma bağlantısı, hesap izinleri bağlantısı ve
 * gönderen kimliği (6563 sayılı Kanun, docs/kvkk.md "Ticari elektronik ileti").
 */
import { LEGAL_IDENTITY } from "../config/legal-identity.ts";
import { escapeHtml } from "../email/escape-html.ts";

export const CAMPAIGN_TITLE_MAX = 120;
export const CAMPAIGN_SUBJECT_MAX = 150;
export const CAMPAIGN_BODY_MAX = 10_000;

export class CampaignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignValidationError";
  }
}

export interface CampaignContentInput {
  title: unknown;
  subject: unknown;
  body: unknown;
}

export interface CampaignContent {
  title: string;
  subject: string;
  body: string;
}

// Sekme ve satır sonu dışındaki kontrol karakterleri (ve satır/paragraf ayırıcı).
// biome-ignore lint/suspicious/noControlCharactersInRegex: kontrol karakterini reddetmek amaç.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;

function singleLine(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) throw new CampaignValidationError(`${label} boş olamaz.`);
  if (text.length > max) throw new CampaignValidationError(`${label} en fazla ${max} karakter.`);
  // Konu başlığa gider: satır sonu başlık enjeksiyonu demektir.
  if (/[\r\n\t]/.test(text) || CONTROL_CHARS.test(text)) {
    throw new CampaignValidationError(`${label} tek satır olmalı ve kontrol karakteri içermemeli.`);
  }
  return text;
}

export function validateCampaignContent(input: CampaignContentInput): CampaignContent {
  const title = singleLine(input.title, "İç ad", CAMPAIGN_TITLE_MAX);
  const subject = singleLine(input.subject, "Konu", CAMPAIGN_SUBJECT_MAX);
  const rawBody = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n") : "";
  const body = rawBody.trim();
  if (body.length === 0) throw new CampaignValidationError("İçerik boş olamaz.");
  if (body.length > CAMPAIGN_BODY_MAX) {
    throw new CampaignValidationError(`İçerik en fazla ${CAMPAIGN_BODY_MAX} karakter.`);
  }
  if (CONTROL_CHARS.test(body)) {
    throw new CampaignValidationError("İçerik kontrol karakteri içermemeli.");
  }
  return { title, subject, body };
}

/** Yalnızca https. Sondaki noktalama bağlantıya dahil edilmez. */
const URL_PATTERN = /https:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

function linkifyLine(line: string): string {
  let html = "";
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    const trailing = TRAILING_PUNCTUATION.exec(url)?.[0] ?? "";
    if (trailing) url = url.slice(0, -trailing.length);
    let valid = false;
    try {
      valid = new URL(url).protocol === "https:";
    } catch {
      valid = false;
    }
    html += escapeHtml(line.slice(last, start));
    html += valid ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(url);
    html += escapeHtml(trailing);
    last = start + match[0].length;
  }
  return html + escapeHtml(line.slice(last));
}

export function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${paragraph.split("\n").map(linkifyLine).join("<br>")}</p>`)
    .join("\n");
}

export interface RenderInput {
  subject: string;
  body: string;
  /** Yayındaki marka adı (web `SITE_BRAND`). */
  brand: string;
  appUrl: string;
  /** Gerçek iletide kişiye özel iptal sayfası; testte `null`. */
  unsubscribeUrl: string | null;
  test: boolean;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Gönderen kimliği: yalnızca doğrulanmış alanlar (karar 0038, `null` yazılmaz). */
function senderIdentity(brand: string): string {
  return [LEGAL_IDENTITY.legalEntityName ?? brand, LEGAL_IDENTITY.legalAddress]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

export const TEST_SUBJECT_PREFIX = "Test: ";
const TEST_NOTICE =
  "Bu bir test iletisidir. Gerçek alıcılara gönderilmedi; abonelikten çıkma bağlantısı test iletisinde çalışmaz.";

export function renderMarketingEmail(input: RenderInput): RenderedEmail {
  const accountUrl = `${input.appUrl}/hesap`;
  const unsubscribeUrl = input.unsubscribeUrl ?? `${input.appUrl}/abonelik-iptali`;
  const subject = input.test ? `${TEST_SUBJECT_PREFIX}${input.subject}` : input.subject;
  const identity = senderIdentity(input.brand);

  // docs/copy.md `email.marketing_reason`, `email.unsubscribe`, `email.marketing_manage`.
  const reason = `Bu e-postayı, ${input.brand} hesabında kampanya ve fırsat e-postalarına izin verdiğin için aldın.`;
  const unsubscribe = "Bu bildirimleri almak istemiyorsan buradan kapatabilirsin.";
  const manage = "İzinlerini hesabından da yönetebilirsin.";

  const text = [
    ...(input.test ? [TEST_NOTICE, ""] : []),
    input.body,
    "",
    "--",
    reason,
    `${unsubscribe} ${unsubscribeUrl}`,
    `${manage} ${accountUrl}`,
    identity,
  ].join("\n");

  const safeUnsubscribe = escapeHtml(unsubscribeUrl);
  const safeAccount = escapeHtml(accountUrl);
  const html = `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:'IBM Plex Sans',Arial,sans-serif;font-size:16px;line-height:1.5;">
${input.test ? `<p style="padding:12px;border:1px solid;"><strong>${escapeHtml(TEST_NOTICE)}</strong></p>\n` : ""}<p style="font-size:18px;"><strong>${escapeHtml(input.brand)}</strong></p>
${bodyToHtml(input.body)}
<hr style="border:none;border-top:1px solid;opacity:0.3;margin:32px 0 16px;">
<div style="font-size:13px;opacity:0.8;">
<p>${escapeHtml(reason)}</p>
<p><a href="${safeUnsubscribe}">${escapeHtml(unsubscribe)}</a></p>
<p>${escapeHtml(manage)} <a href="${safeAccount}">${safeAccount}</a></p>
<p>${escapeHtml(identity)}</p>
</div>
</div>
</body>
</html>`;

  return { subject, text, html };
}
