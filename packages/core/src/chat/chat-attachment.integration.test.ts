/**
 * Karar 0079 — gorsel normal mesajin ekidir — gercek yerel Postgres, model sahte.
 * Sohbet ici gorsel ayni konusmaya eklenir; ozet baglami; en son gorsel esas alinir;
 * konusma basina gorsel siniri; kota ve cift gonderim.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { CHAT_ATTACHMENTS_PER_CONVERSATION } from "./image-context.ts";
import type { ChatInterpreter, InterpretRequest } from "./interpreter.ts";
import {
  type ChatAttachmentInput,
  createConversation,
  IMAGE_ONLY_CONTENT,
  loadConversation,
  processPendingTurn,
  submitUserMessage,
} from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `ca${Date.now().toString(36)}`;
let db: Database;
let userA = 0;
let userB = 0;

const USAGE = { inputTokens: 20, outputTokens: 8, thoughtTokens: 0, totalTokens: 28 };
const BYTES_1 = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const BYTES_2 = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd900", "hex");
const attachment = (bytes: Buffer): ChatAttachmentInput => ({
  bytes,
  mimeType: "image/jpeg",
  width: 64,
  height: 48,
});

function recording(values: unknown[]): ChatInterpreter & { requests: InterpretRequest[] } {
  const queue = [...values];
  const requests: InterpretRequest[] = [];
  return {
    modelVersion: "test-model",
    requests,
    async interpret(request, opts) {
      requests.push(request);
      opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
      return { value: queue.shift(), usage: USAGE, modelVersion: "test-model" };
    },
  };
}

const search = (query: string, imageSummary?: string) => ({
  action: "search",
  message: "Benzerlerini aşağıda açtım.",
  question: null,
  intent: { reset: false, clear: false, remove: [], query },
  ...(imageSummary !== undefined ? { image_summary: imageSummary } : {}),
});

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const a = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `att-a-${run}@test.invalid`,
    ]);
    const b = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `att-b-${run}@test.invalid`,
    ]);
    userA = Number(a.rows[0].id);
    userB = Number(b.rows[0].id);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.CHAT_TURNS_PER_HOUR = "200";
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM api_usage WHERE user_id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userA, userB]]);
  });
});

async function textConversation(text = "siyah ayakkabı"): Promise<string> {
  const created = await createConversation(db, { userId: userA, message: text });
  if (created.status !== "created") throw new Error(`create failed: ${created.status}`);
  return created.conversationId;
}

/** Bekleyen kullanici mesajini yanitlatir (sonraki mesaj `busy` olmasin). */
async function answer(id: string, model: ChatInterpreter) {
  const result = await processPendingTurn(db, {
    userId: userA,
    conversationId: id,
    interpreter: model,
  });
  if (result.status !== "answered") throw new Error(`turn failed: ${result.status}`);
}

async function attachmentCount(id: string): Promise<number> {
  const rows = await withOwnerClient((client) =>
    client.query("SELECT count(*)::int AS n FROM chat_attachment WHERE conversation_id = $1", [id]),
  );
  return rows.rows[0].n;
}

describe("sohbet içinden gönderilen görsel mevcut konuşmaya eklenir", () => {
  it("metin + görsel: AYNI konuşmada TEK kullanıcı mesajı, ek mesaja bağlı", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));

    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "buna benzer beyaz olsun" },
      attachment: attachment(BYTES_1),
      requestKey: `key-${run}-textimg-1`,
    });
    expect(sent).toMatchObject({ status: "queued", seq: 3 });

    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages).toHaveLength(3);
    const last = view?.messages.at(-1);
    expect(last).toMatchObject({ role: "user", content: "buna benzer beyaz olsun" });
    expect(last?.role === "user" && last.attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(view?.awaitingReply).toBe(true);
    expect(await attachmentCount(id)).toBe(1);
  });

  it("yalnız görsel: metin boş görünür, konuşma sürer", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "   " },
      attachment: attachment(BYTES_1),
    });
    expect(sent.status).toBe("queued");
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    const last = view?.messages.at(-1);
    expect(last).toMatchObject({ role: "user", content: "" });
    expect(last?.role === "user" && last.attachmentId).not.toBeNull();
    // Yer tutucu yalnız saklamada; sunumda boş.
    expect(IMAGE_ONLY_CONTENT).toBe("(görsel)");
  });

  it("görsel olmadan boş metin hâlâ reddedilir (metin akışı değişmedi)", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "  " },
    });
    expect(sent).toEqual({ status: "invalid_input" });
  });

  it("seçenek/atla isteği ek taşıyamaz; hiçbir şey yazılmaz", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "option", questionId: "x", value: "y" },
      attachment: attachment(BYTES_1),
    });
    expect(sent).toEqual({ status: "invalid_input" });
    expect(await attachmentCount(id)).toBe(0);
  });

  it("geçersiz ek (boş / 512 KB üstü) reddedilir ve hiçbir şey yazılmaz", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(512 * 1024 + 1)]) {
      const sent = await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "text", text: "x" },
        attachment: attachment(bytes),
      });
      expect(sent).toEqual({ status: "invalid_input" });
    }
    expect(await attachmentCount(id)).toBe(0);
  });

  it("başkasının konuşmasına ek eklenemez", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    const sent = await submitUserMessage(db, {
      userId: userB,
      conversationId: id,
      request: { kind: "text", text: "x" },
      attachment: attachment(BYTES_1),
    });
    expect(sent).toEqual({ status: "not_found" });
    expect(await attachmentCount(id)).toBe(0);
  });

  it("aynı requestKey ikinci ek/mesaj üretmez (duplicate)", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    const input = {
      userId: userA,
      conversationId: id,
      request: { kind: "text" as const, text: "bu" },
      attachment: attachment(BYTES_1),
      requestKey: `key-${run}-dup-img-1`,
    };
    expect((await submitUserMessage(db, input)).status).toBe("queued");
    expect((await submitUserMessage(db, input)).status).toBe("duplicate");
    expect(await attachmentCount(id)).toBe(1);
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages).toHaveLength(3);
  });

  it("cevap beklenirken ikinci görselli mesaj busy; ek yazılmaz", async () => {
    const id = await textConversation();
    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "bu" },
      attachment: attachment(BYTES_1),
    });
    expect(sent).toEqual({ status: "busy" });
    expect(await attachmentCount(id)).toBe(0);
  });

  it(`konuşma başına en fazla ${CHAT_ATTACHMENTS_PER_CONVERSATION} görsel`, async () => {
    const id = await textConversation();
    const model = recording(
      Array.from({ length: CHAT_ATTACHMENTS_PER_CONVERSATION + 1 }, (_, i) => search(`q${i}`)),
    );
    await answer(id, model);
    for (let i = 0; i < CHAT_ATTACHMENTS_PER_CONVERSATION; i++) {
      const sent = await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "text", text: `görsel ${i}` },
        attachment: attachment(BYTES_1),
      });
      expect(sent.status).toBe("queued");
      await answer(id, model);
    }
    const over = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "bir tane daha" },
      attachment: attachment(BYTES_1),
    });
    expect(over).toEqual({ status: "image_limit" });
    expect(await attachmentCount(id)).toBe(CHAT_ATTACHMENTS_PER_CONVERSATION);
    // Metin mesajı sınırdan etkilenmez.
    const text = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "yalnız metin" },
    });
    expect(text.status).toBe("queued");
  });

  it("saatlik kullanıcı tavanı görselli mesajı da sayar", async () => {
    const id = await textConversation();
    await answer(id, recording([search("siyah ayakkabı")]));
    process.env.CHAT_TURNS_PER_HOUR = "1";
    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "bu" },
      attachment: attachment(BYTES_1),
      requestKey: `key-${run}-cap-img-1`,
    });
    expect(sent).toEqual({ status: "rate_limited" });
    expect(await attachmentCount(id)).toBe(0);
  });
});

describe("Gemini bağlamı: özet, kontrollü yeniden gönderim, en son görsel", () => {
  function enableImages() {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_IMAGE_ENABLED", "true");
  }

  async function imageConversation(text = "") {
    const created = await createConversation(db, {
      userId: userA,
      message: text,
      attachment: attachment(BYTES_1),
    });
    if (created.status !== "created") throw new Error(created.status);
    return created.conversationId;
  }

  async function followUp(id: string, text: string, model: ChatInterpreter, withImage?: Buffer) {
    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text },
      ...(withImage ? { attachment: attachment(withImage) } : {}),
    });
    if (sent.status !== "queued") throw new Error(`send failed: ${sent.status}`);
    await answer(id, model);
  }

  it("ilk tur görseli alır; özet saklanır; metin takibinde görsel GÖNDERİLMEZ, özet gider", async () => {
    enableImages();
    const id = await imageConversation();
    const model = recording([
      search("beyaz spor ayakkabı", "beyaz deri spor ayakkabı"),
      search("siyah spor ayakkabı"),
    ]);
    await answer(id, model);
    expect(model.requests[0]?.image?.dataBase64).toBe(BYTES_1.toString("base64"));
    expect(model.requests[0]?.messages[0]).toMatchObject({ hasImage: true });

    const view = await loadConversation(db, { userId: userA, conversationId: id });
    const assistant = view?.messages.at(-1);
    expect(assistant?.role === "assistant" && assistant.imageSummary?.text).toBe(
      "beyaz deri spor ayakkabı",
    );

    await followUp(id, "siyah olsun", model);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.image ?? null).toBeNull();
    expect(model.requests[1]?.messages[0]?.hasImage).toBeUndefined();
    expect(model.requests[1]?.messages[0]?.imageSummary).toBe("beyaz deri spor ayakkabı");
  });

  it("özet üretilmediyse (model özet vermedi) görsel takipte yeniden gönderilir", async () => {
    enableImages();
    const id = await imageConversation();
    const model = recording([search("ayakkabı"), search("siyah ayakkabı")]);
    await answer(id, model);
    await followUp(id, "siyah olsun", model);
    expect(model.requests[1]?.image?.dataBase64).toBe(BYTES_1.toString("base64"));
  });

  it("kullanıcı görsele atıf yaparsa özet olsa da görsel yeniden gönderilir", async () => {
    enableImages();
    const id = await imageConversation();
    const model = recording([search("ayakkabı", "beyaz ayakkabı"), search("ayakkabı tabanı")]);
    await answer(id, model);
    await followUp(id, "fotoğraftakinin tabanı nasıl", model);
    expect(model.requests[1]?.image?.dataBase64).toBe(BYTES_1.toString("base64"));
    expect(model.requests[1]?.messages[0]?.hasImage).toBe(true);
  });

  it("yeni görsel gelince EN SON görsel esas alınır, eskisi gönderilmez", async () => {
    enableImages();
    const id = await imageConversation();
    const model = recording([
      search("ayakkabı", "beyaz ayakkabı"),
      search("çanta", "kahverengi deri çanta"),
    ]);
    await answer(id, model);
    await followUp(id, "bunu da bak", model, BYTES_2);
    expect(model.requests[1]?.image?.dataBase64).toBe(BYTES_2.toString("base64"));
    // Eski görselin özeti bağlamda kalır, yeni görsel hasImage taşır.
    expect(model.requests[1]?.messages[0]?.imageSummary).toBe("beyaz ayakkabı");
    expect(model.requests[1]?.messages[0]?.hasImage).toBeUndefined();
    expect(model.requests[1]?.messages.at(-1)?.hasImage).toBe(true);
  });

  it("CHAT_IMAGE_ENABLED kapalıyken sohbet içi görsel modele gitmez (tur metinle sürer)", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_IMAGE_ENABLED", "");
    const id = await textConversation("siyah ayakkabı");
    const model = recording([search("siyah ayakkabı"), search("beyaz ayakkabı")]);
    await answer(id, model);
    await followUp(id, "beyaz olsun", model, BYTES_1);
    expect(model.requests[1]?.image ?? null).toBeNull();
  });

  it("metin-only sohbette model isteğine görsel alanı hiç girmez", async () => {
    enableImages();
    const id = await textConversation("siyah ayakkabı");
    const model = recording([search("siyah ayakkabı")]);
    await answer(id, model);
    expect(model.requests[0]?.image ?? null).toBeNull();
    expect(model.requests[0]?.messages.some((m) => m.hasImage || m.imageSummary)).toBe(false);
  });
});
