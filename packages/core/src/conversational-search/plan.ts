/**
 * Konusmali arama ile arayuz arasindaki ince adaptor (docs/decisions/0030).
 * Netlestirme motorunu (`../clarification`) YALNIZCA disa acik sozlesmesi
 * uzerinden kullanir; motorun kurallarini yeniden yazmaz.
 *
 * Arayuz bu dosyadan tek bir plan alir ve karari kimin verdigini bilmez:
 * bugun deterministik kurallar, ileride bir model yorumcusu ayni `SearchState`
 * uzerinde calisir. Plan iki bicimdedir:
 *
 * - `conventional`: sorgu kural sozlugune dusmedi (ya da katman calismadi);
 *   mevcut `resolveQuery` yolu hic degismeden kullanilir.
 * - `conversation`: durum motor tarafindan kuruldu. `question` doluysa tek bir
 *   soru sonuclarin USTUNDE gosterilir - sonuclar bekletilmez (docs/pages.md).
 *
 * Gorunen her secenek ve etiket taksonomiden gelir; burada secenek uretilmez.
 * Durum URL'deki adim listesinde tasinir, depolama gerekmez (CLAUDE.md).
 */
import {
  appendInput,
  BUDGET_FACET_ID,
  type ClarificationInput,
  type CompileOptions,
  compileQuery,
  decodeInputs,
  type ExtractContext,
  encodeInput,
  findDomain,
  foldForTrigger,
  MAX_FOLLOW_UP_TEXT_LENGTH,
  replayConversation,
  type SearchState,
} from "../clarification/index.ts";
import type { QueryObject } from "../search/types.ts";

export interface ConversationRequest {
  /** Konusmayi baslatan sorgu (`?q=`). */
  query: string;
  /** URL'deki kodlanmis adimlar (`?n=`), sirasiyla. */
  steps: readonly string[];
  /** Soru ya da sonuclar altindaki serbest metin kutusundan gelen yanit. */
  reply?: string | null;
}

export interface QuestionOptionView {
  id: string;
  label: string;
  selected: boolean;
  /** Bu secenek secilirse URL'e yazilacak adim listesi. */
  steps: string[];
}

export interface QuestionView {
  id: string;
  text: string;
  options: QuestionOptionView[];
  skip: { label: string; steps: string[] };
  showResults: { label: string; steps: string[] };
}

export interface UnderstoodChip {
  key: string;
  label: string;
  /**
   * Kaldirmak icin adim listesi. `null`: bu sinyal ilk sorgudan geliyor ve
   * sozlesmede onu geri alacak bir girdi yok; cip yalnizca gosterilir.
   */
  removeSteps: string[] | null;
}

export type ConversationPlan =
  | {
      mode: "conventional";
      query: string;
      reason: "no_domain" | "empty";
    }
  | {
      mode: "conversation";
      action: "clarify" | "search";
      /** `search()`'e verilecek sorgu; soru acikken de en olasi yorumdur. */
      queryObject: QueryObject;
      /** URL'de tutulmasi gereken adimlar. Istekteki adimlardan farkliysa yonlendir. */
      steps: string[];
      /** Gelen adimlar arasinda reddedilen varsa (bayat link), atildi. */
      droppedInvalidStep: boolean;
      question: QuestionView | null;
      understood: UnderstoodChip[];
      /**
       * Konusmanin gecerli sorgusu. Yanit baska bir urun ailesine gectiyse
       * ("kask" -> "ayakkabı lazım") yeni konusma o metinle baslar.
       */
      query: string;
      /** "daha ucuzlari": sayiya cevrilmez; siralama karari arayuzde. */
      prefersLowerPrice: boolean;
    };

export const SHOW_RESULTS_LABEL = "Sonuçları göster";

/**
 * Serbest metinle yazilan atlama ifadeleri. Motor bunlari henuz tanimiyor;
 * acik bir soru varken yazilirsa ilgili atlama girdisine cevrilir ki
 * kullanici "fark etmez" yazinca ayni soruya takilmasin. ASCII katli.
 */
const SKIP_REPLIES: ReadonlySet<string> = new Set([
  "fark etmez",
  "farketmez",
  "hepsi olur",
  "emin degilim",
  "bilmiyorum",
  "atla",
  "gec",
  "onemli degil",
  "farketmiyor",
  "fark etmiyor",
]);

const SHOW_RESULTS_REPLIES: ReadonlySet<string> = new Set([
  "sonuclari goster",
  "goster",
  "direkt goster",
  "hemen goster",
]);

function normalizeReply(text: string): string {
  return foldForTrigger(text)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Serbest yaniti motorun anladigi girdiye cevirir. */
export function replyToInput(
  reply: string,
  pendingQuestionId: string | null,
): ClarificationInput | null {
  const text = reply.trim().slice(0, MAX_FOLLOW_UP_TEXT_LENGTH);
  if (!text) return null;
  const normalized = normalizeReply(text);
  if (SHOW_RESULTS_REPLIES.has(normalized)) return { type: "show_results" };
  if (pendingQuestionId !== null && SKIP_REPLIES.has(normalized)) {
    return { type: "skip", questionId: pendingQuestionId };
  }
  return { type: "text", text };
}

function formatWholeTry(kurus: number): string {
  return `${Math.floor(kurus / 100).toLocaleString("tr-TR")} TL`;
}

/** Ek gerektirmeyen bicim: "En fazla 5.000 TL" ("5.000 TL'ye" eki sayiya gore degisir). */
export function budgetLabel(minKurus: number | null, maxKurus: number | null): string | null {
  if (minKurus !== null && maxKurus !== null) {
    return `${formatWholeTry(minKurus)} – ${formatWholeTry(maxKurus)}`;
  }
  if (maxKurus !== null) return `En fazla ${formatWholeTry(maxKurus)}`;
  if (minKurus !== null) return `En az ${formatWholeTry(minKurus)}`;
  return null;
}

function capitalizeTr(text: string): string {
  return text.charAt(0).toLocaleUpperCase("tr-TR") + text.slice(1);
}

function lexiconSurface(
  context: ExtractContext,
  kind: "color" | "brand",
  normalized: string,
): string | null {
  const entry = context.lexicon.find(
    (candidate) => candidate.kind === kind && candidate.normalized === normalized,
  );
  return entry ? entry.surface : null;
}

function understoodChips(
  state: SearchState,
  inputs: readonly ClarificationInput[],
  context: ExtractContext,
): UnderstoodChip[] {
  const domain = findDomain(context.registry, state.domainId);
  if (!domain) return [];
  const chips: UnderstoodChip[] = [];

  for (const facet of domain.facets) {
    const assignment = state.facets[facet.id];
    if (!assignment) continue;
    if (facet.appliesWhen) {
      const gate = state.facets[facet.appliesWhen.facetId];
      if (!gate || !facet.appliesWhen.optionIds.includes(gate.optionId)) continue;
    }
    const option = facet.options.find((candidate) => candidate.id === assignment.optionId);
    if (!option) continue;
    chips.push({
      key: `facet:${facet.id}`,
      label: option.label,
      removeSteps: appendInput(inputs, { type: "skip", questionId: facet.id }),
    });
  }

  if (state.budget) {
    const label = budgetLabel(state.budget.minKurus, state.budget.maxKurus);
    if (label && domain.budgetBands !== undefined) {
      chips.push({
        key: "budget",
        label,
        removeSteps: appendInput(inputs, { type: "skip", questionId: BUDGET_FACET_ID }),
      });
    } else if (label) {
      chips.push({ key: "budget", label, removeSteps: null });
    }
  }

  // Sozluk sinyalleri icin sozlesmede geri alma girdisi yok: yalnizca gosterilir.
  for (const color of state.lexical.color ?? []) {
    const surface = lexiconSurface(context, "color", color);
    if (surface)
      chips.push({ key: `color:${color}`, label: capitalizeTr(surface), removeSteps: null });
  }
  for (const brand of state.lexical.brand_include ?? []) {
    const surface = lexiconSurface(context, "brand", brand);
    if (surface)
      chips.push({ key: `brand:${brand}`, label: capitalizeTr(surface), removeSteps: null });
  }
  if (state.lexical.size_norm !== undefined) {
    chips.push({ key: "size", label: `Beden ${state.lexical.size_norm}`, removeSteps: null });
  }

  return chips;
}

/**
 * Istegi plana cevirir. Saf ve deterministiktir; hata firlatirsa cagiran
 * taraf `conventional` yola dusmelidir (netlestirme calismazsa arama calisir).
 */
export function planConversation(
  request: ConversationRequest,
  context: ExtractContext,
  compileOptions: CompileOptions = {},
): ConversationPlan {
  const query = request.query.trim();
  if (!query) return { mode: "conventional", query, reason: "empty" };

  const first: ClarificationInput = { type: "text", text: query };
  let inputs = decodeInputs(request.steps);
  let replayed = replayConversation([first, ...inputs], context);
  let droppedInvalidStep = false;

  if (replayed.rejectedInput !== null) {
    droppedInvalidStep = true;
    const rejectedAt = inputs.indexOf(replayed.rejectedInput);
    inputs = rejectedAt >= 0 ? inputs.slice(0, rejectedAt) : [];
  }

  let replyApplied = false;
  if (request.reply) {
    const next = replyToInput(request.reply, replayed.decision.state.pendingQuestionId);
    if (next !== null) {
      inputs = decodeInputs(appendInput(inputs, next));
      replayed = replayConversation([first, ...inputs], context);
      replyApplied = true;
    }
  }

  const { decision } = replayed;
  // Ilk sorgu kural sozlugune dusmediyse ve takip metni de bir domain
  // acmadiysa, konusma yok: mevcut arama yolu aynen kullanilir.
  if (decision.state.domainId === null) {
    // "kask" konusmasinda "masa lambası" yazildiysa aranan artik o metindir.
    const conventionalQuery =
      replyApplied && decision.state.rawQuery ? decision.state.rawQuery : query;
    return { mode: "conventional", query: conventionalQuery, reason: "no_domain" };
  }

  // Yanit yeni bir konusma baslattiysa URL o metinden, adimsiz devam eder.
  const restartedByReply = replyApplied && decision.state.rawQuery !== query;
  const steps = restartedByReply ? [] : inputs.map(encodeInput);
  const question: QuestionView | null =
    decision.action === "clarify"
      ? {
          id: decision.question.id,
          text: decision.question.text,
          options: decision.question.options.map((option) => ({
            id: option.id,
            label: option.label,
            selected: option.selected,
            steps: appendInput(inputs, {
              type: "answer",
              questionId: decision.question.id,
              optionId: option.id,
            }),
          })),
          skip: {
            label: decision.question.skipOption.label,
            steps: appendInput(inputs, { type: "skip", questionId: decision.question.id }),
          },
          showResults: {
            label: SHOW_RESULTS_LABEL,
            steps: appendInput(inputs, { type: "show_results" }),
          },
        }
      : null;

  return {
    mode: "conversation",
    action: decision.action,
    queryObject: compileQuery(decision.state, context.registry, compileOptions),
    steps,
    droppedInvalidStep,
    question,
    understood: understoodChips(decision.state, inputs, context),
    query: restartedByReply ? decision.state.rawQuery : query,
    prefersLowerPrice: decision.state.constraints.pricePreference === "lower",
  };
}
