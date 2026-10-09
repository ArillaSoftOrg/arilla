import { describe, expect, it } from "vitest";
import type { LlmClient, LlmJsonRequest } from "../llm/client.ts";
import { buildModelTurnSchema, parseModelTurn } from "./contract.ts";
import { buildChatInput, GeminiChatInterpreter, type InterpretRequest } from "./interpreter.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 };

const SEARCH = {
  action: "search",
  message: "Beyaz spor ayakkabıları açtım.",
  question: null,
  intent: { reset: false, clear: false, query: "beyaz spor ayakkabı", remove: [] },
};

describe("model şeması: image_summary yalnızca görselli turlarda", () => {
  it("metin turunun şeması değişmez", () => {
    const schema = buildModelTurnSchema() as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["action", "message", "question", "intent"]);
    expect(schema.properties).not.toHaveProperty("image_summary");
  });

  it("görselli tur şeması image_summary'yi zorunlu-nullable ekler", () => {
    const schema = buildModelTurnSchema({ imageSummary: true }) as {
      required: string[];
      properties: Record<string, { type: unknown }>;
    };
    expect(schema.required).toContain("image_summary");
    expect(schema.properties.image_summary?.type).toEqual(["string", "null"]);
    // Eylem alanından sonra gelir: model önce kararı üretir.
    expect(Object.keys(schema.properties).at(-1)).toBe("image_summary");
  });
});

describe("parseModelTurn: image_summary", () => {
  it("geçerli özeti turla birlikte döner", () => {
    const parsed = parseModelTurn({ ...SEARCH, image_summary: "  beyaz   deri spor ayakkabı " });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.turn.imageSummary).toBe("beyaz deri spor ayakkabı");
  });

  it("özet yoksa ya da null ise turda alan bulunmaz", () => {
    for (const raw of [SEARCH, { ...SEARCH, image_summary: null }]) {
      const parsed = parseModelTurn(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.turn).not.toHaveProperty("imageSummary");
    }
  });

  it("boş ya da sayısal özet turu reddetmez, yalnızca atılır", () => {
    for (const image_summary of ["   ", 7]) {
      const parsed = parseModelTurn({ ...SEARCH, image_summary });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.turn).not.toHaveProperty("imageSummary");
    }
  });

  it("bağlantı içeren çıktı (özet dahil) bütünüyle reddedilir", () => {
    expect(parseModelTurn({ ...SEARCH, image_summary: "bkz https://x.example" }).ok).toBe(false);
  });
});

describe("transcript: kayıtlı özet", () => {
  it("görsel eklenmeyen mesaj image_summary taşır, has_image taşımaz", () => {
    const request: InterpretRequest = {
      messages: [
        { role: "user", kind: "text", text: "", imageSummary: "beyaz spor ayakkabı" },
        { role: "assistant", kind: "search", text: "Açtım." },
        { role: "user", kind: "text", text: "siyah olsun" },
      ],
      currentIntent: null,
      pendingQuestion: null,
      clarifyCount: 0,
      input: { kind: "text", text: "siyah olsun" },
    };
    const json = JSON.parse(buildChatInput(request));
    expect(json.messages[0]).toMatchObject({ image_summary: "beyaz spor ayakkabı" });
    expect(json.messages[0]).not.toHaveProperty("has_image");
    expect(json.messages[2]).not.toHaveProperty("image_summary");
  });
});

describe("GeminiChatInterpreter: şema seçimi", () => {
  function capture() {
    const requests: LlmJsonRequest[] = [];
    const client = {
      modelVersion: "test-model",
      async generateJson(request: LlmJsonRequest) {
        requests.push(request);
        return { value: SEARCH, usage: USAGE, modelVersion: "test-model" };
      },
    } as unknown as LlmClient;
    return { requests, interpreter: new GeminiChatInterpreter(client) };
  }

  const base: InterpretRequest = {
    messages: [{ role: "user", kind: "text", text: "siyah ayakkabı" }],
    currentIntent: null,
    pendingQuestion: null,
    clarifyCount: 0,
    input: { kind: "text", text: "siyah ayakkabı" },
  };

  it("metin turu: eski şema, görsel yok", async () => {
    const { requests, interpreter } = capture();
    await interpreter.interpret(base);
    const schema = requests[0]?.schema as { required: string[] };
    expect(schema.required).not.toContain("image_summary");
    expect(requests[0]).not.toHaveProperty("images");
  });

  it("görselli tur: image_summary'li şema ve görsel", async () => {
    const { requests, interpreter } = capture();
    await interpreter.interpret({
      ...base,
      messages: [{ role: "user", kind: "text", text: "", hasImage: true }],
      image: { mimeType: "image/jpeg", dataBase64: "AAAA" },
    });
    const schema = requests[0]?.schema as { required: string[] };
    expect(schema.required).toContain("image_summary");
    expect(requests[0]?.images).toHaveLength(1);
  });

  it("özetle temsil edilen takip turu: görsel gönderilmez, eski şema", async () => {
    const { requests, interpreter } = capture();
    await interpreter.interpret({
      ...base,
      messages: [
        { role: "user", kind: "text", text: "", imageSummary: "beyaz spor ayakkabı" },
        { role: "user", kind: "text", text: "siyah olsun" },
      ],
    });
    const schema = requests[0]?.schema as { required: string[] };
    expect(schema.required).not.toContain("image_summary");
    expect(requests[0]).not.toHaveProperty("images");
  });
});
