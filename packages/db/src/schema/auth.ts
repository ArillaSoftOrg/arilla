/** 0005_auth.sql karsiligi. */
import { bigint, inet, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const appUser = pgTable("app_user", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  publicId: uuid("public_id").notNull().defaultRandom(),
  email: text("email").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  role: text("role").$type<"user" | "creator" | "moderator" | "admin">().notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
});
