/**
 * docs/copy.md `email.price_drop_subject` / `email.restock_subject`. Ayrı
 * bir `size_restock` konu anahtarı yok - genel "yeniden stokta" konusu
 * kullanılır, beden bilgisi yalnızca gövdede geçer.
 *
 * docs/kvkk.md: alarm e-postaları işlemsel ileti (İYS gerekmez), bu yüzden
 * `email.unsubscribe` metni buraya eklenmiyor - o metin ticari ileti olan
 * haftalık özet için.
 *
 * `productTitle` merchant feed'inden veya kullanıcı linkinden gelir: HTML
 * gövdesine giren her dinamik değer `escapeHtml`'den geçer. Konu ve düz
 * metin gövde HTML değildir, kaçırılmaz.
 */
import { toEmailDeliveryError } from "../email/delivery-error.ts";
import { escapeHtml } from "../email/escape-html.ts";
import { emailFrom, getSmtpTransport } from "../email/transport.ts";
import type { AlertKind } from "./types.ts";

export interface SendAlertEmailInput {
  email: string;
  kind: AlertKind;
  productTitle: string;
  productUrl: string;
  sizeNorm?: string | null;
}

function subjectAndBody(input: Pick<SendAlertEmailInput, "kind" | "productTitle" | "sizeNorm">): {
  subject: string;
  bodyLine: string;
} {
  if (input.kind === "restock" || input.kind === "size_restock") {
    const subject = `${input.productTitle} yeniden stokta`;
    const bodyLine =
      input.kind === "size_restock" && input.sizeNorm
        ? `${input.productTitle} ürününün ${input.sizeNorm} bedeni yeniden stokta.`
        : `${input.productTitle} yeniden stokta.`;
    return { subject, bodyLine };
  }
  return { subject: `${input.productTitle} ucuzladı`, bodyLine: `${input.productTitle} ucuzladı.` };
}

export function buildAlertEmail(input: Omit<SendAlertEmailInput, "email">): {
  subject: string;
  text: string;
  html: string;
} {
  const { subject, bodyLine } = subjectAndBody(input);
  // Metin satiri ham degerlerle kurulur, sonra butunuyle kacirilir - boylece
  // hem baslik hem beden (sizeNorm) HTML'e ham girmez.
  const safeLine = escapeHtml(bodyLine);
  const safeUrl = escapeHtml(input.productUrl);
  return {
    subject,
    text: `${bodyLine} ${input.productUrl}`,
    html: `<p>${safeLine}</p><p><a href="${safeUrl}">${safeUrl}</a></p>`,
  };
}

export async function sendAlertEmail(input: SendAlertEmailInput): Promise<void> {
  const { email, ...content } = input;
  try {
    await getSmtpTransport().sendMail({
      from: emailFrom(),
      to: email,
      ...buildAlertEmail(content),
    });
  } catch (error) {
    throw toEmailDeliveryError(error);
  }
}
