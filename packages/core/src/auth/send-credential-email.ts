/**
 * E-posta/sifre akisinin e-postalari (kayit dogrulama, sifre sifirlama,
 * "bu adresle hesap var"). Baglanti yalnizca govdeye gomulur, loglanmaz.
 * Gonderim hatasi `EmailDeliveryError` olarak firlar. Metinler docs/copy.md
 * `email.credential_*`; "satin al", "ucuz" ve buyuk harfli metin kullanilmaz.
 * Tasiyici `../email/transport.ts` (giris baglantisiyla ayni SMTP havuzu).
 */
import { toEmailDeliveryError } from "../email/delivery-error.ts";
import { escapeHtml } from "../email/escape-html.ts";
import { emailFrom, getSmtpTransport } from "../email/transport.ts";

export type CredentialEmailKind = "verify_email" | "reset_password" | "account_exists";

export interface CredentialEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Yalnizca YENI token'lara uygulanir; `expires_at` yazildigi anda sabitlenir, eski token'lar etkilenmez. */
export const VERIFY_EMAIL_TTL_MINUTES = 15;
export const RESET_PASSWORD_TTL_MINUTES = 30;

const BRAND = "ManiCepte";

function layout(title: string, paragraphs: string[], action: { label: string; url: string }) {
  const url = escapeHtml(action.url);
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:32rem;margin:0 auto;padding:24px"><p style="margin:0 0 24px;font-size:22px;font-style:italic;font-weight:600">${BRAND}</p><h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${escapeHtml(title)}</h1>${body}<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 24px;border-radius:999px;border:2px solid currentColor;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p><p style="margin:0 0 8px;font-size:13px">Düğme çalışmazsa bu bağlantıyı tarayıcına yapıştır:</p><p style="margin:0;font-size:13px;word-break:break-all"><a href="${url}">${url}</a></p></div>`;
}

export function buildCredentialEmail(
  kind: CredentialEmailKind,
  url: string,
): CredentialEmailContent {
  if (kind === "verify_email") {
    return {
      subject: `${BRAND} e-posta adresini doğrula`,
      text: `${BRAND} hesabını oluşturmak için e-posta adresini doğrula (${VERIFY_EMAIL_TTL_MINUTES} dakika geçerli, tek kullanımlık): ${url}\n\nBu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; hesap açılmaz.`,
      html: layout(
        "E-posta adresini doğrula",
        [
          `${BRAND} hesabını oluşturmak için e-posta adresini doğrulaman gerekiyor. Bağlantı ${VERIFY_EMAIL_TTL_MINUTES} dakika geçerli ve yalnızca bir kez kullanılabilir.`,
          "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; hesap açılmaz.",
        ],
        { label: "Adresimi doğrula", url },
      ),
    };
  }
  if (kind === "reset_password") {
    return {
      subject: `${BRAND} şifreni sıfırla`,
      text: `Şifreni belirlemek ya da sıfırlamak için bağlantıya tıkla (${RESET_PASSWORD_TTL_MINUTES} dakika geçerli, tek kullanımlık): ${url}\n\nBu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.`,
      html: layout(
        "Şifreni belirle",
        [
          `Şifreni belirlemek ya da sıfırlamak için aşağıdaki düğmeyi kullan. Bağlantı ${RESET_PASSWORD_TTL_MINUTES} dakika geçerli ve yalnızca bir kez kullanılabilir. Şifre değişince diğer cihazlardaki oturumların kapanır.`,
          "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.",
        ],
        { label: "Şifre belirle", url },
      ),
    };
  }
  return {
    subject: `${BRAND} hesabın zaten var`,
    text: `Bu e-posta adresiyle ${BRAND} hesabın zaten var. Google ya da Apple ile giriş yapabilir ya da e-posta ile giriş için şifre belirleyebilirsin (${RESET_PASSWORD_TTL_MINUTES} dakika geçerli): ${url}\n\nBu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.`,
    html: layout(
      "Hesabın zaten var",
      [
        "Bu e-posta adresiyle bir hesabın zaten var, bu yüzden yeni hesap açmadık. Google ya da Apple ile giriş yapabilir ya da e-posta ile giriş için bir şifre belirleyebilirsin.",
        "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.",
      ],
      { label: "Şifre belirle", url },
    ),
  };
}

export async function sendCredentialEmail(input: {
  kind: CredentialEmailKind;
  email: string;
  url: string;
}): Promise<void> {
  try {
    await getSmtpTransport().sendMail({
      from: emailFrom(),
      to: input.email,
      ...buildCredentialEmail(input.kind, input.url),
    });
  } catch (error) {
    throw toEmailDeliveryError(error);
  }
}
