/**
 * Gelecekteki model tabanli niyet yorumlayicisinin siniri (docs/decisions/0030).
 * Bu dosya hicbir saglayiciya (OpenAI, Anthropic, Fal) baglanmaz ve hicbir
 * cagri yapmaz; yalnizca sozlesmeyi tanimlar.
 *
 * Model YORUMCUDUR, urun kaynagi degildir:
 *
 * - Yalnizca kural sozlugundeki domain/faset/secenek kimliklerini secebilir.
 * - Urun, fiyat, stok, marka uretemez - cikti semasinda bu alanlar yoktur.
 * - Butce yalnizca kullanicinin yazdigi sayidan gelebilir; metinde olmayan
 *   bir sayi reddedilir.
 * - Ciktisi `model` onceligiyle yazilir: acik kullanici beyanini asla ezemez.
 *
 * CLAUDE.md kural 1 (istek yolunda model cagrisi yok) gecerlidir. Bir
 * uygulama baglanmadan once docs/decisions/0030 "Model baglama kosullari"
 * bolumu karsilanmalidir.
 */
import { outranks } from "./state.ts";
import {
  BUDGET_FACET_ID,
  type ClarificationRegistry,
  type FacetAssignment,
  type SearchState,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Modele giden baglam
// ---------------------------------------------------------------------------

export interface InterpreterTaxonomy {
  domains: readonly {
    id: string;
    kind: "product" | "intent";
    facets: readonly {
      id: string;
      question: string;
      options: readonly { id: string; label: string }[];
    }[];
    supportsBudget: boolean;
  }[];
  /** Aramanin gercekten uygulayabildigi kanallar; model bunlarin disina cikamaz. */
  capabilities: {
    filters: readonly ["category_path", "color", "price_min", "price_max", "size_norm", "brand"];
    currency: "TRY";
  };
}

export interface InterpreterRequest {
  /** Kullanicinin bu turdaki ham metni. */
  text: string;
  /** Birikmis yapilandirilmis durum; model sifirdan yorumlamaz. */
  state: SearchState;
  taxonomy: InterpreterTaxonomy;
}

/**
 * Saglayici-bagimsiz arayuz. Donus `unknown`dur: saglayici ne dondururse
 * dondursun `validateInterpretation`'dan gecmeden duruma yazilmaz.
 */
export interface IntentInterpreter {
  interpret(request: InterpreterRequest): Promise<unknown>;
}

export function describeTaxonomy(registry: ClarificationRegistry): InterpreterTaxonomy {
  return {
    domains: registry.domains.map((domain) => ({
      id: domain.id,
      kind: domain.kind,
      facets: domain.facets.map((facet) => ({
        id: facet.id,
        question: facet.question,
        options: facet.options.map((option) => ({ id: option.id, label: option.label })),
      })),
      supportsBudget: (domain.budgetBands?.length ?? 0) > 0,
    })),
    capabilities: {
      filters: ["category_path", "color", "price_min", "price_max", "size_norm", "brand"],
      currency: "TRY",
    },
  };
}

// ---------------------------------------------------------------------------
// Katı yapilandirilmis cikti semasi (OpenAI structured outputs `strict: true`
// ile uyumlu: her nesnede additionalProperties false, tum alanlar required,
// bos deger null ile).
// ---------------------------------------------------------------------------

export function buildInterpreterJsonSchema(
  registry: ClarificationRegistry,
): Record<string, unknown> {
  const facetVariants = registry.domains.flatMap((domain) =>
    domain.facets.map((facet) => ({
      type: "object",
      additionalProperties: false,
      required: ["facet_id", "option_id"],
      properties: {
        facet_id: { type: "string", enum: [facet.id] },
        option_id: { type: "string", enum: facet.options.map((option) => option.id) },
      },
    })),
  );

  return {
    type: "object",
    additionalProperties: false,
    required: ["domain_id", "facets", "budget", "price_preference"],
    properties: {
      domain_id: {
        type: ["string", "null"],
        enum: [...registry.domains.map((domain) => domain.id), null],
      },
      facets: { type: "array", items: { anyOf: facetVariants } },
      budget: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["min_try", "max_try"],
        properties: {
          min_try: { type: ["integer", "null"] },
          max_try: { type: ["integer", "null"] },
        },
      },
      price_preference: { type: ["string", "null"], enum: ["lower", null] },
    },
  };
}

export const INTERPRETER_INSTRUCTIONS = [
  "Türkçe alışveriş sorgusunu yalnızca verilen taksonomiye göre yorumla.",
  "Sadece verilen domain_id, facet_id ve option_id değerlerini kullan; yeni değer üretme.",
  "Emin olmadığın alanı null bırak ya da facets listesine ekleme.",
  "Ürün, marka, fiyat, stok veya mağaza bilgisi üretme; bunlar katalogdan gelir.",
  "Bütçeyi yalnızca kullanıcı metninde açıkça yazan sayılardan TL cinsinden çıkar.",
  "Mevcut durumdaki değerleri tekrar etme; yalnızca bu turdaki metinden çıkanı döndür.",
].join("\n");

// ---------------------------------------------------------------------------
// Dogrulama: modelin ciktisi ASLA dogrudan duruma yazilmaz.
// ---------------------------------------------------------------------------

export interface ValidatedInterpretation {
  domainId: string | null;
  facets: readonly { facetId: string; optionId: string }[];
  budget: { minKurus: number | null; maxKurus: number | null } | null;
  pricePreference: "lower" | null;
}

export interface InterpretationRejection {
  path: string;
  reason:
    | "not_an_object"
    | "unknown_domain"
    | "unknown_facet"
    | "unknown_option"
    | "facet_outside_domain"
    | "budget_not_in_text"
    | "invalid_value";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numbersInText(text: string): Set<number> {
  const found = new Set<number>();
  for (const m of text.matchAll(/\d[\d.]*/g)) {
    const value = Number.parseInt(m[0].replace(/\./g, ""), 10);
    if (Number.isFinite(value)) found.add(value);
  }
  return found;
}

export function validateInterpretation(
  raw: unknown,
  request: Pick<InterpreterRequest, "text" | "state">,
  registry: ClarificationRegistry,
): { value: ValidatedInterpretation; rejected: InterpretationRejection[] } {
  const rejected: InterpretationRejection[] = [];
  const value: ValidatedInterpretation = {
    domainId: null,
    facets: [],
    budget: null,
    pricePreference: null,
  };
  if (!isRecord(raw)) {
    return { value, rejected: [{ path: "$", reason: "not_an_object" }] };
  }

  let domainId: string | null = null;
  if (raw.domain_id !== null && raw.domain_id !== undefined) {
    if (typeof raw.domain_id === "string" && registry.domains.some((d) => d.id === raw.domain_id)) {
      domainId = raw.domain_id;
    } else {
      rejected.push({ path: "domain_id", reason: "unknown_domain" });
    }
  }

  // Fasetler, gecerli olacak domain'e gore dogrulanir: mevcut acik domain
  // modelin onerisinden oncelikli.
  const effectiveDomainId = request.state.domainId ?? domainId;
  const domain = registry.domains.find((d) => d.id === effectiveDomainId);
  const facets: { facetId: string; optionId: string }[] = [];
  const rawFacets = Array.isArray(raw.facets) ? raw.facets : [];
  rawFacets.forEach((entry, i) => {
    const path = `facets[${i}]`;
    if (
      !isRecord(entry) ||
      typeof entry.facet_id !== "string" ||
      typeof entry.option_id !== "string"
    ) {
      rejected.push({ path, reason: "invalid_value" });
      return;
    }
    const knownAnywhere = registry.domains.some((d) =>
      d.facets.some((f) => f.id === entry.facet_id),
    );
    const facet = domain?.facets.find((f) => f.id === entry.facet_id);
    if (!facet) {
      rejected.push({ path, reason: knownAnywhere ? "facet_outside_domain" : "unknown_facet" });
      return;
    }
    if (!facet.options.some((option) => option.id === entry.option_id)) {
      rejected.push({ path, reason: "unknown_option" });
      return;
    }
    facets.push({ facetId: facet.id, optionId: entry.option_id });
  });

  let budget: ValidatedInterpretation["budget"] = null;
  if (isRecord(raw.budget)) {
    const allowed = numbersInText(request.text);
    const readAmount = (field: "min_try" | "max_try"): number | null | "invalid" => {
      const amount = raw.budget && isRecord(raw.budget) ? raw.budget[field] : null;
      if (amount === null || amount === undefined) return null;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return "invalid";
      return allowed.has(amount) ? amount : "invalid";
    };
    const min = readAmount("min_try");
    const max = readAmount("max_try");
    if (min === "invalid" || max === "invalid") {
      rejected.push({ path: "budget", reason: "budget_not_in_text" });
    } else if (min !== null || max !== null) {
      budget = {
        minKurus: min === null ? null : min * 100,
        maxKurus: max === null ? null : max * 100,
      };
    }
  }

  const pricePreference = raw.price_preference === "lower" ? "lower" : null;
  if (
    raw.price_preference !== undefined &&
    raw.price_preference !== null &&
    pricePreference === null
  ) {
    rejected.push({ path: "price_preference", reason: "invalid_value" });
  }

  return {
    value: { domainId, facets, budget, pricePreference },
    rejected,
  };
}

/**
 * Dogrulanmis yorumu `model` onceligiyle duruma yazar. Acik kullanici beyani
 * ve turetilmis degerler korunur; domain yalnizca henuz yoksa atanir.
 */
export function applyInterpretation(
  state: SearchState,
  interpretation: ValidatedInterpretation,
): SearchState {
  const turn = state.turn;
  let next: SearchState = state;

  if (next.domainId === null && interpretation.domainId !== null) {
    next = {
      ...next,
      domainId: interpretation.domainId,
      domainSource: "model",
      intent: interpretation.domainId === "gift" ? "gift" : "product",
    };
  }

  let facets: Record<string, FacetAssignment> = { ...next.facets };
  for (const { facetId, optionId } of interpretation.facets) {
    const incoming: FacetAssignment = { optionId, source: "model", turn };
    if (next.skippedFacets.includes(facetId)) continue;
    if (outranks(incoming, facets[facetId])) facets = { ...facets, [facetId]: incoming };
  }
  next = { ...next, facets };

  if (interpretation.budget && !next.skippedFacets.includes(BUDGET_FACET_ID)) {
    const incoming = { ...interpretation.budget, source: "model" as const, turn };
    if (outranks(incoming, next.budget)) next = { ...next, budget: incoming };
  }

  if (next.constraints.pricePreference === null && interpretation.pricePreference !== null) {
    next = { ...next, constraints: { pricePreference: interpretation.pricePreference } };
  }
  return next;
}
