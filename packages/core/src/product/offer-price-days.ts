/**
 * Teklif basina GUNLUK etkin fiyat (docs/decisions/0068).
 *
 * Sozlesme:
 * - `price_point` = fiyat DEGISIM olayi (fiyat, liste fiyati ya da stok
 *   degistiginde yazilir). "Bu teklif bu gun goruldu" kaniti DEGILDIR.
 * - `offer.last_seen_at` = teklifin son basarili toplamada goruldugu an.
 *
 * Bir teklif icin gun serisi iki gercek veriden kurulur: ilk fiyat olayindan
 * `last_seen_at` gunune kadar, her gunun fiyati o gune kadarki son olaydir
 * (o gun icinde degisim varsa en dusugu). Teklif `last_seen_at`'ten sonra
 * gorulmedigi icin seri orada biter: kaybolan bir teklifin son fiyati
 * sonsuza dek "guncel" sayilmaz. Bu, gunluk toplamanin eskiden urettigi
 * `price_point` gunlerinin birebir turetilmis halidir; hicbir fiyat uydurulmaz.
 *
 * Istek yolu kurali (docs/decisions/0019): tek urune ve `days` pencereye
 * sinirlidir; teklif basina `price_point_offer_time_idx` uzerinden okunur.
 */
import { type SQL, sql } from "drizzle-orm";

export interface OfferPriceDayRow extends Record<string, unknown> {
  offer_id: string;
  day: string;
  min_price: string;
}

/**
 * @param offerIds `SELECT id FROM ...` biciminde, tek kolonlu (`id`) alt sorgu.
 * Cikti kolonlari: `offer_id`, `day` (YYYY-MM-DD), `min_price` (kurus).
 */
export function offerPriceDaysSql(offerIds: SQL, days: number): SQL {
  return sql`
    WITH ids AS (${offerIds}),
    span AS (
      SELECT o.id AS offer_id,
             greatest((now() - make_interval(days => ${days}))::date, f.first_day) AS from_day,
             date_trunc('day', o.last_seen_at)::date AS to_day
        FROM offer o
        JOIN ids ON ids.id = o.id
        JOIN LATERAL (
          SELECT min(date_trunc('day', p.observed_at))::date AS first_day
            FROM price_point p WHERE p.offer_id = o.id
        ) f ON f.first_day IS NOT NULL
    )
    SELECT s.offer_id, d.day::text AS day, LEAST(carry.price, today.price)::text AS min_price
      FROM span s
      CROSS JOIN LATERAL generate_series(s.from_day::timestamp, s.to_day::timestamp,
                                         interval '1 day') AS g(ts)
      CROSS JOIN LATERAL (SELECT g.ts::date AS day) d
      LEFT JOIN LATERAL (
        SELECT p.price FROM price_point p
         WHERE p.offer_id = s.offer_id AND date_trunc('day', p.observed_at)::date < d.day
         ORDER BY p.observed_at DESC LIMIT 1
      ) carry ON true
      LEFT JOIN LATERAL (
        SELECT min(p.price) AS price FROM price_point p
         WHERE p.offer_id = s.offer_id AND date_trunc('day', p.observed_at)::date = d.day
      ) today ON true
     WHERE LEAST(carry.price, today.price) IS NOT NULL
  `;
}
