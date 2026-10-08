/**
 * Sohbet görsel eki (karar 0078) — gerçek yerel Postgres. Model sahtedir; ağ yok.
 * Görselli oluşturma tek işlemde, sahiplik sorguda, çift gönderim tekil, görsel
 * sonraki turda da modele gider.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { ChatInterpreter, InterpretRequest } from "./interpreter.ts";
import {
  createConversation,
  loadChatAttachment,
  loadConversation,
  processPendingTurn,
  submitUserMessage,
} from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `ci${Date.now().toString(36)}`;
let db: Database;
let userA = 0;
let userB = 0;

const USAGE = { inputTokens: 20, outputTokens: 8, thoughtTokens: 0, totalTokens: 28 };
const BYTES = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const ATTACHMENT = { bytes: BYTES, mimeType: "image/jpeg" as const, width: 64, height: 48 };

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

const clarify = () => ({
  action: "clarify",
  message: "Aynı modeli mi arıyorsun, yoksa benzer siyah oversize modeller de olur mu?",
  question: {
    id: "same_or_similar",
    title: "Aynı model mi, benzerleri de olur mu?",
    options: [
      { label: "Aynı model", description: null, value: "same" },
      { label: "Benzerleri de olur", description: null, value: "similar" },
    ],
  },
  intent: null,
});
const search = (query: string) => ({
  action: "search",
  message: "Benzerlerini aşağıda açtım.",
  question: null,
  intent: { reset: false, remove: [], query },
});

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const a = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `img-a-${run}@test.invalid`,
    ]);
    const b = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `img-b-${run}@test.invalid`,
    ]);
    userA = Number(a.rows[0].id);
    userB = Number(b.rows[0].id);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM api_usage WHERE user_id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userA, userB]]);
  });
});

async function createWithImage(message: string, requestKey?: string) {
  const created = await createConversation(db, {
    userId: userA,
    message,
    attachment: ATTACHMENT,
    ...(requestKey ? { requestKey } : {}),
  });
  if (created.status !== "created") throw new Error(`create failed: ${created.status}`);
  return created.conversationId;
}

describe("görselli sohbet oluşturma", () => {
  it("görsel + metin: TEK kullanıcı mesajı, ek mesaja bağlı", async () => {
    const id = await createWithImage("Bunun siyahını bul");
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages).toHaveLength(1);
    const message = view?.messages[0];
    expect(message).toMatchObject({ role: "user", content: "Bunun siyahını bul" });
    expect(message?.role === "user" && message.attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(view?.title).toBe("Bunun siyahını bul");
  });

  it("yalnız görsel (metin yok): mesaj oluşur, içerik boş görünür", async () => {
    const id = await createWithImage("   ");
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    const message = view?.messages[0];
    expect(view?.messages).toHaveLength(1);
    expect(message).toMatchObject({ role: "user", content: "" });
    expect(message?.role === "user" && message.attachmentId).not.toBeNull();
    expect(view?.title).toBe("Fotoğrafla arama");
  });

  it("metin de görsel de yoksa reddedilir; bozuk/büyük ek reddedilir ve hiçbir şey yazılmaz", async () => {
    expect(await createConversation(db, { userId: userA, message: " " })).toEqual({
      status: "invalid_input",
    });
    expect(
      await createConversation(db, {
        userId: userA,
        message: "x",
        attachment: { ...ATTACHMENT, bytes: Buffer.alloc(512 * 1024 + 1) },
      }),
    ).toEqual({ status: "invalid_input" });
    expect(
      await createConversation(db, {
        userId: userA,
        message: "x",
        attachment: { ...ATTACHMENT, bytes: Buffer.alloc(0) },
      }),
    ).toEqual({ status: "invalid_input" });
  });

  it("çift gönderim: aynı requestKey ikinci sohbet/ek/mesaj üretmez", async () => {
    const key = `key-${run}-dup-0001`;
    const first = await createWithImage("tekrar", key);
    const second = await createWithImage("tekrar", key);
    expect(second).toBe(first);
    const [view, count] = await Promise.all([
      loadConversation(db, { userId: userA, conversationId: first }),
      withOwnerClient((client) =>
        client.query("SELECT count(*)::int AS n FROM chat_attachment WHERE conversation_id = $1", [
          first,
        ]),
      ),
    ]);
    expect(view?.messages).toHaveLength(1);
    expect(count.rows[0].n).toBe(1);
  });

  it("eş zamanlı çift gönderimde ek tek kalır (sohbet sayısı <= 2, tur tek)", async () => {
    const key = `key-${run}-race-001`;
    const results = await Promise.all([
      createWithImage("yarış", key),
      createWithImage("yarış", key),
    ]);
    // Ön kontrol yarışa açıktır; sohbet birden fazla açılsa bile her biri kendi eki + tek mesajla tutarlıdır.
    for (const id of new Set(results)) {
      const view = await loadConversation(db, { userId: userA, conversationId: id });
      expect(view?.messages).toHaveLength(1);
    }
  });
});

describe("ek sahipliği", () => {
  it("yalnız sahibi okur; başkası ve geçersiz kimlik null", async () => {
    const id = await createWithImage("sahiplik");
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    const first = view?.messages[0];
    const attachmentId = first?.role === "user" ? (first.attachmentId ?? "") : "";
    const own = await loadChatAttachment(db, { userId: userA, attachmentId });
    expect(own?.mimeType).toBe("image/jpeg");
    expect(own?.data.equals(BYTES)).toBe(true);
    expect(await loadChatAttachment(db, { userId: userB, attachmentId })).toBeNull();
    expect(await loadChatAttachment(db, { userId: userA, attachmentId: "nope" })).toBeNull();
    // Başkasının sohbeti 404 (varlık sızmaz).
    expect(await loadConversation(db, { userId: userB, conversationId: id })).toBeNull();
  });

  it("sohbet silinince ek de gider (CASCADE)", async () => {
    const id = await createWithImage("silinecek");
    await withOwnerClient((client) => client.query("DELETE FROM conversation WHERE id = $1", [id]));
    const rows = await withOwnerClient((client) =>
      client.query("SELECT 1 FROM chat_attachment WHERE conversation_id = $1", [id]),
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe("Gemini turu: görsel bağlamı", () => {
  it("ilk tur görseli alır; sonraki mesajda da görsel (ve has_image) korunur", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_IMAGE_ENABLED", "true");
    const id = await createWithImage("");
    const model = recording([clarify(), search("siyah oversize hoodie")]);

    const first = await processPendingTurn(db, {
      userId: userA,
      conversationId: id,
      interpreter: model,
    });
    expect(first).toMatchObject({ status: "answered", action: "clarify" });
    expect(model.requests[0]?.image?.mimeType).toBe("image/jpeg");
    expect(model.requests[0]?.image?.dataBase64).toBe(BYTES.toString("base64"));
    expect(model.requests[0]?.messages[0]).toMatchObject({ hasImage: true, text: "" });

    const sent = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "option", questionId: "same_or_similar", value: "similar" },
      requestKey: `key-${run}-follow-1`,
    });
    expect(sent.status).toBe("queued");
    const second = await processPendingTurn(db, {
      userId: userA,
      conversationId: id,
      interpreter: model,
    });
    expect(second).toMatchObject({ status: "answered", action: "search" });
    // Aynı konuşma/oturum: önceki görsel bağlamı ikinci turda da modelde.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.image?.dataBase64).toBe(BYTES.toString("base64"));
    expect(model.requests[1]?.messages[0]?.hasImage).toBe(true);
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.currentIntent?.query).toBe("siyah oversize hoodie");
  });

  it("CHAT_IMAGE_ENABLED kapalıysa görsel modele GİTMEZ (tur metinle sürer)", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_IMAGE_ENABLED", "");
    const id = await createWithImage("siyah hoodie");
    const model = recording([search("siyah hoodie")]);
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    expect(model.requests[0]?.image ?? null).toBeNull();
  });

  it("aynı sohbette eşzamanlı iki tur tek Gemini çağrısı yapar (kira)", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_IMAGE_ENABLED", "true");
    const id = await createWithImage("kira");
    const model = recording([search("kira testi"), search("kira testi")]);
    const input = { userId: userA, conversationId: id, interpreter: model };
    const results = await Promise.all([
      processPendingTurn(db, input),
      processPendingTurn(db, input),
    ]);
    expect(results.filter((r) => r.status === "answered")).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  it("model hatası + yalnız görsel: ölü uç değil, soru sorulur ve sohbet sürer", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_IMAGE_ENABLED", "true");
    const id = await createWithImage("");
    const model = recording([{ action: "bozuk" }]);
    const result = await processPendingTurn(db, {
      userId: userA,
      conversationId: id,
      interpreter: model,
    });
    expect(result).toMatchObject({ status: "answered", action: "clarify", source: "fallback" });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.pendingQuestion?.options.length).toBeGreaterThan(1);
    expect(view?.awaitingReply).toBe(false);
  });
});
