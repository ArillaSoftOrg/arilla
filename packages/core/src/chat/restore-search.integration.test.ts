/**
 * "Bu aramaya don" (karar 0199) — gercek yerel Postgres, sahte model. Yetkilendirme, konusma
 * sahipligi, sira butunlugu, eski mesajlarin degismemesi ve tekrar tiklama davranisi.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import type { ChatInterpreter } from "./interpreter.ts";
import {
  createConversation,
  loadConversation,
  processPendingTurn,
  RESTORE_ASSISTANT_TEXT,
  restoreSearch,
  submitUserMessage,
} from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `rs${Date.now().toString(36)}`;
let db: Database;
let userA = 0;
let userB = 0;

const USAGE = { inputTokens: 5, outputTokens: 5, thoughtTokens: 0, totalTokens: 10 };

function scripted(values: unknown[]): ChatInterpreter {
  const queue = [...values];
  return {
    modelVersion: "test-model",
    async interpret(_request, opts) {
      opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
      return { value: queue.shift(), usage: USAGE, modelVersion: "test-model" };
    },
  };
}

const search = (intent: Record<string, unknown>) => ({
  action: "search",
  message: "Aşağıda arıyorum.",
  question: null,
  intent: { reset: false, remove: [], ...intent },
});

/** İki konulu konuşma: telefon (seq 2), masa lambası (seq 4). */
async function twoTopicConversation(user = userA): Promise<string> {
  const created = await createConversation(db, {
    userId: user,
    message: `${run} samsung telefon 15.000 TL altı`,
  });
  if (created.status !== "created") throw new Error(created.status);
  const id = created.conversationId;
  await processPendingTurn(db, {
    userId: user,
    conversationId: id,
    interpreter: scripted([
      search({ query: `${run} samsung telefon`, brand: "Samsung", priceMax: 15000 }),
    ]),
  });
  const sent = await submitUserMessage(db, {
    userId: user,
    conversationId: id,
    request: { kind: "text", text: "masa lambası" },
  });
  expect(sent).toMatchObject({ status: "queued" });
  await processPendingTurn(db, {
    userId: user,
    conversationId: id,
    interpreter: scripted([search({ reset: true, query: `${run} masa lambası` })]),
  });
  return id;
}

const messageRows = (id: string) =>
  withOwnerClient(async (c) => {
    const r = await c.query(
      "SELECT seq, role, kind, content, payload FROM chat_message WHERE conversation_id = $1 ORDER BY seq",
      [id],
    );
    return r.rows;
  });

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const a = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `rs-a-${run}@test.invalid`,
    ]);
    const b = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `rs-b-${run}@test.invalid`,
    ]);
    userA = Number(a.rows[0].id);
    userB = Number(b.rows[0].id);
  });
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM api_usage WHERE user_id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userA, userB]]);
  });
});

describe("restoreSearch", () => {
  it("re-runs a stored earlier intent as a new turn without touching old messages", async () => {
    const id = await twoTopicConversation();
    const before = await messageRows(id);
    expect(before.map((r) => `${r.seq}:${r.kind}`)).toEqual([
      "1:text",
      "2:search",
      "3:text",
      "4:search",
    ]);

    const result = await restoreSearch(db, {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      requestKey: `${run}-key-1`,
    });
    expect(result).toEqual({ status: "restored", seq: 6 });

    const after = await messageRows(id);
    // eski mesajlar birebir ayni, yalnizca iki yeni satir eklendi, sira ardisik
    expect(after.slice(0, 4)).toEqual(before);
    expect(after.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(after[4]).toMatchObject({ role: "user", kind: "text" });
    expect(after[4].content).toContain("samsung telefon");
    expect(after[5]).toMatchObject({
      role: "assistant",
      kind: "search",
      content: RESTORE_ASSISTANT_TEXT,
    });

    const view = await loadConversation(db, { userId: userA, conversationId: id });
    // saklanan niyet aynen donmus: marka ve butce de dahil
    expect(view?.currentIntent).toMatchObject({
      query: `${run} samsung telefon`,
      brand: "Samsung",
      priceMax: 15000,
    });
    expect(view?.awaitingReply).toBe(false);
  });

  it("a repeated click is idempotent: same key is a duplicate, same intent is already current", async () => {
    const id = await twoTopicConversation();
    const first = await restoreSearch(db, {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      requestKey: `${run}-dup-key`,
    });
    expect(first).toMatchObject({ status: "restored" });
    const count = (await messageRows(id)).length;

    // ayni anahtarla ikinci istek (cift tiklama)
    expect(
      await restoreSearch(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        requestKey: `${run}-dup-key`,
      }),
    ).toEqual({ status: "duplicate" });
    // yeni anahtarla ama niyet zaten gecerli
    expect(
      await restoreSearch(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        requestKey: `${run}-dup-key-2`,
      }),
    ).toEqual({ status: "already_current" });
    expect((await messageRows(id)).length).toBe(count);
  });

  it("only the owner can restore: another user gets not_found and nothing is written", async () => {
    const id = await twoTopicConversation();
    const before = await messageRows(id);
    expect(
      await restoreSearch(db, {
        userId: userB,
        conversationId: id,
        messageSeq: 2,
        requestKey: `${run}-foreign`,
      }),
    ).toEqual({ status: "not_found" });
    expect(await messageRows(id)).toEqual(before);
  });

  it("concurrent clicks with the same key write exactly one turn", async () => {
    const id = await twoTopicConversation();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        restoreSearch(db, {
          userId: userA,
          conversationId: id,
          messageSeq: 2,
          requestKey: `${run}-same-key`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "restored")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== "restored")
        .every((r) => r.status === "duplicate" || r.status === "already_current"),
    ).toBe(true);
    const rows = await messageRows(id);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("concurrent restores of different targets serialize: seq stays gapless, last write wins", async () => {
    const id = await twoTopicConversation();
    // iki farkli hedef, ayni anda: ikisi de yazilabilir ya da ikinci `already_current` olabilir
    const results = await Promise.all([
      restoreSearch(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 2,
        requestKey: `${run}-par-a`,
      }),
      restoreSearch(db, {
        userId: userA,
        conversationId: id,
        messageSeq: 4,
        requestKey: `${run}-par-b`,
      }),
    ]);
    expect(results.every((r) => ["restored", "already_current", "busy"].includes(r.status))).toBe(
      true,
    );
    const rows = await messageRows(id);
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.messages.length).toBe(rows.length);
    // son yazilan arama mesajinin niyeti konusmanin gecerli niyetidir
    const lastSearch = [...rows].reverse().find((r) => r.kind === "search");
    expect(view?.currentIntent).toEqual(lastSearch?.payload?.intent);
  });

  it("restoring while a model turn holds the lease is busy and writes nothing", async () => {
    const id = await twoTopicConversation();
    await withOwnerClient((c) =>
      c.query(
        "UPDATE conversation SET processing_until = now() + interval '1 minute' WHERE id = $1",
        [id],
      ),
    );
    expect(await restoreSearch(db, { userId: userA, conversationId: id, messageSeq: 2 })).toEqual({
      status: "busy",
    });
    expect((await messageRows(id)).length).toBe(4);
  });

  it("rejects non-search messages, missing messages and malformed input", async () => {
    const id = await twoTopicConversation();
    const base = { userId: userA, conversationId: id };
    expect(await restoreSearch(db, { ...base, messageSeq: 1 })).toEqual({ status: "not_found" });
    expect(await restoreSearch(db, { ...base, messageSeq: 3 })).toEqual({ status: "not_found" });
    expect(await restoreSearch(db, { ...base, messageSeq: 999 })).toEqual({ status: "not_found" });
    expect(await restoreSearch(db, { ...base, messageSeq: 0 })).toEqual({
      status: "invalid_input",
    });
    expect(await restoreSearch(db, { ...base, messageSeq: 1.5 })).toEqual({
      status: "invalid_input",
    });
    expect(
      await restoreSearch(db, { userId: userA, conversationId: "not-a-uuid", messageSeq: 2 }),
    ).toEqual({ status: "not_found" });
    expect((await messageRows(id)).length).toBe(4);
  });

  it("is busy while a user message waits for its answer", async () => {
    const id = await twoTopicConversation();
    await submitUserMessage(db, {
      userId: userA,
      conversationId: id,
      request: { kind: "text", text: "siyah olsun" },
    });
    expect(await restoreSearch(db, { userId: userA, conversationId: id, messageSeq: 2 })).toEqual({
      status: "busy",
    });
    expect((await messageRows(id)).length).toBe(5);
  });

  it("clears an open clarification question when restoring", async () => {
    const id = await twoTopicConversation();
    await withOwnerClient((c) =>
      c.query(`UPDATE conversation SET pending_question = $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify({
          id: "q1",
          title: "Hangisi?",
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
          allowCustomAnswer: true,
          skippable: true,
        }),
      ]),
    );
    expect(
      await restoreSearch(db, { userId: userA, conversationId: id, messageSeq: 2 }),
    ).toMatchObject({ status: "restored" });
    const view = await loadConversation(db, { userId: userA, conversationId: id });
    expect(view?.pendingQuestion).toBeNull();
  });
});
