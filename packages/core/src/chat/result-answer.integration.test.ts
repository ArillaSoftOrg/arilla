/**
 * Karar 0203 — sonuç cevabı pilotu, gerçek yerel Postgres, sahte model. Bayrak/izin listesi/soru
 * tetiği, ürün gerçeklerinin okunması, doğrulama, saklama ve arama niyetinin korunması.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { ResultFact } from "./answer.ts";
import type { ChatInterpreter, InterpretRequest } from "./interpreter.ts";
import {
  createConversation,
  loadConversation,
  processPendingTurnDetailed,
  submitUserMessage,
} from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `ra${Date.now().toString(36)}`.replace(/[0-9]/g, "k");
const TAG = `zxq${run}`;
let db: Database;
let userA = 0;
let userB = 0;
let merchantId = 0;
const productIds: number[] = [];
const USAGE = { inputTokens: 30, outputTokens: 20, thoughtTokens: 0, totalTokens: 50 };

const NAMES = ["alfa", "beta", "gama", "delta"];

/** Betikli model: gelen isteği yakalar, sıradaki çıktıyı (ya da fonksiyonu) döndürür. */
function scripted(steps: Array<unknown | ((request: InterpretRequest) => unknown)>) {
  const seen: InterpretRequest[] = [];
  const queue = [...steps];
  const interpreter: ChatInterpreter = {
    modelVersion: "test-model",
    async interpret(request, opts) {
      seen.push(request);
      opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
      const next = queue.shift();
      const value =
        typeof next === "function" ? (next as (r: InterpretRequest) => unknown)(request) : next;
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

/** Gelen gerçeklerden, sunucunun doğrulayacağı DOĞRU bir cevap kurar. */
function goodAnswer(request: InterpretRequest) {
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

const BAD_ANSWER = {
  action: "answer",
  message: "Kısa özet.",
  question: null,
  intent: null,
  answer: {
    paragraphs: [
      {
        text: "Bu lambaların hepsi kesinlikle en iyi ve kaliteli seçenekler olarak görünüyor.",
        evidence: [{ item: "p1", field: "title", quote: "lamba" }],
      },
    ],
  },
};

async function conversationWithSearch(user = userA): Promise<string> {
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

async function ask(id: string, user: number, text: string, steps: unknown[]) {
  const sent = await submitUserMessage(db, {
    userId: user,
    conversationId: id,
    request: { kind: "text", text },
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

function enable(users: string) {
  vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
  vi.stubEnv("CHAT_RESULT_ANSWER", "true");
  vi.stubEnv("CHAT_RESULT_ANSWER_USERS", users);
}

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const a = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `ra-a-${run}@test.invalid`,
    ]);
    const b = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `ra-b-${run}@test.invalid`,
    ]);
    userA = Number(a.rows[0].id);
    userB = Number(b.rows[0].id);
    const m = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
       VALUES ($1, 'Cevap Magaza', $2, 'xml_feed', 80) RETURNING id`,
      [`ra-${run}`, `ra-${run}.test`],
    );
    merchantId = Number(m.rows[0].id);
    for (const [i, name] of NAMES.entries()) {
      const price = (i + 1) * 10_000; // 100, 200, 300, 400 TL
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
        [merchantId, id, key, `https://ra-${run}.test/${name}`, `${TAG} lamba ${name}`, price],
      );
    }
  });
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM api_usage WHERE user_id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM offer WHERE product_id = ANY($1)", [productIds]);
    await client.query("DELETE FROM product WHERE id = ANY($1)", [productIds]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
  });
});

describe("result answer pilot", () => {
  it("reads facts for an allow-listed user, stores a validated answer and keeps the search intent", async () => {
    enable(String(userA));
    const id = await conversationWithSearch();
    const before = await loadConversation(db, { userId: userA, conversationId: id });
    const { seen, outcome } = await ask(id, userA, "hangisi daha uygun?", [goodAnswer]);

    expect(seen).toHaveLength(1);
    const facts = seen[0]?.resultFacts as ResultFact[];
    expect(facts.length).toBe(4);
    expect(facts.map((f) => f.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(facts.every((f) => f.title.startsWith(TAG) && f.price_try !== null)).toBe(true);

    expect(outcome.result).toMatchObject({ status: "answered", action: "answer", source: "model" });
    expect(outcome.preview).toMatchObject({ kind: "answer" });

    const after = await loadConversation(db, { userId: userA, conversationId: id });
    const last = after?.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", kind: "notice" });
    expect(last?.content).toContain(`${TAG} lamba`);
    expect(last?.content).toMatch(/TL fiyatla listeleniyor/);
    // arama niyeti ve sonuç bloğu değişmedi
    expect(after?.currentIntent).toEqual(before?.currentIntent);
    const row = await withOwnerClient((c) =>
      c.query(
        "SELECT payload FROM chat_message WHERE conversation_id = $1 ORDER BY seq DESC LIMIT 1",
        [id],
      ),
    );
    expect(row.rows[0].payload.answer).toMatchObject({ validated: true, rejected: [] });
    expect(row.rows[0].payload.answer.paragraphs).toHaveLength(1);
    // tek model çağrısı api_usage'a yazıldı (kural 9), ek çağrı yok
    const usage = await withOwnerClient((c) =>
      c.query(
        "SELECT count(*)::int AS n FROM api_usage WHERE user_id = $1 AND created_at > now() - interval '5 minutes'",
        [userA],
      ),
    );
    expect(usage.rows[0].n).toBe(2); // ilk arama turu + cevap turu
  });

  it("an unverifiable answer is stored as the model-free summary, never as the model text", async () => {
    enable(String(userA));
    const id = await conversationWithSearch();
    const { outcome } = await ask(id, userA, "farkları açıkla", [BAD_ANSWER]);
    expect(outcome.result).toMatchObject({ status: "answered", action: "answer" });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    const last = view?.messages.at(-1);
    expect(last?.content).not.toMatch(/en iyi|kaliteli/);
    expect(last?.content).toContain("yorumlayamadım");
    const row = await withOwnerClient((c) =>
      c.query(
        "SELECT payload FROM chat_message WHERE conversation_id = $1 ORDER BY seq DESC LIMIT 1",
        [id],
      ),
    );
    expect(row.rows[0].payload.answer).toMatchObject({ validated: false });
    expect(row.rows[0].payload.answer.rejected).toContain("forbidden_claim");
  });

  it("no facts are read, and no answer is possible, when the flag is off, the user is not listed or the text is not a question", async () => {
    const id = await conversationWithSearch();
    // bayrak kapalı
    let r = await ask(id, userA, "hangisi daha uygun?", [search()]);
    expect(r.seen[0]?.resultFacts).toBeUndefined();

    // bayrak açık ama kullanıcı listede değil
    enable(String(userB));
    r = await ask(id, userA, "hangisi daha uygun?", [search()]);
    expect(r.seen[0]?.resultFacts).toBeUndefined();

    // izinli kullanıcı ama mesaj soru değil
    enable(String(userA));
    r = await ask(id, userA, "siyah olsun", [search()]);
    expect(r.seen[0]?.resultFacts).toBeUndefined();
  });

  it("an answer from a model that was given no facts is refused and the normal fallback search runs", async () => {
    const id = await conversationWithSearch();
    const { outcome } = await ask(id, userA, "hangisi daha uygun?", [
      goodAnswer({
        resultFacts: [
          {
            id: "p1",
            title: `${TAG} lamba alfa`,
            brand: null,
            store: null,
            price_try: 100,
            offer_count: 1,
          },
        ],
      } as unknown as InterpretRequest),
    ]);
    expect(outcome.result).toMatchObject({
      status: "answered",
      source: "fallback",
      action: "search",
    });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.at(-1)).toMatchObject({ kind: "search" });
  });

  it("without a current search there are no facts to read", async () => {
    enable(String(userA));
    const created = await createConversation(db, { userId: userA, message: "hangisi daha uygun?" });
    if (created.status !== "created") throw new Error(created.status);
    const model = scripted([search()]);
    await processPendingTurnDetailed(db, {
      userId: userA,
      conversationId: created.conversationId,
      interpreter: model.interpreter,
    });
    expect(model.seen[0]?.resultFacts).toBeUndefined();
  });
});
