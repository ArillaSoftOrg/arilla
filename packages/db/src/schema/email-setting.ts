/** 0120_email_setting.sql karsiligi (docs/decisions/0222). */
import { bigint, boolean, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";

/**
 * Yonetimdeki e-posta anahtarlari. Tek satir (`id = 1`, CHECK ile zorunlu). Satir yoksa kod
 * ayni varsayilanlari kullanir (`packages/core/src/email/settings.ts`).
 */
export const emailSetting = pgTable("email_setting", {
  id: smallint("id").primaryKey().default(1),
  teamNotifications: boolean("team_notifications").notNull().default(false),
  visitorConfirmations: boolean("visitor_confirmations").notNull().default(false),
  priceAlerts: boolean("price_alerts").notNull().default(true),
  marketingEmails: boolean("marketing_emails").notNull().default(true),
  /** Son degistiren yonetici; hesap silinirse NULL (SET NULL). */
  updatedBy: bigint("updated_by", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
