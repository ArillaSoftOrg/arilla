/**
 * `/yonetim/sozluk` (docs/pages.md): `lexicon` tablosunun tablo görünümü,
 * satır içi düzenleme, tür filtresi, arama; ekranın üstünde son 7 günde
 * kademe 3'e düşen sorgular.
 */

import { type Database, lexicon, queryResolution } from "@arilla/db";
import { and, desc, eq, gte, ilike, or } from "drizzle-orm";
import type { LexiconKind } from "../search/lexicon.ts";
import { recordAdminEvent } from "./audit.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const LEXICON_KINDS: readonly LexiconKind[] = [
  "color",
  "category",
  "brand",
  "size",
  "material",
  "style",
  "synonym",
];

export function isLexiconKind(value: unknown): value is LexiconKind {
  return typeof value === "string" && (LEXICON_KINDS as readonly string[]).includes(value);
}

export const LEXICON_SURFACE_MAX = 80;
export const LEXICON_NORMALIZED_MAX = 120;
export const LEXICON_WEIGHT_MAX = 10;
export const LEXICON_PAGE_SIZE_MAX = 200;

export interface LexiconFilter {
  kind?: LexiconKind;
  search?: string;
  /** Varsayılan 50, üst sınır `LEXICON_PAGE_SIZE_MAX`. */
  limit?: number;
  offset?: number;
}

/** Sınırlı: sözlük büyüdükçe tüm tabloyu tarayıcıya taşımaz. */
export async function listLexicon(db: Database, filter: LexiconFilter = {}) {
  const conditions = [];
  if (filter.kind) conditions.push(eq(lexicon.kind, filter.kind));
  if (filter.search) {
    const term = `%${filter.search}%`;
    conditions.push(or(ilike(lexicon.surface, term), ilike(lexicon.normalized, term)));
  }
  const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), LEXICON_PAGE_SIZE_MAX);
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
  return db
    .select()
    .from(lexicon)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(lexicon.kind, lexicon.surface, lexicon.id)
    .limit(limit)
    .offset(offset);
}

export interface UpsertLexiconInput {
  /** Verilirse güncelleme, verilmezse ekleme (kind+surface çakışırsa yine güncelleme). */
  id?: number;
  kind: LexiconKind;
  surface: string;
  normalized: string;
  weight?: number;
}

export type LexiconField = "id" | "kind" | "surface" | "normalized" | "weight";

export class LexiconValidationError extends Error {
  readonly field: LexiconField;

  constructor(field: LexiconField, message: string) {
    super(message);
    this.name = "LexiconValidationError";
    this.field = field;
  }
}

interface ValidLexiconInput {
  id?: number;
  kind: LexiconKind;
  surface: string;
  normalized: string;
  weight: number;
}

/**
 * Server action girdisi istemciden gelir; tipler çalışma anında güvence
 * değildir. Tür, uzunluk ve ağırlık burada, veritabanına gitmeden denetlenir.
 */
export function validateLexiconInput(input: UpsertLexiconInput): ValidLexiconInput {
  if (input.id !== undefined && !(Number.isSafeInteger(input.id) && input.id > 0)) {
    throw new LexiconValidationError("id", "Geçersiz satır.");
  }
  if (!isLexiconKind(input.kind)) {
    throw new LexiconValidationError("kind", "Geçersiz tür.");
  }
  const surface = typeof input.surface === "string" ? input.surface.trim() : "";
  if (surface.length === 0 || surface.length > LEXICON_SURFACE_MAX) {
    throw new LexiconValidationError("surface", `Yüzey 1–${LEXICON_SURFACE_MAX} karakter olmalı.`);
  }
  const normalized = typeof input.normalized === "string" ? input.normalized.trim() : "";
  if (normalized.length === 0 || normalized.length > LEXICON_NORMALIZED_MAX) {
    throw new LexiconValidationError(
      "normalized",
      `Karşılık 1–${LEXICON_NORMALIZED_MAX} karakter olmalı.`,
    );
  }
  const weight = input.weight ?? 1.0;
  if (
    typeof weight !== "number" ||
    !Number.isFinite(weight) ||
    weight < 0 ||
    weight > LEXICON_WEIGHT_MAX
  ) {
    throw new LexiconValidationError("weight", `Ağırlık 0–${LEXICON_WEIGHT_MAX} arası olmalı.`);
  }
  return { id: input.id, kind: input.kind, surface, normalized, weight };
}

type LexiconRow = typeof lexicon.$inferSelect;

function snapshot(row: LexiconRow) {
  return { kind: row.kind, surface: row.surface, normalized: row.normalized, weight: row.weight };
}

export interface UpsertLexiconResult {
  /** false: `id` verildi ama satır yok (başka sekmede silinmiş). */
  found: boolean;
}

/**
 * Ekle/düzenle. `query_resolution` önbelleği bu işlemde tamamen temizlenir:
 * aksi halde daha önce görülmüş bir sorgu, yeni sözlük satırına rağmen eski
 * ayrıştırmayı döndürmeye devam eder ve pages.md'nin "aramayı anında
 * etkiliyor" kabul kriteri tekrar eden sorgular için tutmazdı
 * (`resolveQuery`, `packages/core/src/search/query-resolution.ts`, bir
 * `query_norm`'u kalıcı olarak önbelleğe alır).
 *
 * Denetim kaydı aynı işlemde yazılır (önce/sonra).
 */
export async function upsertLexiconEntry(
  db: Database,
  actor: AdminActor,
  rawInput: UpsertLexiconInput,
): Promise<UpsertLexiconResult> {
  assertCapability(actor, "dictionary.write");
  const input = validateLexiconInput(rawInput);

  return db.transaction(async (tx) => {
    const existing =
      input.id !== undefined
        ? await tx.select().from(lexicon).where(eq(lexicon.id, input.id)).for("update")
        : await tx
            .select()
            .from(lexicon)
            .where(and(eq(lexicon.kind, input.kind), eq(lexicon.surface, input.surface)))
            .for("update");
    const before = existing[0];
    if (input.id !== undefined && !before) return { found: false };

    const values = {
      kind: input.kind,
      surface: input.surface,
      normalized: input.normalized,
      weight: input.weight,
    };
    let targetId: number;
    if (before) {
      await tx.update(lexicon).set(values).where(eq(lexicon.id, before.id));
      targetId = before.id;
    } else {
      const inserted = await tx.insert(lexicon).values(values).returning({ id: lexicon.id });
      const row = inserted[0];
      if (!row) throw new Error("lexicon insert bos sonuc dondurdu");
      targetId = row.id;
    }
    await tx.delete(queryResolution);

    await recordAdminEvent(tx, {
      actor,
      action: before ? "lexicon.update" : "lexicon.create",
      targetType: "lexicon",
      targetId,
      before: before ? snapshot(before) : null,
      after: values,
    });
    return { found: true };
  });
}

/** Sil. Önbellek aynı gerekçeyle temizlenir; silinen satır denetim kaydında kalır. */
export async function deleteLexiconEntry(
  db: Database,
  actor: AdminActor,
  id: number,
): Promise<UpsertLexiconResult> {
  assertCapability(actor, "dictionary.write");
  if (!(Number.isSafeInteger(id) && id > 0)) {
    throw new LexiconValidationError("id", "Geçersiz satır.");
  }

  return db.transaction(async (tx) => {
    const deleted = await tx.delete(lexicon).where(eq(lexicon.id, id)).returning();
    const row = deleted[0];
    if (!row) return { found: false };
    await tx.delete(queryResolution);
    await recordAdminEvent(tx, {
      actor,
      action: "lexicon.delete",
      targetType: "lexicon",
      targetId: id,
      before: snapshot(row),
      after: null,
    });
    return { found: true };
  });
}

export interface Tier3Query {
  queryNorm: string;
  hitCount: number;
  lastUsedAt: Date;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * pages.md: "son 7 günde kademe 3'e düşen sorguların listesi... sözlüğe
 * eklenecek adaylar oradan seçilir." Kademe 3 (model) henüz yazılmadı — C1
 * yalnızca kademe 2 üretiyor (`packages/core/src/search/query-resolution.ts`)
 * — o iş bitene kadar bu liste her zaman boş döner.
 */
export async function recentTier3Queries(db: Database, limit = 20): Promise<Tier3Query[]> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  return db
    .select({
      queryNorm: queryResolution.queryNorm,
      hitCount: queryResolution.hitCount,
      lastUsedAt: queryResolution.lastUsedAt,
    })
    .from(queryResolution)
    .where(and(eq(queryResolution.parserTier, 3), gte(queryResolution.lastUsedAt, since)))
    .orderBy(desc(queryResolution.hitCount))
    .limit(limit);
}
