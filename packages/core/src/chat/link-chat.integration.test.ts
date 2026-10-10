/**
 * Sohbette ürün linki (karar 0090) — gerçek Postgres + Redis. Worker SAHTEDİR:
 * `link_resolution_request` satırı doğrudan güncellenir. Model sahte sayaçlı
 * istemcidir; ağ yok. Her senaryo kendi kullanıcısını açar (oran sınırı
 * kullanıcı başınadır).
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount } from "../account/delete-account.ts";
import { LINK_RESOLUTION_QUEUE_KEY } from "../discovery/link-resolution.ts";
import { LlmError } from "../llm/client.ts";
import type { ProviderBudgetHooks, ProviderBudgetReservation } from "../quota/provider-budget.ts";
import { getRedis } from "../redis/client.ts";
import { invalidateLexiconCache } from "../search/lexicon-cache.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { ChatInterpreter, InterpretRequest } from "./interpreter.ts";
import type { ChatLinkPayload } from "./link.ts";
import { planLinkTurn } from "./link-turn.ts";
import { getChatLinkView, loadChatLinkResults } from "./link-view.ts";
import {
  type ChatMessageView,
  createConversation,
  loadConversation,
  processPendingTurn,
  submitUserMessage,
} from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `cl${Date.now().toString(36)}`;
const BLACK = `blk${run}`;
const WHITE = `wht${run}`;
const SPORT = `sprt${run}`;
const USAGE = { inputTokens: 20, outputTokens: 8, thoughtTokens: 0, totalTokens: 28 };

let db: Database;
const users: number[] = [];
const conversations: string[] = [];
let urlCounter = 0;

function freshUrl(): string {
  urlCounter += 1;
  return `https://zq${run}.test/urun/${urlCounter}`;
}

async function owner<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return withOwnerClient(async (client) => (await client.query(text, params)).rows as T[]);
}

async function newUser(): Promise<number> {
  const rows = await owner<{ id: string }>(
    "INSERT INTO app_user (email) VALUES ($1) RETURNING id",
    [`${run}-${randomUUID().slice(0, 8)}@test.invalid`],
  );
  const id = Number(rows[0]?.id);
  users.push(id);
  return id;
}

type Scripted = unknown | Error;

function model(
  values: Scripted[] = [],
  modelVersion = "test-model",
): ChatInterpreter & {
  calls: number;
  requests: InterpretRequest[];
} {
  const queue = [...values];
  const state = { calls: 0, requests: [] as InterpretRequest[] };
  return {
    modelVersion,
    get calls() {
      return state.calls;
    },
    get requests() {
      return state.requests;
    },
    async interpret(request, opts) {
      state.calls++;
      state.requests.push(request);
      const next = queue.shift();
      if (next instanceof Error) {
        opts?.onCall?.({ modelVersion, httpStatus: null, usage: null });
        throw next;
      }
      opts?.onCall?.({ modelVersion, httpStatus: 200, usage: USAGE });
      return { value: next, usage: USAGE, modelVersion };
    },
  };
}

const searchReply = (intent: Record<string, unknown>) => ({
  action: "search",
  message: "Tercihlerini anladım.",
  question: null,
  intent: { reset: false, remove: [], ...intent },
});

interface Chat {
  user: number;
  id: string;
}

async function say(
  user: number,
  conversationId: string | null,
  text: string,
  interpreter: ChatInterpreter = model(),
): Promise<{ chat: Chat; last: ChatMessageView | undefined; messages: ChatMessageView[] }> {
  let id = conversationId;
  if (id === null) {
    const created = await createConversation(db, { userId: user, message: text });
    if (created.status !== "created") throw new Error(`create failed: ${created.status}`);
    id = created.conversationId;
    conversations.push(id);
  } else {
    const sent = await submitUserMessage(db, {
      userId: user,
      conversationId: id,
      request: { kind: "text", text },
    });
    if (sent.status !== "queued") throw new Error(`submit failed: ${sent.status}`);
  }
  const result = await processPendingTurn(db, { userId: user, conversationId: id, interpreter });
  if (result.status !== "answered") throw new Error(`turn failed: ${JSON.stringify(result)}`);
  const view = await loadConversation(db, { userId: user, conversationId: id });
  const messages = view?.messages ?? [];
  return { chat: { user, id }, last: messages.at(-1), messages };
}

function linkOf(message: ChatMessageView | undefined): ChatLinkPayload {
  if (message?.role !== "assistant" || message.kind !== "notice" || !message.link) {
    throw new Error(`no link payload: ${JSON.stringify(message)}`);
  }
  return message.link;
}

async function chargeRows(userId: number) {
  return owner<{ state: string; link_request_id: string | null }>(
    "SELECT state, link_request_id FROM ai_search_charge WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
}

async function requestRows(conversationId: string) {
  return owner<{ id: string; status: string }>(
    "SELECT id, status FROM link_resolution_request WHERE session_id = $1",
    [`chat:${conversationId}`],
  );
}

async function usageCount(userId: number): Promise<number> {
  const rows = await owner<{ n: number }>(
    "SELECT count(*)::int AS n FROM api_usage WHERE user_id = $1 AND operation = 'chat_turn'",
    [userId],
  );
  return rows[0]?.n ?? 0;
}

const SOURCE = {
  site: `zq${run}.test`,
  title: `Zq${run} deneme sneaker`,
  brand: null,
  category: null,
  image_status: "embedded",
};

async function fakeWorkerResolve(
  requestId: string,
  options: { source?: Record<string, unknown> | null; finishedHoursAgo?: number } = {},
) {
  await owner(
    `UPDATE link_resolution_request
        SET status = 'resolved', source = $2::jsonb,
            finished_at = now() - ($3::int * interval '1 hour')
      WHERE id = $1`,
    [
      requestId,
      JSON.stringify(options.source === undefined ? SOURCE : options.source),
      options.finishedHoursAgo ?? 0,
    ],
  );
}

async function fakeWorkerFail(requestId: string, errorCode: string) {
  await owner(
    `UPDATE link_resolution_request
        SET status = 'failed', error_code = $2, error_text = $2, finished_at = now()
      WHERE id = $1`,
    [requestId, errorCode],
  );
}

/** Worker çözdü + durum okuması hakkı kesinleştirdi: sonraki yeni link aranabilir. */
async function settleLink(link: ChatLinkPayload) {
  if (link.requestId === null) throw new Error("no request");
  await fakeWorkerResolve(link.requestId);
  await getChatLinkView(db, link);
}

const lexiconRows: [string, string, string][] = [
  ["color", BLACK, `black${run}`],
  ["color", WHITE, `white${run}`],
  ["style", SPORT, `sport${run}`],
];

beforeAll(async () => {
  db = getTestDb();
  for (const [kind, surface, normalized] of lexiconRows) {
    await owner(
      "INSERT INTO lexicon (kind, surface, normalized) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [kind, surface, normalized],
    );
  }
  invalidateLexiconCache(db);
});

beforeEach(() => {
  vi.stubEnv("CHAT_DISCOVERY_ENABLED", "true");
  vi.stubEnv("CHAT_LINK_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  for (const id of conversations) {
    const ids = await requestRows(id);
    for (const row of ids) {
      await getRedis().lrem(LINK_RESOLUTION_QUEUE_KEY, 0, JSON.stringify({ request_id: row.id }));
    }
    await owner("DELETE FROM link_resolution_request WHERE session_id = $1", [`chat:${id}`]);
  }
  await owner("DELETE FROM lexicon WHERE surface = ANY($1)", [[BLACK, WHITE, SPORT]]);
  invalidateLexiconCache(db);
  for (const id of users) await deleteAccount(db, id);
});

describe("link dalı: yeni bağlantı", () => {
  it("yalnız URL: model çağrılmaz, hak harcanır, notice mesajında requestId", async () => {
    const user = await newUser();
    const interpreter = model();
    const url = freshUrl();
    const { chat, messages, last } = await say(user, null, url, interpreter);

    const link = linkOf(last);
    expect(messages).toHaveLength(2);
    expect(last).toMatchObject({ role: "assistant", kind: "notice" });
    expect(link).toMatchObject({
      version: 1,
      errorCode: null,
      extraLinks: 0,
      remainderText: "",
      preferences: {},
      normalizedUrl: url,
    });
    expect(link.requestId).toMatch(/^[0-9a-f-]{36}$/);

    expect(interpreter.calls).toBe(0);
    expect(await usageCount(user)).toBe(0);
    const charges = await chargeRows(user);
    expect(charges).toEqual([{ state: "reserved", link_request_id: link.requestId }]);
    const requests = await requestRows(chat.id);
    expect(requests).toEqual([{ id: link.requestId, status: "queued" }]);
  });

  it("URL + açıklama + fiyat + renk + stil: tercihler kuruş ve kanonik etiketle saklanır", async () => {
    const user = await newUser();
    const { last } = await say(
      user,
      null,
      `Buna benzer bul ${freshUrl()} ${BLACK} olsun, ${SPORT}, 3000 TL altı, daha ucuz`,
    );
    const link = linkOf(last);
    expect(link.preferences).toEqual({
      colors: [`black${run}`],
      styles: [`sport${run}`],
      priceMaxKurus: 300000,
      sort: "cheapest",
    });
    expect(link.note).toBeNull();
    expect(link.remainderText).not.toContain("https");
    expect(last?.role === "assistant" && last.content).toContain("3.000 TL altı");
  });

  it("URL mesajın ortasında ve www. ile", async () => {
    const user = await newUser();
    const host = `www.zq${run}.test/urun/www-${++urlCounter}`;
    const { last, chat } = await say(user, null, `bak şuna ${host} ${WHITE} olsun`);
    const link = linkOf(last);
    expect(link.normalizedUrl).toContain(`zq${run}.test/urun/www-`);
    expect(link.preferences.colors).toEqual([`white${run}`]);
    expect(await requestRows(chat.id)).toHaveLength(1);
  });

  it("birden fazla link: ilki işlenir, sayı kaydedilir", async () => {
    const user = await newUser();
    const { last } = await say(user, null, `${freshUrl()} ${freshUrl()}`);
    expect(linkOf(last).extraLinks).toBe(1);
    expect(last?.role === "assistant" && last.content).toContain("ilkini");
  });

  it("geçersiz/engelli URL: sohbet içinde açıklama, hak ve istek yok", async () => {
    const user = await newUser();
    const interpreter = model();
    const { last, chat } = await say(user, null, "bak http://localhost/admin", interpreter);
    const link = linkOf(last);
    expect(link).toMatchObject({ requestId: null, errorCode: "blocked_destination" });
    expect(last?.role === "assistant" && last.content).toContain("Bu bağlantıyı açamıyoruz");
    expect(interpreter.calls).toBe(0);
    expect(await chargeRows(user)).toEqual([]);
    expect(await requestRows(chat.id)).toEqual([]);
  });

  it("aynı turu yeniden işleme: çift mesaj, çift hak ve çift istek yok", async () => {
    const user = await newUser();
    const first = await say(user, null, freshUrl());
    const link = linkOf(first.last);

    // Çökme benzetimi: asistan mesajı yazılmadı sayılır, tur yeniden işlenir.
    await owner("DELETE FROM chat_message WHERE conversation_id = $1 AND seq = 2", [first.chat.id]);
    await owner("UPDATE conversation SET message_count = 1 WHERE id = $1", [first.chat.id]);
    const again = await processPendingTurn(db, {
      userId: user,
      conversationId: first.chat.id,
      interpreter: model(),
    });
    expect(again.status).toBe("answered");

    const view = await loadConversation(db, { userId: user, conversationId: first.chat.id });
    expect(view?.messages).toHaveLength(2);
    expect(linkOf(view?.messages.at(-1)).requestId).toBe(link.requestId);
    expect(await chargeRows(user)).toHaveLength(1);
    expect(await requestRows(first.chat.id)).toHaveLength(1);

    // Tamamlanmış turu bir daha işlemek hiçbir şey yazmaz.
    const idle = await processPendingTurn(db, {
      userId: user,
      conversationId: first.chat.id,
      interpreter: model(),
    });
    expect(idle.status).toBe("idle");
  });

  it("aynı linki ikinci kullanıcı gönderince yeni hak harcanmaz (önbellek)", async () => {
    const a = await newUser();
    const b = await newUser();
    const url = freshUrl();
    const first = linkOf((await say(a, null, url)).last);
    const second = linkOf((await say(b, null, url)).last);
    expect(second.requestId).toBe(first.requestId);
    expect(await chargeRows(b)).toEqual([]);
  });

  it("hak yok: sohbet içinde kararlı kodla açıklanır, istek açılmaz", async () => {
    vi.stubEnv("AI_SEARCH_DAILY_LIMIT", "0");
    const user = await newUser();
    const { last, chat } = await say(user, null, freshUrl());
    expect(linkOf(last)).toMatchObject({ requestId: null, errorCode: "no_rights" });
    expect(last?.role === "assistant" && last.content).toContain("arama hakların bitti");
    expect(await requestRows(chat.id)).toEqual([]);
  });

  it("aktif link araması sürerken ikinci yeni link: busy (hak harcanmaz)", async () => {
    const user = await newUser();
    const first = await say(user, null, freshUrl());
    const second = await say(user, first.chat.id, freshUrl());
    expect(linkOf(second.last)).toMatchObject({ requestId: null, errorCode: "busy" });
    expect(await chargeRows(user)).toHaveLength(1);
  });

  it("oran sınırı: dakikada 3 yeni link, dördüncüsü search_rate_limited", async () => {
    const user = await newUser();
    let chatId: string | null = null;
    let last: ChatMessageView | undefined;
    for (let i = 0; i < 4; i++) {
      const out = await say(user, chatId, freshUrl());
      chatId = out.chat.id;
      last = out.last;
      if (i < 3) await settleLink(linkOf(last));
    }
    expect(linkOf(last)).toMatchObject({ requestId: null, errorCode: "search_rate_limited" });
    expect(await chargeRows(user)).toHaveLength(3);
  });

  it("bayrak kapalıyken URL'li mesaj bugünkü gibi: notice yok, hak yok, istek yok", async () => {
    vi.stubEnv("CHAT_LINK_ENABLED", "false");
    const user = await newUser();
    const interpreter = model();
    const { last, chat } = await say(user, null, `${freshUrl()} siyah olsun`, interpreter);
    expect(interpreter.calls).toBe(0);
    expect(last).toMatchObject({ role: "assistant", kind: "search", source: "fallback" });
    expect(last && "link" in last).toBe(false);
    expect(await chargeRows(user)).toEqual([]);
    expect(await requestRows(chat.id)).toEqual([]);
  });

  it("Faz 5 bayrağı tek başına link dalını açmaz", async () => {
    vi.stubEnv("CHAT_LINK_ENABLED", "false");
    vi.stubEnv("CHAT_LINK_INTERPRET_ENABLED", "true");
    const user = await newUser();
    const { last } = await say(user, null, freshUrl());
    expect(last).toMatchObject({ kind: "search" });
    expect(await chargeRows(user)).toEqual([]);
  });
});

describe("URL'siz sohbet bozulmaz", () => {
  for (const flag of ["true", "false"]) {
    it(`CHAT_LINK_ENABLED=${flag}: normal akış modelle çalışır`, async () => {
      vi.stubEnv("CHAT_LINK_ENABLED", flag);
      const user = await newUser();
      const interpreter = model([searchReply({ query: "siyah sneaker" })]);
      const { last } = await say(user, null, "siyah sneaker arıyorum", interpreter);
      expect(interpreter.calls).toBe(1);
      expect(last).toMatchObject({ role: "assistant", kind: "search", source: "model" });
      expect(await usageCount(user)).toBe(1);
      expect(await chargeRows(user)).toEqual([]);
    });
  }
});

describe("getChatLinkView / loadChatLinkResults", () => {
  async function queued() {
    const user = await newUser();
    const { last, chat } = await say(user, null, freshUrl());
    return { user, chat, link: linkOf(last) };
  }

  it("pending: yeni kuyruktaki istek", async () => {
    const { link } = await queued();
    expect(await getChatLinkView(db, link)).toEqual({ state: "pending" });
    expect(await loadChatLinkResults(db, link)).toBeNull();
  });

  it("stale: 2 dakikadan eski queued/processing", async () => {
    const { link } = await queued();
    await owner(
      "UPDATE link_resolution_request SET created_at = now() - interval '3 minutes' WHERE id = $1",
      [link.requestId],
    );
    expect(await getChatLinkView(db, link)).toEqual({ state: "stale" });
    await owner("UPDATE link_resolution_request SET status = 'processing' WHERE id = $1", [
      link.requestId,
    ]);
    expect(await getChatLinkView(db, link)).toEqual({ state: "stale" });
  });

  for (const code of [
    "robots_disallowed",
    "access_denied",
    "not_found",
    "no_product",
    "unsupported_content",
    "too_large",
    "blocked_destination",
    "invalid_url",
    "too_many_redirects",
    "rate_limited",
    "upstream_error",
    "timeout",
    "fetch_failed",
    "queue_unavailable",
    "unexpected",
  ]) {
    it(`failed(${code}): kod aynen döner ve bağlı hak iade edilir`, async () => {
      const { user, link } = await queued();
      if (link.requestId === null) throw new Error("no request");
      await fakeWorkerFail(link.requestId, code);
      expect(await getChatLinkView(db, link)).toEqual({ state: "failed", errorCode: code });
      expect((await chargeRows(user))[0]?.state).toBe("refunded");
      // İkinci okuma hakkı ikinci kez hareket ettirmez.
      await getChatLinkView(db, link);
      expect(await chargeRows(user)).toHaveLength(1);
    });
  }

  it("resolved: kaynak okunur, hak kesinleşir, sonuç tercihle yüklenir", async () => {
    const { user, link } = await queued();
    if (link.requestId === null) throw new Error("no request");
    await fakeWorkerResolve(link.requestId);
    const view = await getChatLinkView(db, link);
    expect(view).toMatchObject({ state: "resolved", textOnly: false });
    expect((await chargeRows(user))[0]?.state).toBe("settled");

    const withPrefs = { ...link, preferences: { sort: "cheapest" as const } };
    const results = await loadChatLinkResults(db, withPrefs, view);
    expect(results).not.toBeNull();
    expect(results?.preferences).toBeDefined();
    expect(results?.preferences.applied ?? []).toBeInstanceOf(Array);
  });

  it("resolved ama görsel embedding'e dönüşmedi: textOnly", async () => {
    const { link } = await queued();
    if (link.requestId === null) throw new Error("no request");
    await fakeWorkerResolve(link.requestId, { source: { ...SOURCE, image_status: "failed" } });
    expect(await getChatLinkView(db, link)).toMatchObject({ state: "resolved", textOnly: true });
  });

  it("requestId ile okuma: 24 saatlik önbellek penceresi dışında da çözülür", async () => {
    const { link } = await queued();
    if (link.requestId === null) throw new Error("no request");
    await fakeWorkerResolve(link.requestId, { finishedHoursAgo: 48 });
    expect(await getChatLinkView(db, link)).toMatchObject({ state: "resolved" });
  });

  it("kaynağı okunamayan eski çözüm: no_product", async () => {
    const { link } = await queued();
    if (link.requestId === null) throw new Error("no request");
    await fakeWorkerResolve(link.requestId, { source: null });
    expect(await getChatLinkView(db, link)).toEqual({ state: "failed", errorCode: "no_product" });
  });

  it("sorgusuz (hata) link ve bozuk kimlik veritabanına gitmeden failed", async () => {
    expect(await getChatLinkView(db, { requestId: null, errorCode: "no_rights" })).toEqual({
      state: "failed",
      errorCode: "no_rights",
    });
    expect(await getChatLinkView(db, { requestId: "x", errorCode: null })).toMatchObject({
      state: "failed",
    });
    expect(await getChatLinkView(db, { requestId: randomUUID(), errorCode: null })).toMatchObject({
      state: "failed",
      errorCode: "unexpected",
    });
  });
});

describe("takip (iyileştirme turu)", () => {
  it("daha ucuz -> siyah -> daha spor: aynı requestId, yeni hak/istek/model yok", async () => {
    const user = await newUser();
    const interpreter = model();
    const first = await say(user, null, freshUrl(), interpreter);
    const requestId = linkOf(first.last).requestId;
    const chat = first.chat;

    const second = await say(user, chat.id, "daha ucuz olsun", interpreter);
    expect(linkOf(second.last)).toMatchObject({ requestId, preferences: { sort: "cheapest" } });

    const third = await say(user, chat.id, `${BLACK} olsun`, interpreter);
    expect(linkOf(third.last)).toMatchObject({
      requestId,
      preferences: { sort: "cheapest", colors: [`black${run}`] },
    });

    const fourth = await say(user, chat.id, `daha ${SPORT}`, interpreter);
    expect(linkOf(fourth.last)).toMatchObject({
      requestId,
      preferences: { sort: "cheapest", colors: [`black${run}`], styles: [`sport${run}`] },
    });

    expect(fourth.messages).toHaveLength(8);
    expect(interpreter.calls).toBe(0);
    expect(await usageCount(user)).toBe(0);
    expect(await chargeRows(user)).toHaveLength(1);
    expect(await requestRows(chat.id)).toHaveLength(1);
  });

  it("fiyat değişir; 'fiyat sınırını kaldır' temizler; renk değişir", async () => {
    const user = await newUser();
    const first = await say(user, null, `${freshUrl()} 3000 TL altı ${BLACK}`);
    expect(linkOf(first.last).preferences).toMatchObject({ priceMaxKurus: 300000 });

    const lower = await say(user, first.chat.id, "2000 TL altı olsun");
    expect(linkOf(lower.last).preferences).toMatchObject({
      priceMaxKurus: 200000,
      colors: [`black${run}`],
    });

    const white = await say(user, first.chat.id, `${WHITE} olsun`);
    expect(linkOf(white.last).preferences.colors).toEqual([`white${run}`]);

    const cleared = await say(user, first.chat.id, "fiyat sınırını kaldır");
    const preferences = linkOf(cleared.last).preferences;
    expect(preferences.priceMaxKurus).toBeUndefined();
    expect(preferences.priceMinKurus).toBeUndefined();
    expect(preferences.colors).toEqual([`white${run}`]);
  });

  it("yeniden işleme: aynı takip aynı sonucu verir, mesaj çiftlenmez", async () => {
    const user = await newUser();
    const first = await say(user, null, freshUrl());
    const refined = await say(user, first.chat.id, "daha ucuz");
    const before = linkOf(refined.last);
    await owner("DELETE FROM chat_message WHERE conversation_id = $1 AND seq = 4", [first.chat.id]);
    await owner("UPDATE conversation SET message_count = 3 WHERE id = $1", [first.chat.id]);
    await processPendingTurn(db, {
      userId: user,
      conversationId: first.chat.id,
      interpreter: model(),
    });
    const view = await loadConversation(db, { userId: user, conversationId: first.chat.id });
    expect(view?.messages).toHaveLength(4);
    expect(linkOf(view?.messages.at(-1))).toEqual(before);
  });

  it("yeni link referansı değiştirir: tercihler sıfırlanır, kalan metinden yenisi çıkar", async () => {
    const user = await newUser();
    const first = await say(user, null, `${freshUrl()} ${BLACK} daha ucuz`);
    await settleLink(linkOf(first.last));
    const second = await say(user, first.chat.id, `${freshUrl()} ${WHITE}`);
    const link = linkOf(second.last);
    expect(link.requestId).not.toBe(linkOf(first.last).requestId);
    expect(link.preferences).toEqual({ colors: [`white${run}`] });

    const follow = await say(user, first.chat.id, "daha ucuz");
    expect(linkOf(follow.last)).toMatchObject({
      requestId: link.requestId,
      preferences: { colors: [`white${run}`], sort: "cheapest" },
    });
  });

  it("ilgisiz/yeni konu: normal akış, sonraki 'daha ucuz' da link takibi sayılmaz", async () => {
    const user = await newUser();
    const first = await say(user, null, freshUrl());
    const interpreter = model([searchReply({ query: "kırmızı elbise", reset: true })]);
    const other = await say(user, first.chat.id, "kırmızı elbise arıyorum", interpreter);
    expect(interpreter.calls).toBe(1);
    expect(other.last).toMatchObject({ kind: "search" });

    const next = model([searchReply({ sort: "cheapest" })]);
    const after = await say(user, first.chat.id, "daha ucuz olsun", next);
    expect(next.calls).toBe(1);
    expect(after.last).toMatchObject({ kind: "search" });
    expect(await chargeRows(user)).toHaveLength(1);
  });

  it("referans yokken 'daha ucuz' normal akıştır", async () => {
    const user = await newUser();
    const interpreter = model([searchReply({ query: "sneaker" })]);
    const { last } = await say(user, null, "sneaker daha ucuz olsun", interpreter);
    expect(interpreter.calls).toBe(1);
    expect(last).toMatchObject({ kind: "search" });
  });

  it("görsel referansı: 0078 davranışı değişmez, 'daha ucuz' modele gider", async () => {
    const user = await newUser();
    const created = await createConversation(db, {
      userId: user,
      message: "bunun benzeri",
      attachment: {
        bytes: Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"),
        mimeType: "image/jpeg",
        width: 64,
        height: 48,
      },
    });
    if (created.status !== "created") throw new Error("create failed");
    conversations.push(created.conversationId);
    const interpreter = model([
      searchReply({ query: "sneaker" }),
      searchReply({ sort: "cheapest" }),
    ]);
    await processPendingTurn(db, {
      userId: user,
      conversationId: created.conversationId,
      interpreter,
    });
    const next = await say(user, created.conversationId, "daha ucuz olsun", interpreter);
    expect(interpreter.calls).toBe(2);
    expect(next.last).toMatchObject({ kind: "search" });
    expect(await chargeRows(user)).toEqual([]);
  });

  it("görselli sohbette sonradan gelen link link dalına girer, takip link içindir", async () => {
    const user = await newUser();
    const created = await createConversation(db, {
      userId: user,
      message: "bunun benzeri",
      attachment: {
        bytes: Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"),
        mimeType: "image/jpeg",
        width: 64,
        height: 48,
      },
    });
    if (created.status !== "created") throw new Error("create failed");
    conversations.push(created.conversationId);
    await processPendingTurn(db, {
      userId: user,
      conversationId: created.conversationId,
      interpreter: model([searchReply({ query: "sneaker" })]),
    });
    const withLink = await say(user, created.conversationId, freshUrl());
    const followed = await say(user, created.conversationId, `${BLACK} olsun`);
    expect(linkOf(followed.last)).toMatchObject({
      requestId: linkOf(withLink.last).requestId,
      preferences: { colors: [`black${run}`] },
    });
  });

  it("tanınmayan tercih (Faz 5 kapalı): tanınan uygulanır, nazik not, model yok", async () => {
    const user = await newUser();
    const interpreter = model();
    const first = await say(user, null, `${freshUrl()} ofiste giyebileceğim ${BLACK}`, interpreter);
    const link = linkOf(first.last);
    expect(link.preferences).toEqual({ colors: [`black${run}`] });
    expect(link.note).toBe("preference_not_understood");
    expect(first.last?.role === "assistant" && first.last.content).toContain(
      "Tercihini tam anlayamadım",
    );
    expect(interpreter.calls).toBe(0);

    // Yalnız tanınmayan takip: referans korunur (normal akış), model Faz 5 kapalıyken çağrılmaz.
    const after = model([searchReply({ query: "ofis ayakkabısı" })]);
    const next = await say(user, first.chat.id, "ofiste giyebileceğim", after);
    expect(next.last).toMatchObject({ kind: "search" });
  });
});

describe("Faz 5: model yalnızca tanınmayan tercih için", () => {
  beforeEach(() => {
    vi.stubEnv("CHAT_LINK_INTERPRET_ENABLED", "true");
  });

  it("yalnız URL ve yalnız tanınan tercih: 0 çağrı", async () => {
    const user = await newUser();
    const interpreter = model();
    const first = await say(user, null, freshUrl(), interpreter);
    await say(user, first.chat.id, "daha ucuz", interpreter);
    await say(user, first.chat.id, `${BLACK} 2000 TL altı`, interpreter);
    await say(user, first.chat.id, `daha ${SPORT}`, interpreter);
    await say(user, null, `${freshUrl()} ${WHITE} 3000 TL altı`, interpreter);
    expect(interpreter.calls).toBe(0);
    expect(await usageCount(user)).toBe(0);
  });

  it("kalıntı varsa TEK çağrı: api_usage yazılır, yalnız doğrulanan alanlar alınır, URL gitmez", async () => {
    const user = await newUser();
    const url = freshUrl();
    const interpreter = model([
      searchReply({
        query: "kendi uydurması",
        category: "ayakkabı",
        brand: "Nike",
        excludeBrands: ["Adidas"],
        size: "42",
        colors: [BLACK, "morumsu"],
        attributes: [
          { key: "style", value: SPORT },
          { key: "uydurma", value: "yok" },
        ],
        priceMax: 99999,
        sort: "cheapest",
      }),
    ]);
    const { last } = await say(user, null, `${url} ofiste giyebileceğim`, interpreter);
    const link = linkOf(last);
    expect(interpreter.calls).toBe(1);
    expect(await usageCount(user)).toBe(1);
    // Fiyat metinde yok: groundPatch uydurmayı atar.
    expect(link.preferences).toEqual({
      colors: [`black${run}`],
      styles: [`sport${run}`],
      sort: "cheapest",
    });
    expect(link.note).toBeNull();

    // Modele giden istek: URL yok, asistan/link mesajı yok, amaç etiketli.
    const sent = JSON.stringify(interpreter.requests);
    expect(sent).not.toContain("https");
    expect(sent).not.toContain(`zq${run}`);
    expect(interpreter.requests[0]?.purpose).toBe("link_preference");
    expect(interpreter.requests[0]?.messages.every((m) => m.role === "user")).toBe(true);
    expect(interpreter.requests[0]?.image ?? null).toBeNull();
  });

  it("sağlayıcı bütçesi: link turu gerçek deneme sayısına kesinleştirilir (0 çağrı = tam iade)", async () => {
    const reservation: ProviderBudgetReservation = {
      operation: "chat_turn",
      key: `provider-budget:chat_turn:test-${run}`,
      ttlSeconds: 60,
      reserved: 3,
    };
    const settled: number[] = [];
    const budget: ProviderBudgetHooks = {
      reserve: async () => ({ allowed: true, reservation }),
      settle: async (_reservation, attempts) => {
        settled.push(attempts);
      },
    };
    const turn = async (text: string, interpreter: ChatInterpreter) => {
      const user = await newUser();
      const created = await createConversation(db, { userId: user, message: text });
      if (created.status !== "created") throw new Error(`create failed: ${created.status}`);
      conversations.push(created.conversationId);
      const result = await processPendingTurn(db, {
        userId: user,
        conversationId: created.conversationId,
        interpreter,
        budget,
      });
      expect(result.status).toBe("answered");
    };

    await turn(freshUrl(), model());
    expect(settled).toEqual([0]);

    const interpreter = model([searchReply({ attributes: [{ key: "style", value: SPORT }] })]);
    await turn(`${freshUrl()} ofiste giyebileceğim`, interpreter);
    expect(interpreter.calls).toBe(1);
    expect(settled).toEqual([0, 1]);
  });

  it("maliyet: fiyatlı modelle link tercihi çağrısı api_usage'a sıfırdan büyük maliyetle yazılır", async () => {
    vi.stubEnv("LLM_COST_TRY_PER_USD", "40");
    const user = await newUser();
    const interpreter = model(
      [searchReply({ attributes: [{ key: "style", value: SPORT }] })],
      "gemini-3.1-flash-lite",
    );
    await say(user, null, `${freshUrl()} ofiste giyebileceğim`, interpreter);
    const rows = await owner<{ cost_micros: string; model_version: string }>(
      "SELECT cost_micros, model_version FROM api_usage WHERE user_id = $1 AND operation = 'chat_turn'",
      [user],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model_version).toBe("gemini-3.1-flash-lite");
    expect(Number(rows[0]?.cost_micros)).toBeGreaterThan(0);
  });

  it("günlük sağlayıcı tavanı dolu: link turu modele gitmez, bütçe kesinleştirilecek bir şey yok", async () => {
    const settle = vi.fn(async () => {});
    const user = await newUser();
    const created = await createConversation(db, {
      userId: user,
      message: `${freshUrl()} ofiste giyebileceğim`,
    });
    if (created.status !== "created") throw new Error(`create failed: ${created.status}`);
    conversations.push(created.conversationId);
    const interpreter = model([searchReply({ attributes: [{ key: "style", value: SPORT }] })]);
    const result = await processPendingTurn(db, {
      userId: user,
      conversationId: created.conversationId,
      interpreter,
      budget: { reserve: async () => ({ allowed: false }), settle },
    });
    expect(result.status).toBe("answered");
    expect(interpreter.calls).toBe(0);
    expect(await usageCount(user)).toBe(0);
    expect(settle).not.toHaveBeenCalled();
    const view = await loadConversation(db, {
      userId: user,
      conversationId: created.conversationId,
    });
    expect(linkOf(view?.messages.at(-1)).note).toBe("preference_not_understood");
  });

  it("takipte de yalnız kalıntı varsa çağrılır ve tercihler birleşir", async () => {
    const user = await newUser();
    const first = await say(user, null, `${freshUrl()} ${BLACK}`);
    const interpreter = model([searchReply({ attributes: [{ key: "style", value: SPORT }] })]);
    const next = await say(user, first.chat.id, "ofiste giyebileceğim", interpreter);
    expect(interpreter.calls).toBe(1);
    expect(linkOf(next.last).preferences).toEqual({
      colors: [`black${run}`],
      styles: [`sport${run}`],
    });
    // Önceki URL'li mesaj modele gitmez.
    expect(JSON.stringify(interpreter.requests)).not.toContain("https");
    expect(await chargeRows(user)).toHaveLength(1);
  });

  it("model URL üretirse çıktı reddedilir: tanınanlar uygulanır, not eklenir", async () => {
    const user = await newUser();
    const interpreter = model([
      {
        ...searchReply({ colors: [WHITE] }),
        message: "Bak https://kotu.example/x",
      },
    ]);
    const { last } = await say(user, null, `${freshUrl()} ofiste giyebileceğim`, interpreter);
    const link = linkOf(last);
    expect(interpreter.calls).toBe(1);
    expect(link.preferences).toEqual({});
    expect(link.note).toBe("preference_not_understood");
  });

  it("model hatası: deterministik yedek, sohbet sürer, deneme api_usage'a yazılır", async () => {
    const user = await newUser();
    const interpreter = model([new LlmError("timeout")]);
    const { last } = await say(
      user,
      null,
      `${freshUrl()} ${BLACK} ofiste giyebileceğim`,
      interpreter,
    );
    const link = linkOf(last);
    expect(link.preferences).toEqual({ colors: [`black${run}`] });
    expect(link.note).toBe("preference_not_understood");
    expect(await usageCount(user)).toBe(1);
  });

  it("model yalnızca uydurma alan döndürürse hiçbir tercih eklenmez", async () => {
    const user = await newUser();
    const interpreter = model([
      searchReply({ brand: "Nike", category: "ayakkabı", query: "x", colors: ["turkuaz"] }),
    ]);
    const { last } = await say(user, null, `${freshUrl()} ofiste giyebileceğim`, interpreter);
    expect(linkOf(last).preferences).toEqual({});
    expect(linkOf(last).note).toBe("preference_not_understood");
  });

  it("günlük tavan dolu (planLinkTurn): model çağrılmaz, yedek ve not", async () => {
    const user = await newUser();
    const interpreter = model();
    const conversationId = randomUUID();
    const plan = await planLinkTurn(db, {
      userId: user,
      conversationId,
      lastSeq: 1,
      modelAllowed: false,
      interpreter,
      messages: [
        { role: "user", kind: "text", content: `${freshUrl()} ${BLACK} ofiste giyebileceğim` },
      ],
    });
    conversations.push(conversationId);
    expect(interpreter.calls).toBe(0);
    expect(plan?.link.preferences).toEqual({ colors: [`black${run}`] });
    expect(plan?.link.note).toBe("preference_not_understood");
    expect(plan?.calls).toEqual([]);
  });

  it("bayrak kapalıyken kalıntı: tanınan uygulanır, not var, model yok", async () => {
    vi.stubEnv("CHAT_LINK_INTERPRET_ENABLED", "false");
    const user = await newUser();
    const interpreter = model();
    const { last } = await say(user, null, `${freshUrl()} ${WHITE} ofiste`, interpreter);
    expect(interpreter.calls).toBe(0);
    expect(linkOf(last).preferences).toEqual({ colors: [`white${run}`] });
    expect(linkOf(last).note).toBe("preference_not_understood");
  });

  it("uzun/yeni konu mesajı takip sayılmaz: normal akış", async () => {
    const user = await newUser();
    const first = await say(user, null, freshUrl());
    const interpreter = model([searchReply({ query: "çanta" })]);
    const next = await say(
      user,
      first.chat.id,
      "uzun bir çanta arıyorum aslında hem de şık olsun",
      interpreter,
    );
    expect(next.last).toMatchObject({ kind: "search" });
  });
});
