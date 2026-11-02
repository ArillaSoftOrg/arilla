/**
 * Fiyat geçmişi bölümü ve özetinin ortak biçimlendirmesi (karar 0168). Saf işlevler;
 * hem sunucu özeti hem istemci grafiği kullanır. Para birimi her zaman açıkça yazılır.
 */

import type { ChangeDirection, HistoryChange } from "@arilla/core/price-history-view";
import { formatTRY } from "@arilla/ui";

/** Tutarı küçük biriminden yazar. TL "1.199 TL"; diğerleri "11,02 USD" (çevrilmez). */
export function formatMoney(minor: number, currency: string): string {
  if (currency === "TRY") return formatTRY(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100).toLocaleString("tr-TR");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}${whole},${rest} ${currency}`;
}

/** "%0,27"; sıfırdan farklı ama çok küçük değişim "%0,01'den az" diye yuvarlanmaz-silinmez. */
export function formatPercent(percent: number): string {
  const abs = Math.abs(percent);
  if (abs > 0 && abs < 0.01) return "%0,01'den az";
  return `%${abs.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`;
}

export const DIRECTION_GLYPH: Record<ChangeDirection, string> = {
  up: "▲",
  down: "▼",
  flat: "■",
};

export const DIRECTION_WORD: Record<ChangeDirection, string> = {
  up: "yükseldi",
  down: "düştü",
  flat: "değişmedi",
};

/** "0,03 USD (%0,27)" - yön sözcüğü ayrıca verilir; işaret yerine sözcük kullanılır. */
export function formatChangeAmount(change: HistoryChange, currency: string): string {
  if (change.direction === "flat") return formatMoney(0, currency);
  const amount = formatMoney(Math.abs(change.amountMinor), currency);
  return change.percent === null ? amount : `${amount} (${formatPercent(change.percent)})`;
}

/** "15.10" - eksen etiketi. */
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
}
