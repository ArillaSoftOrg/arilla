/**
 * Karar 0101 - sohbet gorsel acik rizasi, gercek yerel Postgres (migration 0063).
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  CHAT_IMAGE_CONSENT_VERSION,
  getChatImageConsent,
  hasChatImageConsent,
  recordChatImageConsent,
} from "./image-consent.ts";

const run = `ic${Date.now().toString(36)}`;
let db: Database;
let userId = 0;
let otherId = 0;
let seq = 0;

async function newUser(): Promise<number> {
  return withOwnerClient(async (client) => {
    const row = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
      `consent-${run}-${seq++}@test.invalid`,
    ]);
    return Number(row.rows[0].id);
  });
}

beforeAll(async () => {
  db = getTestDb();
  userId = await newUser();
  otherId = await newUser();
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userId, otherId]]);
  });
});

const rows = (id: number) =>
  withOwnerClient(async (client) => {
    const r = await client.query(
      "SELECT granted, source, text_version, ip FROM user_consent WHERE user_id = $1 AND kind = 'chat_image' ORDER BY id",
      [id],
    );
    return r.rows;
  });

describe("chat_image rizasi", () => {
  it("kayit yokken riza yok, karar verilmemis", async () => {
    expect(await getChatImageConsent(db, userId)).toEqual({ granted: false, decided: false });
    expect(await hasChatImageConsent(db, userId)).toBe(false);
  });

  it("ret yazilir ama gorsel acmaz", async () => {
    await recordChatImageConsent(db, { userId, granted: false, source: "chat_image_prompt" });
    expect(await getChatImageConsent(db, userId)).toEqual({ granted: false, decided: true });
  });

  it("kabul yazilir: surum ve kaynak kayitli, IP yok", async () => {
    const result = await recordChatImageConsent(db, {
      userId,
      granted: true,
      source: "chat_image_prompt",
    });
    expect(result.written).toBe(true);
    expect(await hasChatImageConsent(db, userId)).toBe(true);
    const last = (await rows(userId)).at(-1);
    expect(last).toMatchObject({
      granted: true,
      source: "chat_image_prompt",
      text_version: CHAT_IMAGE_CONSENT_VERSION,
      ip: null,
    });
  });

  it("ayni karar tekrarlanirsa satir yazilmaz", async () => {
    const before = (await rows(userId)).length;
    const again = await recordChatImageConsent(db, {
      userId,
      granted: true,
      source: "chat_image_prompt",
    });
    expect(again.written).toBe(false);
    expect((await rows(userId)).length).toBe(before);
  });

  it("geri cekme: riza biter, gecmis satirlar korunur (yalniz ekleme)", async () => {
    const before = (await rows(userId)).length;
    await recordChatImageConsent(db, { userId, granted: false, source: "account_settings" });
    expect(await hasChatImageConsent(db, userId)).toBe(false);
    expect((await rows(userId)).length).toBe(before + 1);
  });

  it("eski metin surumune verilmis kabul gecersiz sayilir", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted, source, text_version) VALUES ($1, 'chat_image', true, 'chat_image_prompt', 'chat-image-2000-01-01')",
        [otherId],
      );
    });
    expect(await getChatImageConsent(db, otherId)).toEqual({ granted: false, decided: true });
  });

  it("baska kullanicinin rizasi gecmez", async () => {
    const fresh = await newUser();
    try {
      expect(await hasChatImageConsent(db, fresh)).toBe(false);
    } finally {
      await withOwnerClient((c) => c.query("DELETE FROM app_user WHERE id = $1", [fresh]));
    }
  });
});
