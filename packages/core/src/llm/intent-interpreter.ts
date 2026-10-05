/**
 * `IntentInterpreter` (docs/decisions/0030) icin model uyarlayicisi
 * (docs/decisions/0059). YALNIZCA cevrimdisi toplu is kullanir; `/ara`
 * istek yolu bunu cagirmaz, saklanmis dogrulanmis yorumu okur.
 *
 * Sema, talimatlar ve dogrulama netlestirme katmanindan aynen alinir:
 * burada yeni kural yazilmaz. Model ciktisi `unknown`dir ve
 * `validateInterpretation`'dan gecmeden kabul edilmez.
 *
 * Modele giden baglam yalnizca sorgu metni, taksonomi ve mevcut durumdaki
 * domain/faset kimlikleridir; kullanici, oturum ya da etkinlik verisi yoktur.
 */
import {
  buildInterpreterJsonSchema,
  INTERPRETER_INSTRUCTIONS,
  type IntentInterpreter,
  type InterpretationRejection,
  type InterpreterRequest,
  type ValidatedInterpretation,
  validateInterpretation,
} from "../clarification/interpreter.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import {
  type LlmClient,
  LlmError,
  type LlmErrorCode,
  type LlmJsonResult,
  type LlmUsage,
} from "./client.ts";

/** Yorum ciktisi kucuk bir nesnedir; dusunme payi dahil yeterli ust sinir. */
const INTERPRETER_MAX_OUTPUT_TOKENS = 512;

/** Modele giden tek girdi metni: sorgu, durumdaki kimlikler, taksonomi. */
export function buildInterpreterInput(request: InterpreterRequest): string {
  return JSON.stringify({
    query: request.text,
    current: {
      domain_id: request.state.domainId,
      facets: Object.entries(request.state.facets).map(([facetId, assignment]) => ({
        facet_id: facetId,
        option_id: assignment.optionId,
      })),
    },
    taxonomy: request.taxonomy,
  });
}

export class LlmIntentInterpreter implements IntentInterpreter {
  private readonly schema: Record<string, unknown>;

  constructor(
    private readonly client: LlmClient,
    registry: ClarificationRegistry,
  ) {
    this.schema = buildInterpreterJsonSchema(registry);
  }

  get modelVersion(): string {
    return this.client.modelVersion;
  }

  /** Sinir sozlesmesi: ham cikti, dogrulanmamis. */
  async interpret(request: InterpreterRequest): Promise<unknown> {
    return (await this.interpretWithUsage(request)).value;
  }

  /** Ham cikti + kullanim; toplu is `api_usage` kaydi icin bunu kullanir. */
  interpretWithUsage(request: InterpreterRequest): Promise<LlmJsonResult> {
    return this.client.generateJson({
      systemInstruction: INTERPRETER_INSTRUCTIONS,
      input: buildInterpreterInput(request),
      schema: this.schema,
      maxOutputTokens: INTERPRETER_MAX_OUTPUT_TOKENS,
    });
  }
}

export type ModelInterpretationOutcome =
  /** Dogrulamadan gecen en az bir alan var; reddedilen alanlar ayrica listelenir. */
  | {
      status: "accepted";
      value: ValidatedInterpretation;
      rejected: InterpretationRejection[];
      usage: LlmUsage;
      modelVersion: string;
    }
  /** Model gecerli bicimde "bir sey bulamadim" dedi. */
  | { status: "empty"; usage: LlmUsage; modelVersion: string }
  /** Cikti nesne degil ya da her alani reddedildi; hicbir sey saklanmaz. */
  | {
      status: "invalid";
      rejected: InterpretationRejection[];
      usage: LlmUsage;
      modelVersion: string;
    }
  /** Saglayici cagrisi basarisiz; arama bundan etkilenmez. */
  | { status: "provider_error"; code: LlmErrorCode | "unknown" };

function isEmpty(value: ValidatedInterpretation): boolean {
  return (
    value.domainId === null &&
    value.facets.length === 0 &&
    value.budget === null &&
    value.pricePreference === null
  );
}

/**
 * Yorumla ve dogrula. Asla firlatmaz: saglayici hatasi `provider_error`,
 * gecersiz cikti `invalid` olur ve cagiran hicbir sey saklamaz.
 */
export async function interpretWithModel(
  interpreter: LlmIntentInterpreter,
  request: InterpreterRequest,
  registry: ClarificationRegistry,
): Promise<ModelInterpretationOutcome> {
  let result: LlmJsonResult;
  try {
    result = await interpreter.interpretWithUsage(request);
  } catch (error) {
    return { status: "provider_error", code: error instanceof LlmError ? error.code : "unknown" };
  }

  const { usage, modelVersion } = result;
  const { value, rejected } = validateInterpretation(result.value, request, registry);
  if (!isEmpty(value)) return { status: "accepted", value, rejected, usage, modelVersion };
  if (rejected.length > 0) return { status: "invalid", rejected, usage, modelVersion };
  return { status: "empty", usage, modelVersion };
}
