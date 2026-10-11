import { webExitClick } from "@arilla/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { recordWebExit, signWebExit, verifyWebExit } from "./exit.ts";

const SESSION = `web-exit-test-${Date.now()}`;

describe("recordWebExit() - integration (gercek Postgres)", () => {
  const db = getTestDb();

  afterAll(async () => {
    await withOwnerClient((client) =>
      client.query("DELETE FROM web_exit_click WHERE session_id = $1", [SESSION]),
    );
  });

  it("dogrulanmis cikisi deftere yazar; dogrulanmamis fiyat yazilmaz", async () => {
    const verified = verifyWebExit(
      signWebExit({
        url: "https://shop.com.tr/urun/abc",
        kind: "exact",
        price: 129_990,
        priceStatus: "verified",
        surface: "search",
        position: 2,
      }),
    );
    const unverified = verifyWebExit(
      signWebExit({
        url: "https://baska.com.tr/urun/x?renk=siyah",
        kind: "similar",
        price: null,
        priceStatus: "unverified",
        surface: "link",
        position: null,
      }),
    );
    if (!verified || !unverified) throw new Error("token");

    const a = await recordWebExit(db, { payload: verified, sessionId: SESSION, userId: null });
    const b = await recordWebExit(db, { payload: unverified, sessionId: SESSION, userId: null });

    const rows = await db.select().from(webExitClick).where(eq(webExitClick.sessionId, SESSION));
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.id === a.clickId);
    const rowB = rows.find((r) => r.id === b.clickId);
    expect(rowA).toMatchObject({
      host: "shop.com.tr",
      matchKind: "exact",
      priceAtClick: 129_990,
      priceStatus: "verified",
      surface: "search",
      resultPosition: 2,
    });
    expect(rowB).toMatchObject({
      host: "baska.com.tr",
      matchKind: "similar",
      priceAtClick: null,
      priceStatus: "unverified",
      surface: "link",
      resultPosition: null,
    });
  });

  it("guvensiz adres deftere yazilmaz", async () => {
    await expect(
      recordWebExit(db, {
        payload: {
          url: "http://10.0.0.1/x",
          kind: "exact",
          price: null,
          priceStatus: "unverified",
          surface: "search",
          position: null,
        },
        sessionId: SESSION,
        userId: null,
      }),
    ).rejects.toThrow();
  });

  it("uygulama rolu defteri degistiremez (append-only)", async () => {
    await withOwnerClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE arilla_app");
        await expect(
          client.query("UPDATE web_exit_click SET host = 'x.com' WHERE session_id = $1", [SESSION]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query("ROLLBACK");
      }
    });
    await withOwnerClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE arilla_app");
        await expect(
          client.query("DELETE FROM web_exit_click WHERE session_id = $1", [SESSION]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });
});
