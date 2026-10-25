/**
 * Altı işlemsel e-posta şablonu (karar 0151). Metinler docs/copy.md
 * `email.*`; "satın al", "ucuz", "dupe" ve büyük harfli metin kullanılmaz.
 * Hiçbir şablon şifre, ham token ya da kişisel veri taşımaz: yalnızca
 * (varsa) tek kullanımlık bağlantı. Süreler `auth/token-ttl.ts`'ten gelir.
 */
import { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_MINUTES } from "../auth/token-ttl.ts";
import { EMAIL_BRAND, type RenderedMail, renderEmail } from "./layout.ts";

export type TransactionalEmailKind =
  | "verify_email"
  | "welcome"
  | "reset_password"
  | "password_changed"
  | "add_password"
  | "account_exists";

/** Bağlantı gerektiren şablonlar. */
export type LinkEmailKind = "verify_email" | "reset_password" | "add_password" | "account_exists";

const NOT_YOU_LINK =
  "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; bağlantıya tıklamadıkça hiçbir şey değişmez.";

export function buildVerifyEmail(url: string): RenderedMail {
  return renderEmail({
    subject: `${EMAIL_BRAND} hesabını doğrula`,
    preheader: "Hesabını oluşturmak için e-posta adresini doğrula.",
    title: "Hesabını doğrula",
    paragraphs: [
      `${EMAIL_BRAND} hesabını oluşturmak için e-posta adresini doğrulaman gerekiyor.`,
      `Bağlantı ${VERIFY_EMAIL_TTL_MINUTES} dakika geçerli ve yalnızca bir kez kullanılabilir.`,
    ],
    action: { label: "Hesabımı doğrula", url },
    security: [
      "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; doğrulamadıkça hesap açılmaz.",
    ],
  });
}

/** Hesap doğrulaması tamamlanınca gönderilir; reklam/pazarlama içermez. */
export function buildWelcomeEmail(url: string): RenderedMail {
  return renderEmail({
    subject: `${EMAIL_BRAND}'ye hoş geldin`,
    preheader: "Hesabın hazır. ManiCepte ile neler yapabileceğine göz at.",
    title: `${EMAIL_BRAND}'ye hoş geldin`,
    paragraphs: [
      "E-posta adresin doğrulandı ve hesabın hazır.",
      `${EMAIL_BRAND} şu an erken erişimde; özellikler açıldıkça hesabında görünür. Şimdilik şunları yapabilirsin:`,
    ],
    highlights: [
      "Fotoğraf, ürün bağlantısı ya da yazıyla ürün ara.",
      "Aynı ve benzer ürünleri farklı mağazalarda karşılaştır.",
      "Beğendiklerini kaydet, fiyat alarmı kur.",
    ],
    action: { label: `${EMAIL_BRAND}'i aç`, url },
    security: ["Bu hesabı sen açmadıysan bu e-postayı yanıtlayarak bize bildir; inceleyelim."],
  });
}

export function buildResetPasswordEmail(url: string): RenderedMail {
  return renderEmail({
    subject: `${EMAIL_BRAND} şifreni sıfırla`,
    preheader: "Yeni şifreni belirlemek için bağlantıyı kullan.",
    title: "Şifreni sıfırla",
    paragraphs: [
      "Şifreni sıfırlamak için aşağıdaki düğmeyi kullan.",
      `Bağlantı ${RESET_PASSWORD_TTL_MINUTES} dakika geçerli ve yalnızca bir kez kullanılabilir. Şifre değişince diğer cihazlardaki oturumların kapanır.`,
    ],
    action: { label: "Şifremi sıfırla", url },
    security: ["Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez."],
  });
}

/** Bildirim: şifre ya da başka hassas bilgi taşımaz, bağlantısı yoktur. */
export function buildPasswordChangedEmail(): RenderedMail {
  return renderEmail({
    subject: `${EMAIL_BRAND} şifren değiştirildi`,
    preheader: "Hesabının şifresi az önce değiştirildi.",
    title: "Şifren değiştirildi",
    paragraphs: [
      `${EMAIL_BRAND} hesabının şifresi az önce değiştirildi. Güvenliğin için diğer cihazlardaki oturumlar kapatıldı.`,
      "Değişikliği sen yaptıysan başka bir işlem yapman gerekmez.",
    ],
    security: [
      "Bu değişikliği sen yapmadıysan bu e-postayı hemen yanıtlayarak bize bildir. Hesabına girebiliyorsan “Şifremi unuttum” ile yeni bir şifre belirle.",
      "Güvenliğin için bu e-postada şifre ya da başka hassas bilgi bulunmaz.",
    ],
  });
}

/** Google/Apple ile açılmış hesaba e-posta+şifre girişi eklemek için tek kullanımlık bağlantı. */
export function buildAddPasswordEmail(url: string): RenderedMail {
  return renderEmail({
    subject: `${EMAIL_BRAND} hesabına şifre ekle`,
    preheader: "Hesabına e-posta ile de girebilmek için şifre belirle.",
    title: "Hesabına şifre ekle",
    paragraphs: [
      `Bu e-posta adresiyle açılmış bir ${EMAIL_BRAND} hesabın var. Google ya da Apple ile girmeye devam edebilirsin; e-posta ve şifreyle de girebilmek için aşağıdaki düğmeyle bir şifre belirle.`,
      `Bağlantı ${RESET_PASSWORD_TTL_MINUTES} dakika geçerli ve yalnızca bir kez kullanılabilir. Hesabın aynı kalır, yeni hesap açılmaz.`,
    ],
    action: { label: "Şifre belirle", url },
    security: [NOT_YOU_LINK],
  });
}

/** Kayıt formu, adresi zaten hesaba bağlı biri için gönderilir (yeni hesap açılmaz). */
export function buildAccountExistsEmail(url: string): RenderedMail {
  return renderEmail({
    subject: `${EMAIL_BRAND} hesabın zaten var`,
    preheader: "Bu adresle hesabın zaten var; yeni hesap açmadık.",
    title: "Hesabın zaten var",
    paragraphs: [
      "Bu e-posta adresiyle bir hesabın zaten var, bu yüzden yeni hesap açmadık. Google ya da Apple ile giriş yapabilir ya da e-posta ile giriş için bir şifre belirleyebilirsin.",
      `Bağlantı ${RESET_PASSWORD_TTL_MINUTES} dakika geçerli ve yalnızca bir kez kullanılabilir.`,
    ],
    action: { label: "Şifre belirle", url },
    security: [NOT_YOU_LINK],
  });
}

export function buildTransactionalEmail(kind: TransactionalEmailKind, url?: string): RenderedMail {
  if (kind === "password_changed") return buildPasswordChangedEmail();
  if (!url) throw new Error(`${kind} e-postası bağlantı gerektirir`);
  switch (kind) {
    case "verify_email":
      return buildVerifyEmail(url);
    case "welcome":
      return buildWelcomeEmail(url);
    case "reset_password":
      return buildResetPasswordEmail(url);
    case "add_password":
      return buildAddPasswordEmail(url);
    case "account_exists":
      return buildAccountExistsEmail(url);
  }
}
