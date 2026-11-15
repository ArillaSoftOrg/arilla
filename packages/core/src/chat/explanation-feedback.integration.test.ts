/**
 * Değerlendirme geri bildirimi (karar 0202; migration 0116) — gerçek yerel Postgres.
 * İki oy bağımsız; sahiplik; tablo yokken (migration kod'dan sonra) hiçbir şey kırılmaz; hesap
 * silme/dışa aktarma/yorum temizleme yeni tabloyu kapsar.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportUserData } from "../account/export-user-data.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { setExplanationFeedback, validateExplanationFeedback } from "./explanation-feedback.ts";
import { purgeExpiredFeedbackComments } from "./feedback.ts";
import type { ChatInterpreter } from "./interpreter.ts";
import {
  createConversation,
  loadConversation,
  processPendingTurn,
  setResultFeedback,
} from "./service.ts";

process.env.CHAT_TURNS_PER_HOUR = "200";

const run = `ef${Date.now().toString(36)}`;
let db: Database;
let userA = 0;
let userB = 0;
const USAGE = { inputTokens: 5, outputTokens: 5, thoughtTokens: 0, totalTokens: 10 };

const interpreter: ChatInterpreter = {
  modelVersion: "test-model",
  async interpret(_request, opts) {
    opts?.onCall?.({ modelVersion: "test-model", httpStatus: 200, usage: USAGE });
    return {
      value: {
        action: "search",
        message: "Aşağıda arıyorum.",
        question: null,
        intent: { reset: false, clear: false, remove: [], query: `${run} lamba` },
      },
      usage: USAGE,
      modelVersion: "test-model",
    };
  },
};

async function searchConversation(user = userA): Promise<string> {
  const created = await createConversation(db, { userId: user, message: `${run} lamba` });
  if (created.status !== "created") throw new Error(created.status);
  const done = await processPendingTurn(db, {
    userId: user,
    conversationId: created.conversationId,
    interpreter,
  });
  if (done.status !== "answered") throw new Error(done.status);
  return created.conversationId;
}

const rows = (table: string, id: string) =>
  withOwnerClient(
    async (c) => (await c.query(`SELECT * FROM ${table} WHERE conversation_id = $1`, [id])).rows,
  );

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const a = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `ef-a-${run}@test.invalid`,
    ]);
    const b = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `ef-b-${run}@test.invalid`,
    ]);
    userA = Number(a.rows[0].id);
    userB = Number(b.rows[0].id);
  });
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query(
      "ALTER TABLE IF EXISTS chat_explanation_feedback_off RENAME TO chat_explanation_feedback",
    );
    await client.query("DELETE FROM api_usage WHERE user_id = ANY($1)", [[userA, userB]]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userA, userB]]);
  });
});

describe("validateExplanationFeedback", () => {
  it("accepts a plain positive vote and negative votes with allowed reasons", () => {
    expect(validateExplanationFeedback({ helpful: true })).toEqual({
      ok: true,
      reasons: [],
      comment: null,
    });
    expect(
      validateExplanationFeedback({
        helpful: false,
        reasons: ["unclear", "unclear"],
        comment: " yanlış ",
      }),
    ).toEqual({ ok: true, reasons: ["unclear"], comment: "yanlış" });
  });
  it("rejects reasons of the other widget, positive votes with details, long comments", () => {
    expect(validateExplanationFeedback({ helpful: false, reasons: ["not_found"] })).toEqual({
      ok: false,
    });
    expect(validateExplanationFeedback({ helpful: true, reasons: ["other"] })).toEqual({
      ok: false,
    });
    expect(validateExplanationFeedback({ helpful: false, comment: "x".repeat(501) })).toEqual({
      ok: false,
    });
    expect(validateExplanationFeedback({ helpful: "yes" })).toEqual({ ok: false });
  });
});

describe("setExplanationFeedback", () => {
  it("saves independently of the result vote: neither overwrites the other", async () => {
    const id = await searchConversation();
    const base = { userId: userA, conversationId: id, messageSeq: 2 };
    expect(await setResultFeedback(db, { ...base, helpful: true })).toBe("saved");
    expect(
      await setExplanationFeedback(db, { ...base, helpful: false, reasons: ["unclear"] }),
    ).toBe("saved");
    const result = await rows("chat_result_feedback", id);
    const explanation = await rows("chat_explanation_feedback", id);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ helpful: true });
    expect(explanation).toHaveLength(1);
    expect(explanation[0]).toMatchObject({ helpful: false, reasons: ["unclear"] });
    // oy değiştirilebilir (upsert), tek satır kalır
    expect(await setExplanationFeedback(db, { ...base, helpful: true })).toBe("saved");
    const again = await rows("chat_explanation_feedback", id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ helpful: true, reasons: [] });
    // sonuç oyu etkilenmedi
    expect((await rows("chat_result_feedback", id))[0]).toMatchObject({ helpful: true });
  });

  it("the conversation view carries both votes; no vote means no field", async () => {
    const id = await searchConversation();
    const base = { userId: userA, conversationId: id, messageSeq: 2 };
    const before = await loadConversation(db, { userId: userA, conversationId: id });
    expect(before?.messages[1]).not.toHaveProperty("explanationHelpful");
    await setExplanationFeedback(db, { ...base, helpful: false, reasons: ["inaccurate"] });
    const after = await loadConversation(db, { userId: userA, conversationId: id });
    expect(after?.messages[1]).toMatchObject({ helpful: null, explanationHelpful: false });
  });

  it("ownership and message kind: another user, a user message and a missing seq are rejected", async () => {
    const id = await searchConversation();
    const base = { conversationId: id, helpful: true };
    expect(await setExplanationFeedback(db, { ...base, userId: userB, messageSeq: 2 })).toBe(
      "not_found",
    );
    expect(await setExplanationFeedback(db, { ...base, userId: userA, messageSeq: 1 })).toBe(
      "invalid",
    );
    expect(await setExplanationFeedback(db, { ...base, userId: userA, messageSeq: 99 })).toBe(
      "not_found",
    );
    expect(await setExplanationFeedback(db, { ...base, userId: userA, messageSeq: 0 })).toBe(
      "invalid",
    );
    expect(
      await setExplanationFeedback(db, {
        ...base,
        conversationId: "nope",
        userId: userA,
        messageSeq: 2,
      }),
    ).toBe("not_found");
    expect(await rows("chat_explanation_feedback", id)).toHaveLength(0);
  });

  it("is idempotent for identical content (updated_at does not move)", async () => {
    const id = await searchConversation();
    const base = {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      helpful: false,
      reasons: ["other"],
    };
    await setExplanationFeedback(db, base);
    const first = (await rows("chat_explanation_feedback", id))[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setExplanationFeedback(db, base);
    const second = (await rows("chat_explanation_feedback", id))[0];
    expect(second.updated_at).toEqual(first.updated_at);
  });
});

describe("version matrix: new code on a database without migration 0116", () => {
  it("votes are unavailable, the conversation loads, purge and export keep working, the result vote is unaffected", async () => {
    const id = await searchConversation();
    await withOwnerClient((c) =>
      c.query("ALTER TABLE chat_explanation_feedback RENAME TO chat_explanation_feedback_off"),
    );
    try {
      const base = { userId: userA, conversationId: id, messageSeq: 2 };
      expect(await setExplanationFeedback(db, { ...base, helpful: true })).toBe("unavailable");
      const view = await loadConversation(db, { userId: userA, conversationId: id });
      expect(view?.messages).toHaveLength(2);
      expect(await setResultFeedback(db, { ...base, helpful: true })).toBe("saved");
      await expect(purgeExpiredFeedbackComments(db)).resolves.toMatchObject({ truncated: false });
      const exported = await exportUserData(db, userA);
      expect(exported.conversations.length).toBeGreaterThan(0);
    } finally {
      await withOwnerClient((c) =>
        c.query("ALTER TABLE chat_explanation_feedback_off RENAME TO chat_explanation_feedback"),
      );
    }
  });
});

describe("retention, export and account deletion", () => {
  it("clears old comments in the new table too and keeps the vote and reasons", async () => {
    const id = await searchConversation();
    await setExplanationFeedback(db, {
      userId: userA,
      conversationId: id,
      messageSeq: 2,
      helpful: false,
      reasons: ["unclear"],
      comment: "kişisel not",
    });
    await withOwnerClient((c) =>
      c.query(
        "UPDATE chat_explanation_feedback SET updated_at = now() - interval '120 days' WHERE conversation_id = $1",
        [id],
      ),
    );
    const result = await purgeExpiredFeedbackComments(db);
    expect(result.cleared).toBeGreaterThanOrEqual(1);
    expect((await rows("chat_explanation_feedback", id))[0]).toMatchObject({
      helpful: false,
      reasons: ["unclear"],
      comment: null,
    });
  });

  it("exports the explanation vote and removes it with the conversation", async () => {
    const id = await searchConversation(userB);
    await setExplanationFeedback(db, {
      userId: userB,
      conversationId: id,
      messageSeq: 2,
      helpful: false,
      reasons: ["irrelevant"],
    });
    const exported = await exportUserData(db, userB);
    const chat = exported.conversations.find((c) => c.publicId === id);
    expect(chat?.messages.find((m) => m.seq === 2)?.explanationFeedback).toMatchObject({
      helpful: false,
      reasons: ["irrelevant"],
    });
    await withOwnerClient((c) => c.query("DELETE FROM conversation WHERE id = $1", [id]));
    expect(await rows("chat_explanation_feedback", id)).toHaveLength(0);
  });
});
