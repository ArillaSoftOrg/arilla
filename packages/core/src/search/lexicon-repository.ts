/**
 * Tek DB-okuma noktasi: `lexicon` tablosunu ayristiricinin kullandigi saf
 * `LexiconEntry` bicimine cevirir. Sozluk kucuk bir tablo, tam tarama
 * guvenlidir (docs/search.md: "lexicon tablosunun veritabaninda olmasi
 * onemli - yeni bir esanlamli eklemek icin surum cikmaya gerek kalmaz").
 */
import { type Database, lexicon } from "@arilla/db";
import type { LexiconEntry } from "./lexicon.ts";

export async function loadLexicon(db: Database): Promise<LexiconEntry[]> {
  const rows = await db.select().from(lexicon);
  return rows.map((row) => ({
    kind: row.kind,
    surface: row.surface,
    normalized: row.normalized,
    weight: row.weight,
  }));
}
