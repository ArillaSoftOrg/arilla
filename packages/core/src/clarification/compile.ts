/**
 * Yapilandirilmis durum -> mevcut arama motorunun `QueryObject`'i
 * (docs/search.md). Erisim, siralama ve urun gercegi `search()`'te kalir;
 * burada yalnizca sorgu nesnesi kurulur.
 *
 * Metin kapisi (`unparsed`) Turkce tamlama sirasini korur: niteleyiciler
 * once, bas isim sonda ("erkek koşu ayakkabı").
 */

import { matchTokens } from "../search/text-match.ts";
import type { QueryFilters, QueryObject, SortMode } from "../search/types.ts";
import { foldForTrigger } from "./extract.ts";
import { findDomain } from "./state.ts";
import type { ClarificationRegistry, SearchState } from "./types.ts";

export interface CompileOptions {
  /**
   * Katalogdaki `category.path` degerleri. Verilirse listede olmayan kategori
   * katkisi dusurulur - kural sozlugu ile gercek agac ayrisirsa arama bos
   * sonuca kilitlenmez.
   */
  knownCategoryPaths?: ReadonlySet<string>;
  sort?: SortMode;
}

function isKnown(path: string, known: ReadonlySet<string> | undefined): boolean {
  return known === undefined || known.has(path);
}

function pickCategory(candidates: readonly { path: string; turn: number }[]): string | undefined {
  if (candidates.length === 0) return undefined;
  // Biri digerinin alt yoluysa daha ozel olan; degilse en son secilen.
  const sorted = [...candidates].sort((a, b) => b.turn - a.turn);
  const latest = sorted[0];
  if (!latest) return undefined;
  const moreSpecific = candidates.find(
    (c) => c.path !== latest.path && c.path.startsWith(`${latest.path}/`),
  );
  return moreSpecific?.path ?? latest.path;
}

export function compileQuery(
  state: SearchState,
  registry: ClarificationRegistry,
  options: CompileOptions = {},
): QueryObject {
  const domain = findDomain(registry, state.domainId);
  const terms: string[] = [];
  const categoryCandidates: { path: string; turn: number }[] = [];

  if (domain) {
    for (const facet of domain.facets) {
      const assignment = state.facets[facet.id];
      if (!assignment) continue;
      if (facet.appliesWhen) {
        const gate = state.facets[facet.appliesWhen.facetId];
        if (!gate || !facet.appliesWhen.optionIds.includes(gate.optionId)) continue;
      }
      const option = facet.options.find((o) => o.id === assignment.optionId);
      const contribution = option?.contribution;
      if (!contribution) continue;
      terms.push(...(contribution.terms ?? []));
      if (
        contribution.categoryPath &&
        isKnown(contribution.categoryPath, options.knownCategoryPaths)
      ) {
        categoryCandidates.push({ path: contribution.categoryPath, turn: assignment.turn });
      }
    }
  }

  // Model-yalniz urun turlerinde serbest kalan kelimeler metin kapisina
  // GIRMEZ: ya model tarafindan yorumlandi (butce, "oyun" -> gaming) ya da
  // katalogda karsiligi yok ("hafif", "16 gb ram"). Kapiya girselerdi kapi
  // neredeyse hic urun gecirmezdi. Marka/renk zaten suzgec olarak uygulanir.
  if (!domain?.modelOnly) terms.push(...state.terms);
  if (domain) terms.push(...domain.retrievalTerms);

  const seen = new Set<string>();
  const unparsedTerms = terms.filter((term) => {
    const key = foldForTrigger(term);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Bas ismin es anlamlilari tanimliysa (katalog urun turleri) bas isim tek
  // bir alternatif slotu olur: "laptop" | "notebook" | "dizustu". Digerleri
  // icin `text_slots` uretilmez; arama bugunku gibi `unparsed`tan kurar.
  let textSlots: string[][] | undefined;
  if (domain?.retrievalAlternatives && domain.retrievalAlternatives.length > 0) {
    const head = matchTokens([...domain.retrievalTerms, ...domain.retrievalAlternatives].join(" "));
    const headSet = new Set(head);
    const qualifiers = matchTokens(unparsedTerms.join(" ")).filter((token) => !headSet.has(token));
    textSlots = [...qualifiers.map((token) => [token]), head];
  }

  const filters: QueryFilters = {};
  const categoryPath =
    pickCategory(categoryCandidates) ??
    (domain?.categoryPath && isKnown(domain.categoryPath, options.knownCategoryPaths)
      ? domain.categoryPath
      : undefined) ??
    state.lexical.category_path;
  if (categoryPath !== undefined) filters.category_path = categoryPath;
  if (state.lexical.color) filters.color = [...state.lexical.color];
  if (state.lexical.size_norm !== undefined) filters.size_norm = state.lexical.size_norm;
  if (state.lexical.brand_include) filters.brand_include = [...state.lexical.brand_include];
  if (state.lexical.brand_exclude) filters.brand_exclude = [...state.lexical.brand_exclude];
  if (state.budget?.minKurus != null) filters.price_min = state.budget.minKurus;
  if (state.budget?.maxKurus != null) filters.price_max = state.budget.maxKurus;

  return {
    intent: "browse",
    anchor: null,
    text: state.rawQuery,
    filters,
    style_tags: [],
    sort: options.sort ?? "balanced",
    unparsed: unparsedTerms.join(" "),
    ...(textSlots ? { text_slots: textSlots } : {}),
    // Deterministik kurallarla kuruldu; tahmin degil.
    confidence: 1,
  };
}
