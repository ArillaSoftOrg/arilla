import { describe, expect, it } from "vitest";
import type { LlmCall, LlmJsonResult } from "../llm/client.ts";
import { buildGeminiInput } from "../llm/gemini.ts";
import { parseClarifyQuestion } from "./contract.ts";
import {
  buildChatInput,
  type ChatInterpreter,
  fallbackTurn,
  IMAGE_CLARIFY_TURN,
  type InterpretRequest,
  interpretTurn,
} from "./interpreter.ts";

const USAGE = { inputTokens: 10, outputTokens: 5, thoughtTokens: 0, totalTokens: 15 };
const IMAGE = { mimeType: "image/jpeg" as const, dataBase64: "AAAA" };

function imageRequest(overrides: Partial<InterpretRequest> = {}): InterpretRequest {
  return {
    messages: [{ role: "user", kind: "text", text: "", hasImage: true }],
    currentIntent: null,
    pendingQuestion: null,
    clarifyCount: 0,
    input: { kind: "text", text: "" },
    image: IMAGE,
    ...overrides,
  };
}

function recording(value: unknown): ChatInterpreter & { requests: InterpretRequest[] } {
  const requests: InterpretRequest[] = [];
  return {
    modelVersion: "test-model",
    requests,
    async interpret(request, options) {
      requests.push(request);
      const call: LlmCall = { modelVersion: "test-model", httpStatus: 200, usage: USAGE };
      options?.onCall?.(call);
      const result: LlmJsonResult = { value, usage: USAGE, modelVersion: "test-model" };
      return result;
    },
  };
}

const SEARCH = {
  action: "search",
  message: "Siyah oversize bir hoodie görüyorum, benzerlerini açtım.",
  question: null,
  intent: { reset: false, query: "siyah oversize hoodie", remove: [] },
};
const CLARIFY = {
  action: "clarify",
  message: "Fotoğraftaki ürünü net seçemedim. Ne tür bir ürün arıyorsun?",
  question: {
    id: "kind",
    title: "Ne tür bir ürün?",
    options: [
      { label: "Ayakkabı", description: null, value: "shoes" },
      { label: "Giyim", description: null, value: "clothing" },
    ],
  },
  intent: null,
};

describe("sohbet görsel eki: model girdisi", () => {
  it("görselli mesaj has_image ile işaretlenir; görsel baytı metin bağlamına girmez", () => {
    const json = JSON.parse(buildChatInput(imageRequest()));
    expect(json.messages[0]).toMatchObject({ role: "user", has_image: true, text: "" });
    expect(JSON.stringify(json)).not.toContain(IMAGE.dataBase64);
  });

  it("görselsiz mesajda has_image alanı yoktur (metin akışı değişmez)", () => {
    const json = JSON.parse(
      buildChatInput({
        messages: [{ role: "user", kind: "text", text: "siyah ayakkabı" }],
        currentIntent: null,
        pendingQuestion: null,
        clarifyCount: 0,
        input: { kind: "text", text: "siyah ayakkabı" },
      }),
    );
    expect(json.messages[0]).not.toHaveProperty("has_image");
  });

  it("Gemini girdisi: görsel yoksa düz metin, varsa [text, image] dizisi", () => {
    const base = { systemInstruction: "s", input: "{}", schema: {} };
    expect(buildGeminiInput(base)).toBe("{}");
    expect(buildGeminiInput({ ...base, images: [] })).toBe("{}");
    expect(buildGeminiInput({ ...base, images: [IMAGE] })).toEqual([
      { type: "text", text: "{}" },
      { type: "image", data: "AAAA", mime_type: "image/jpeg" },
    ]);
  });
});

describe("sohbet görsel eki: tur", () => {
  it("yalnız görsel: model görseli alır ve arama niyeti döner", async () => {
    const interpreter = recording(SEARCH);
    const outcome = await interpretTurn(interpreter, imageRequest());
    expect(interpreter.requests).toHaveLength(1);
    expect(interpreter.requests[0]?.image).toEqual(IMAGE);
    expect(outcome.kind === "turn" && outcome.source).toBe("model");
    expect(outcome.kind === "turn" && outcome.turn.action).toBe("search");
  });

  it("görsel + metin: görsel ve metin AYNI istekte gider (tek model çağrısı)", async () => {
    const interpreter = recording(SEARCH);
    await interpretTurn(
      interpreter,
      imageRequest({
        messages: [{ role: "user", kind: "text", text: "Bunun siyahını bul", hasImage: true }],
        input: { kind: "text", text: "Bunun siyahını bul" },
      }),
    );
    expect(interpreter.requests).toHaveLength(1);
    expect(interpreter.requests[0]?.image).toEqual(IMAGE);
    expect(interpreter.requests[0]?.input).toEqual({ kind: "text", text: "Bunun siyahını bul" });
  });

  it("model görseli anlayamayıp soru sorarsa sohbet sürer (clarify)", async () => {
    const outcome = await interpretTurn(recording(CLARIFY), imageRequest());
    expect(outcome.kind === "turn" && outcome.turn.action).toBe("clarify");
  });

  it("sonraki mesaj önceki görsel bağlamını korur: görsel yeniden eklenir", async () => {
    const interpreter = recording(SEARCH);
    await interpretTurn(
      interpreter,
      imageRequest({
        messages: [
          { role: "user", kind: "text", text: "", hasImage: true },
          { role: "assistant", kind: "clarify", text: "Ne tür bir ürün?" },
          { role: "user", kind: "text", text: "siyah oversize modeller olur" },
        ],
        clarifyCount: 1,
        input: { kind: "text", text: "siyah oversize modeller olur" },
      }),
    );
    expect(interpreter.requests[0]?.image).toEqual(IMAGE);
    expect(interpreter.requests[0]?.messages[0]?.hasImage).toBe(true);
  });

  it("görselin kendi mesajı model süzgecine takılırsa görsel modele GİTMEZ", async () => {
    const interpreter = recording(SEARCH);
    await interpretTurn(
      interpreter,
      imageRequest({
        messages: [
          {
            role: "user",
            kind: "text",
            text: "kredi kartı numaram 4111 1111 1111 1111",
            hasImage: true,
          },
          { role: "assistant", kind: "clarify", text: "?" },
          { role: "user", kind: "text", text: "siyah ayakkabı" },
        ],
        input: { kind: "text", text: "siyah ayakkabı" },
      }),
    );
    for (const request of interpreter.requests) expect(request.image ?? null).toBeNull();
  });

  it("model hatası / bozuk çıktı + yalnız görsel: ölü uç yok, deterministik soru", async () => {
    const outcome = await interpretTurn(recording({ action: "nope" }), imageRequest());
    expect(outcome.kind).toBe("turn");
    if (outcome.kind !== "turn") return;
    expect(outcome.source).toBe("fallback");
    expect(outcome.turn.action).toBe("clarify");
  });

  it("model arama döner ama sorgu kuramazsa (yalnız görsel) soruya düşer", async () => {
    const outcome = await interpretTurn(
      recording({ ...SEARCH, intent: { reset: false, query: null, remove: [] } }),
      imageRequest(),
    );
    expect(outcome.kind === "turn" && outcome.turn.action).toBe("clarify");
  });

  it("günlük tavan dolu + yalnız görsel: model çağrılmaz, soru sorulur", async () => {
    const interpreter = recording(SEARCH);
    const outcome = await interpretTurn(interpreter, imageRequest(), { modelAllowed: false });
    expect(interpreter.requests).toHaveLength(0);
    expect(outcome.kind === "turn" && outcome.turn.action).toBe("clarify");
  });

  it("deterministik soru doğrulayıcıdan geçer; seçenek cevabı aramaya dönüşür", () => {
    expect(IMAGE_CLARIFY_TURN.action).toBe("clarify");
    if (IMAGE_CLARIFY_TURN.action === "clarify") {
      expect(parseClarifyQuestion(IMAGE_CLARIFY_TURN.question)).not.toBeNull();
    }
    const turn = fallbackTurn({
      messages: [
        { role: "user", kind: "text", text: "", hasImage: true },
        { role: "assistant", kind: "clarify", text: "?" },
        { role: "user", kind: "option", text: "Ayakkabı" },
      ],
      currentIntent: null,
      pendingQuestion: { id: "image_product_type", title: "t" },
      clarifyCount: 1,
      input: {
        kind: "option",
        questionId: "image_product_type",
        value: "shoes",
        label: "Ayakkabı",
      },
    });
    expect(turn.action).toBe("search");
    expect(turn.action === "search" && turn.intent.query).toBe("Ayakkabı");
  });

  it("metinli mesajda fallback değişmedi: metinle arar", () => {
    const turn = fallbackTurn({
      messages: [{ role: "user", kind: "text", text: "siyah hoodie" }],
      currentIntent: null,
      pendingQuestion: null,
      clarifyCount: 0,
      input: { kind: "text", text: "siyah hoodie" },
    });
    expect(turn.action === "search" && turn.intent.query).toBe("siyah hoodie");
  });
});
