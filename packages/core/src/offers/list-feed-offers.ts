/**
 * Kanonik urune baglanmamis gercek besleme teklifleri (karar 0114).
 *
 * Iki tur:
 * - `domestic`: TRY teklifler (eslesmemis). Fiyat TL olarak gosterilir; "en uygun
 *   fiyat" siralamasina girer.
 * - `international`: TRY DISI teklifler (or. AliExpress USD). Orijinal tutar ve
 *   para birimi korunur; TCMB kuru varsa YAKLASIK TRY eklenir (kur tarihiyle).
 *   Kargo/gumruk/vergi bilinmedigi icin toplam fiyat dogrulanmis DEGILDIR:
 *   fiyat siralamasina GIRMEZ, her zaman en yeni gorulene gore listelenir.
 *
 * Eslestirme yapilmaz: bu liste urun birlestirmez, yalnizca teklifi gosterir.
 * Gorunurluk: etkin merchant, etkin ve satistaki teklif, `product_id IS NULL`.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { type ApproxTry, approximateTry, type FxQuote, latestFxQuote } from "../pricing/fx.ts";

export type FeedOfferKind = "domestic" | "international";
export type FeedOfferSort = "recent" | "price";

export const FEED_OFFER_PAGE_SIZE = 24;
const MAX_PAGE = 50;
const MAX_QUERY = 100;

export interface FeedOfferCard {
  offerId: number;
  title: string;
  imageUrl: string | null;
  merchantName: string;
  currency: string;
  priceMinor: number;
  listPriceMinor: number | null;
  /** Yalnizca `international`: kur varsa yaklasik TRY; yoksa null (uydurulmaz). */
  approx: ApproxTry | null;
}

export interface FeedOfferPage {
  kind: FeedOfferKind;
  /** `international` icin her zaman "recent" (dogrulanmamis toplam fiyat siralanmaz). */
  sort: FeedOfferSort;
  page: number;
  items: FeedOfferCard[];
  hasMore: boolean;
  /** Kullanilan kurlar (para birimi -> kur); kur yoksa listede yok. */
  quotes: Record<string, FxQuote>;
}

export function normalizeFeedOfferQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
  return value.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? value : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type Row = {
  id: string;
  title_raw: string;
  image_url: string | null;
  merchant_name: string;
  currency: string;
  current_price: string;
  list_price: string | null;
};

export async function listFeedOffers(
  db: Database,
  input: { kind: FeedOfferKind; q?: string | null; sort?: FeedOfferSort; page?: number },
  now: Date = new Date(),
): Promise<FeedOfferPage> {
  const kind = input.kind;
  const sort: FeedOfferSort = kind === "domestic" && input.sort === "price" ? "price" : "recent";
  const page =
    Number.isInteger(input.page) && (input.page ?? 1) >= 1
      ? Math.min(input.page ?? 1, MAX_PAGE)
      : 1;
  const q = normalizeFeedOfferQuery(input.q);
  const conditions = [
    sql`o.is_active`,
    sql`o.in_stock`,
    sql`o.product_id IS NULL`,
    sql`o.current_price IS NOT NULL AND o.current_price > 0`,
    kind === "international" ? sql`o.currency <> 'TRY'` : sql`o.currency = 'TRY'`,
  ];
  if (q) conditions.push(sql`o.title_raw ILIKE ${`%${escapeLike(q)}%`}`);
  const order =
    sort === "price" ? sql`o.current_price ASC, o.id ASC` : sql`o.last_seen_at DESC, o.id DESC`;

  const result = await db.execute<Row>(sql`
    SELECT o.id, o.title_raw, o.image_url, m.name AS merchant_name, o.currency,
           o.current_price, o.list_price
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id AND m.is_active
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY ${order}
     LIMIT ${FEED_OFFER_PAGE_SIZE + 1} OFFSET ${(page - 1) * FEED_OFFER_PAGE_SIZE}
  `);

  const rows = result.rows.slice(0, FEED_OFFER_PAGE_SIZE);
  const quotes: Record<string, FxQuote> = {};
  if (kind === "international") {
    for (const currency of new Set(rows.map((row) => row.currency))) {
      const quote = await latestFxQuote(db, currency);
      if (quote) quotes[currency] = quote;
    }
  }

  return {
    kind,
    sort,
    page,
    hasMore: result.rows.length > FEED_OFFER_PAGE_SIZE,
    quotes,
    items: rows.map((row) => {
      const priceMinor = Number(row.current_price);
      return {
        offerId: Number(row.id),
        title: row.title_raw,
        imageUrl: row.image_url,
        merchantName: row.merchant_name,
        currency: row.currency,
        priceMinor,
        listPriceMinor: row.list_price === null ? null : Number(row.list_price),
        approx:
          kind === "international"
            ? approximateTry(priceMinor, row.currency, quotes[row.currency] ?? null, now)
            : null,
      };
    }),
  };
}

/** "22,11 USD" - kaynak para birimiyle, float yok. */
export function formatMinorWithCurrency(minor: number, currency: string): string {
  const whole = Math.trunc(minor / 100).toLocaleString("tr-TR");
  const rest = String(Math.abs(minor % 100)).padStart(2, "0");
  return `${whole},${rest} ${currency}`;
}
