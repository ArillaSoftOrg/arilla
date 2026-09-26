/** Para kurus cinsinden tamsayi (docs/schema.sql), asla float. */
export function formatTRY(kurus: number): string {
  const whole = Math.floor(kurus / 100);
  const remainder = kurus % 100;
  const wholeFormatted = whole.toLocaleString("tr-TR");
  return remainder === 0
    ? `${wholeFormatted} TL`
    : `${wholeFormatted},${String(remainder).padStart(2, "0")} TL`;
}

/**
 * docs/copy.md `product.card_price_from`: varyantlar arasi baslangic fiyati
 * (0037). Yalnizca urun gercekten farkli fiyatli varyantlar satiyorsa.
 */
export function formatStartingPrice(kurus: number): string {
  return `${formatTRY(kurus)}'den başlayan`;
}
