/**
 * Istemci tarafi gecikme isaretleri. YALNIZCA `performance.mark/measure`
 * (DevTools / `performance.getEntriesByType`); sunucuya gonderilmez (tanimsiz
 * analitik olayi yok, docs/events.md) ve metin tasimaz.
 *
 * `submittedAt` (epoch ms) sekmeler arasi aktarilir; `chatMark` her isaret icin
 * `<ad>:since_submit` olcumu uretir. Modul durumu `router.replace` (SPA gezinme)
 * boyunca korunur.
 */
let submittedAt: number | null = null;

export function setChatSubmittedAt(value: number | null): void {
  submittedAt = value;
}

export function chatMark(name: string): void {
  try {
    performance.mark(name);
    if (submittedAt !== null) {
      performance.measure(`${name}:since_submit`, {
        start: submittedAt - performance.timeOrigin,
        end: performance.now(),
      });
    }
  } catch {
    // Olcum asla akisi bozmaz.
  }
}
