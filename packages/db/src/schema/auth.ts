/** 0005_auth.sql + 0024_oauth_identity.sql + 0025_apple_phone_identity.sql + 0031_early_access.sql + 0034 (`app_user.referral_code`) + 0036 (`session` istek baglami) karsiligi. */
import {
  bigint,
  boolean,
  inet,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const appUser = pgTable("app_user", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  publicId: uuid("public_id").notNull().defaultRandom(),
  /** 0025: telefon ve e-postasiz Apple girisinde NULL. */
  email: text("email"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  role: text("role").$type<"user" | "creator" | "moderator" | "admin">().notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** 0034: davet kodu; ilk istendiginde uretilir. */
  referralCode: text("referral_code"),
  /** 0045: karsilama tamamlandi/atlandi; NULL = henuz gosterilmedi. */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
});

/** Token asla duz metin saklanmaz, asla log'a yazilmaz. */
export const authToken = pgTable("auth_token", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  requestIp: inet("request_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ip: inet("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  /** 0036: kaba istek bağlamı; yalnızca yeni oturumlarda dolar. */
  deviceClass: text("device_class").$type<DeviceClass>(),
  browserFamily: text("browser_family").$type<BrowserFamily>(),
  countryCode: text("country_code"),
});

/** 0036: user agent'tan türetilen kaba sınıflar (ham user agent saklanmaz). */
export type DeviceClass = "mobile" | "tablet" | "desktop" | "other";
export type BrowserFamily =
  | "chrome"
  | "safari"
  | "firefox"
  | "edge"
  | "samsung"
  | "opera"
  | "other";

export type IdentityProvider = "google" | "apple" | "phone";

export const userIdentity = pgTable(
  "user_identity",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    provider: text("provider").$type<IdentityProvider>().notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerSubjectUnique: uniqueIndex("user_identity_provider_subject_unique").on(
      table.provider,
      table.providerSubject,
    ),
  }),
);

/** 0025: telefonla giris kodu. Kod duz metin saklanmaz; tek kullanimlik, sureli. */
export const phoneLoginCode = pgTable("phone_login_code", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  /** E.164 */
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  attempts: smallint("attempts").notNull().default(0),
  requestIp: inet("request_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EarlyAccessStatus = "pending";

/** 0031: erken erisim listesi. Kullanici basina tek satir (PK = user_id). */
export const earlyAccess = pgTable("early_access", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  status: text("status").$type<EarlyAccessStatus>().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 0050: erken erisim sayaci. Tek satir (id = 1): platform disi gercek
 * basvurularin sayisi; gosterilen sayi bunun + `early_access` satir sayisidir.
 */
export const earlyAccessCounter = pgTable("early_access_counter", {
  id: smallint("id").primaryKey().default(1),
  offPlatformCount: integer("off_platform_count").notNull(),
  updatedBy: bigint("updated_by", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
