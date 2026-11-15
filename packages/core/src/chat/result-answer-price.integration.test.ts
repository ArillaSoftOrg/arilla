/**
 * Karar 0213: cevap gerçekleri, kartta gösterilen fiyatı kullanır. Kurla çevrilmiş yurt dışı fiyat
 * `price_approx` (+ kur tarihi biliniyorsa `price_date`) ile işaretlenir; kuru olmayan yabancı fiyat
 * `price_try = null` olur ama ürün sonuçtan ÇIKMAZ; kesin TRY fiyat işaretsizdir. Gerçek Postgres,
 * sahte model, ücretli çağrı yok.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { ResultFact } from "./answer.ts";
import type { ChatInterpreter, InterpretRequest } from "./interpreter.ts";
import { createConversation, processPendingTurnDetailed, submitUserMessage } from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `rp${Date.now().toString(36)}`.replace(/[0-9]/g, "k");
const TAG = `zxq${run}`;
const RATE_CCY = "KWD";
const NO_RATE_CCY = "OMR";
let db: Database;
let user = 0;
let merchantId = 0;
let rateId = 0;
const productIds: number[] = [];
const USAGE = { inputTokens: 30, outputTokens: 20, thoughtTokens: 0, totalTokens: 50 };

const FIXTURES: Array<{ name: string; price: number; currency: string }> = [
  { name: "trexact", price: 30_000, currency: "TRY" }, // 300 TL, kesin
  { name: "kurlu", price: 250, currency: RATE_CCY }, // 2,50 KWD x 100 = 250 TL, yaklaşık
  { name: "kursuz", price: 50, currency: NO_RATE_CCY }, // kur yok: fiyat bilinmiyor
];

function scripted() {
  const seen: InterpretRequest[] = [];
  const queue: unknown[] = [];
  const interpreter: ChatInterpreter = {
    modelVersion: "test-model",
    async interpret(request, opts) {
      seen.push(request);
      opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
      const value =
        queue.shift() ??
        ({
          action: "search",
          message: "Aşağıda arıyorum.",
          question: null,
          intent: { reset: false, clear: false, remove: [], query: `${TAG} lamba` },
          answer: null,
        } as const);
      return { value, usage: USAGE, modelVersion: "test-model" };
    },
  };
  return { interpreter, seen };
}

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const u = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `rp-${run}@test.invalid`,
    ]);
    user = Number(u.rows[0].id);
    const rate = await client.query(
      `INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date)
       VALUES ('tcmb', $1, 'TRY', 100, 'forex_selling', (now() AT TIME ZONE 'UTC')::date)
       ON CONFLICT (source, base, quote, rate_kind, effective_date) DO UPDATE SET rate = EXCLUDED.rate
       RETURNING id`,
      [RATE_CCY],
    );
    rateId = Number(rate.rows[0].id);
    const m = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
       VALUES ($1, 'Fiyat Magaza', $2, 'xml_feed', 80) RETURNING id`,
      [`rp-${run}`, `rp-${run}.test`],
    );
    merchantId = Number(m.rows[0].id);
    for (const f of FIXTURES) {
      const key = `${TAG}-${f.name}`;
      const p = await client.query(
        `INSERT INTO product (slug, title, min_price, primary_image_url, offer_count)
         VALUES ($1, $2, NULL, $3, 1) RETURNING id`,
        [key, `${TAG} lamba ${f.name}`, `https://img.test/${key}.jpg`],
      );
      const id = Number(p.rows[0].id);
      productIds.push(id);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, currency, is_active, in_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE)`,
        [
          merchantId,
          id,
          key,
          `https://rp-${run}.test/${f.name}`,
          `${TAG} lamba ${f.name}`,
          f.price,
          f.currency,
        ],
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
    await client.query("DELETE FROM fx_rate WHERE id = $1", [rateId]);
  });
});

describe("answer facts carry the card price (decision 0213)", () => {
  it("marks converted foreign prices approximate with the rate date, keeps price-less products, leaves exact TRY unmarked", async () => {
    vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("CHAT_RESULT_ANSWER", "true");
    vi.stubEnv("CHAT_RESULT_ANSWER_USERS", String(user));
    const created = await createConversation(db, { userId: user, message: `${TAG} lamba` });
    if (created.status !== "created") throw new Error(created.status);
    const first = scripted();
    await processPendingTurnDetailed(db, {
      userId: user,
      conversationId: created.conversationId,
      interpreter: first.interpreter,
    });
    const sent = await submitUserMessage(db, {
      userId: user,
      conversationId: created.conversationId,
      request: { kind: "text", text: "farkları açıkla" },
    });
    if (sent.status !== "queued") throw new Error(sent.status);
    const second = scripted();
    await processPendingTurnDetailed(db, {
      userId: user,
      conversationId: created.conversationId,
      interpreter: second.interpreter,
    });
    const facts = second.seen[0]?.resultFacts as ResultFact[];
    const by = (name: string) => facts.find((f) => f.title.endsWith(` ${name}`)) as ResultFact;

    expect(facts).toHaveLength(3); // fiyatı olmayan ürün sonuçtan çıkmadı
    expect(by("trexact")).toMatchObject({ price_try: 300 });
    expect(by("trexact")).not.toHaveProperty("price_approx");
    expect(by("trexact")).not.toHaveProperty("price_date");
    expect(by("kurlu")).toMatchObject({ price_try: 250, price_approx: true });
    expect(by("kurlu").price_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(by("kursuz").price_try).toBeNull();
    expect(by("kursuz")).not.toHaveProperty("price_date");
  });
});
