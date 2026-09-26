/**
 * Secili varyantin fiyat gecmisi (docs/decisions/0037).
 *
 * `price_point` teklif duzeyindedir: cok boyutlu bir teklifte (Korendy 60 ml +
 * 100 ml) hangi gun hangi boyutun fiyati oldugunu bilmez. Bu yuzden:
 *
 * - TEK ticari varyantli teklif (varyant satiri yok ve basligindaki miktar
 *   secili anahtar; ya da tum varyant satirlari ayni anahtar): `price_point`
 *   o varyantin gecmisidir.
 * - Cok boyutlu teklif: `variant_price_event` (yalnizca degisimde yazilir).
 *   Bir gunun fiyati = o gun sonuna kadarki son olay; yalnizca teklifin o gun
 *   gercekten goruldugu gunler (`price_point`).
 *
 * Hicbir nokta sentezlenmez: kaynagi olmayan teklif seriye katilmaz ve
 * "tam" sayilmaz.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import type { OfferVariantRow } from "./get-price-comparison.ts";
import type { PriceHistoryPoint } from "./result-types.ts";
import { variantKey } from "./variant-price.ts";

export type HistorySource =
  | { kind: "offer"; offerId: number }
  | { kind: "variants"; offerId: number; variantIds: number[] };

export interface VariantPriceHistory {
  points: PriceHistoryPoint[];
  /** Secili varyanti su an satan teklif sayisi. */
  compatibleOfferCount: number;
  /** Seriye en az bir gun katan teklif sayisi. */
  contributingOfferCount: number;
  /** Her uyumlu teklif seriye katiliyor mu. */
  complete: boolean;
}

/** Teklif basina hangi gecmis kaynagi guvenilir (saf). */
export function historySources(
  rows: readonly (OfferVariantRow & { current_price?: string })[],
  selectedKey: string,
): HistorySource[] {
  const byOffer = new Map<number, OfferVariantRow[]>();
  for (const row of rows) {
    const list = byOffer.get(Number(row.offer_id)) ?? [];
    list.push(row);
    byOffer.set(Number(row.offer_id), list);
  }
  const sources: HistorySource[] = [];
  for (const [offerId, offerRows] of byOffer) {
    const variantRows = offerRows.filter((row) => row.variant_id !== null);
    if (variantRows.length === 0) {
      const info = variantKey({
        label: offerRows[0]?.title_raw ?? null,
        sizeNorm: null,
        priceKurus: 0,
        inStock: true,
        fromVariantRow: false,
      });
      if (info?.key === selectedKey) sources.push({ kind: "offer", offerId });
      continue;
    }
    const keyed = variantRows.map((row) => ({
      id: Number(row.variant_id),
      key:
        variantKey({
          label: row.size_label,
          sizeNorm: row.size_norm,
          priceKurus: 0,
          inStock: true,
          fromVariantRow: true,
        })?.key ?? null,
    }));
    const matching = keyed.filter((variant) => variant.key === selectedKey);
    if (matching.length === 0) continue;
    // Tum satirlar ayni ticari varyant: teklif fiyati o varyantin fiyatidir.
    if (matching.length === keyed.length) {
      sources.push({ kind: "offer", offerId });
    } else {
      sources.push({ kind: "variants", offerId, variantIds: matching.map((v) => v.id) });
    }
  }
  return sources;
}

export interface OfferDay {
  offerId: number;
  day: string;
  minPrice: number;
}

export interface PriceEvent {
  variantId: number;
  price: number;
  /** ISO zaman damgasi (UTC). */
  observedAt: string;
}

/** Kaynaklardan gunluk seri (saf). Olay yoksa o gun icin deger uretilmez. */
export function mergeVariantHistory(
  sources: readonly HistorySource[],
  offerDays: readonly OfferDay[],
  events: readonly PriceEvent[],
): VariantPriceHistory {
  const perDay = new Map<string, number>();
  const contributing = new Set<number>();
  const daysByOffer = new Map<number, OfferDay[]>();
  for (const day of offerDays) {
    const list = daysByOffer.get(day.offerId) ?? [];
    list.push(day);
    daysByOffer.set(day.offerId, list);
  }
  const eventsByVariant = new Map<number, PriceEvent[]>();
  for (const event of [...events].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    const list = eventsByVariant.get(event.variantId) ?? [];
    list.push(event);
    eventsByVariant.set(event.variantId, list);
  }

  // Once teklif basina gunluk deger; seri SONRA kurulur.
  const perOffer = new Map<number, Map<string, number>>();
  const put = (day: string, price: number, offerId: number) => {
    const days = perOffer.get(offerId) ?? new Map<string, number>();
    const current = days.get(day);
    days.set(day, current === undefined ? price : Math.min(current, price));
    perOffer.set(offerId, days);
    contributing.add(offerId);
  };

  for (const source of sources) {
    const days = daysByOffer.get(source.offerId) ?? [];
    if (source.kind === "offer") {
      for (const day of days) put(day.day, day.minPrice, source.offerId);
      continue;
    }
    for (const day of days) {
      const dayEnd = `${day.day}T23:59:59.999Z`;
      let best: number | undefined;
      for (const variantId of source.variantIds) {
        const last = (eventsByVariant.get(variantId) ?? [])
          .filter((event) => event.observedAt <= dayEnd)
          .at(-1);
        if (last && (best === undefined || last.price < best)) best = last.price;
      }
      if (best !== undefined) put(day.day, best, source.offerId);
    }
  }

  // Bilesim sabit kalmali: yalnizca KATILAN her teklifin degeri olan gunler.
  // Aksi halde yeni katilan (ya da kaybolan) bir magaza "fiyat dustu/artti"
  // gibi gorunurdu (QA: 24.09'da yalnizca Vionine 1.709 TL, 26.09'da Korendy
  // 1.118 TL katilinca sahte dusus).
  const allDays = new Set<string>();
  for (const days of perOffer.values()) for (const day of days.keys()) allDays.add(day);
  for (const day of allDays) {
    const values = [...perOffer.values()].map((days) => days.get(day));
    if (values.every((value) => value !== undefined)) {
      perDay.set(day, Math.min(...(values as number[])));
    }
  }

  const points = [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, minPriceKurus]) => ({ date, minPriceKurus }));
  return {
    points,
    compatibleOfferCount: sources.length,
    contributingOfferCount: contributing.size,
    complete: sources.length > 0 && contributing.size === sources.length,
  };
}

/** Fiyat konumu iddiasinin kapsadigi pencere. */
export const POSITION_WINDOW_DAYS = 90;

/**
 * "Son 90 gunun en dusuk fiyati" yalnizca: seri TAM (her uyumlu teklif
 * katiliyor), seri gercekten ~90 gunu kapsiyor ve bugunku en iyi uyumlu fiyat
 * serinin en dusugunden buyuk degil. Aksi halde iddia yok (null).
 */
export function variantLowestClaim(
  history: VariantPriceHistory,
  currentBestKurus: number | null,
  today: Date,
): boolean {
  if (!history.complete || currentBestKurus === null || history.points.length === 0) return false;
  const earliest = new Date(`${history.points[0]?.date}T00:00:00Z`);
  const spanDays = (today.getTime() - earliest.getTime()) / 86_400_000;
  if (spanDays < POSITION_WINDOW_DAYS - 1) return false;
  return currentBestKurus <= Math.min(...history.points.map((point) => point.minPriceKurus));
}

type DayRow = Record<string, unknown> & { offer_id: string; day: string; min_price: string };
type EventRow = Record<string, unknown> & {
  variant_id: string;
  price: string;
  observed_at: string;
};

export async function getVariantPriceHistory(
  db: Database,
  productId: number,
  selectedKey: string,
  days = POSITION_WINDOW_DAYS,
): Promise<VariantPriceHistory> {
  const rows = await db.execute<OfferVariantRow>(sql`
    SELECT o.id AS offer_id, o.title_raw, ov.id AS variant_id, ov.size_label, ov.size_norm,
           ov.in_stock, ov.price_override
      FROM offer o
      LEFT JOIN offer_variant ov ON ov.offer_id = o.id
     WHERE o.product_id = ${productId} AND o.is_active AND o.current_price IS NOT NULL
     ORDER BY o.id, ov.id
  `);
  const sources = historySources(rows.rows, selectedKey);
  if (sources.length === 0) {
    return { points: [], compatibleOfferCount: 0, contributingOfferCount: 0, complete: false };
  }
  const offerIds = sources.map((source) => source.offerId);
  const variantIds = sources.flatMap((source) =>
    source.kind === "variants" ? source.variantIds : [],
  );
  const dayRows = await db.execute<DayRow>(sql`
    SELECT pp.offer_id, date_trunc('day', pp.observed_at)::date::text AS day,
           MIN(pp.price)::text AS min_price
      FROM price_point pp
     WHERE pp.offer_id = ANY(${sql.param(offerIds)}::bigint[])
       AND pp.observed_at >= now() - make_interval(days => ${days})
     GROUP BY 1, 2
  `);
  const eventRows =
    variantIds.length > 0
      ? await db.execute<EventRow>(sql`
          SELECT variant_id, price::text, to_char(observed_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
            FROM variant_price_event
           WHERE variant_id = ANY(${sql.param(variantIds)}::bigint[])
        `)
      : { rows: [] as EventRow[] };
  return mergeVariantHistory(
    sources,
    dayRows.rows.map((row) => ({
      offerId: Number(row.offer_id),
      day: row.day,
      minPrice: Number(row.min_price),
    })),
    eventRows.rows.map((row) => ({
      variantId: Number(row.variant_id),
      price: Number(row.price),
      observedAt: row.observed_at,
    })),
  );
}
