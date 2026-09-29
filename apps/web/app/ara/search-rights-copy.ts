/**
 * Arama hakki metinleri (docs/decisions/0047, docs/copy.md). Terim "arama
 * hakki" ve "bonus hak"; "coin", "kredi", "satin al" gecmez.
 */
export const SEARCH_RIGHTS_HREF = "/hesap#arama-haklari";

export const SEARCH_RIGHTS_COPY = {
  noRights: "Bugünkü arama hakların ve bonus hakların bitti. Hakların gece 00:00'da yenilenir.",
  earnLink: "Bonus hak kazanmanın yolları",
  rateLimited: "Biraz hızlı gittin. Bir dakika sonra tekrar dener misin?",
  busy: "Önceki araman hâlâ sürüyor. Bitince yenisini başlatabilirsin.",
  usedBonus: "Bugünkü hakların bittiği için bu arama bonus hakkından kullanıldı.",
} as const;

/** "Bugün 7/10 · Bonus 14" satiri: kalan gunluk hak / gunluk limit. */
export function searchRightsSummary(status: {
  dailyRemaining: number;
  dailyLimit: number;
  bonus: number;
}): string {
  return `Bugün kalan ${status.dailyRemaining}/${status.dailyLimit} · Bonus ${status.bonus}`;
}

/** Yenilenme zamani, Istanbul saatiyle. */
export function nextResetLabel(nextResetAt: Date): string {
  const time = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
  }).format(nextResetAt);
  return `Günlük hakların ${time}'da yenilenir.`;
}
