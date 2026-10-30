/**
 * `/kaydettiklerim`: urun kaydedildiginden beri fiyati ne kadar degisti (karar 0159).
 *
 * Yontem - ayni saticinin ayni teklifi, kendi fiyatiyla:
 * 1. Referans teklif: urunun BUGUNKU en uygun teklifi; etkin, magazasi etkin, stokta,
 *    TRY, fiyatli ve dogrulanmis (`offerVerifiedSql`, karar 0156). Esitlikte kucuk id.
 * 2. Kayit anindaki fiyat: AYNI teklifin `saved_item.created_at` aninda ya da ondan en
 *    fazla `SAVED_PRICE_LOOKBACK_HOURS` once gozlenen son `price_point` satiri. Daha eski
 *    gozlem kayit anindaki fiyat sayilmaz (tahmin yapilmaz); kayittan SONRAKI gozlem de
 *    kullanilmaz.
 * 3. Bugunku fiyat: teklifin `current_price`'i.
 *
 * Ek guvenlik kosullari (referans teklif icin; saglanmazsa BASKA teklife gecilmez, gosterge
 * "yeterli veri yok" olur). Politika sistemi (0156) degismez; bunlar yalniz bu gostergeyi gizler:
 * - Yakin zamanda dogrulanmis: besleme uyeligi (`feed_source_offer.last_seen_at`, 0156'nin
 *   kaynagi), `offer.last_seen_at` ve son `price_point` gozleminin EN YENISI son
 *   `SAVED_PRICE_CONFIRMED_WITHIN_DAYS` gun icinde. TRY beslemelerinde tazelik politikasi
 *   tanimli degilken `offerVerifiedSql` her teklifi dogrulanmis sayar; bu kosul eski fiyati
 *   "bugunku" diye gostermeyi onler. (Besleme senkronu `price_point`'i yalniz fiyat degisince
 *   yazar; bu yuzden tek basina son gozlem sinyal degildir.)
 * - Bugunku fiyat gercekten gozlenmis: son `price_point.price = current_price`.
 * - Kartla ayni fiyat: `current_price = product.min_price`. Kart depolanan ozeti gosterir;
 *   ozet farkliysa (bayat, stok disi ya da dogrulanamayan daha ucuz teklif) kullaniciya
 *   kartla celisen bir "bugunku fiyat" uzerinden degisim gosterilmez.
 *
 * Karsilastirma YAPILMAZ ("yeterli veri yok"): urun yayinda degilse; dogrulanmis TRY
 * teklifi yoksa; referans teklifin kayit anina ait gozlemi yoksa; ek kosullardan biri
 * saglanmiyorsa; urun varyant fiyatliysa (`getStartingFromProductIds`: `price_point` teklif
 * duzeyinde en ucuz varyanttir, beden fiyati degisimi ile secim degisimi ayrilamaz). Baska
 * saticiya ya da para birimine gecilmez: farkli teklifler ayni fiyat gecmisi sayilmaz.
 *
 * Maliyet: kullanicinin kayitlari icin TEK sorgu (+ varyant kontrolu icin tek toplu sorgu);
 * urun basina bir LATERAL teklif secimi (`offer_product_idx`), referans teklif basina iki
 * `price_point` birincil anahtar yoklamasi (`LIMIT 1`) ve `feed_source_offer_offer_idx`.
 * Tarama yok.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { offerVerifiedSql } from "../offers/freshness.ts";
import { getStartingFromProductIds } from "../product/get-price-comparison.ts";

/** Kayit anindan en fazla bu kadar onceki gozlem "kayit anindaki fiyat" sayilir. */
export const SAVED_PRICE_LOOKBACK_HOURS = 48;

/** Referans teklif en son bu kadar gun icinde kaynakta gorulmus olmali. */
export const SAVED_PRICE_CONFIRMED_WITHIN_DAYS = 3;

export type SavedPriceChange =
  | {
      kind: "down" | "up" | "same";
      /** Kurus, TRY. */
      savedPriceKurus: number;
      currentPriceKurus: number;
      /** Mutlak fark, kurus (>= 0). */
      diffKurus: number;
      /** Mutlak degisim, yuzde, tam sayiya yuvarli (yarim yukari). */
      percent: number;
    }
  | { kind: "insufficient" };

/**
 * Saf: iki kurus tutarindan degisim. Yuzde tam sayi aritmetigiyle, yarim yukari
 * yuvarlanir. Gecersiz girdi (tamsayi olmayan, <= 0) karsilastirma degildir.
 */
export function classifyPriceChange(
  savedPriceKurus: number,
  currentPriceKurus: number,
): SavedPriceChange {
  if (
    !Number.isSafeInteger(savedPriceKurus) ||
    !Number.isSafeInteger(currentPriceKurus) ||
    savedPriceKurus <= 0 ||
    currentPriceKurus <= 0
  ) {
    return { kind: "insufficient" };
  }
  const delta = currentPriceKurus - savedPriceKurus;
  const diffKurus = Math.abs(delta);
  const percent = Math.floor((diffKurus * 200 + savedPriceKurus) / (savedPriceKurus * 2));
  return {
    kind: delta < 0 ? "down" : delta > 0 ? "up" : "same",
    savedPriceKurus,
    currentPriceKurus,
    diffKurus,
    percent,
  };
}

type Row = {
  product_id: string | number;
  saved_price: string | number | null;
  current_price: string | number | null;
  /** Ek guvenlik kosullarinin hepsi saglandi mi. */
  trusted: boolean | null;
};

/**
 * Kullanicinin her kayitli urunu icin fiyat degisimi. Yalniz o kullanicinin kayitlari
 * okunur (`saved_item.user_id`). Donen haritada her kayitli urun vardir.
 */
export async function getSavedPriceChanges(
  db: Database,
  userId: number,
): Promise<Map<number, SavedPriceChange>> {
  const result = await db.execute<Row>(sql`
    SELECT s.product_id, past.price AS saved_price, ref.current_price,
           (ref.current_price = p.min_price
            AND latest.price = ref.current_price
            AND GREATEST(ref.last_seen_at, member.last_seen_at, latest.observed_at)
                >= now() - make_interval(days => ${SAVED_PRICE_CONFIRMED_WITHIN_DAYS})
           ) AS trusted
      FROM saved_item s
      JOIN product p ON p.id = s.product_id
      LEFT JOIN LATERAL (
        SELECT o.id, o.current_price, o.last_seen_at
          FROM offer o
          JOIN merchant m ON m.id = o.merchant_id AND m.is_active
         WHERE o.product_id = s.product_id
           AND p.publication_state = 'published'
           AND o.is_active AND o.in_stock
           AND o.currency = 'TRY'
           AND o.current_price IS NOT NULL AND o.current_price > 0
           AND ${offerVerifiedSql("o")}
         ORDER BY o.current_price, o.id
         LIMIT 1
      ) ref ON TRUE
      LEFT JOIN LATERAL (
        SELECT pp.price
          FROM price_point pp
         WHERE pp.offer_id = ref.id
           AND pp.observed_at <= s.created_at
           AND pp.observed_at > s.created_at - make_interval(hours => ${SAVED_PRICE_LOOKBACK_HOURS})
         ORDER BY pp.observed_at DESC
         LIMIT 1
      ) past ON TRUE
      LEFT JOIN LATERAL (
        SELECT pp.price, pp.observed_at
          FROM price_point pp
         WHERE pp.offer_id = ref.id
         ORDER BY pp.observed_at DESC
         LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT max(fm.last_seen_at) AS last_seen_at
          FROM feed_source_offer fm
         WHERE fm.offer_id = ref.id
      ) member ON TRUE
     WHERE s.user_id = ${userId}
  `);

  const rows = result.rows;
  const productIds = rows.map((row) => Number(row.product_id));
  const variantPriced = await getStartingFromProductIds(db, productIds);

  const changes = new Map<number, SavedPriceChange>();
  for (const row of rows) {
    const productId = Number(row.product_id);
    if (
      variantPriced.has(productId) ||
      row.saved_price === null ||
      row.current_price === null ||
      row.trusted !== true
    ) {
      changes.set(productId, { kind: "insufficient" });
      continue;
    }
    changes.set(productId, classifyPriceChange(Number(row.saved_price), Number(row.current_price)));
  }
  return changes;
}
