/**
 * Gorsel varyanti bayraklari (karar 0167). Ortamdan YALNIZCA sunucuda okunur;
 * `NEXT_PUBLIC_` degildir, bu yuzden derleme zamaninda gomulmez: degeri degistirmek
 * yeni imaj gerektirmez, yalnizca sunucu surecinin yeniden baslatilmasini ister.
 *
 * `IMAGE_VARIANTS_ALIEXPRESS_ENABLED=true` verilmedikce kapalidir (varsayilan):
 * AliExpress gorselleri bugunku gibi katalogdaki orijinal URL'den yuklenir.
 * Hepsiburada varyantlari (karar 0166) bu bayraktan bagimsizdir.
 */
type Env = Readonly<Record<string, string | undefined>>;

export function isAliExpressImageVariantsEnabled(env: Env = process.env): boolean {
  return env.IMAGE_VARIANTS_ALIEXPRESS_ENABLED?.trim().toLowerCase() === "true";
}
