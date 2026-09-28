/**
 * Kayıt bu kadar yeniyse "Listedesin." (az önce katıldı), daha eskiyse
 * "Erken erişim listesindesin." (geri dönen kullanıcı). Yalnızca metin
 * seçimi; ayrı bir durum sütunu ya da sorgu parametresi yok.
 */
export const JUST_JOINED_WINDOW_MS = 10 * 60 * 1000;

export type EarlyAccessPageState = "join" | "just_joined" | "returning";

export function earlyAccessState(
  entry: { createdAt: Date } | null,
  now: Date = new Date(),
): EarlyAccessPageState {
  if (!entry) return "join";
  return now.getTime() - entry.createdAt.getTime() <= JUST_JOINED_WINDOW_MS
    ? "just_joined"
    : "returning";
}
