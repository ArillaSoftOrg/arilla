import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
