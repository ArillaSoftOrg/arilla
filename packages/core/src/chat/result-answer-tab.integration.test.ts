/**
 * Karar 0211: sonuç cevabı, mesajın gönderildiği AKTİF sekmenin sıralamasındaki ürünlerden yazılır.
 * Gerçek yerel Postgres, sahte model. Cevaptaki ürünler ekrandaki kartlarla aynı kümedir; eski
 * istemci (sekme bilgisi yok) varsayılan sekmeyle çalışır; geçmiş mesajlar değişmez.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { ResultFact } from "./answer.ts";
import { emptyIntent } from "./intent.ts";
import type { ChatInterpreter, InterpretRequest } from "./interpreter.ts";
import { searchByIntent } from "./search-adapter.ts";
import {
  createConversation,
  loadConversation,
  processPendingTurnDetailed,
  submitUserMessage,
} from "./service.ts";
import type { ChatViewTab } from "./view-tab.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `rt${Date.now().toString(36)}`.replace(/[0-9]/g, "k");
const TAG = `zxq${run}`;
let db: Database;
let user = 0;
let merchantId = 0;
const productIds: number[] = [];
const USAGE = { inputTokens: 30, outputTokens: 20, thoughtTokens: 0, totalTokens: 50 };

// Eklenme sırası bilinçli: en ucuz ürün EN SON eklenir (balanced eşitlikte id sırasıdır).
const FIXTURES: Array<[string, number]> = [
  ["orta", 30_000],
  ["pahali", 40_000],
  ["ucuzca", 20_000],
  ["enucuz", 10_000],
];

function scripted(steps: Array<unknown | ((request: InterpretRequest) => unknown)>) {
  const seen: InterpretRequest[] = [];
  const queue = [...steps];
  const interpreter: ChatInterpreter = {
    modelVersion: "test-model",
    async interpret(request, opts) {
      seen.push(request);
      opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
      const next = queue.shift();
      const value = typeof next === "function" ? next(request) : next;
      return { value, usage: USAGE, modelVersion: "test-model" };
    },
  };
  return { interpreter, seen };
}

const search = () => ({
  action: "search",
  message: "Aşağıda arıyorum.",
  question: null,
  intent: { reset: false, clear: false, remove: [], query: `${TAG} lamba` },
  answer: null,
});

function answerFrom(request: InterpretRequest) {
  const fact = request.resultFacts?.[0] as ResultFact;
  return {
    action: "answer",
    message: "Kısa özet.",
    question: null,
    intent: null,
    answer: {
      paragraphs: [
        {
          text: `${fact.title} ürünü ${fact.price_try} TL fiyatla listeleniyor.`,
          evidence: [
            { item: fact.id, field: "title", quote: `${TAG} lamba` },
            { item: fact.id, field: "price", quote: String(fact.price_try) },
          ],
        },
      ],
    },
  };
}

async function conversationWithSearch(): Promise<string> {
  const created = await createConversation(db, { userId: user, message: `${TAG} lamba` });
  if (created.status !== "created") throw new Error(created.status);
  const first = scripted([search()]);
  const done = await processPendingTurnDetailed(db, {
    userId: user,
    conversationId: created.conversationId,
    interpreter: first.interpreter,
  });
  if (done.result.status !== "answered") throw new Error(done.result.status);
  return created.conversationId;
}

async function ask(
  id: string,
  text: string,
  steps: unknown[],
  viewTab?: ChatViewTab | string | null,
) {
  const sent = await submitUserMessage(db, {
    userId: user,
    conversationId: id,
    request: { kind: "text", text },
    ...(viewTab === undefined ? {} : { viewTab: viewTab as ChatViewTab | null }),
  });
  if (sent.status !== "queued") throw new Error(sent.status);
  const model = scripted(steps);
  const outcome = await processPendingTurnDetailed(db, {
    userId: user,
    conversationId: id,
    interpreter: model.interpreter,
  });
  return { ...model, outcome };
}

const titlesOf = (facts: readonly ResultFact[] | undefined) => (facts ?? []).map((f) => f.title);

async function cardTitles(sort: "balanced" | "lowest_price" | "best_match") {
  const result = await searchByIntent(db, emptyIntent(`${TAG} lamba`), { pageSize: 8, sort });
  if (result.outcome.mode !== "results") throw new Error(result.outcome.mode);
  return result.outcome.items.map((item) => item.title);
}

function enable({ uxV2 }: { uxV2: boolean }) {
  vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
  vi.stubEnv("CHAT_RESULT_ANSWER", "true");
  vi.stubEnv("CHAT_RESULT_ANSWER_USERS", String(user));
  if (uxV2) vi.stubEnv("CHAT_UX_V2", "true");
}

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const u = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `rt-${run}@test.invalid`,
    ]);
    user = Number(u.rows[0].id);
    const m = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
       VALUES ($1, 'Sekme Magaza', $2, 'xml_feed', 80) RETURNING id`,
      [`rt-${run}`, `rt-${run}.test`],
    );
    merchantId = Number(m.rows[0].id);
    for (const [name, price] of FIXTURES) {
      const key = `${TAG}-${name}`;
      const p = await client.query(
        `INSERT INTO product (slug, title, min_price, primary_image_url, offer_count)
         VALUES ($1, $2, $3, $4, 1) RETURNING id`,
        [key, `${TAG} lamba ${name}`, price, `https://img.test/${key}.jpg`],
      );
      const id = Number(p.rows[0].id);
      productIds.push(id);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [merchantId, id, key, `https://rt-${run}.test/${name}`, `${TAG} lamba ${name}`, price],
      );
    }
  });
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM api_usage WHERE user_id = $1", [user]);
    await client.query("DELETE FROM app_user WHERE id = $1", [user]);
    await client.query("DELETE FROM offer WHERE product_id = ANY($1)", [productIds]);
    await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
  });
});

describe("result answer facts follow the active tab (decision 0211)", () => {
  it("fixtures separate the tabs: the cheapest product is last in Önerilenler, first in En Uygun Fiyat", async () => {
    enable({ uxV2: true });
    const balanced = await cardTitles("balanced");
    const cheapest = await cardTitles("lowest_price");
    expect(balanced.at(-1)).toBe(`${TAG} lamba enucuz`);
    expect(cheapest[0]).toBe(`${TAG} lamba enucuz`);
    expect(balanced).not.toEqual(cheapest);
  });

  it("En Uygun Fiyat: the facts are exactly the cards of that tab, in the same order", async () => {
    enable({ uxV2: true });
    const id = await conversationWithSearch();
    const { seen } = await ask(id, "hangisi daha uygun?", [search()], "firsat");
    expect(titlesOf(seen[0]?.resultFacts)).toEqual(await cardTitles("lowest_price"));
    const prices = (seen[0]?.resultFacts ?? []).map((f) => f.price_try as number);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("Önerilenler: the facts are the balanced cards", async () => {
    enable({ uxV2: true });
    const id = await conversationWithSearch();
    const { seen } = await ask(id, "hangisi daha uygun?", [search()], "secilen");
    expect(titlesOf(seen[0]?.resultFacts)).toEqual(await cardTitles("balanced"));
  });

  it("En İyi Eşleşmeler: the facts are the best_match cards", async () => {
    enable({ uxV2: true });
    const id = await conversationWithSearch();
    const { seen } = await ask(id, "farkları açıkla", [search()], "eslesme");
    expect(titlesOf(seen[0]?.resultFacts)).toEqual(await cardTitles("best_match"));
  });

  it("an old client (no tab) and a bogus tab both fall back to the default tab", async () => {
    enable({ uxV2: true });
    // Ayrı sohbetler: ilk turun `search` sonucu niyeti ("daha uygun" -> cheapest) değiştirir ve
    // sayfa da o niyetle fiyat sekmesini açar; burada varsayılan sekme davranışı ölçülür.
    const oldClient = await ask(await conversationWithSearch(), "farkları açıkla", [search()]);
    expect(titlesOf(oldClient.seen[0]?.resultFacts)).toEqual(await cardTitles("balanced"));
    const bogus = await ask(await conversationWithSearch(), "farkları açıkla", [search()], "zzz");
    expect(titlesOf(bogus.seen[0]?.resultFacts)).toEqual(await cardTitles("balanced"));
  });

  it("with no explicit tab, an intent that asked for cheaper opens the price tab, like the page does", async () => {
    enable({ uxV2: true });
    const id = await conversationWithSearch();
    // 1. tur: "daha uygun" niyeti cheapest'e çevirir (model search döndürür)
    await ask(id, "daha uygun fiyatlı olanlar", [search()]);
    const next = await ask(id, "hangisi daha uygun?", [search()]);
    expect(titlesOf(next.seen[0]?.resultFacts)).toEqual(await cardTitles("lowest_price"));
  });

  it("the answer records which tab it was written for; the user message keeps the tab", async () => {
    enable({ uxV2: true });
    const id = await conversationWithSearch();
    const { outcome } = await ask(id, "hangisi daha uygun?", [answerFrom], "firsat");
    expect(outcome.result).toMatchObject({ status: "answered", action: "answer" });
    const view = await loadConversation(db, { userId: user, conversationId: id });
    const notice = view?.messages.at(-1);
    expect(notice).toMatchObject({ role: "assistant", kind: "notice", answerTab: "firsat" });
    // cevap EN UCUZ ürünü dayanak aldı (p1), balanced olsaydı "orta" olurdu
    expect(notice?.content).toContain(`${TAG} lamba enucuz`);
    const userMessage = view?.messages.at(-2);
    expect(userMessage).toMatchObject({ role: "user", viewTab: "firsat" });
  });

  it("history is untouched: an earlier answer keeps its own tab label after the user asks again on another tab", async () => {
    enable({ uxV2: true });
    const id = await conversationWithSearch();
    await ask(id, "hangisi daha uygun?", [answerFrom], "firsat");
    await ask(id, "farkları açıkla", [answerFrom], "secilen");
    const view = await loadConversation(db, { userId: user, conversationId: id });
    const notices = (view?.messages ?? []).filter(
      (m) => m.role === "assistant" && m.kind === "notice",
    );
    expect(
      notices.map((m) => (m.role === "assistant" && m.kind === "notice" ? m.answerTab : null)),
    ).toEqual(["firsat", "secilen"]);
    // aynı arama bloğu ve niyet bozulmadı
    expect(view?.currentIntent?.query).toBe(`${TAG} lamba`);
  });

  it("flag off: no facts are read for any tab", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    const id = await conversationWithSearch();
    const { seen } = await ask(id, "hangisi daha uygun?", [search()], "firsat");
    expect(seen[0]?.resultFacts).toBeUndefined();
  });
});
