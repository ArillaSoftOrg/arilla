/**
 * 0003_price_history.sql karsiligi.
 *
 * `price_point` Postgres tarafinda aya gore partition'li; Drizzle'in partition
 * kavrami yoktur, ebeveyn tablo normal tablo gibi sorgulanir. Partition
 * uretimi `scripts/partitions.ts` isidir.
 */
import { bigint, boolean, pgTable, primaryKey, smallint, timestamp } from "drizzle-orm/pg-core";

/**
 * APPEND-ONLY. `arilla_app` rolunun UPDATE ve DELETE yetkisi yoktur
 * (migrations/0010). Duzeltme gerekiyorsa yeni satir eklenir.
 *
 * Fiyat degismemis olsa bile satir yazilir: surekliligin kendisi veridir.
 */
export const pricePoint = pgTable(
  "price_point",
  {
    offerId: bigint("offer_id", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Kurus cinsinden tamsayi. Asla float. */
    price: bigint("price", { mode: "number" }).notNull(),
    listPrice: bigint("list_price", { mode: "number" }),
    inStock: boolean("in_stock").notNull(),
  },
  (table) => [primaryKey({ columns: [table.offerId, table.observedAt] })],
);

export const productPriceStats = pgTable("product_price_stats", {
  productId: bigint("product_id", { mode: "number" }).primaryKey(),
  min30d: bigint("min_30d", { mode: "number" }),
  min90d: bigint("min_90d", { mode: "number" }),
  max90d: bigint("max_90d", { mode: "number" }),
  median90d: bigint("median_90d", { mode: "number" }),
  /** 0 = son 90 gunun en dusugu. */
  currentPercentile: smallint("current_percentile"),
  dropCount90d: smallint("drop_count_90d"),
  lastDropAt: timestamp("last_drop_at", { withTimezone: true }),
  /** Liste fiyati indirimden hemen once yukseltilmis mi. */
  listPriceInflated: boolean("list_price_inflated").notNull().default(false),
  listPriceRaisedAt: timestamp("list_price_raised_at", { withTimezone: true }),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});
