import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRedis } from "../redis/client.ts";
import { getTestDb } from "../test-db.ts";
import { recordSearchAndCheckWall } from "./search-wall.ts";

describe("recordSearchAndCheckWall() - entegrasyon (gerçek Redis)", () => {
  const sessionId = `e2-search-wall-${Date.now()}`;

  beforeAll(() => {
    // .env yüklemesini tetikler (test-db.ts'in yan etkisi) - REDIS_URL bu sayede dolu.
    getTestDb();
  });

  afterAll(async () => {
    await getRedis().del(`search-wall:${sessionId}`);
  });

  it("FREE_SEARCHES_BEFORE_LOGIN sınırına kadar duvar göstermez, sonra gösterir", async () => {
    const limit = Number(process.env.FREE_SEARCHES_BEFORE_LOGIN ?? 3);

    for (let i = 0; i < limit; i++) {
      const result = await recordSearchAndCheckWall(sessionId);
      expect(result.shouldShowWall).toBe(false);
    }

    const overLimit = await recordSearchAndCheckWall(sessionId);
    expect(overLimit.shouldShowWall).toBe(true);
  });
});
