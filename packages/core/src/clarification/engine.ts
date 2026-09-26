/**
 * Karar: bu turda soru mu sorulur, arama mi yapilir? Anket gibi bir akis
 * istenmiyor - en az faydali soru sayisi hedeflenir.
 *
 * Arama hazirligi (readiness):
 *
 * - Domain yoksa (kural listesinde olmayan sorgu) hemen aranir.
 * - Kullanici "sonuçları göster" dediyse hemen aranir.
 * - Model numarasi gibi somut bir urun referansi varsa ("iphone 16") aranir.
 * - `essential` soru, cevaplanmadan ya da atlanmadan arama hazir sayilmaz.
 * - `useful` soru yalnizca sinyal sayisi `readyAfterSignals`'in altindaysa
 *   sorulur. Sinyal: bir filtre fasetinin secimi, butce, renk/beden/marka,
 *   ya da ilk sorgudan kalan somut kelimeler.
 * - Bir domain'de en fazla `maxQuestions` farkli soru sorulur.
 * - Kullanici bir soruyu atladiysa ("Fark etmez") artik `useful` soru
 *   sorulmaz: atlama "beni sorguya cekme" demektir. Yalnizca aramanin
 *   anlamli olmasi icin sart olan `essential` soru kalabilir.
 * - Ayni soru en fazla iki kez sorulur; ikinci kez de cevapsiz kalirsa
 *   kullanici soruyla ilgilenmiyor demektir: baska soru sorulmadan aranir.
 *   Kullanici sihirbazda hapsolmaz.
 */
import type { ExtractContext } from "./extract.ts";
import {
  applyInput,
  createInitialState,
  findDomain,
  InvalidClarificationInputError,
} from "./state.ts";
import {
  BUDGET_FACET_ID,
  type ClarificationDecision,
  type ClarificationInput,
  type ClarificationQuestion,
  type DomainDefinition,
  type Readiness,
  type SearchState,
  SKIP_OPTION_ID,
} from "./types.ts";

export const MAX_ASKS_PER_QUESTION = 2;
/** Uc bir guvenlik siniri: bu kadar turdan sonra ne olursa olsun aranir. */
export const MAX_TURNS = 8;

const DEFAULT_BUDGET_QUESTION = "Ne kadar ayırmayı düşünüyorsun?";

function isApplicable(domain: DomainDefinition, facetId: string, state: SearchState): boolean {
  if (facetId === BUDGET_FACET_ID) return (domain.budgetBands?.length ?? 0) > 0;
  const facet = domain.facets.find((f) => f.id === facetId);
  if (!facet) return false;
  if (!facet.appliesWhen) return true;
  const gate = state.facets[facet.appliesWhen.facetId];
  return gate !== undefined && facet.appliesWhen.optionIds.includes(gate.optionId);
}

function isResolved(facetId: string, state: SearchState): boolean {
  if (state.skippedFacets.includes(facetId)) return true;
  if (facetId === BUDGET_FACET_ID) return state.budget !== null;
  return state.facets[facetId] !== undefined;
}

function hasAbandonedQuestion(state: SearchState): boolean {
  return Object.entries(state.askCounts).some(
    ([id, count]) => count >= MAX_ASKS_PER_QUESTION && !isResolved(id, state),
  );
}

function hasModelNumber(terms: readonly string[]): boolean {
  return terms.some((term) => /\d/.test(term));
}

export function countSignals(domain: DomainDefinition, state: SearchState): number {
  let signals = 0;
  for (const facet of domain.facets) {
    if (facet.role !== "filter") continue;
    if (state.facets[facet.id] && isApplicable(domain, facet.id, state)) signals += 1;
  }
  if (state.budget !== null) signals += 1;
  const { color, size_norm, brand_include } = state.lexical;
  if (color && color.length > 0) signals += 1;
  if (size_norm !== undefined) signals += 1;
  if (brand_include && brand_include.length > 0) signals += 1;
  if (state.terms.length > 0) signals += 1;
  return signals;
}

export function buildQuestion(
  domain: DomainDefinition,
  facetId: string,
  state: SearchState,
): ClarificationQuestion {
  if (facetId === BUDGET_FACET_ID) {
    const bands = domain.budgetBands ?? [];
    return {
      id: BUDGET_FACET_ID,
      text: domain.budgetQuestion ?? DEFAULT_BUDGET_QUESTION,
      options: bands.map((band) => ({
        id: band.id,
        label: band.label,
        selected:
          state.budget !== null &&
          state.budget.minKurus === (band.minTry === null ? null : band.minTry * 100) &&
          state.budget.maxKurus === (band.maxTry === null ? null : band.maxTry * 100),
      })),
      skipOption: { id: SKIP_OPTION_ID, label: "Fark etmez" },
      allowFreeText: true,
    };
  }
  const facet = domain.facets.find((f) => f.id === facetId);
  if (!facet) throw new Error(`"${facetId}" "${domain.id}" icinde tanimli degil`);
  return {
    id: facet.id,
    text: facet.question,
    options: facet.options.map((option) => ({
      id: option.id,
      label: option.label,
      selected: state.facets[facet.id]?.optionId === option.id,
    })),
    skipOption: { id: SKIP_OPTION_ID, label: facet.skipLabel },
    allowFreeText: true,
  };
}

function nextQuestionId(
  domain: DomainDefinition,
  state: SearchState,
  signals: number,
): string | null {
  const questionsAsked = Object.keys(state.askCounts).length;
  for (const entry of domain.questionOrder) {
    const id = entry.facetId;
    if (!isApplicable(domain, id, state) || isResolved(id, state)) continue;
    const asked = state.askCounts[id] ?? 0;
    if (asked >= MAX_ASKS_PER_QUESTION) continue;
    if (asked === 0 && questionsAsked >= domain.maxQuestions) continue;
    if (entry.importance === "essential") return id;
    if (state.skippedFacets.length > 0) continue;
    if (signals < domain.readyAfterSignals) return id;
  }
  return null;
}

function readinessFor(domain: DomainDefinition | undefined, state: SearchState): Readiness {
  if (!domain) {
    return {
      signals: 0,
      signalsNeeded: 0,
      missingEssential: [],
      questionsAsked: Object.keys(state.askCounts).length,
      maxQuestions: 0,
    };
  }
  return {
    signals: countSignals(domain, state),
    signalsNeeded: domain.readyAfterSignals,
    missingEssential: domain.questionOrder
      .filter(
        (entry) =>
          entry.importance === "essential" &&
          isApplicable(domain, entry.facetId, state) &&
          !isResolved(entry.facetId, state),
      )
      .map((entry) => entry.facetId),
    questionsAsked: Object.keys(state.askCounts).length,
    maxQuestions: domain.maxQuestions,
  };
}

function searchNow(state: SearchState, readiness: Readiness): ClarificationDecision {
  const status =
    state.clarificationStatus === "user_requested_results" ? "user_requested_results" : "ready";
  return {
    action: "search",
    state: { ...state, pendingQuestionId: null, clarificationStatus: status },
    readiness,
  };
}

/**
 * Durumdan karar uretir. Soru sorulursa donen durumda `pendingQuestionId` ve
 * `askCounts` guncellenmistir; bir sonraki `applyInput` bu durumdan devam eder.
 */
export function decide(state: SearchState, context: ExtractContext): ClarificationDecision {
  const domain = findDomain(context.registry, state.domainId);
  const readiness = readinessFor(domain, state);

  if (
    !domain ||
    state.clarificationStatus === "user_requested_results" ||
    state.turn >= MAX_TURNS ||
    hasModelNumber(state.terms) ||
    hasAbandonedQuestion(state) ||
    (domain.readyOnConcreteTerms === true && state.terms.length > 0)
  ) {
    return searchNow(state, readiness);
  }

  const questionId = nextQuestionId(domain, state, readiness.signals);
  if (questionId === null) return searchNow(state, readiness);

  const nextState: SearchState = {
    ...state,
    pendingQuestionId: questionId,
    askCounts: { ...state.askCounts, [questionId]: (state.askCounts[questionId] ?? 0) + 1 },
    clarificationStatus: "collecting",
  };
  return {
    action: "clarify",
    state: nextState,
    question: buildQuestion(domain, questionId, nextState),
    readiness: { ...readiness, questionsAsked: Object.keys(nextState.askCounts).length },
  };
}

/** Tek tur: girdiyi uygula, karar ver. */
export function step(
  state: SearchState,
  input: ClarificationInput,
  context: ExtractContext,
): ClarificationDecision {
  return decide(applyInput(state, input, context), context);
}

/**
 * Girdi dizisini bastan oynatir. URL'den kurulan konusmalar icin: gecersiz
 * bir girdiye gelinirse orada durulur ve o ana kadarki karar doner - bayat
 * ya da elle bozulmus bir link kullaniciyi hata sayfasina dusurmez.
 */
export function replayConversation(
  inputs: readonly ClarificationInput[],
  context: ExtractContext,
): { decision: ClarificationDecision; rejectedInput: ClarificationInput | null } {
  let decision = decide(createInitialState(), context);
  for (const input of inputs) {
    try {
      decision = step(decision.state, input, context);
    } catch (error) {
      if (error instanceof InvalidClarificationInputError) {
        return { decision, rejectedInput: input };
      }
      throw error;
    }
  }
  return { decision, rejectedInput: null };
}
