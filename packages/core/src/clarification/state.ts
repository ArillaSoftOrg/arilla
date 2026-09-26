/**
 * Durum gecisleri. `applyInput(state, input)` saf ve deterministiktir: ayni
 * girdi dizisi her zaman ayni durumu uretir. Durum bu yuzden URL'deki girdi
 * listesinden yeniden kurulabilir (`url-state.ts`) - `localStorage` veya
 * sunucu tarafli oturum gerekmez (CLAUDE.md).
 *
 * Celiski kurali: her faset TEK deger tutar. Yeni deger eskisini, onceligi
 * en az onun kadar yuksekse ezer:
 *
 *   son acik kullanici beyani > turetilmis deger > model cikarimi
 *
 * "önce kapalı, sonra açık olsun" -> yalnizca `open_face` kalir.
 */
import { type ExtractContext, type ExtractedFacts, extractFacts } from "./extract.ts";
import {
  type AnsweredQuestion,
  BUDGET_FACET_ID,
  type BudgetAssignment,
  type ClarificationInput,
  type ClarificationRegistry,
  type DomainDefinition,
  type FacetAssignment,
  type LexicalSignals,
  type Provenance,
  type SearchState,
  type ShoppingIntent,
  type TurnResult,
} from "./types.ts";

export class InvalidClarificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClarificationInputError";
  }
}

const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = {
  explicit: 3,
  inferred: 2,
  model: 1,
};

/** Esit oncelikte yeni gelen kazanir; dusuk oncelik yuksegi asla ezmez. */
export function outranks(
  incoming: { source: Provenance; turn: number },
  existing: { source: Provenance; turn: number } | null | undefined,
): boolean {
  if (!existing) return true;
  const a = PROVENANCE_RANK[incoming.source];
  const b = PROVENANCE_RANK[existing.source];
  return a > b || (a === b && incoming.turn >= existing.turn);
}

export function createInitialState(): SearchState {
  return {
    version: 1,
    rawQuery: "",
    turn: 0,
    intent: "open",
    domainId: null,
    domainSource: null,
    facets: {},
    skippedFacets: [],
    budget: null,
    lexical: {},
    terms: [],
    constraints: { pricePreference: null },
    pendingQuestionId: null,
    askCounts: {},
    answeredQuestions: [],
    clarificationStatus: "collecting",
  };
}

export function findDomain(
  registry: ClarificationRegistry,
  domainId: string | null,
): DomainDefinition | undefined {
  return domainId === null ? undefined : registry.domains.find((d) => d.id === domainId);
}

function intentFor(
  domain: DomainDefinition | undefined,
  secondary: readonly string[],
): ShoppingIntent {
  if (domain?.id === "gift" || secondary.includes("gift")) return "gift";
  return domain ? "product" : "open";
}

function withFacet(
  state: SearchState,
  domain: DomainDefinition,
  facetId: string,
  assignment: FacetAssignment,
): SearchState {
  if (!outranks(assignment, state.facets[facetId])) return state;
  let facets: Record<string, FacetAssignment> = { ...state.facets, [facetId]: assignment };

  // Ima edilen fasetler "inferred" olarak yazilir: acik bir cevabi ezemez,
  // ama kendisi de sonraki acik cevapla ezilir.
  const option = domain.facets
    .find((facet) => facet.id === facetId)
    ?.options.find((o) => o.id === assignment.optionId);
  for (const [impliedFacet, impliedOption] of Object.entries(option?.implies ?? {})) {
    const implied: FacetAssignment = {
      optionId: impliedOption,
      source: assignment.source === "model" ? "model" : "inferred",
      turn: assignment.turn,
    };
    if (outranks(implied, facets[impliedFacet])) facets = { ...facets, [impliedFacet]: implied };
  }

  return {
    ...state,
    facets,
    skippedFacets: state.skippedFacets.filter((id) => id !== facetId),
  };
}

function withBudget(state: SearchState, budget: BudgetAssignment): SearchState {
  if (!outranks(budget, state.budget)) return state;
  return {
    ...state,
    budget,
    skippedFacets: state.skippedFacets.filter((id) => id !== BUDGET_FACET_ID),
  };
}

/** Alan bazinda son yazan kazanir; yeni turda soylenmeyen alan korunur. */
function mergeLexical(previous: LexicalSignals, next: LexicalSignals): LexicalSignals {
  return { ...previous, ...next };
}

/** Yeni konusma: ilk sorgu ya da farkli bir urun ailesine gecis. */
function freshFromFacts(text: string, facts: ExtractedFacts, context: ExtractContext): SearchState {
  const domain = findDomain(context.registry, facts.domainId);
  let state: SearchState = {
    ...createInitialState(),
    rawQuery: text.trim(),
    turn: 1,
    intent: intentFor(domain, facts.secondaryDomainIds),
    domainId: domain?.id ?? null,
    domainSource: domain ? "explicit" : null,
    lexical: facts.lexical,
    terms: facts.terms,
    constraints: { pricePreference: facts.pricePreference },
  };
  if (facts.budget) state = withBudget(state, { ...facts.budget, source: "explicit", turn: 1 });
  if (domain) {
    for (const [facetId, optionId] of Object.entries(facts.facets)) {
      state = withFacet(state, domain, facetId, { optionId, source: "explicit", turn: 1 });
    }
  }
  return state;
}

/** Aramaya etki eden alanlar ayni mi? Tur sayaci ve cevap gunlugu haric. */
function sameSearchMeaning(a: SearchState, b: SearchState): boolean {
  const facetKey = (state: SearchState) =>
    Object.entries(state.facets)
      .map(([id, assignment]) => `${id}=${assignment.optionId}`)
      .sort()
      .join("|");
  return (
    facetKey(a) === facetKey(b) &&
    a.budget?.minKurus === b.budget?.minKurus &&
    a.budget?.maxKurus === b.budget?.maxKurus &&
    JSON.stringify(a.lexical) === JSON.stringify(b.lexical) &&
    [...a.skippedFacets].sort().join("|") === [...b.skippedFacets].sort().join("|")
  );
}

/**
 * Suren konusmada domain tetiklemeyen ama hicbir fasete de dusmeyen metin
 * yeni bir urun ailesi mi? Deterministik kural:
 *
 * - arama fiili + somut kelime: "masa lambası bakıyorum" -> evet
 * - en az iki kelimelik isim obegi: "masa lambası" -> evet
 * - tek kelime ya da tercih cumlesi ("marka önemli değil",
 *   "yağmurda da kullanacağım") -> hayir; `unrecognized` olur ve arayuz
 *   "yeni arama olarak kullan" secenegini acikca sunar.
 */
function startsNewProductFamily(facts: ReturnType<typeof extractFacts>): boolean {
  if (facts.terms.length === 0) return false;
  return facts.hasSearchVerb || (facts.isNounPhrase && facts.terms.length >= 2);
}

function applyText(state: SearchState, text: string, context: ExtractContext): TurnResult {
  const facts = extractFacts(text, context, { contextDomainId: state.domainId });
  const switchesDomain =
    facts.detectedDomainId !== null && facts.detectedDomainId !== state.domainId;
  if (state.rawQuery === "" || state.domainId === null || switchesDomain) {
    // Yeni urun ailesi = yeni konusma. Uyumluluk kurali: onceki ailenin
    // fasetleri, cevaplari, atlamalari, ima edilen degerleri ve butcesi
    // tasinmaz (butce bantlari aileye ozgudur). Yalnizca bu metin kalir.
    return {
      state: freshFromFacts(text, facts, context),
      outcome: "new_search",
      ignoredPricePreference: false,
    };
  }

  // Ayni domain'de takip metni: yalnizca faset, butce ve sozluk sinyalleri
  // guncellenir. Serbest kelimeler metin kapisina EKLENMEZ - "yağmurda da
  // kullanacağım" gibi bir cumle aramayi daraltmamali.
  const turn = state.turn + 1;
  const domain = findDomain(context.registry, state.domainId);
  let next: SearchState = {
    ...state,
    turn,
    lexical: mergeLexical(state.lexical, facts.lexical),
    constraints: {
      pricePreference: facts.pricePreference ?? state.constraints.pricePreference,
    },
  };
  if (facts.budget) next = withBudget(next, { ...facts.budget, source: "explicit", turn });
  if (domain) {
    for (const [facetId, optionId] of Object.entries(facts.facets)) {
      next = withFacet(next, domain, facetId, { optionId, source: "explicit", turn });
      next = logAnswer(next, facetId, optionId, turn);
    }
  }

  if (!sameSearchMeaning(state, next)) {
    return {
      state: next,
      outcome: "applied",
      ignoredPricePreference: facts.pricePreference !== null,
    };
  }
  if (facts.pricePreference !== null) {
    return { state: next, outcome: "unsupported_preference", ignoredPricePreference: false };
  }
  if (startsNewProductFamily(facts)) {
    const standalone = extractFacts(text, context);
    return {
      state: freshFromFacts(text, standalone, context),
      outcome: "new_search",
      ignoredPricePreference: false,
    };
  }
  // Hicbir sey anlasilmadi: durum AYNEN kalir (tur sayaci dahil).
  return { state, outcome: "unrecognized", ignoredPricePreference: false };
}

function logAnswer(
  state: SearchState,
  questionId: string,
  optionId: string | null,
  turn: number,
): SearchState {
  const entry: AnsweredQuestion = { questionId, optionId, turn };
  return { ...state, answeredQuestions: [...state.answeredQuestions, entry] };
}

function requireDomain(state: SearchState, registry: ClarificationRegistry): DomainDefinition {
  const domain = findDomain(registry, state.domainId);
  if (!domain) {
    throw new InvalidClarificationInputError("Acik bir netlestirme sorusu yok: domain belirsiz.");
  }
  return domain;
}

function requireQuestion(domain: DomainDefinition, questionId: string): void {
  const known =
    questionId === BUDGET_FACET_ID
      ? domain.budgetBands !== undefined
      : domain.facets.some((facet) => facet.id === questionId);
  if (!known) {
    throw new InvalidClarificationInputError(
      `"${questionId}" sorusu "${domain.id}" icin tanimli degil.`,
    );
  }
}

function applyAnswer(
  state: SearchState,
  questionId: string,
  optionId: string,
  registry: ClarificationRegistry,
): SearchState {
  const domain = requireDomain(state, registry);
  requireQuestion(domain, questionId);
  const turn = state.turn + 1;

  if (questionId === BUDGET_FACET_ID) {
    const band = domain.budgetBands?.find((b) => b.id === optionId);
    if (!band) {
      throw new InvalidClarificationInputError(`"${optionId}" gecerli bir butce secenegi degil.`);
    }
    const next = withBudget(
      { ...state, turn },
      {
        minKurus: band.minTry === null ? null : band.minTry * 100,
        maxKurus: band.maxTry === null ? null : band.maxTry * 100,
        source: "explicit",
        turn,
      },
    );
    return logAnswer(next, questionId, optionId, turn);
  }

  const facet = domain.facets.find((f) => f.id === questionId);
  if (!facet?.options.some((option) => option.id === optionId)) {
    throw new InvalidClarificationInputError(
      `"${optionId}" "${questionId}" icin gecerli bir secenek degil.`,
    );
  }
  const next = withFacet({ ...state, turn }, domain, questionId, {
    optionId,
    source: "explicit",
    turn,
  });
  return logAnswer(next, questionId, optionId, turn);
}

function applySkip(
  state: SearchState,
  questionId: string,
  registry: ClarificationRegistry,
): SearchState {
  const domain = requireDomain(state, registry);
  requireQuestion(domain, questionId);
  const turn = state.turn + 1;
  // "Fark etmez" acik bir beyandir: onceki kisit (ne kaynakli olursa olsun) kalkar.
  const { [questionId]: _removed, ...facets } = state.facets;
  const next: SearchState = {
    ...state,
    turn,
    facets,
    budget: questionId === BUDGET_FACET_ID ? null : state.budget,
    skippedFacets: state.skippedFacets.includes(questionId)
      ? state.skippedFacets
      : [...state.skippedFacets, questionId],
  };
  return logAnswer(next, questionId, null, turn);
}

/**
 * Girdiyi uygular ve etkisini soyler. Serbest metin icin `outcome`
 * `unrecognized` olabilir; secenek, atlama ve "sonuçları göster" her zaman
 * `applied`'dir (gecersizse hata firlatir).
 */
export function applyInputWithOutcome(
  state: SearchState,
  input: ClarificationInput,
  context: ExtractContext,
): TurnResult {
  switch (input.type) {
    case "text":
      return applyText(state, input.text, context);
    case "answer":
      return {
        state: applyAnswer(state, input.questionId, input.optionId, context.registry),
        outcome: "applied",
        ignoredPricePreference: false,
      };
    case "skip":
      return {
        state: applySkip(state, input.questionId, context.registry),
        outcome: "applied",
        ignoredPricePreference: false,
      };
    case "show_results":
      return {
        state: { ...state, turn: state.turn + 1, clarificationStatus: "user_requested_results" },
        outcome: "applied",
        ignoredPricePreference: false,
      };
  }
}

export function applyInput(
  state: SearchState,
  input: ClarificationInput,
  context: ExtractContext,
): SearchState {
  return applyInputWithOutcome(state, input, context).state;
}
