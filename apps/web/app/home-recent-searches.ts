import { listRecentSearches, type RecentSearch } from "@arilla/core";
import { getDatabase } from "@arilla/db";

export interface RecentSearchChip {
  label: string;
  href: string;
}

/** Geçmiş kaydı -> chip. Yalnızca gerçek alanlar: sorgu metni ve `/ara?q=` bağlantısı. */
export function toRecentSearchChips(searches: readonly RecentSearch[]): RecentSearchChip[] {
  return searches.map((search) => ({
    label: search.queryNorm,
    href: `/ara?q=${encodeURIComponent(search.queryNorm)}`,
  }));
}

/**
 * Ana sayfa sunucu tarafı yükleme: misafir -> DB'ye gitmez. Hata sessizce boş
 * liste olur (bölüm yoksa görünmez); yalnızca hata sınıfı loga düşer, sorgu
 * metni değil (CLAUDE.md: hata kayıtlarında kişisel veri yok).
 */
export async function loadRecentSearchChips(userId: number | null): Promise<RecentSearchChip[]> {
  if (userId === null) return [];
  try {
    return toRecentSearchChips(await listRecentSearches(getDatabase(), userId));
  } catch (error) {
    console.warn(
      `[anasayfa] son aramalar okunamadi, bolum atlandi (${error instanceof Error ? error.name : "unknown"})`,
    );
    return [];
  }
}
