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
  type LlmCall,
  type LlmCallOptions,
  type LlmClient,
  LlmError,
  type LlmErrorCode,
  type LlmJsonResult,
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

  /**
   * Ham cikti + kullanim. `options.onCall` her HTTP denemesi icin bir kez
   * cagrilir; toplu is `api_usage` satirlarini bundan yazar.
   */
  interpretWithUsage(
    request: InterpreterRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmJsonResult> {
    return this.client.generateJson(
      {
        systemInstruction: INTERPRETER_INSTRUCTIONS,
        input: buildInterpreterInput(request),
        schema: this.schema,
        maxOutputTokens: INTERPRETER_MAX_OUTPUT_TOKENS,
      },
      options,
    );
  }
}

/**
 * Saglayici yanit verdi (HTTP 200) ama cikti kullanilamaz: kesik, JSON degil
 * ya da bicimsiz. Bu bir MODEL ciktisi hatasidir, gecici degil: `invalid`
 * olarak saklanir ki ayni surumde tekrar odenmesin.
 */
const OUTPUT_ERROR_CODES = new Set<LlmErrorCode>([
  "incomplete",
  "invalid_json",
  "malformed_response",
]);

/** Dogrulama kodlarina ek olarak cikti hatasi kodlari; hepsi sabit, icerik yok. */
export type ModelRejection =
  | InterpretationRejection
  | { path: "$"; reason: "incomplete" | "invalid_json" | "malformed_response" };

export type ModelInterpretationOutcome =
  /** Dogrulamadan gecen en az bir alan var; reddedilen alanlar ayrica listelenir. */
  | {
      status: "accepted";
      value: ValidatedInterpretation;
      rejected: ModelRejection[];
      calls: LlmCall[];
      modelVersion: string;
    }
  /** Model gecerli bicimde "bir sey bulamadim" dedi. */
  | { status: "empty"; rejected: []; calls: LlmCall[]; modelVersion: string }
  /** Cikti kullanilamaz ya da her alani reddedildi; yorum saklanmaz, durum saklanir. */
  | {
      status: "invalid";
      rejected: ModelRejection[];
      calls: LlmCall[];
      modelVersion: string;
      /** Saglayici durum degeri (or. `MAX_TOKENS`); yalnizca cikti-hatasi yolunda. Hata kaydi icindir. */
      errorDetail?: string | null;
    }
  /** Gecici/yapilandirma hatasi; hicbir sey saklanmaz, sonraki kosu yeniden dener. */
  | {
      status: "provider_error";
      code: LlmErrorCode | "unknown";
      calls: LlmCall[];
      modelVersion: string;
      /** Saglayici durum degeri; hata kaydi icindir, serbest metin degil. */
      errorDetail?: string | null;
    };

/** Yalnizca doluysa eklenir: mevcut sonuc bicimi (ve testleri) degismez. */
function detailOf(error: unknown): { errorDetail?: string } {
  return error instanceof LlmError && error.detail ? { errorDetail: error.detail } : {};
}

function isEmpty(value: ValidatedInterpretation): boolean {
  return (
    value.domainId === null &&
    value.facets.length === 0 &&
    value.budget === null &&
    value.pricePreference === null
  );
}

/**
 * Yorumla ve dogrula. Asla firlatmaz. Her sonuc, yapilan HTTP denemelerinin
 * muhasebe kayitlarini (`calls`) tasir - gecersiz cikti ve saglayici hatasi dahil.
 */
export async function interpretWithModel(
  interpreter: LlmIntentInterpreter,
  request: InterpreterRequest,
  registry: ClarificationRegistry,
): Promise<ModelInterpretationOutcome> {
  const calls: LlmCall[] = [];
  const modelVersion = interpreter.modelVersion;
  let result: LlmJsonResult;
  try {
    result = await interpreter.interpretWithUsage(request, { onCall: (call) => calls.push(call) });
  } catch (error) {
    const code = error instanceof LlmError ? error.code : "unknown";
    if (code !== "unknown" && OUTPUT_ERROR_CODES.has(code)) {
      return {
        status: "invalid",
        rejected: [
          { path: "$", reason: code as "incomplete" | "invalid_json" | "malformed_response" },
        ],
        calls,
        modelVersion,
        ...detailOf(error),
      };
    }
    return {
      status: "provider_error",
      code,
      calls,
      modelVersion,
      ...detailOf(error),
    };
  }

  const { value, rejected } = validateInterpretation(result.value, request, registry);
  if (!isEmpty(value)) {
    return { status: "accepted", value, rejected, calls, modelVersion: result.modelVersion };
  }
  if (rejected.length > 0) {
    return { status: "invalid", rejected, calls, modelVersion: result.modelVersion };
  }
  return { status: "empty", rejected: [], calls, modelVersion: result.modelVersion };
}
