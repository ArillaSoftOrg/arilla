/**
 * Teklif stok durumu UC durumludur (karar 0130): `available`, `unavailable`, `unknown`.
 *
 * `offer.in_stock` NOT NULL bir bayraktir; stok bildirmeyen kaynakta (Hepsiburada yonetici
 * toplamasi) temkinli olarak false yazilir ve belirsizlik `offer.attributes_raw.stock_state`
 * = 'unknown' ile tasinir (services/ingest/feeds/intake.py). Bu durumda arayuz "stokta yok"
 * DEMEZ: bilinmeyen bilgi uydurulmaz. Diger tum beslemeler icin anahtar yoktur ve sonuc
 * eskisiyle aynidir.
 */
export type StockState = "available" | "unavailable" | "unknown";

export function offerStockState(inStock: boolean, declared: string | null | undefined): StockState {
  if (inStock) return "available";
  return declared === "unknown" ? "unknown" : "unavailable";
}
