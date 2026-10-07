/**
 * Sozluk (`lexicon`) kisa omurlu surec ici onbellegi. Sozluk katalog
 * genelinde ortak, seyrek degisen veridir; sohbet her turda ve her arama
 * render'inda tum tabloyu yeniden okuyordu.
 *
 * - Kapsam: `Database` nesnesi basina (test veritabanlari birbirini kirletmez).
 * - Omur: `LEXICON_CACHE_TTL_MS`; sonra bir sonraki okuma tazeler. Sonsuza
 *   kadar bayat kalmaz, sozluk degisikligi en cok bu sure sonra gorunur.
 * - Es zamanli istekler tek DB okumasini paylasir; hata onbellege yazilmaz.
 * - `invalidateLexiconCache`: sozlugu yazan kod (admin, test) aninda tazeletir.
 */
import type { Database } from "@arilla/db";
import type { LexiconEntry } from "./lexicon.ts";
import { loadLexicon } from "./lexicon-repository.ts";

export const LEXICON_CACHE_TTL_MS = 5 * 60 * 1000;

interface Entry {
  value: LexiconEntry[] | null;
  expiresAt: number;
  inflight: Promise<LexiconEntry[]> | null;
}

const entries = new WeakMap<Database, Entry>();

export async function loadLexiconCached(
  db: Database,
  now: () => number = Date.now,
  load: (db: Database) => Promise<LexiconEntry[]> = loadLexicon,
): Promise<LexiconEntry[]> {
  const entry = entries.get(db) ?? { value: null, expiresAt: 0, inflight: null };
  entries.set(db, entry);
  if (entry.value !== null && now() < entry.expiresAt) return entry.value;
  if (entry.inflight) return entry.inflight;
  const pending = load(db)
    .then((value) => {
      entry.value = value;
      entry.expiresAt = now() + LEXICON_CACHE_TTL_MS;
      return value;
    })
    .finally(() => {
      entry.inflight = null;
    });
  entry.inflight = pending;
  return pending;
}

export function invalidateLexiconCache(db: Database): void {
  entries.delete(db);
}
