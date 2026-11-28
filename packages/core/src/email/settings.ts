/**
 * Yönetimdeki e-posta anahtarları (docs/decisions/0222). Tek satır (`email_setting`, id = 1).
 *
 * İki ayrı okuma:
 * - `readEmailSettings`: GÖNDERİM yolları için, yetki sormaz, asla fırlatmaz. Tablo yoksa ya da
 *   veritabanı hata verirse güvenli varsayılan: yeni bildirimler KAPALI, mevcut e-postalar eskisi
 *   gibi AÇIK (bu özellik gelmeden önceki davranış).
 * - `getEmailSettingsForAdmin`: `/yonetim/eposta` için, `email.manage` ister.
 *
 * Yazma `updateEmailSettings`: yetki (ikinci kez), katı doğrulama, aynı işlemde denetim kaydı.
 */
import { type Database, emailSetting } from "@arilla/db";
import { eq } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";

export interface EmailSettings {
  teamNotifications: boolean;
  visitorConfirmations: boolean;
  priceAlerts: boolean;
  marketingEmails: boolean;
}

export const EMAIL_SETTING_KEYS = [
  "teamNotifications",
  "visitorConfirmations",
  "priceAlerts",
  "marketingEmails",
] as const satisfies readonly (keyof EmailSettings)[];

/** Satır yokken geçerli değerler; migration'daki kolon varsayılanlarıyla aynı olmalı. */
export const EMAIL_SETTING_DEFAULTS: Readonly<EmailSettings> = {
  teamNotifications: false,
  visitorConfirmations: false,
  priceAlerts: true,
  marketingEmails: true,
};

export class EmailSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSettingsValidationError";
  }
}

/**
 * Saf doğrulama. Bilinmeyen anahtar, eksik anahtar ve boolean olmayan değer reddedilir:
 * `Boolean("false")` gibi sessiz dönüşümler anahtarı yanlış çevirebilirdi.
 */
export function validateEmailSettings(input: unknown): EmailSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EmailSettingsValidationError("Ayarlar bir nesne olmalı.");
  }
  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(EMAIL_SETTING_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new EmailSettingsValidationError("Bilinmeyen ayar var.");
  }
  const result = { ...EMAIL_SETTING_DEFAULTS };
  for (const key of EMAIL_SETTING_KEYS) {
    const value = record[key];
    if (typeof value !== "boolean") {
      throw new EmailSettingsValidationError("Her ayar açık ya da kapalı olmalı.");
    }
    result[key] = value;
  }
  return result;
}

function fromRow(
  row: Partial<Record<keyof EmailSettings, boolean | null | undefined>> | undefined,
): EmailSettings {
  return {
    teamNotifications: row?.teamNotifications ?? EMAIL_SETTING_DEFAULTS.teamNotifications,
    visitorConfirmations: row?.visitorConfirmations ?? EMAIL_SETTING_DEFAULTS.visitorConfirmations,
    priceAlerts: row?.priceAlerts ?? EMAIL_SETTING_DEFAULTS.priceAlerts,
    marketingEmails: row?.marketingEmails ?? EMAIL_SETTING_DEFAULTS.marketingEmails,
  };
}

const settingColumns = {
  teamNotifications: emailSetting.teamNotifications,
  visitorConfirmations: emailSetting.visitorConfirmations,
  priceAlerts: emailSetting.priceAlerts,
  marketingEmails: emailSetting.marketingEmails,
};

/** Gönderim yolları için. Yetki sormaz; hata durumunda varsayılana düşer ve fırlatmaz. */
export async function readEmailSettings(db: Pick<Database, "select">): Promise<EmailSettings> {
  try {
    const rows = await db
      .select(settingColumns)
      .from(emailSetting)
      .where(eq(emailSetting.id, 1))
      .limit(1);
    return fromRow(rows[0]);
  } catch {
    // Hata ayrıntısı (SQL, bağlantı) loga girmez; yalnızca sabit bir not.
    console.error("[eposta] ayarlar okunamadi, varsayilanlar kullaniliyor");
    return { ...EMAIL_SETTING_DEFAULTS };
  }
}

export interface EmailSettingsView {
  settings: EmailSettings;
  updatedAt: Date | null;
}

/** `/yonetim/eposta`. Okuma hatası burada gizlenmez: sayfa hatayı göstermeli. */
export async function getEmailSettingsForAdmin(
  db: Pick<Database, "select">,
  actor: AdminActor,
): Promise<EmailSettingsView> {
  assertCapability(actor, "email.manage");
  const rows = await db
    .select({ ...settingColumns, updatedAt: emailSetting.updatedAt })
    .from(emailSetting)
    .where(eq(emailSetting.id, 1))
    .limit(1);
  const row = rows[0];
  return { settings: fromRow(row), updatedAt: row?.updatedAt ?? null };
}

/** Denetim kaydına yalnızca anahtar değerleri girer (kişisel veri yok). */
function auditValues(settings: EmailSettings): Record<keyof EmailSettings, boolean> {
  return {
    teamNotifications: settings.teamNotifications,
    visitorConfirmations: settings.visitorConfirmations,
    priceAlerts: settings.priceAlerts,
    marketingEmails: settings.marketingEmails,
  };
}

export async function updateEmailSettings(
  db: Database,
  actor: AdminActor,
  input: unknown,
): Promise<EmailSettings> {
  assertCapability(actor, "email.manage");
  const next = validateEmailSettings(input);

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select(settingColumns)
      .from(emailSetting)
      .where(eq(emailSetting.id, 1))
      .limit(1);
    const before = fromRow(rows[0]);

    await tx
      .insert(emailSetting)
      .values({ id: 1, ...next, updatedBy: actor.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: emailSetting.id,
        set: { ...next, updatedBy: actor.userId, updatedAt: new Date() },
      });

    await recordAdminEvent(tx, {
      actor,
      action: "email_settings.update",
      targetType: "email_settings",
      targetId: 1,
      before: auditValues(before),
      after: auditValues(next),
    });
    return next;
  });
}
