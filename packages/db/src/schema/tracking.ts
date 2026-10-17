/** 0080_tracking_link.sql karsiligi (docs/decisions/0115). */
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Yonetimden olusturulan kisa baglanti (`/<slug>`). Slug olusturulduktan sonra
 * degismez; baglanti silinmez, pasife alinir.
 */
export const trackingLink = pgTable(
  "tracking_link",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    /** Mutlak https adresi ya da kokten baslayan yol. Izinli alan adlari kodda dogrulanir. */
    targetUrl: text("target_url").notNull(),
    source: text("source"),
    campaign: text("campaign"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tracking_link_created_idx").on(table.createdAt.desc(), table.id.desc())],
);

/**
 * Saat basina tiklama sayaci (UTC saat basi). Kisi tanimlayicisi (IP, User-Agent,
 * oturum, cerez) YOKTUR; gunluk gorunum sorguda toplanir.
 */
export const trackingLinkClickHour = pgTable(
  "tracking_link_click_hour",
  {
    linkId: bigint("link_id", { mode: "number" }).notNull(),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    clicks: integer("clicks").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.linkId, table.hour] }),
    index("tracking_link_click_hour_time_idx").on(table.hour),
  ],
);
