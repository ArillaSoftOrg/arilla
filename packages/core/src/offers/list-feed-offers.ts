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
/**
 * Arama plani (milyonluk katalog): planlayici bilinmeyen bir onek icin ~%2 eslesme
 * tahmin eder ve "en yeni" indeksini sirayla gezer; eslesmeyen kelimede tum tablo
 * taranir (2,19M teklifte 102 sn). Bu yuzden once tam metin indeksinden en fazla
 * SEARCH_CANDIDATE_CAP aday alinir ve yalnizca onlar siralanir. Aday sayisi siniri
 * asarsa kelime yogundur; o zaman sirali indeks hizla 24 sonuc bulur. Her iki yol da
 * SEARCH_TIMEOUT ile sinirlidir.
 */
const SEARCH_CANDIDATE_CAP = 5_000;
const SEARCH_TIMEOUT = "4s";

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
  /** Arama zaman asimina ugradi; sonuc yok sayilir, kullanicidan daha belirgin arama istenir. */
  timedOut: boolean;
}

export function normalizeFeedOfferQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
  return value.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? value : null;
}

/**
 * Kelime/onek aramasi (0069): "kahve kavanoz" -> "kahve:* & kavanoz:*". Yalnizca harf ve
 * rakam kelimeleri gecer (tsquery sozdizimine kullanici metni sizmaz); en fazla 8 kelime.
 */
export function feedOfferTsQuery(q: string): string | null {
  const words = (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return words.length > 0 ? words.map((word) => `${word}:*`).join(" & ") : null;
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
  /** Yalnizca test: aday siniri (yogun kelime yolunu kucuk veriyle sinamak icin). */
  candidateCap: number = SEARCH_CANDIDATE_CAP,
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
  const tsQuery = q ? feedOfferTsQuery(q) : null;
  // Ifade 0069 kismi indeksiyle (offer_unmatched_title_fts) birebir ayni olmali.
  if (tsQuery) {
    conditions.push(sql`to_tsvector('simple', o.title_raw) @@ to_tsquery('simple', ${tsQuery})`);
  }
  const order =
    sort === "price" ? sql`o.current_price ASC, o.id ASC` : sql`o.last_seen_at DESC, o.id DESC`;

  const select = (where: ReturnType<typeof sql>) => sql`
    SELECT o.id, o.title_raw, o.image_url, m.name AS merchant_name, o.currency,
           o.current_price, o.list_price
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id AND m.is_active
     WHERE ${where}
     ORDER BY ${order}
     LIMIT ${FEED_OFFER_PAGE_SIZE + 1} OFFSET ${(page - 1) * FEED_OFFER_PAGE_SIZE}
  `;
  const filter = sql.join(conditions, sql` AND `);

  let found: Row[];
  let timedOut = false;
  if (!tsQuery) {
    found = (await db.execute<Row>(select(filter))).rows;
  } else {
    try {
      found = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${SEARCH_TIMEOUT}'`));
        // Aday asamasi yalnizca tam metin (bitmap) indeksini kullanabilsin.
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql`SET LOCAL enable_indexscan = off`);
        const hits = await tx.execute<{ n: string }>(sql`
          SELECT count(*) AS n FROM (
            SELECT 1 FROM offer o WHERE ${filter} LIMIT ${candidateCap + 1}
          ) h
        `);
        const dense = Number(hits.rows[0]?.n ?? 0) > candidateCap;
        if (!dense) {
          return (
            await tx.execute<Row>(
              select(sql`o.id IN (
                SELECT o.id FROM offer o WHERE ${filter} LIMIT ${candidateCap + 1}
              )`),
            )
          ).rows;
        }
        await tx.execute(sql`SET LOCAL enable_seqscan = on`);
        await tx.execute(sql`SET LOCAL enable_indexscan = on`);
        return (await tx.execute<Row>(select(filter))).rows;
      });
    } catch (error) {
      if (pgCode(error) !== "57014") throw error;
      found = [];
      timedOut = true;
    }
  }

  const rows = found.slice(0, FEED_OFFER_PAGE_SIZE);
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
    hasMore: found.length > FEED_OFFER_PAGE_SIZE,
    quotes,
    timedOut,
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

function pgCode(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } } | null;
  return value?.code ?? value?.cause?.code;
}

/** "22,11 USD" - kaynak para birimiyle, float yok. */
export function formatMinorWithCurrency(minor: number, currency: string): string {
  const whole = Math.trunc(minor / 100).toLocaleString("tr-TR");
  const rest = String(Math.abs(minor % 100)).padStart(2, "0");
  return `${whole},${rest} ${currency}`;
}
