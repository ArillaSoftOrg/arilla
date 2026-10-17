/**
 * Teklif stok durumu UC durumludur (karar 0130): `available`, `unavailable`, `unknown`.
 *
 * `offer.in_stock` NOT NULL bir bayraktir; stok bildirmeyen kaynakta (Hepsiburada yonetici
 * toplamasi) temkinli olarak false yazilir ve belirsizlik `offer.attributes_raw.stock_state`
 * = 'unknown' ile tasinir (services/ingest/feeds/intake.py). Bu durumda arayuz "stokta yok"
 * DEMEZ: bilinmeyen bilgi uydurulmaz. Diger tum beslemeler icin anahtar yoktur ve sonuc
 * eskisiyle aynidir.
 *
 * Bildirilen `unknown` `inStock`tan once gelir: Trendyol (karar 0118) bilinmeyen stogu aramada
 * cezalandirmamak icin `in_stock = true` yazar; bu da bir stok iddiasi degildir.
 */
export type StockState = "available" | "unavailable" | "unknown";

export function offerStockState(inStock: boolean, declared: string | null | undefined): StockState {
  if (declared === "unknown") return "unknown";
  return inStock ? "available" : "unavailable";
}
