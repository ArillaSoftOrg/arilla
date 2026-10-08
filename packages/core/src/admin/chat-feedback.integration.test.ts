import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  getChatFeedbackDetail,
  getChatFeedbackSummary,
  isChatFeedbackDay,
  listChatFeedback,
} from "./chat-feedback.ts";

/**
 * Sabit gecmis tarihler (2020): yerel veritabanindaki baska verilerden yalitir.
 * Zaman damgalari +03 (Istanbul): gun = literalin ilk 10 hanesi.
 */
interface Vote {
  at: string;
  helpful: boolean;
  reasons?: string[];
  comment?: string;
  model?: string;
  payload?: Record<string, unknown>;
}

const NOW = new Date("2020-03-10T09:00:00+03:00");
const VOTES: Vote[] = [
  { at: "2020-02-01T12:00:00+03:00", helpful: true },
  { at: "2020-03-04T23:59:00+03:00", helpful: true },
  { at: "2020-03-05T12:00:00+03:00", helpful: true, model: "m-1" },
  { at: "2020-03-05T23:30:00+03:00", helpful: true },
  {
    at: "2020-03-06T12:00:00+03:00",
    helpful: false,
    reasons: ["irrelevant"],
    comment: "yorum-metni-gizli-kalmali",
    model: "m-1",
    payload: { source: "model" },
  },
  { at: "2020-03-07T12:00:00+03:00", helpful: false },
  {
    at: "2020-03-08T12:00:00+03:00",
    helpful: false,
    reasons: ["slow"],
    comment: "cok yavasti",
    model: "m-2",
    payload: { source: "fallback", fallbackReason: "filtered" },
  },
  { at: "2020-03-09T12:00:00+03:00", helpful: true, model: "m-1" },
  { at: "2020-03-09T23:59:00+03:00", helpful: false, reasons: ["other"] },
];
const UNVOTED_MESSAGES = 2;
const RANGE = { from: "2020-03-05", to: "2020-03-09" };

const day = (v: Vote) => v.at.slice(0, 10);
const inRange = (v: Vote) => day(v) >= RANGE.from && day(v) <= RANGE.to;

describe("sohbet geri bildirimi yonetimi - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let admin: AdminActor;
  let moderator: AdminActor;
  let voterId = 0;
  const messageIds: number[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const make = async (role: string, tag: string) =>
        Number(
          (
            await client.query("INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id", [
              `cf-${tag}-${suffix}@test.local`,
              role,
            ])
          ).rows[0].id,
        );
      admin = { userId: await make("admin", "admin"), role: "admin" };
      moderator = { userId: await make("moderator", "mod"), role: "moderator" };
      voterId = await make("user", "voter");

      const conv = await client.query(
        "INSERT INTO conversation (user_id, title) VALUES ($1, 'cf test') RETURNING id",
        [voterId],
      );
      const conversationId = String(conv.rows[0].id);
      let seq = 0;
      const addMessage = async (at: string, payload: Record<string, unknown>) => {
        seq += 1;
        const m = await client.query(
          `INSERT INTO chat_message (conversation_id, seq, role, kind, content, payload, created_at)
           VALUES ($1, $2, 'assistant', 'search', 'ozel-sohbet-metni', $3, $4) RETURNING id`,
          [conversationId, seq, JSON.stringify(payload), at],
        );
        return Number(m.rows[0].id);
      };
      for (const vote of VOTES) {
        const id = await addMessage(vote.at, vote.payload ?? { source: "model" });
        messageIds.push(id);
        await client.query(
          `INSERT INTO chat_result_feedback
             (message_id, conversation_id, helpful, reasons, comment, model_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
          [
            id,
            conversationId,
            vote.helpful,
            vote.reasons ?? [],
            vote.comment ?? null,
            vote.model ?? null,
            vote.at,
          ],
        );
      }
      for (let i = 0; i < UNVOTED_MESSAGES; i++) await addMessage("2020-03-06T15:00:00+03:00", {});
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [admin.userId, moderator.userId, voterId],
      ]);
    });
  });

  async function auditRows() {
    return withOwnerClient((c) =>
      c.query(
        "SELECT action, target_type, target_id, after FROM admin_audit_event WHERE actor_user_id = $1 ORDER BY id",
        [admin.userId],
      ),
    );
  }

  it("validates calendar days", () => {
    expect(isChatFeedbackDay("2020-03-05")).toBe(true);
    expect(isChatFeedbackDay("2020-02-31")).toBe(false);
    expect(isChatFeedbackDay("05-03-2020")).toBe(false);
    expect(isChatFeedbackDay(undefined)).toBe(false);
  });

  it("denies non-admin roles and writes no audit event", async () => {
    await expect(getChatFeedbackSummary(db, moderator, RANGE, NOW)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(listChatFeedback(db, moderator, RANGE, NOW)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(
      getChatFeedbackDetail(db, { userId: voterId, role: "user" }, messageIds[0] as number),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
    expect((await auditRows()).rows).toHaveLength(0);
  });

  it("totals, positive rate and participation match the fixture inside the range", async () => {
    const summary = await getChatFeedbackSummary(db, admin, RANGE, NOW);
    const expected = VOTES.filter(inRange);
    const positive = expected.filter((v) => v.helpful).length;
    expect(summary.totals).toMatchObject({
      total: expected.length,
      positive,
      negative: expected.length - positive,
      withComment: expected.filter((v) => v.comment).length,
    });
    expect(summary.totals.positiveRate).toBeCloseTo(positive / expected.length);
    // Oylanabilir mesajlar: aralikta olusan asistan arama mesajlari (oylu + oysuz).
    expect(summary.participation.voted).toBe(expected.length);
    expect(summary.participation.votable).toBe(expected.length + UNVOTED_MESSAGES);
    expect(summary.participation.rate).toBeCloseTo(
      expected.length / (expected.length + UNVOTED_MESSAGES),
    );
  });

  it("uses Istanbul day boundaries (23:59 +03 stays on its own day)", async () => {
    const edge = await getChatFeedbackSummary(
      db,
      admin,
      { from: "2020-03-09", to: "2020-03-09" },
      NOW,
    );
    expect(edge.totals.total).toBe(VOTES.filter((v) => day(v) === "2020-03-09").length);
    const before = await getChatFeedbackSummary(
      db,
      admin,
      { from: "2020-03-04", to: "2020-03-04" },
      NOW,
    );
    expect(before.totals.total).toBe(1);
  });

  it("reason distribution counts only negative votes, none for unspecified", async () => {
    const { reasons } = await getChatFeedbackSummary(db, admin, RANGE, NOW);
    const map = Object.fromEntries(reasons.map((r) => [r.reason, r.count]));
    expect(map).toEqual({ irrelevant: 1, slow: 1, other: 1, none: 1 });
  });

  it("7 and 30 day windows are relative to now and independent of the range filter", async () => {
    const summary = await getChatFeedbackSummary(
      db,
      admin,
      { from: "2020-03-09", to: "2020-03-09" },
      NOW,
    );
    // Son 7 gun = 2020-03-04..2020-03-10; son 30 gun = 2020-02-10..2020-03-10.
    expect(summary.last7.total).toBe(VOTES.filter((v) => day(v) >= "2020-03-04").length);
    expect(summary.last30.total).toBe(VOTES.filter((v) => day(v) >= "2020-02-10").length);
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily[29]?.day).toBe("2020-03-10");
    const sum = summary.daily.reduce((n, d) => n + d.positive + d.negative, 0);
    expect(sum).toBe(summary.last30.total);
    const march5 = summary.daily.find((d) => d.day === "2020-03-05");
    expect(march5).toMatchObject({ positive: 2, negative: 0 });
  });

  it("breaks results down by model version (null = unknown)", async () => {
    const { models } = await getChatFeedbackSummary(db, admin, RANGE, NOW);
    const byModel = Object.fromEntries(models.map((m) => [m.modelVersion ?? "unknown", m.total]));
    expect(byModel).toEqual({ "m-1": 3, "m-2": 1, unknown: 3 });
  });

  it("filters the list by direction, reason and comment, and pages with a cursor", async () => {
    const all = await listChatFeedback(db, admin, RANGE, NOW);
    expect(all.rows).toHaveLength(VOTES.filter(inRange).length);
    expect(all.rows.map((r) => r.messageId)).toEqual(
      [...all.rows.map((r) => r.messageId)].sort((a, b) => b - a),
    );

    const negative = await listChatFeedback(db, admin, { ...RANGE, helpful: false }, NOW);
    expect(negative.rows.every((r) => r.helpful === false)).toBe(true);
    expect(negative.rows).toHaveLength(VOTES.filter((v) => inRange(v) && !v.helpful).length);

    const slow = await listChatFeedback(db, admin, { ...RANGE, reason: "slow" }, NOW);
    expect(slow.rows).toHaveLength(1);
    expect(slow.rows[0]?.comment).toBe("cok yavasti");

    const commented = await listChatFeedback(db, admin, { ...RANGE, hasComment: true }, NOW);
    expect(commented.rows).toHaveLength(2);

    const second = all.rows[1] as (typeof all.rows)[number];
    const older = await listChatFeedback(db, admin, { ...RANGE, beforeId: second.messageId }, NOW);
    expect(older.rows.map((r) => r.messageId)).toEqual(all.rows.slice(2).map((r) => r.messageId));
  });

  it("list rows carry no chat text, user identity or email", async () => {
    const page = await listChatFeedback(db, admin, RANGE, NOW);
    const text = JSON.stringify(page.rows);
    expect(text).not.toContain("ozel-sohbet-metni");
    expect(text).not.toContain("@test.local");
    expect(Object.keys(page.rows[0] ?? {}).sort()).toEqual(
      [
        "comment",
        "conversationId",
        "createdAt",
        "helpful",
        "messageId",
        "messageSeq",
        "modelVersion",
        "reasons",
        "updatedAt",
      ].sort(),
    );
  });

  it("detail shows search source and fallback reason but never chat text", async () => {
    const fallbackId = messageIds[VOTES.findIndex((v) => v.comment === "cok yavasti")] as number;
    const detail = await getChatFeedbackDetail(db, admin, fallbackId);
    expect(detail).toMatchObject({
      helpful: false,
      reasons: ["slow"],
      comment: "cok yavasti",
      modelVersion: "m-2",
      searchSource: "fallback",
      fallbackReason: "filtered",
    });
    expect(JSON.stringify(detail)).not.toContain("ozel-sohbet-metni");
    expect(await getChatFeedbackDetail(db, admin, 2_000_000_000)).toBeNull();
    expect(await getChatFeedbackDetail(db, admin, -1)).toBeNull();
  });

  it("audits every list and detail view without content, comments or reasons", async () => {
    const rows = (await auditRows()).rows;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("chat_feedback.list_view");
    expect(actions).toContain("chat_feedback.view");
    const listEvent = rows.find(
      (r) => r.action === "chat_feedback.list_view" && r.after?.filters?.includes("reason"),
    );
    expect(listEvent?.after).toMatchObject({
      filters: expect.arrayContaining(["from", "to", "reason"]),
    });
    expect(listEvent?.target_type).toBe("chat_feedback");
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("yorum-metni-gizli-kalmali");
    expect(serialized).not.toContain("cok yavasti");
    expect(serialized).not.toContain("ozel-sohbet-metni");
    // Bulunamayan ayrinti denetim yazmaz.
    expect(rows.filter((r) => r.action === "chat_feedback.view")).toHaveLength(1);
  });
});
