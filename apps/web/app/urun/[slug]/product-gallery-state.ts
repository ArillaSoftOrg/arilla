/**
 * Galeri secim mantigi (karar 0073). Saf fonksiyonlar: bilesenden ayri durur ki
 * klavye ve sinir davranisi DOM olmadan test edilebilsin.
 */

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Kucuk resim satirinda klavye hareketi. Ok tuslari satir sonunda DONER
 * (son -> ilk), Home/End uclara gider. Ilgisiz tus icin null (varsayilan
 * tarayici davranisi bozulmaz).
 */
export function nextIndex(current: number, key: string, count: number): number | null {
  if (count <= 1) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Ana gorselin alt metni: tek gorselde urun adi, cokta "ad - gorsel n / toplam". */
export function mainImageAlt(title: string, index: number, count: number): string {
  return count > 1 ? `${title} – görsel ${index + 1} / ${count}` : title;
}

export function thumbLabel(title: string, index: number, count: number): string {
  return `${title}: görsel ${index + 1} / ${count}`;
}
