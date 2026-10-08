/**
 * Arama hakki metinleri (docs/decisions/0047, docs/copy.md). Terim "arama
 * hakki" ve "bonus hak"; "coin", "kredi", "satin al" gecmez.
 */
import { LINK_SEARCH_PUBLIC } from "@arilla/core/link-input";
import type { QuotaWindow } from "@arilla/core/quota-policy";

export const SEARCH_RIGHTS_HREF = "/hesap#arama-haklari";

/**
 * Hak rozetinin etiketi (docs/copy.md `rights.summary`). Link araması geçici
 * olarak kapalıyken (`LINK_SEARCH_PUBLIC`) yalnızca fotoğraf araması anılır;
 * hak hesabı değişmez.
 */
export const SEARCH_RIGHTS_BADGE_LABEL = LINK_SEARCH_PUBLIC
  ? "Fotoğraf ve link araması"
  : "Fotoğraf araması";

/**
 * Hangi pencere doldu (`quota/policy.ts`, `search_rights`). Saatlik sinir bir
 * patlama sinirdir ve bonusla asilmaz; gun/hafta/ay dolunca bonus harcanir,
 * bu metinler bonus da bittiginde gosterilir.
 */
export const SEARCH_RIGHTS_NO_RIGHTS: Readonly<Record<QuotaWindow, string>> = {
  hour: "Bu saat için arama sınırına ulaştın. Hakların bir sonraki saat başında yenilenir.",
  day: "Bugünkü arama hakların ve bonus hakların bitti. Hakların gece 00:00'da yenilenir.",
  week: "Bu haftaki arama hakların ve bonus hakların bitti. Hakların pazartesi 00:00'da yenilenir.",
  month: "Bu ayki arama hakların ve bonus hakların bitti. Hakların ayın 1'inde 00:00'da yenilenir.",
};

export const SEARCH_RIGHTS_COPY = {
  noRights: SEARCH_RIGHTS_NO_RIGHTS.day,
  earnLink: "Bonus hak kazanmanın yolları",
  rateLimited: "Biraz hızlı gittin. Bir dakika sonra tekrar dener misin?",
  busy: "Önceki araman hâlâ sürüyor. Bitince yenisini başlatabilirsin.",
  usedBonus: "Arama hakların bittiği için bu arama bonus hakkından kullanıldı.",
} as const;

/** Bonus kazanma yolu yalnizca gun/hafta/ay dolunca ise yarar; saatlik sinirda degil. */
export function bonusCanHelp(window: QuotaWindow): boolean {
  return window !== "hour";
}

const PERIOD_LABEL = { day: "Bugün", week: "Bu hafta", month: "Bu ay" } as const;

/**
 * "Bugün kalan 27/30 · Bonus 14": tek satir, en kisitlayici pencere (cogu
 * zaman gun). Hafta ya da ay daha az birakirsa o gosterilir; dort pencere de
 * sunucuda ayri ayri uygulanir.
 */
export function searchRightsSummary(status: {
  limitingWindow: "day" | "week" | "month";
  windows: Readonly<Record<"day" | "week" | "month", { remaining: number; limit: number }>>;
  bonus: number;
}): string {
  const window = status.windows[status.limitingWindow];
  return `${PERIOD_LABEL[status.limitingWindow]} kalan ${window.remaining}/${window.limit} · Bonus ${status.bonus}`;
}

/** Yenilenme zamani, Istanbul saatiyle (en kisitlayici pencere). */
export function nextResetLabel(
  nextResetAt: Date,
  window: "day" | "week" | "month" = "day",
): string {
  if (window === "week") return "Haftalık hakların pazartesi 00:00'da yenilenir.";
  if (window === "month") return "Aylık hakların ayın 1'inde 00:00'da yenilenir.";
  const time = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
  }).format(nextResetAt);
  return `Günlük hakların ${time}'da yenilenir.`;
}

/** Rozetin ikinci satiri: dolan pencere ya da bir sonraki yenilenme. */
export function searchRightsHint(status: {
  limitingWindow: "day" | "week" | "month";
  periodRemaining: number;
  bonus: number;
  nextResetAt: Date;
  windows: Readonly<Record<"hour", { remaining: number }>>;
}): { text: string; exhaustedWindow: QuotaWindow | null } {
  if (status.windows.hour.remaining === 0) {
    return { text: SEARCH_RIGHTS_NO_RIGHTS.hour, exhaustedWindow: "hour" };
  }
  if (status.periodRemaining === 0 && status.bonus === 0) {
    return {
      text: SEARCH_RIGHTS_NO_RIGHTS[status.limitingWindow],
      exhaustedWindow: status.limitingWindow,
    };
  }
  return { text: nextResetLabel(status.nextResetAt, status.limitingWindow), exhaustedWindow: null };
}
