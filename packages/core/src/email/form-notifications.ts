/**
 * İletişim / geri bildirim formları için e-posta bildirimleri (docs/decisions/0222).
 *
 * İki ayrı e-posta, iki ayrı yönetim anahtarı:
 * - Ekibe bildirim (`teamNotifications`): `ADMIN_NOTIFY_EMAIL` adresine. KİŞİSEL VERİ TAŞIMAZ:
 *   yalnızca kategori, başlık ve gelen kutusu bağlantısı. Gönderenin e-postası ve mesaj metni
 *   e-postaya konmaz (yalnızca `messages.read` + denetimle görünür, karar 0049/0061).
 * - Ziyaretçiye onay (`visitorConfirmations`): formda bırakılan adrese, SABİT metinle. Kullanıcının
 *   yazdığı serbest metin hiçbir yerde yankılanmaz (başkasının adresine metin göndermek kötüye
 *   kullanım yüzeyi olurdu).
 *
 * `notifyFormReceived` asla fırlatmaz: kayıt zaten yazılmıştır, e-posta hatası formu bozmaz. Logda
 * yalnızca hata kodu yer alır (alıcı, başlık, gövde yok).
 *
 * Şablonlar saf fonksiyonlardır; yönetim önizlemesi ve gerçek gönderim AYNI fonksiyonları kullanır.
 */
import type { Database } from "@arilla/db";
import type { Transporter } from "nodemailer";
import { buildAlertEmail } from "../account/send-alert-email.ts";
import { adminHostPolicy } from "../admin/admin-host.ts";
import { readAppUrl } from "../config/app-url.ts";
import { FORM_EMAIL_PATTERN } from "../feedback/validate.ts";
import { toEmailDeliveryError } from "./delivery-error.ts";
import { EMAIL_BRAND, type RenderedMail, renderEmail } from "./layout.ts";
import { type EmailSettings, readEmailSettings } from "./settings.ts";
import { buildTransactionalEmail } from "./transactional-templates.ts";
import { emailFrom, emailReplyTo, getSmtpTransport, smtpConfigFromEnv } from "./transport.ts";

export type FormNotificationKind = "contact" | "feedback";

export interface FormNotification {
  kind: FormNotificationKind;
  /** Okunur kategori etiketi (web kopyasından gelir). */
  categoryLabel: string;
  /** İletişim konusu ya da geri bildirim başlığı. */
  title: string;
  /** Formda bırakılan adres; yoksa onay e-postası gitmez. */
  visitorEmail: string | null;
}

const TEAM_FOOTER = "Bu bildirim, yönetimdeki e-posta ayarlarında açık olduğu için gönderildi.";
const INBOX_PATH = "/yonetim/mesajlar";

const KIND_TEXT: Record<
  FormNotificationKind,
  { teamTitle: string; teamSubject: string; visitorTitle: string; visitorIntro: string }
> = {
  contact: {
    teamTitle: "Yeni iletişim mesajı",
    teamSubject: "Yeni iletişim mesajı",
    visitorTitle: "Mesajını aldık",
    visitorIntro: "İletişim formundan gönderdiğin mesaj bize ulaştı.",
  },
  feedback: {
    teamTitle: "Yeni geri bildirim",
    teamSubject: "Yeni geri bildirim",
    visitorTitle: "Geri bildirimini aldık",
    visitorIntro: "Gönderdiğin geri bildirim bize ulaştı, teşekkürler.",
  },
};

/** Gelen kutusu bağlantısı: yönetim ayrı ana makinedeyse onun adresi, değilse site adresi. */
export function inboxUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  try {
    const policy = adminHostPolicy(env);
    if (policy.mode === "split") return `${policy.origin}${INBOX_PATH}`;
    if (policy.mode === "invalid") return null;
    const base = readAppUrl(env);
    return base ? `${base}${INBOX_PATH}` : null;
  } catch {
    return null;
  }
}

export function buildTeamNotificationEmail(
  input: Pick<FormNotification, "kind" | "categoryLabel" | "title">,
  inbox: string | null,
): RenderedMail {
  const text = KIND_TEXT[input.kind];
  return renderEmail({
    subject: `${EMAIL_BRAND}: ${text.teamSubject}`,
    preheader: `${text.teamTitle}: ${input.categoryLabel}.`,
    title: text.teamTitle,
    paragraphs: [
      `Konu: ${input.categoryLabel}`,
      `Başlık: ${input.title}`,
      "Gönderenin bilgileri ve mesajın metni bu e-postada yer almaz; gelen kutusundan okuyabilirsin.",
    ],
    ...(inbox ? { action: { label: "Gelen kutusunu aç", url: inbox } } : {}),
    footer: TEAM_FOOTER,
  });
}

export function buildVisitorConfirmationEmail(
  input: Pick<FormNotification, "kind" | "categoryLabel">,
): RenderedMail {
  const text = KIND_TEXT[input.kind];
  const followUp =
    input.kind === "contact"
      ? "Mesajını inceleyip bu adrese yanıt vereceğiz."
      : "Her geri bildirime tek tek yanıt veremeyebiliriz; ürünü geliştirirken hepsini dikkate alırız.";
  return renderEmail({
    subject: `${EMAIL_BRAND}: ${text.visitorTitle.toLocaleLowerCase("tr-TR")}`,
    preheader: text.visitorIntro,
    title: text.visitorTitle,
    paragraphs: [`${text.visitorIntro} Konu: ${input.categoryLabel}.`, followUp],
    security: ["Bunu sen göndermediysen bu e-postayı yok sayabilirsin; başka bir işlem gerekmez."],
    footer: `${EMAIL_BRAND} formuna gönderilen bir mesaj nedeniyle yollandı. Bu ileti işlemseldir; reklam içermez.`,
  });
}

export type FormMailTransport = Pick<Transporter, "sendMail">;

export interface NotifyFormDeps {
  transport?: FormMailTransport;
  env?: Readonly<Record<string, string | undefined>>;
  /** Test kancası: verilirse veritabanı okunmaz. */
  settings?: EmailSettings;
}

export interface NotifyFormResult {
  team: boolean;
  visitor: boolean;
}

function teamRecipient(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.ADMIN_NOTIFY_EMAIL?.trim().toLowerCase();
  return raw && FORM_EMAIL_PATTERN.test(raw) ? raw : null;
}

export interface EmailChannelStatus {
  /** SMTP bağlantı ayarı geçerli mi (ağ erişimi yok; yalnızca ortam değişkenleri). */
  smtpConfigured: boolean;
  /** Gönderen adresi (`EMAIL_FROM`) tanımlı mı. */
  fromConfigured: boolean;
  /** Ekip bildirimi alıcısı (`ADMIN_NOTIFY_EMAIL`) geçerli mi. */
  notifyConfigured: boolean;
}

/**
 * Yönetim sayfasındaki "bağlı" durumu. Değer ASLA dönmez: yalnızca üç boolean (sırlar panelde
 * gösterilmez, karar 0086). Sağlayıcıya bağlanmaz.
 */
export function emailChannelStatus(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmailChannelStatus {
  let smtpConfigured = true;
  try {
    smtpConfigFromEnv(env);
  } catch {
    smtpConfigured = false;
  }
  return {
    smtpConfigured,
    fromConfigured: Boolean(env.EMAIL_FROM?.trim()),
    notifyConfigured: teamRecipient(env) !== null,
  };
}

/**
 * Form kaydından SONRA çağrılır. Açık anahtarlara göre ekibe ve/veya ziyaretçiye e-posta gönderir;
 * hangisinin gittiğini döner. Hiçbir koşulda fırlatmaz.
 */
export async function notifyFormReceived(
  db: Pick<Database, "select">,
  input: FormNotification,
  deps: NotifyFormDeps = {},
): Promise<NotifyFormResult> {
  const result: NotifyFormResult = { team: false, visitor: false };
  try {
    const env = deps.env ?? process.env;
    const settings = deps.settings ?? (await readEmailSettings(db));
    if (!settings.teamNotifications && !settings.visitorConfirmations) return result;

    const transport = deps.transport ?? getSmtpTransport();
    const from = emailFrom();

    if (settings.teamNotifications) {
      const to = teamRecipient(env);
      if (!to) {
        console.error(
          "[eposta] ADMIN_NOTIFY_EMAIL tanimsiz ya da gecersiz, ekip bildirimi gonderilmedi",
        );
      } else {
        try {
          await transport.sendMail({
            from,
            to,
            ...buildTeamNotificationEmail(input, inboxUrl(env)),
          });
          result.team = true;
        } catch (error) {
          console.error(
            `[eposta] ekip bildirimi gonderilemedi: ${toEmailDeliveryError(error).code}`,
          );
        }
      }
    }

    const visitor = input.visitorEmail?.trim().toLowerCase();
    if (settings.visitorConfirmations && visitor && FORM_EMAIL_PATTERN.test(visitor)) {
      try {
        await transport.sendMail({
          from,
          to: visitor,
          replyTo: emailReplyTo(),
          ...buildVisitorConfirmationEmail(input),
        });
        result.visitor = true;
      } catch (error) {
        console.error(
          `[eposta] ziyaretci onayi gonderilemedi: ${toEmailDeliveryError(error).code}`,
        );
      }
    }
  } catch (error) {
    console.error(`[eposta] form bildirimi islenemedi: ${toEmailDeliveryError(error).code}`);
  }
  return result;
}

// --- Yönetim önizlemesi -----------------------------------------------------------------------

export type EmailPreviewGroup = "team" | "visitor" | "account" | "alert";

export interface EmailPreview {
  key: string;
  label: string;
  group: EmailPreviewGroup;
  mail: RenderedMail;
}

const SAMPLE_LINK = "https://ornek.test/baglanti";

/** Örnek verili önizleme. E-posta göndermez, veritabanına dokunmaz. */
export function buildEmailPreviews(): EmailPreview[] {
  return [
    {
      key: "contact_team",
      label: "İletişim mesajı · ekibe bildirim",
      group: "team",
      mail: buildTeamNotificationEmail(
        { kind: "contact", categoryLabel: "Teknik sorun", title: "Giriş yapamıyorum" },
        `https://ornek.test${INBOX_PATH}`,
      ),
    },
    {
      key: "feedback_team",
      label: "Geri bildirim · ekibe bildirim",
      group: "team",
      mail: buildTeamNotificationEmail(
        { kind: "feedback", categoryLabel: "Öneri", title: "Karşılaştırma ekranı" },
        `https://ornek.test${INBOX_PATH}`,
      ),
    },
    {
      key: "contact_visitor",
      label: "İletişim mesajı · ziyaretçiye onay",
      group: "visitor",
      mail: buildVisitorConfirmationEmail({ kind: "contact", categoryLabel: "Teknik sorun" }),
    },
    {
      key: "feedback_visitor",
      label: "Geri bildirim · ziyaretçiye onay",
      group: "visitor",
      mail: buildVisitorConfirmationEmail({ kind: "feedback", categoryLabel: "Öneri" }),
    },
    {
      key: "price_drop_alert",
      label: "Fiyat alarmı",
      group: "alert",
      mail: buildAlertEmail({
        kind: "price_drop",
        productTitle: "Örnek ürün",
        productUrl: `${SAMPLE_LINK}/urun/ornek`,
      }),
    },
    ...(
      [
        ["verify_email", "Hesap doğrulama (her zaman açık)"],
        ["welcome", "Hoş geldin (her zaman açık)"],
        ["reset_password", "Şifre sıfırlama (her zaman açık)"],
        ["password_changed", "Şifre değişti (her zaman açık)"],
        ["add_password", "Şifre ekleme (her zaman açık)"],
        ["account_exists", "Hesap zaten var (her zaman açık)"],
      ] as const
    ).map(([kind, label]) => ({
      key: kind,
      label,
      group: "account" as const,
      mail: buildTransactionalEmail(kind, SAMPLE_LINK),
    })),
  ];
}
