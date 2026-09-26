/** 0027_admin_audit_event.sql karsiligi (docs/decisions/0039). */
import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Yonetim mutasyonlarinin denetim izi. APPEND-ONLY: arilla_app yalnizca
 * SELECT + INSERT. Kimlik bilgisi, IP, user agent yazilmaz.
 */
export const adminAuditEvent = pgTable("admin_audit_event", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  actorUserId: bigint("actor_user_id", { mode: "number" }).notNull(),
  /** Islem anindaki rol; sonradan rol degisse de kayit dogru kalir. */
  actorRole: text("actor_role").notNull(),
  /** 'matching.approve', 'lexicon.update', ... */
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
