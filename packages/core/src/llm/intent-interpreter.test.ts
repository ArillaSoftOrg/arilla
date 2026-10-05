import { describe, expect, it } from "vitest";
import {
  buildInterpreterJsonSchema,
  describeTaxonomy,
  INTERPRETER_INSTRUCTIONS,
  type InterpreterRequest,
} from "../clarification/interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { createInitialState } from "../clarification/state.ts";
import { type LlmClient, LlmError, type LlmJsonRequest, type LlmUsage } from "./client.ts";
import {
  buildInterpreterInput,
  interpretWithModel,
  LlmIntentInterpreter,
} from "./intent-interpreter.ts";

const registry = DEFAULT_CLARIFICATION_REGISTRY;
const USAGE: LlmUsage = { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, totalTokens: 125 };

function request(text: string): InterpreterRequest {
  return { text, state: createInitialState(), taxonomy: describeTaxonomy(registry) };
}

/** Verilen ciktiyi ya da hatayi donduren sahte istemci; istekleri kaydeder. */
function fakeClient(output: unknown | Error) {
  const requests: LlmJsonRequest[] = [];
  const client: LlmClient = {
    modelVersion: "fake-model",
    async generateJson(req) {
      requests.push(req);
      if (output instanceof Error) throw output;
      return { value: output, usage: USAGE, modelVersion: "fake-model" };
    },
  };
  return { client, requests };
}

function run(output: unknown | Error, text = "kask arıyorum 2000 tl altı") {
  const { client, requests } = fakeClient(output);
  const interpreter = new LlmIntentInterpreter(client, registry);
  return {
    outcome: interpretWithModel(interpreter, request(text), registry),
    requests,
    interpreter,
  };
}

const VALID = {
  domain_id: "helmet",
  facets: [{ facet_id: "helmet_type", option_id: "full_face" }],
  budget: { min_try: null, max_try: 2000 },
  price_preference: null,
};

describe("istek", () => {
  it("mevcut talimat, sema ve taksonomi aynen kullanilir", async () => {
    const { outcome, requests } = run(VALID);
    await outcome;
    const sent = requests[0];
    expect(sent?.systemInstruction).toBe(INTERPRETER_INSTRUCTIONS);
    expect(sent?.schema).toEqual(buildInterpreterJsonSchema(registry));
    expect(JSON.parse(sent?.input ?? "{}").taxonomy).toEqual(describeTaxonomy(registry));
  });

  it("girdi yalnizca sorgu, durumdaki kimlikler ve taksonomi", () => {
    const input = JSON.parse(buildInterpreterInput(request("kask")));
    expect(Object.keys(input).sort()).toEqual(["current", "query", "taxonomy"]);
    expect(input.query).toBe("kask");
    expect(input.current).toEqual({ domain_id: null, facets: [] });
    const serialized = JSON.stringify(input);
    for (const forbidden of ["user_id", "session_id", "userId", "sessionId", "ip"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("interpret sinir sozlesmesi ham ciktiyi dogrulamadan dondurur", async () => {
    const raw = { domain_id: "uydurma", extra: true };
    const { interpreter } = run(raw);
    await expect(interpreter.interpret(request("kask"))).resolves.toEqual(raw);
  });
});

describe("dogrulama", () => {
  it("gecerli cikti kabul edilir; butce kurusa cevrilir, kullanim korunur", async () => {
    const outcome = await run(VALID).outcome;
    expect(outcome).toEqual({
      status: "accepted",
      value: {
        domainId: "helmet",
        facets: [{ facetId: "helmet_type", optionId: "full_face" }],
        budget: { minKurus: null, maxKurus: 200_000 },
        pricePreference: null,
      },
      rejected: [],
      usage: USAGE,
      modelVersion: "fake-model",
    });
  });

  it("taksonomide olmayan domain, faset ve secenek reddedilir", async () => {
    const outcome = await run({
      domain_id: "uydurma_domain",
      facets: [
        { facet_id: "uydurma_faset", option_id: "x" },
        { facet_id: "helmet_type", option_id: "uydurma_secenek" },
      ],
      budget: null,
      price_preference: null,
    }).outcome;
    expect(outcome.status).toBe("invalid");
    if (outcome.status !== "invalid") return;
    // Domain reddedilince fasetler domainsiz kalir: bilinen faset alan disi sayilir.
    expect(outcome.rejected).toEqual([
      { path: "domain_id", reason: "unknown_domain" },
      { path: "facets[0]", reason: "unknown_facet" },
      { path: "facets[1]", reason: "facet_outside_domain" },
    ]);
    expect(outcome.usage).toEqual(USAGE);
  });

  it("gecerli domain icinde uydurulan secenek dusurulur, gecerli kisim kalir", async () => {
    const outcome = await run({
      domain_id: "helmet",
      facets: [
        { facet_id: "helmet_type", option_id: "uydurma_secenek" },
        { facet_id: "helmet_type", option_id: "open_face" },
      ],
      budget: null,
      price_preference: null,
    }).outcome;
    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") return;
    expect(outcome.value.facets).toEqual([{ facetId: "helmet_type", optionId: "open_face" }]);
    expect(outcome.rejected).toEqual([{ path: "facets[0]", reason: "unknown_option" }]);
  });

  it("metinde yazmayan butce reddedilir", async () => {
    const outcome = await run(
      {
        domain_id: null,
        facets: [],
        budget: { min_try: null, max_try: 5000 },
        price_preference: null,
      },
      "kask arıyorum 2000 tl altı",
    ).outcome;
    expect(outcome).toMatchObject({
      status: "invalid",
      rejected: [{ path: "budget", reason: "budget_not_in_text" }],
    });
  });

  it("uydurulan butce gecerli domaini bozmaz ama saklanmaz", async () => {
    const outcome = await run({ ...VALID, budget: { min_try: null, max_try: 9999 } }).outcome;
    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") return;
    expect(outcome.value.budget).toBeNull();
    expect(outcome.rejected).toEqual([{ path: "budget", reason: "budget_not_in_text" }]);
  });

  it.each([
    ["dizi", ["helmet"]],
    ["metin", "helmet"],
    ["null", null],
    ["sayi", 42],
  ])("nesne olmayan cikti (%s) gecersiz", async (_label, raw) => {
    const outcome = await run(raw).outcome;
    expect(outcome).toMatchObject({
      status: "invalid",
      rejected: [{ path: "$", reason: "not_an_object" }],
    });
  });

  it("eksik alanli cikti guvenle bos sayilir", async () => {
    const outcome = await run({}).outcome;
    expect(outcome).toEqual({ status: "empty", usage: USAGE, modelVersion: "fake-model" });
  });

  it("gecerli 'bulamadim' yaniti bos", async () => {
    const outcome = await run({ domain_id: null, facets: [], budget: null, price_preference: null })
      .outcome;
    expect(outcome.status).toBe("empty");
  });
});

describe("saglayici hatasi", () => {
  it.each(["timeout", "rate_limited", "server_error", "invalid_json", "missing_api_key"] as const)(
    "%s firlatilmaz, provider_error olur",
    async (code) => {
      const outcome = await run(new LlmError(code)).outcome;
      expect(outcome).toEqual({ status: "provider_error", code });
    },
  );

  it("beklenmeyen hata da firlatilmaz ve icerigi tasinmaz", async () => {
    const outcome = await run(new Error("body-secret")).outcome;
    expect(outcome).toEqual({ status: "provider_error", code: "unknown" });
    expect(JSON.stringify(outcome)).not.toContain("body-secret");
  });
});
