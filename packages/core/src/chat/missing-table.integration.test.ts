import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportUserData } from "../account/export-user-data.ts";
import { isChatFeedbackSchemaMissing, listChatFeedback } from "../admin/chat-feedback.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { createConversation, loadConversation, setResultFeedback } from "./service.ts";

/** Kod migration'dan once dagitilirsa (0055 yok) sohbet kirilmaz. Tablo gecici olarak yeniden adlandirilir. */
describe("0055 not yet applied", () => {
  let userId = 0;
  beforeAll(async () => {
    await withOwnerClient(async (c) => {
      const r = await c.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `mt-${Date.now()}@test.invalid`,
      ]);
      userId = Number(r.rows[0].id);
    });
  });
  afterAll(async () => {
    await withOwnerClient((c) => c.query("DELETE FROM app_user WHERE id = $1", [userId]));
  });

  it("loads the conversation and rejects the vote instead of throwing", async () => {
    await withOwnerClient((c) =>
      c.query("ALTER TABLE IF EXISTS chat_result_feedback RENAME TO chat_result_feedback_off"),
    );
    try {
      const created = await createConversation(getTestDb(), { userId, message: "ayakkabi" });
      if (created.status !== "created") throw new Error("create failed");
      const view = await loadConversation(getTestDb(), {
        userId,
        conversationId: created.conversationId,
      });
      expect(view?.messages).toHaveLength(1);
      await withOwnerClient((c) =>
        c.query(
          "INSERT INTO chat_message (conversation_id, seq, role, kind, content) VALUES ($1, 2, 'assistant', 'search', 'x')",
          [created.conversationId],
        ),
      );
      expect(
        await setResultFeedback(getTestDb(), {
          userId,
          conversationId: created.conversationId,
          messageSeq: 2,
          helpful: true,
        }),
      ).toBe("invalid");
    } finally {
      await withOwnerClient((c) =>
        c.query("ALTER TABLE IF EXISTS chat_result_feedback_off RENAME TO chat_result_feedback"),
      );
    }
  });
});

/**
 * Kod 0058'den once dagitilirsa (kolonlar yok): yalniz evet/hayir yazilir, neden/yorum
 * "saved" donmeden reddedilir (sessiz kayip yok), yonetim sorgulari sema-eksik olarak taninir,
 * veri indirme kirilmaz. Kolonlar gecici olarak yeniden adlandirilir.
 */
describe("0058 not yet applied", () => {
  const COLUMNS = ["reasons", "comment", "model_version"];
  let userId = 0;
  let adminId = 0;
  beforeAll(async () => {
    await withOwnerClient(async (c) => {
      const make = async (role: string, tag: string) =>
        Number(
          (
            await c.query("INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id", [
              `mc-${tag}-${Date.now()}@test.invalid`,
              role,
            ])
          ).rows[0].id,
        );
      userId = await make("user", "u");
      adminId = await make("admin", "a");
    });
  });
  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM admin_audit_event WHERE actor_user_id = $1", [adminId]);
      await c.query("DELETE FROM app_user WHERE id = ANY($1)", [[userId, adminId]]);
    });
  });

  it("saves a bare vote, refuses reason/comment instead of dropping them, and never throws", async () => {
    const db = getTestDb();
    const created = await createConversation(db, { userId, message: "ayakkabi" });
    if (created.status !== "created") throw new Error("create failed");
    await withOwnerClient((c) =>
      c.query(
        "INSERT INTO chat_message (conversation_id, seq, role, kind, content) VALUES ($1, 2, 'assistant', 'search', 'x')",
        [created.conversationId],
      ),
    );
    const vote = (extra: object, helpful = false) =>
      setResultFeedback(db, {
        userId,
        conversationId: created.conversationId,
        messageSeq: 2,
        helpful,
        ...extra,
      });
    const rows = () =>
      withOwnerClient((c) =>
        c.query("SELECT helpful FROM chat_result_feedback WHERE conversation_id = $1", [
          created.conversationId,
        ]),
      );

    // Kolonlari "yok" say: bir oy yazilirken Postgres 42703 verir.
    for (const col of COLUMNS) {
      await withOwnerClient((c) =>
        c.query(`ALTER TABLE chat_result_feedback RENAME COLUMN ${col} TO ${col}_off`),
      );
    }
    try {
      expect(await vote({ reasons: ["slow"] })).toBe("unavailable");
      expect(await vote({ comment: "yavasti" })).toBe("unavailable");
      expect((await rows()).rows).toHaveLength(0);
      expect(await vote({})).toBe("saved");
      expect((await rows()).rows).toEqual([{ helpful: false }]);
      expect(await vote({}, true)).toBe("saved");
      expect((await rows()).rows).toEqual([{ helpful: true }]);

      let thrown: unknown;
      try {
        await listChatFeedback(db, { userId: adminId, role: "admin" });
      } catch (error) {
        thrown = error;
      }
      expect(isChatFeedbackSchemaMissing(thrown)).toBe(true);
      expect(isChatFeedbackSchemaMissing(new Error("baska hata"))).toBe(false);

      // Sohbet yuklenir ve oy gorunur (okuma yolu yalniz message_id/helpful secer).
      const view = await loadConversation(db, { userId, conversationId: created.conversationId });
      expect(view?.messages[1]).toMatchObject({ kind: "search", helpful: true });

      const exported = await exportUserData(db, userId);
      expect(exported.conversations).toHaveLength(1);
    } finally {
      await withOwnerClient(async (c) => {
        for (const col of COLUMNS) {
          await c.query(`ALTER TABLE chat_result_feedback RENAME COLUMN ${col}_off TO ${col}`);
        }
      });
    }
  });
});
