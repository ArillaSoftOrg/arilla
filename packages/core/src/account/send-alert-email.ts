/**
 * docs/copy.md `email.price_drop_subject` / `email.restock_subject`. Ayrı
 * bir `size_restock` konu anahtarı yok - genel "yeniden stokta" konusu
 * kullanılır, beden bilgisi yalnızca gövdede geçer.
 *
 * docs/kvkk.md: alarm e-postaları işlemsel ileti (İYS gerekmez), bu yüzden
 * `email.unsubscribe` metni buraya eklenmiyor - o metin ticari ileti olan
 * haftalık özet için.
 */
import { emailFrom, getSmtpTransport } from "../email/transport.ts";
import type { AlertKind } from "./types.ts";

export interface SendAlertEmailInput {
  email: string;
  kind: AlertKind;
  productTitle: string;
  productUrl: string;
  sizeNorm?: string | null;
}

function subjectAndBody(input: SendAlertEmailInput): { subject: string; bodyLine: string } {
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

export async function sendAlertEmail(input: SendAlertEmailInput): Promise<void> {
  const { subject, bodyLine } = subjectAndBody(input);
  await getSmtpTransport().sendMail({
    from: emailFrom(),
    to: input.email,
    subject,
    text: `${bodyLine} ${input.productUrl}`,
    html: `<p>${bodyLine}</p><p><a href="${input.productUrl}">${input.productUrl}</a></p>`,
  });
}
