/** Para kurus cinsinden tamsayi (docs/schema.sql), asla float. */
export function formatTRY(kurus: number): string {
  const whole = Math.floor(kurus / 100);
  const remainder = kurus % 100;
  const wholeFormatted = whole.toLocaleString("tr-TR");
  return remainder === 0
    ? `${wholeFormatted} TL`
    : `${wholeFormatted},${String(remainder).padStart(2, "0")} TL`;
}
