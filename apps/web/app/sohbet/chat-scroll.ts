/**
 * Sohbet kaydırma ve mobil klavye yardımcıları (karar 0201; plan Faz 6). Saf fonksiyonlar: DOM yok.
 */

/** Alta bu kadar yakınsa (px) kullanıcı "sondadır": yeni içerik otomatik kaydırılır. */
export const NEAR_BOTTOM_PX = 120;

/** Sayfanın altına olan uzaklık (px); negatif olamaz. */
export function distanceFromBottom(
  scrollHeight: number,
  scrollY: number,
  viewportHeight: number,
): number {
  return Math.max(0, scrollHeight - (scrollY + viewportHeight));
}

/**
 * Yeni içerik geldiğinde ekran alta kaydırılsın mı?
 * - Kullanıcı bu turu kendisi gönderdiyse (`userJustSent`) ya da sayfa ilk açılıyorsa evet.
 * - Aksi halde yalnızca alta yakınsa. Eski mesajları okuyan kullanıcı zorla kaydırılmaz
 *   (arayüz "Yeni yanıt" düğmesi gösterir).
 */
export function shouldAutoScroll(input: {
  userJustSent: boolean;
  initial: boolean;
  distanceFromBottom: number;
  threshold?: number;
}): boolean {
  if (input.userJustSent || input.initial) return true;
  return input.distanceFromBottom <= (input.threshold ?? NEAR_BOTTOM_PX);
}

/**
 * Ekran klavyesinin kapladığı alt boşluk (px): iOS Safari'de klavye görsel görünümü küçültür ama
 * düzen görünümünü değil; yapışkan mesaj kutusu bu kadar yukarı alınır. Android Chrome'da
 * (içeriği yeniden boyutlandıran) ve klavye yokken 0. Gürültü (≤1 px) yok sayılır.
 */
export function keyboardInsetPx(
  layoutHeight: number,
  viewport: { height: number; offsetTop: number },
): number {
  const inset = layoutHeight - viewport.height - viewport.offsetTop;
  return inset > 1 ? Math.round(inset) : 0;
}
