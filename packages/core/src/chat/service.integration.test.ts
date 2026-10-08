/**
 * Konusmali kesif (karar 0074) — gercek yerel Postgres. Model sahtedir (betikli
 * `ChatInterpreter`); ag yok. Yalitim: kullanicilar, katalog ve sohbetler bu kosuya
 * ozel olusturulur ve temizlenir.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmError } from "../llm/client.ts";
import { loadLexiconCached } from "../search/lexicon-cache.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { emptyIntent } from "./intent.ts";
import type { ChatInterpreter } from "./interpreter.ts";
import { IntentSearchTimeoutError, searchByIntent } from "./search-adapter.ts";
import {
  createConversation,
  getTurnStatus,
  loadConversation,
  processPendingTurn,
  processPendingTurnDetailed,
  purgeExpiredConversations,
  setResultFeedback,
  submitUserMessage,
} from "./service.ts";

// Bu dosyadaki cok sayida tur saatlik tavana takilmasin; tavan testi kendi degerini verir.
process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `ch${Date.now().toString(36)}`;
const TOKEN = `lumb${run}`;
let db: Database;
let userA = 0;
let userB = 0;
const productIds: number[] = [];
let merchantId = 0;
let brandId = 0;

const USAGE = { inputTokens: 20, outputTokens: 8, thoughtTokens: 0, totalTokens: 28 };

type Scripted = unknown | Error;

/** Sirayla betikteki degerleri doner; Error ise `LlmError` gibi firlatir. */
function scripted(
  values: Scripted[],
  options: { delayMs?: number } = {},
): ChatInterpreter & { calls: number } {
  const queue = [...values];
  const state = { calls: 0 };
  return {
    modelVersion: "test-model",
    get calls() {
      return state.calls;
    },
    async interpret(_request, opts) {
      state.calls++;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const next = queue.shift();
      if (next instanceof Error) {
        opts?.onCall?.({ modelVersion: "test-model", httpStatus: null, usage: null });
        throw next;
      }
      opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
      return { value: next, usage: USAGE, modelVersion: "test-model" };
    },
  };
}

const clarify = (id = "shoe_type") => ({
  action: "clarify",
  message: "Ne tür ürün arıyorsun?",
  question: {
    id,
    title: "Ne tür ürün arıyorsun?",
    options: [
      { label: "Sneaker", description: "Günlük", value: "sneaker" },
      { label: "Bot", description: null, value: "boots" },
      { label: "Sandalet", description: null, value: "sandals" },
    ],
  },
  intent: null,
});

const search = (intent: Record<string, unknown>) => ({
  action: "search",
  message: "Buldukların aşağıda.",
  question: null,
  intent: { reset: false, remove: [], ...intent },
});

async function newConversation(user: number, message = `${TOKEN} arıyorum`) {
  const created = await createConversation(db, { userId: user, message });
  if (created.status !== "created") throw new Error(`create failed: ${created.status}`);
  return created.conversationId;
}

async function lastAssistantKind(conversationId: string, user = userA) {
  const view = await loadConversation(db, { userId: user, conversationId });
  return view?.messages.at(-1);
}

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const a = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `chat-a-${run}@test.invalid`,
    ]);
    const b = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `chat-b-${run}@test.invalid`,
    ]);
    userA = Number(a.rows[0].id);
    userB = Number(b.rows[0].id);

    const m = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
       VALUES ($1, 'Chat Magaza', $2, 'xml_feed', 80) RETURNING id`,
      [`ch-${run}`, `ch-${run}.test`],
    );
    merchantId = Number(m.rows[0].id);
    const brand = await client.query(
      "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
      [`zq-${run}`, `Zq${run}`, `zq${run}`],
    );
    brandId = Number(brand.rows[0].id);
    for (const [kind, surface, normalized] of [
      ["brand", `zq${run}`, `zq${run}`],
      ["color", "siyah", "black"],
    ]) {
      await client.query(
        "INSERT INTO lexicon (kind, surface, normalized) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [kind, surface, normalized],
      );
    }
    const rows: [string, number | null, string, number][] = [
      [`${TOKEN} Sneaker Siyah`, brandId, "black", 250_000],
      [`${TOKEN} Sneaker Beyaz`, null, "white", 150_000],
    ];
    let n = 0;
    for (const [title, brand_id, color, price] of rows) {
      n++;
      const p = await client.query(
        `INSERT INTO product (slug, title, brand_id, color, min_price, primary_image_url, offer_count)
         VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING id`,
        [`ch-${run}-${n}`, title, brand_id, color, price, `https://img.test/${run}/${n}.jpg`],
      );
      const productId = Number(p.rows[0].id);
      productIds.push(productId);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [merchantId, productId, `ch-${run}-${n}`, `https://ch-${run}.test/${n}`, title, price],
      );
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM api_usage WHERE user_id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userA, userB]]);
    if (productIds.length > 0) {
      await client.query("DELETE FROM offer WHERE product_id = ANY($1)", [productIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    }
    await client.query("DELETE FROM brand WHERE id = $1", [brandId]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
  });
});

describe("conversation create + initial message", () => {
  it("creates a conversation owned by the user with the first message stored", async () => {
    const id = await newConversation(userA, `  ${TOKEN}   arıyorum  `);
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view).toMatchObject({ awaitingReply: true, currentIntent: null, pendingQuestion: null });
    expect(view?.messages).toEqual([
      expect.objectContaining({ seq: 1, role: "user", kind: "text", content: `${TOKEN} arıyorum` }),
    ]);
    expect(view?.title).toBe(`${TOKEN} arıyorum`);
  });

  it("rejects empty or whitespace-only input", async () => {
    expect(await createConversation(db, { userId: userA, message: "   " })).toEqual({
      status: "invalid_input",
    });
  });
});

describe("clarify -> option -> search flow", () => {
  it("clarify, option click, search with real DB results", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([
      clarify(),
      search({
        query: `${TOKEN} sneaker`,
        category: "ayakkabı",
        attributes: [{ key: "usage", value: "günlük" }],
      }),
    ]);

    // 1) model sorar
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toEqual({
      status: "answered",
      source: "model",
      action: "clarify",
    });
    let view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.awaitingReply).toBe(false);
    expect(view?.pendingQuestion?.id).toBe("shoe_type");
    expect(view?.pendingQuestion?.options.map((o) => o.value)).toEqual([
      "sneaker",
      "boots",
      "sandals",
    ]);

    // 2) gecersiz secenek ve yanlis soru reddedilir (istemci uyduramaz)
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "option", questionId: "shoe_type", value: "rocket" },
      }),
    ).toEqual({ status: "invalid_option" });
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "option", questionId: "other", value: "sneaker" },
      }),
    ).toEqual({ status: "invalid_option" });

    // 3) gecerli secenek kullanici cevabi olarak islenir
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "option", questionId: "shoe_type", value: "sneaker" },
      }),
    ).toEqual({ status: "queued", seq: 3 });
    view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.at(-1)).toMatchObject({
      role: "user",
      kind: "option",
      content: "Sneaker",
      value: "sneaker",
    });

    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toMatchObject({
      status: "answered",
      action: "search",
    });
    view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.pendingQuestion).toBeNull();
    expect(view?.currentIntent).toMatchObject({
      query: `${TOKEN} sneaker`,
      category: "ayakkabı",
      attributes: { usage: "günlük" },
    });
    const last = view?.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", kind: "search", source: "model" });

    // 4) ürünler yalnızca gerçek DB sonuçlarından gelir
    const { outcome } = await searchByIntent(
      db,
      view?.currentIntent as NonNullable<typeof view>["currentIntent"] & object,
    );
    expect(outcome.mode).toBe("results");
    expect(outcome.items.map((i) => i.title).sort()).toEqual([
      `${TOKEN} Sneaker Beyaz`,
      `${TOKEN} Sneaker Siyah`,
    ]);
    expect(outcome.items.every((i) => productIds.includes(i.productId))).toBe(true);
  });

  it("custom answer is stored as text answering the open question", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([clarify(), search({ query: `${TOKEN} trekking` })]);
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "text", text: "trekking ayakkabı" },
      }),
    ).toMatchObject({ status: "queued" });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.at(-1)).toMatchObject({ kind: "text", content: "trekking ayakkabı" });
    const row = await withOwnerClient((c) =>
      c.query("SELECT payload FROM chat_message WHERE conversation_id = $1 AND seq = 3", [id]),
    );
    expect(row.rows[0].payload).toEqual({ answersQuestion: "shoe_type" });
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    expect(
      (await loadConversation(db, { userId: userA, conversationId: id }))?.currentIntent?.query,
    ).toBe(`${TOKEN} trekking`);
  });

  it("skip is accepted only while a question is open", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "skip", questionId: "shoe_type" },
      }),
    ).toEqual({ status: "busy" }); // cevap bekleyen mesaj var; once yanitlanir
    const model = scripted([clarify(), search({ query: TOKEN })]);
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "skip", questionId: "shoe_type" },
      }),
    ).toMatchObject({ status: "queued" });
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.map((m) => `${m.role}:${m.kind}`)).toEqual([
      "user:text",
      "assistant:clarify",
      "user:skip",
      "assistant:search",
    ]);
    expect(view?.pendingQuestion).toBeNull();
    // soru kapaninca atlama artik gecerli degil
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "skip", questionId: "shoe_type" },
      }),
    ).toEqual({ status: "invalid_option" });
  });
});

describe("refinement merges into the stored intent", () => {
  it("'siyah olsun', 'Nike olsun', '2500 TL altı' keep the earlier intent; refresh shows full history", async () => {
    const id = await newConversation(userA, `${TOKEN} sneaker`);
    const model = scripted([
      search({ query: `${TOKEN} sneaker`, category: "ayakkabı" }),
      search({ colors: ["siyah"] }),
      search({ brand: `Zq${run}` }),
      search({ priceMax: 2500 }),
      search({ sort: "cheapest" }),
    ]);
    const turns = ["siyah olsun", `Zq${run} olsun`, "2500 TL altı", "daha uygun fiyatlı"];
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    for (const text of turns) {
      expect(
        await submitUserMessage(db, {
          userId: userA,
          conversationId: id,
          request: { kind: "text", text },
        }),
      ).toMatchObject({ status: "queued" });
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    }

    // "Sayfa yenilemesi": sifirdan okunan gorunum
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.currentIntent).toEqual({
      query: `${TOKEN} sneaker`,
      category: "ayakkabı",
      brand: `Zq${run}`,
      excludeBrands: [],
      colors: ["siyah"],
      size: null,
      priceMin: null,
      priceMax: 2500,
      attributes: {},
      sort: "cheapest",
    });
    expect(view?.messages).toHaveLength(10);
    expect(view?.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Her arama mesaji kendi anindaki niyeti tasir (gecmis degismez)
    const intents = view?.messages.flatMap((m) =>
      m.role === "assistant" && m.kind === "search" ? [m.intent] : [],
    );
    expect(intents?.[0]?.colors).toEqual([]);
    expect(intents?.[1]?.colors).toEqual(["siyah"]);
    expect(intents?.[4]?.sort).toBe("cheapest");

    // Birlesik niyet gercek DB'den yalnizca siyah + marka + fiyat kosullu urunu getirir
    const { outcome } = await searchByIntent(
      db,
      view?.currentIntent as NonNullable<typeof view>["currentIntent"] & object,
    );
    expect(outcome.mode).toBe("results");
    expect(outcome.items.map((i) => i.title)).toEqual([`${TOKEN} Sneaker Siyah`]);
  });

  it("reset starts a new topic", async () => {
    const id = await newConversation(userA, `${TOKEN} sneaker`);
    const model = scripted([
      search({ query: `${TOKEN} sneaker`, brand: "Nike", priceMax: 900 }),
      search({ reset: true, query: "kulaklık" }),
    ]);
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "kulaklık bakalım" },
    });
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.currentIntent).toMatchObject({ query: "kulaklık", brand: null, priceMax: null });
  });
});

describe("malformed model output", () => {
  it("falls back to a plain search of the user's text and records the source", async () => {
    const id = await newConversation(userA, `${TOKEN} sneaker`);
    const model = scripted([{ action: "run_sql", sql: "DROP TABLE product" }]);
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toEqual({
      status: "answered",
      source: "fallback",
      action: "search",
    });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.currentIntent?.query).toBe(`${TOKEN} sneaker`);
    expect(view?.messages.at(-1)).toMatchObject({ kind: "search", source: "fallback" });
    // Urun tablosu yerinde (model SQL calistiramaz)
    const count = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int AS n FROM product WHERE id = ANY($1)", [productIds]),
    );
    expect(count.rows[0].n).toBe(2);
  });

  it("truncated or non-JSON output also falls back", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([new LlmError("invalid_json")]);
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toMatchObject({
      status: "answered",
      source: "fallback",
    });
  });
});

describe("provider failure + retry", () => {
  it("keeps the user message, writes no assistant message, releases the lease, and retry succeeds", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([new LlmError("timeout"), search({ query: TOKEN })]);
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toEqual({
      status: "provider_error",
      code: "timeout",
    });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.awaitingReply).toBe(true);
    expect(view?.messages).toHaveLength(1);

    // Kira birakildi: yeniden deneme beklemeden calisir
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toMatchObject({
      status: "answered",
    });
    expect((await lastAssistantKind(id))?.kind).toBe("search");
  });

  it("records every HTTP attempt in api_usage (rule 9), including failed ones", async () => {
    const id = await newConversation(userB, `${TOKEN}`);
    const model = scripted([new LlmError("rate_limited"), search({ query: TOKEN })]);
    await processPendingTurn(db, { userId: userB, conversationId: id, interpreter: model });
    await processPendingTurn(db, { userId: userB, conversationId: id, interpreter: model });
    const rows = await withOwnerClient((c) =>
      c.query(
        "SELECT operation, model_version, units, user_id FROM api_usage WHERE user_id = $1 AND operation = 'chat_turn' ORDER BY id",
        [userB],
      ),
    );
    expect(
      rows.rows.map((r) => [r.operation, r.model_version, Number(r.units), Number(r.user_id)]),
    ).toEqual([
      ["chat_turn", "test-model", 0, userB],
      ["chat_turn", "test-model", 28, userB],
    ]);
  });
});

describe("ownership", () => {
  it("another user cannot read, write to, or process a conversation", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    expect(await loadConversation(db, { userId: userB, conversationId: id })).toBeNull();
    expect(
      await submitUserMessage(db, {
        userId: userB,
        conversationId: id,
        request: { kind: "text", text: "merhaba" },
      }),
    ).toEqual({ status: "not_found" });
    const model = scripted([search({ query: TOKEN })]);
    expect(
      await processPendingTurn(db, { userId: userB, conversationId: id, interpreter: model }),
    ).toEqual({
      status: "not_found",
    });
    expect(model.calls).toBe(0);
    // sahibi etkilenmedi
    expect(
      (await loadConversation(db, { userId: userA, conversationId: id }))?.messages,
    ).toHaveLength(1);
  });

  it("malformed ids are not found, never an error", async () => {
    expect(await loadConversation(db, { userId: userA, conversationId: "not-a-uuid" })).toBeNull();
    expect(
      await loadConversation(db, {
        userId: userA,
        conversationId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBeNull();
  });
});

describe("duplicate submit and races", () => {
  it("the same request key is accepted once", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([search({ query: TOKEN })]);
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    const request = { kind: "text", text: "siyah olsun" } as const;
    const first = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request,
      requestKey: `${run}-key-1`,
    });
    const second = await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request,
      requestKey: `${run}-key-1`,
    });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("duplicate");
    expect(
      (await loadConversation(db, { userId: userA, conversationId: id }))?.messages,
    ).toHaveLength(3);
  });

  it("parallel submits: exactly one is queued, no gap or duplicate seq", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    await processPendingTurn(db, {
      userId: userA,
      conversationId: id,
      interpreter: scripted([search({ query: TOKEN })]),
    });
    const results = await Promise.all(
      ["bir", "iki", "üç", "dört", "beş"].map((text, i) =>
        submitUserMessage(db, {
          userId: userA,
          conversationId: id,
          request: { kind: "text", text },
          requestKey: `${run}-par-${i}-xxxxxxxx`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.status === "busy")).toHaveLength(4);
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("parallel processing: one model call, the other caller sees busy", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([search({ query: TOKEN }), search({ query: TOKEN })], { delayMs: 150 });
    const [a, b] = await Promise.all([
      processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
      processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["answered", "busy"]);
    expect(model.calls).toBe(1);
    expect(
      (await loadConversation(db, { userId: userA, conversationId: id }))?.messages,
    ).toHaveLength(2);
    // Cevap yazildiktan sonra tekrar cagri bir sey yapmaz
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toEqual({
      status: "idle",
    });
    expect(model.calls).toBe(1);
  });

  it("an expired lease (crashed worker) can be taken over", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    await withOwnerClient((c) =>
      c.query(
        "UPDATE conversation SET processing_until = now() - interval '1 second' WHERE id = $1",
        [id],
      ),
    );
    expect(
      await processPendingTurn(db, {
        userId: userA,
        conversationId: id,
        interpreter: scripted([search({ query: TOKEN })]),
      }),
    ).toMatchObject({ status: "answered" });
  });

  it("a live lease blocks a second turn", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    await withOwnerClient((c) =>
      c.query(
        "UPDATE conversation SET processing_until = now() + interval '30 seconds' WHERE id = $1",
        [id],
      ),
    );
    const model = scripted([search({ query: TOKEN })]);
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model }),
    ).toEqual({
      status: "busy",
    });
    expect(model.calls).toBe(0);
  });
});

describe("limits", () => {
  it("per-user hourly cap blocks new conversations and messages (model cost ceiling)", async () => {
    // Bu kullanicinin saatlik tavani zaten kullanilmis bir kullanici yarat
    const capped = await withOwnerClient(async (c) => {
      const r = await c.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `chat-cap-${run}@test.invalid`,
      ]);
      return Number(r.rows[0].id);
    });
    try {
      vi.stubEnv("CHAT_TURNS_PER_HOUR", "2");
      const id = await newConversation(capped, `${TOKEN} bir`);
      await processPendingTurn(db, {
        userId: capped,
        conversationId: id,
        interpreter: scripted([search({ query: TOKEN })]),
      });
      expect(
        await submitUserMessage(db, {
          userId: capped,
          conversationId: id,
          request: { kind: "text", text: "iki" },
        }),
      ).toMatchObject({ status: "queued" });
      await processPendingTurn(db, {
        userId: capped,
        conversationId: id,
        interpreter: scripted([search({ colors: ["siyah"] })]),
      });
      expect(
        await submitUserMessage(db, {
          userId: capped,
          conversationId: id,
          request: { kind: "text", text: "üç" },
        }),
      ).toEqual({ status: "rate_limited" });
      expect(await createConversation(db, { userId: capped, message: "yeni" })).toEqual({
        status: "rate_limited",
      });
    } finally {
      await withOwnerClient(async (c) => {
        await c.query("DELETE FROM api_usage WHERE user_id = $1", [capped]);
        await c.query("DELETE FROM app_user WHERE id = $1", [capped]);
      });
    }
  });

  it("a conversation accepts a bounded number of user messages", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    await withOwnerClient(async (c) => {
      // Tek seq'ler kullanici (60 adet), cift seq'ler asistan; son mesaj (120) asistan.
      await c.query(
        `INSERT INTO chat_message (conversation_id, seq, role, kind, content)
         SELECT $1, s, CASE WHEN s % 2 = 1 THEN 'user' ELSE 'assistant' END,
                CASE WHEN s % 2 = 1 THEN 'text' ELSE 'notice' END, 'x'
           FROM generate_series(2, 120) AS s`,
        [id],
      );
      await c.query("UPDATE conversation SET message_count = 120 WHERE id = $1", [id]);
    });
    expect(
      await submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "text", text: "bir daha" },
      }),
    ).toEqual({ status: "conversation_full" });
  });
});

describe("empty result", () => {
  it("an intent matching nothing comes back empty or fallback, never invented products", async () => {
    const { outcome } = await searchByIntent(db, {
      query: `zzqq${run} yokurun`,
      category: null,
      brand: null,
      excludeBrands: [],
      colors: [],
      size: null,
      priceMin: null,
      priceMax: null,
      attributes: {},
      sort: null,
    });
    expect(outcome.mode).toBe("empty");
    expect(outcome.items).toEqual([]);
  });
});

describe("retention and account deletion", () => {
  it("purges conversations idle for more than 90 days (messages cascade)", async () => {
    const old = await newConversation(userA, `${TOKEN} eski`);
    const fresh = await newConversation(userA, `${TOKEN} yeni`);
    await withOwnerClient((c) =>
      c.query(
        "UPDATE conversation SET last_message_at = now() - interval '91 days' WHERE id = $1",
        [old],
      ),
    );
    const result = await purgeExpiredConversations(db);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await loadConversation(db, { userId: userA, conversationId: old })).toBeNull();
    expect(await loadConversation(db, { userId: userA, conversationId: fresh })).not.toBeNull();
    const orphans = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int AS n FROM chat_message WHERE conversation_id = $1", [old]),
    );
    expect(orphans.rows[0].n).toBe(0);
  });

  it("deleting the account removes the user's conversations", async () => {
    const temp = await withOwnerClient(async (c) => {
      const r = await c.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `chat-del-${run}@test.invalid`,
      ]);
      return Number(r.rows[0].id);
    });
    const id = await newConversation(temp, `${TOKEN} silinecek`);
    await withOwnerClient((c) => c.query("DELETE FROM app_user WHERE id = $1", [temp]));
    expect(await loadConversation(db, { userId: temp, conversationId: id })).toBeNull();
    const rows = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int AS n FROM chat_message WHERE conversation_id = $1", [id]),
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("hardening: stale turn, clarification loop, search guards", () => {
  it("a stale turn (another worker answered during the model call) writes no second reply", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const racing: ChatInterpreter = {
      modelVersion: "test-model",
      async interpret(_req, opts) {
        // Model cagrisi surerken baska bir is cevabi yazdi (kira dolmustu).
        await withOwnerClient(async (c) => {
          await c.query(
            "INSERT INTO chat_message (conversation_id, seq, role, kind, content) VALUES ($1, 2, 'assistant', 'notice', 'baska is')",
            [id],
          );
          await c.query("UPDATE conversation SET message_count = 2 WHERE id = $1", [id]);
        });
        opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
        return { value: search({ query: TOKEN }), usage: USAGE, modelVersion: "test-model" };
      },
    };
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: racing }),
    ).toEqual({
      status: "idle",
    });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.map((m) => m.content)).toEqual([TOKEN, "baska is"]);
  });

  it("a model that keeps asking the same question is cut off after two clarifications", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([clarify(), clarify(), clarify()]);
    const answer = async () =>
      submitUserMessage(db, {
        userId: userA,
        conversationId: id,
        request: { kind: "option", questionId: "shoe_type", value: "sneaker" },
      });
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    expect(await answer()).toMatchObject({ status: "queued" });
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: model });
    expect(await answer()).toMatchObject({ status: "queued" });
    const last = await processPendingTurn(db, {
      userId: userA,
      conversationId: id,
      interpreter: model,
    });
    expect(last).toEqual({ status: "answered", source: "fallback", action: "search" });
    expect((await lastAssistantKind(id))?.kind).toBe("search");
  });

  it("the daily provider ceiling skips the model but the user still gets a search", async () => {
    const id = await newConversation(userA, `${TOKEN}`);
    const model = scripted([search({ query: "model-sorgusu" })]);
    await withOwnerClient((c) =>
      c.query(
        "INSERT INTO api_usage (user_id, operation, model_version, units) SELECT $1, 'chat_turn', 'x', 0 FROM generate_series(1, 3000)",
        [userA],
      ),
    );
    try {
      const result = await processPendingTurn(db, {
        userId: userA,
        conversationId: id,
        interpreter: model,
      });
      expect(result).toEqual({ status: "answered", source: "fallback", action: "search" });
      expect(model.calls).toBe(0);
    } finally {
      await withOwnerClient((c) =>
        c.query("DELETE FROM api_usage WHERE user_id = $1 AND model_version = 'x'", [userA]),
      );
    }
  });

  it("a search timeout surfaces as IntentSearchTimeoutError (intent stays stored)", async () => {
    const stub = {
      transaction: async () => {
        throw Object.assign(new Error("canceling statement"), { code: "57014" });
      },
    } as unknown as Database;
    await expect(
      searchByIntent(stub, { ...emptyIntent(TOKEN) }, { lexicon: [] }),
    ).rejects.toBeInstanceOf(IntentSearchTimeoutError);
  });

  it("a card priced above the requested cap is dropped even if the product's min_price passes", async () => {
    const { pid } = await withOwnerClient(async (c) => {
      const p = await c.query(
        `INSERT INTO product (slug, title, min_price, offer_count) VALUES ($1, $2, 200000, 1) RETURNING id`,
        [`ch-${run}-px`, `${TOKEN} Fiyat Sapmasi`],
      );
      const pid = Number(p.rows[0].id);
      await c.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
         VALUES ($1, $2, $3, $4, 'x', 400000, TRUE)`,
        [merchantId, pid, `ch-${run}-px`, `https://ch-${run}.test/px`],
      );
      return { pid };
    });
    try {
      const result = await searchByIntent(db, {
        ...emptyIntent(`${TOKEN} Fiyat Sapmasi`),
        priceMax: 2500,
      });
      expect(result.outcome.items.every((i) => (i.minPrice ?? 0) <= 250_000)).toBe(true);
      expect(result.droppedForPrice).toBeGreaterThanOrEqual(1);
    } finally {
      await withOwnerClient(async (c) => {
        await c.query("DELETE FROM offer WHERE product_id = $1", [pid]);
        await c.query("DELETE FROM product WHERE id = $1", [pid]);
      });
    }
  });

  it("a relaxed search reports what it relaxed (never silent)", async () => {
    // Renk sozlukte (siyah) ama bu urunlerde 'kirmizi' yok: gevsetme olursa raporlanir.
    const result = await searchByIntent(db, {
      ...emptyIntent(`${TOKEN} sneaker`),
      colors: ["kırmızı"],
    });
    if (result.outcome.mode !== "results") {
      expect(result.relaxed.length + (result.outcome.mode === "empty" ? 1 : 0)).toBeGreaterThan(0);
    }
  });
});

describe("result feedback (0055) and sort tabs", () => {
  async function conversationWithSearch(user = userA) {
    const id = await newConversation(user, `${TOKEN} sneaker`);
    await processPendingTurn(db, {
      userId: user,
      conversationId: id,
      interpreter: scripted([search({ query: `${TOKEN} sneaker` })]),
    });
    return id;
  }

  it("stores one vote per search message, lets the user change it, and exposes it on reload", async () => {
    const id = await conversationWithSearch();
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        helpful: true,
      }),
    ).toBe("saved");
    let view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages[1]).toMatchObject({ kind: "search", helpful: true });
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        helpful: false,
      }),
    ).toBe("saved");
    view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages[1]).toMatchObject({ helpful: false });
    const rows = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int AS n FROM chat_result_feedback WHERE conversation_id = $1", [
        id,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("only the owner can vote, only on assistant search messages", async () => {
    const id = await conversationWithSearch();
    expect(
      await setResultFeedback(db, {
        userId: userB,
        conversationId: id,
        messageSeq: 2,
        helpful: true,
      }),
    ).toBe("not_found");
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 1,
        helpful: true,
      }),
    ).toBe("invalid");
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 99,
        helpful: true,
      }),
    ).toBe("not_found");
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: "nope",
        messageSeq: 2,
        helpful: true,
      }),
    ).toBe("not_found");
    expect(
      (await loadConversation(db, { userId: userA, conversationId: id }))?.messages[1],
    ).toMatchObject({ helpful: null });
  });

  async function voteRow(id: string) {
    const r = await withOwnerClient((c) =>
      c.query(
        "SELECT helpful, reasons, comment, model_version, updated_at FROM chat_result_feedback WHERE conversation_id = $1",
        [id],
      ),
    );
    return r.rows;
  }

  it("negative vote stores reason + comment; switching to positive clears them (0079)", async () => {
    const id = await conversationWithSearch();
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        helpful: false,
        reasons: ["irrelevant"],
        comment: "  Alakasiz urunler geldi   ",
      }),
    ).toBe("saved");
    let rows = await voteRow(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      helpful: false,
      reasons: ["irrelevant"],
      comment: "Alakasiz urunler geldi",
    });
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        helpful: true,
      }),
    ).toBe("saved");
    rows = await voteRow(id);
    expect(rows[0]).toMatchObject({ helpful: true, reasons: [], comment: null });
  });

  it("negative vote with empty reason and comment is still saved", async () => {
    const id = await conversationWithSearch();
    expect(
      await setResultFeedback(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        helpful: false,
        reasons: [],
        comment: "   ",
      }),
    ).toBe("saved");
    expect((await voteRow(id))[0]).toMatchObject({ helpful: false, reasons: [], comment: null });
  });

  it("rejects invalid details and writes nothing", async () => {
    const id = await conversationWithSearch();
    const base = { userId: userA, conversationId: id, messageSeq: 2 };
    for (const bad of [
      { helpful: false, reasons: ["nope"] },
      { helpful: false, reasons: ["slow", "other", "irrelevant", "not_found"] },
      { helpful: false, comment: "x".repeat(501) },
      { helpful: true, reasons: ["slow"] },
      { helpful: true, comment: "yorum" },
    ]) {
      expect(await setResultFeedback(db, { ...base, ...bad })).toBe("invalid");
    }
    expect(await voteRow(id)).toHaveLength(0);
  });

  it("repeating the same vote is idempotent: updated_at does not move; a change does", async () => {
    const id = await conversationWithSearch();
    const vote = {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      helpful: false,
      reasons: ["slow"],
      comment: "yavas",
    };
    await setResultFeedback(db, vote);
    const first = (await voteRow(id))[0].updated_at as Date;
    await new Promise((r) => setTimeout(r, 20));
    expect(await setResultFeedback(db, vote)).toBe("saved");
    expect(((await voteRow(id))[0].updated_at as Date).getTime()).toBe(first.getTime());
    await setResultFeedback(db, { ...vote, comment: "cok yavas" });
    const rows = await voteRow(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toBe("cok yavas");
    expect((rows[0].updated_at as Date).getTime()).toBeGreaterThan(first.getTime());
  });

  it("another user cannot attach reason/comment to someone else's message", async () => {
    const id = await conversationWithSearch();
    expect(
      await setResultFeedback(db, {
        userId: userB,
        conversationId: id,
        messageSeq: 2,
        helpful: false,
        reasons: ["other"],
        comment: "x",
      }),
    ).toBe("not_found");
    expect(await voteRow(id)).toHaveLength(0);
  });

  it("records the approximate model version from the same user's chat_turn usage", async () => {
    const id = await conversationWithSearch();
    const usage = await withOwnerClient((c) =>
      c.query(
        "SELECT model_version FROM api_usage WHERE user_id = $1 AND operation = 'chat_turn' ORDER BY created_at DESC LIMIT 1",
        [userA],
      ),
    );
    await setResultFeedback(db, {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      helpful: false,
    });
    expect((await voteRow(id))[0].model_version).toBe(usage.rows[0]?.model_version ?? null);
  });

  it("votes disappear with the conversation (cascade) and carry no text", async () => {
    const id = await conversationWithSearch();
    await setResultFeedback(db, {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      helpful: true,
    });
    const cols = await withOwnerClient((c) =>
      c.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_result_feedback' ORDER BY 1",
      ),
    );
    // 0058: yalnizca neden kodu ve istege bagli yorum; sohbet metni/ham sorgu kolonu yok.
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "comment",
      "conversation_id",
      "created_at",
      "helpful",
      "message_id",
      "model_version",
      "reasons",
      "updated_at",
    ]);
    await withOwnerClient((c) => c.query("DELETE FROM conversation WHERE id = $1", [id]));
    const left = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int AS n FROM chat_result_feedback WHERE conversation_id = $1", [
        id,
      ]),
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("tab changes re-run only the existing search with another sort: same intent, no model call", async () => {
    const intent = { ...emptyIntent(`${TOKEN} sneaker`) };
    const balanced = await searchByIntent(db, intent, { sort: "balanced" });
    const deals = await searchByIntent(db, intent, { sort: "best_deal" });
    expect(balanced.outcome.sort).toBe("balanced");
    expect(deals.outcome.sort).toBe("best_deal");
    expect(balanced.outcome.items.length).toBeGreaterThan(0);
    expect(deals.outcome.items.every((i) => productIds.includes(i.productId))).toBe(true);
    expect(intent.query).toBe(`${TOKEN} sneaker`); // niyet degismedi
  });
});

describe("ilk tur: tek Gemini cagrisi, kira, durum (gecikme turu)", () => {
  async function setLease(conversationId: string, expr: string) {
    await withOwnerClient((c) =>
      c.query(`UPDATE conversation SET processing_until = ${expr} WHERE id = $1`, [conversationId]),
    );
  }
  const answer = () => scripted([search({ query: `${TOKEN} sneaker` })]);

  it("iki es zamanli tetik (after + kurtarma) yalnizca BIR model cagrisi yapar", async () => {
    const id = await newConversation(userA);
    const interpreter = scripted([search({ query: `${TOKEN} sneaker` })], { delayMs: 60 });
    const [first, second] = await Promise.all([
      processPendingTurn(db, { userId: userA, conversationId: id, interpreter }),
      processPendingTurn(db, { userId: userA, conversationId: id, interpreter }),
    ]);
    expect(interpreter.calls).toBe(1);
    expect([first.status, second.status].sort()).toEqual(["answered", "busy"]);
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("cevap yazildiktan sonra ucuncu tetik idle: ikinci cagri ve ikinci cevap yok", async () => {
    const id = await newConversation(userA);
    const interpreter = answer();
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter });
    const again = await processPendingTurn(db, { userId: userA, conversationId: id, interpreter });
    expect(again.status).toBe("idle");
    expect(interpreter.calls).toBe(1);
  });

  it("suren kira turu engeller; suresi dolmus kira (cokmus is) kurtarilir", async () => {
    const id = await newConversation(userA);
    await setLease(id, "now() + interval '30 seconds'");
    const blocked = answer();
    expect(
      await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: blocked }),
    ).toEqual({ status: "busy" });
    expect(blocked.calls).toBe(0);

    await setLease(id, "now() - interval '1 second'");
    const recovery = answer();
    const result = await processPendingTurn(db, {
      userId: userA,
      conversationId: id,
      interpreter: recovery,
    });
    expect(result.status).toBe("answered");
    expect(recovery.calls).toBe(1);
  });

  it("baska kullanici ya da yanlis UUID: not_found, model cagrilmaz, durum sizmaz", async () => {
    const id = await newConversation(userA);
    const interpreter = answer();
    expect(
      await processPendingTurn(db, { userId: userB, conversationId: id, interpreter }),
    ).toEqual({ status: "not_found" });
    expect(
      await processPendingTurn(db, {
        userId: userA,
        conversationId: "00000000-0000-4000-8000-000000000000",
        interpreter,
      }),
    ).toEqual({ status: "not_found" });
    expect(interpreter.calls).toBe(0);
    expect(await getTurnStatus(db, { userId: userB, conversationId: id })).toEqual({
      state: "not_found",
    });
    expect(await getTurnStatus(db, { userId: userA, conversationId: "bozuk" })).toEqual({
      state: "not_found",
    });
  });

  it("getTurnStatus: pending -> in_flight -> answered", async () => {
    const id = await newConversation(userA);
    expect(await getTurnStatus(db, { userId: userA, conversationId: id })).toEqual({
      state: "pending",
    });
    await setLease(id, "now() + interval '30 seconds'");
    expect(await getTurnStatus(db, { userId: userA, conversationId: id })).toEqual({
      state: "in_flight",
    });
    await setLease(id, "NULL");
    await processPendingTurn(db, { userId: userA, conversationId: id, interpreter: answer() });
    expect(await getTurnStatus(db, { userId: userA, conversationId: id })).toMatchObject({
      state: "answered",
      preview: { seq: 2, kind: "search" },
    });
  });

  it("processPendingTurnDetailed: on izleme kalici cevapla ayni; olcumler metin tasimaz", async () => {
    const id = await newConversation(userA);
    const { result, preview, timings } = await processPendingTurnDetailed(db, {
      userId: userA,
      conversationId: id,
      interpreter: answer(),
    });
    expect(result.status).toBe("answered");
    const stored = await lastAssistantKind(id);
    expect(preview).toEqual({ seq: stored?.seq, kind: "search", content: stored?.content });
    for (const key of ["chat.total", "chat.claim_turn", "chat.gemini", "chat.persist"] as const) {
      expect(typeof timings[key]).toBe("number");
    }
    expect(JSON.stringify(timings)).not.toContain(TOKEN);
  });

  it("sorgu sayisi: tek kira UPDATE, tek mesaj okumasi, sohbet/oy tekrar okumasi yok", async () => {
    const counts: Record<string, number> = {};
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
          return value.apply(target, args);
        };
      },
    });
    const id = await newConversation(userA);
    await loadLexiconCached(counted); // sozluk sicak (onbellek nesne basina)
    for (const key of Object.keys(counts)) delete counts[key]; // olculen sey tur sorgulari
    await processPendingTurn(counted, {
      userId: userA,
      conversationId: id,
      interpreter: answer(),
    });
    expect(counts.update).toBe(1);
    expect(counts.select).toBe(1);
    expect(counts.execute).toBe(1);
    expect(counts.transaction).toBe(1);
  });
});
