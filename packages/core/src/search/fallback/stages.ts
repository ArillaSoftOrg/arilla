/**
 * Fallback adim plani: hangi sorgu hangi sirayla, hangi gevsetmeyle denenir.
 * Saf fonksiyon; saglayici cagirmaz.
 *
 * Sira (daha siki olan once, ucuz olan once):
 *   exact -> alias -> fuzzy -> token gevsetme (surum eki, model kodu, bas isim)
 *   -> kisit gevsetme (renk, beden, kategori -> ust kategori) -> related
 *
 * Kurallar:
 * - Fiyat araligi, marka haric tutma, stok ve magaza kisiti ASLA gevsetilmez.
 * - Marka/kategori kisiti tamamen kaldirilmaz (kategori yalnizca ust
 *   kategoriye cikar); gevsetme sorguyu capasiz birakacaksa o adim uretilmez.
 * - Her adim hangi seyi gevsettigini `relaxed` ile tasir (yalnizca dahili).
 */
import type { QueryFilters } from "../types.ts";
import { isSpecToken, type QueryToken, slotsOf } from "./analyze.ts";
import type { Relaxation, SearchQuery, SearchStageId } from "./types.ts";

export interface PlannedStage {
  id: SearchStageId;
  /** Bu adimin sorguladigi tokenlar; adim ailesi/bas isim eslesen urun `related` sayilir. */
  tokens: QueryToken[];
  query: SearchQuery;
  relaxed: Relaxation[];
}

/** Bir sorgu icin en fazla bu kadar saglayici cagrisi (zero-result yolu). */
export const MAX_STAGES = 10;

function hasAnchor(tokens: readonly QueryToken[], filters: QueryFilters): boolean {
  return (
    tokens.length > 0 ||
    (filters.brand_include?.length ?? 0) > 0 ||
    (filters.category_path ?? "") !== ""
  );
}

/**
 * Ust kategori; KOK kategoriye (tek parca) cikilmaz: "moda" ile "nike" bir
 * cantayi ayakkabi aramasinin ilgili urunu yapar.
 */
function parentCategory(path: string): string | null {
  const index = path.lastIndexOf("/");
  if (index <= 0) return null;
  const parent = path.slice(0, index);
  return parent.includes("/") ? parent : null;
}

interface TokenStep {
  id: SearchStageId;
  tokens: QueryToken[];
  relaxed: Relaxation[];
}

/**
 * Soldan saga okunan modelde (marka/aile, sayi, surum eki) sagdan birakma:
 * "iphone 17 pro max" -> "iphone 17 pro" -> "iphone 17" -> "iphone".
 * Model kodu olmayan sorgularda (Turkce isim tamlamasi, bas isim sonda)
 * yalnizca bas isimle denenir.
 */
export function tokenLadder(tokens: readonly QueryToken[]): TokenStep[] {
  const steps: TokenStep[] = [];
  const current = [...tokens];
  const relaxed: Relaxation[] = [];

  const droppable = (token: QueryToken | undefined) =>
    token !== undefined && (token.kind === "variant" || isSpecToken(token));

  while (current.length > 1 && droppable(current[current.length - 1])) {
    const dropped = current.pop() as QueryToken;
    relaxed.push(`token:${dropped.value}`);
    steps.push({ id: "variant_relaxed", tokens: [...current], relaxed: [...relaxed] });
  }

  const withoutModel = current.filter((token) => token.kind !== "model");
  if (current.length > withoutModel.length && withoutModel.length > 0) {
    for (const token of current) if (token.kind === "model") relaxed.push(`token:${token.value}`);
    // Model kodundan sonra kalan surum ekleri de anlamsizlasir ("iphone pro" kalmasin).
    const family = withoutModel.filter((token) => token.kind !== "variant");
    const kept = family.length > 0 ? family : withoutModel;
    steps.push({ id: "family", tokens: kept, relaxed: [...relaxed] });
  } else if (steps.length === 0 && current.length > 1) {
    const head = current[current.length - 1] as QueryToken;
    if (head.kind === "word" && head.value.length >= 4) {
      const dropped = current.slice(0, -1).map((token): Relaxation => `token:${token.value}`);
      steps.push({ id: "head_only", tokens: [head], relaxed: dropped });
    }
  }
  return steps;
}

interface ConstraintStep {
  filters: QueryFilters;
  relaxed: Relaxation[];
}

/** Renk -> beden -> kategori (ust kategoriye). Fiyat ve haric tutmalar dokunulmaz. */
export function constraintLadder(
  filters: QueryFilters,
  tokens: readonly QueryToken[],
): ConstraintStep[] {
  const steps: ConstraintStep[] = [];
  const current: QueryFilters = { ...filters };
  const relaxed: Relaxation[] = [];

  const push = () => {
    if (hasAnchor(tokens, current)) steps.push({ filters: { ...current }, relaxed: [...relaxed] });
  };

  if (current.color && current.color.length > 0) {
    current.color = undefined;
    relaxed.push("color");
    push();
  }
  if (current.size_norm) {
    current.size_norm = undefined;
    relaxed.push("size");
    push();
  }
  let parent = current.category_path ? parentCategory(current.category_path) : null;
  while (parent !== null) {
    current.category_path = parent;
    if (!relaxed.includes("category")) relaxed.push("category");
    push();
    parent = parentCategory(parent);
  }
  return steps;
}

export interface StagePlanInput {
  text: string;
  tokens: readonly QueryToken[];
  /** Ayristiricinin urettigi orijinal slotlar (exact adimi bunlari AYNEN kullanir). */
  baseSlots: string[][];
  filters: QueryFilters;
  sort: SearchQuery["sort"];
  /** Orijinal tokenlar bir es anlamli/takma ad ile genisletilebilir mi. */
  hasAliasExpansion: boolean;
  /** Bulanik adim anlamli mi (en az bir uzun kelime tokeni). */
  canFuzzy: boolean;
  limit: number;
}

function queryKey(query: SearchQuery): string {
  return JSON.stringify([query.slots, query.filters, query.fuzzy]);
}

/** `exact` adimi pipeline tarafindan ayri calistirilir; burasi onu SONRAKI adimlari uretir. */
export function planFallbackStages(input: StagePlanInput): PlannedStage[] {
  const { tokens, filters } = input;
  const make = (
    id: SearchStageId,
    stageTokens: readonly QueryToken[],
    slots: string[][],
    stageFilters: QueryFilters,
    relaxed: Relaxation[],
    fuzzy = false,
  ): PlannedStage => ({
    id,
    tokens: [...stageTokens],
    relaxed,
    query: {
      text: input.text,
      slots,
      filters: stageFilters,
      // Sonraki adimlar sekmeye bakmaz: yakinlik siralamasi dengeli skorla yapilir.
      sort: "balanced",
      limit: input.limit,
      offset: 0,
      fuzzy,
    },
  });

  const stages: PlannedStage[] = [];
  const seen = new Set<string>();
  const add = (stage: PlannedStage) => {
    const key = queryKey(stage.query);
    if (seen.has(key) || stages.length >= MAX_STAGES) return;
    seen.add(key);
    stages.push(stage);
  };

  // exact adiminin anahtari: tekrar denenmesin.
  seen.add(queryKey(make("exact", tokens, input.baseSlots, filters, []).query));

  if (input.hasAliasExpansion) add(make("alias", tokens, slotsOf(tokens), filters, ["alias"]));
  if (input.canFuzzy) add(make("fuzzy", tokens, input.baseSlots, filters, ["typo"], true));

  const tokenSteps = tokenLadder(tokens);
  for (const step of tokenSteps) {
    add(make(step.id, step.tokens, slotsOf(step.tokens), filters, step.relaxed));
  }

  const constraintSteps = constraintLadder(filters, tokens);
  for (const step of constraintSteps) {
    add(make("constraint_relaxed", tokens, input.baseSlots, step.filters, step.relaxed));
  }

  // Son care: hem token hem kisit gevsetilmis en genis ama hala capali sorgu.
  const lastTokens = tokenSteps[tokenSteps.length - 1];
  const lastConstraints = constraintSteps[constraintSteps.length - 1];
  if (lastTokens && lastConstraints) {
    add(
      make("related", lastTokens.tokens, slotsOf(lastTokens.tokens), lastConstraints.filters, [
        ...lastTokens.relaxed,
        ...lastConstraints.relaxed,
      ]),
    );
  }
  return stages;
}
