/**
 * Arama hakki - gercek Postgres (docs/decisions/0046). Ayirma/kesinlestirme/
 * iade, esanlilik, motor kisitlari, davet ve odul tekilligi, durum-bilgili
 * link uzlasmasi.
 *
 * Test edilen kod uygulama rolu (`DATABASE_URL`, arilla_app) ile baglanir;
 * kurulum/temizlik sahip rol ile.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { grantFirstFeedbackReward } from "./bonus.ts";
import {
  findActiveCharge,
  getCharge,
  refundCharge,
  reserveSearch,
  settleCharge,
} from "./charge.ts";
import { DEFAULT_DAILY_SEARCH_LIMIT } from "./config.ts";
import {
  reconcileLinkRequestCharge,
  reconcileStaleCharges,
  reserveSearchReconciling,
} from "./reconcile.ts";
import { attachReferral, getOrCreateReferralCode } from "./referral.ts";
import { getEntitlementStatus, listEntitlementHistory } from "./status.ts";

const tag = `ent-${Date.now()}`;
const created: number[] = [];

async function newUser(label: string): Promise<number> {
  return withOwnerClient(async (client) => {
    const res = await client.query<{ id: string }>(
      "INSERT INTO app_user (email) VALUES ($1) RETURNING id",
      [`${tag}-${label}-${randomUUID().slice(0, 8)}@example.test`],
    );
    const id = Number(res.rows[0]?.id);
    created.push(id);
    return id;
  });
}

function key(): string {
  return randomUUID();
}

async function owner<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withOwnerClient(async (client) => (await client.query(text, params)).rows as T[]);
}

async function setBonus(userId: number, balance: number): Promise<void> {
  await owner(
    `INSERT INTO bonus_account (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
    [userId, balance],
  );
}

async function setUsedToday(userId: number, used: number): Promise<void> {
  await owner(
    `INSERT INTO ai_quota_day (user_id, day, daily_limit, used)
     VALUES ($1, (now() AT TIME ZONE 'Europe/Istanbul')::date, $2, $3)
     ON CONFLICT (user_id, day) DO UPDATE SET used = EXCLUDED.used`,
    [userId, DEFAULT_DAILY_SEARCH_LIMIT, used],
  );
}

async function balanceOf(userId: number): Promise<number> {
  const [row] = await owner<{ balance: number }>(
    "SELECT balance FROM bonus_account WHERE user_id = $1",
    [userId],
  );
  return row?.balance ?? 0;
}

async function ledgerOf(userId: number) {
  return owner<{ delta: number; requested: number; reason: string; idempotency_key: string }>(
    "SELECT delta, requested, reason, idempotency_key FROM bonus_ledger WHERE user_id = $1 ORDER BY id",
    [userId],
  );
}

async function reserveOk(db: Database, userId: number, operation: "visual_search" | "link_search") {
  const result = await reserveSearch(db, { userId, operation, requestKey: key() });
  if (result.status !== "reserved") throw new Error(`beklenen reserved, gelen ${result.status}`);
  return result.charge;
}

describe("arama hakki - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await owner("DELETE FROM app_user WHERE id = ANY($1)", [created]);
  });

  describe("ayir -> kesinlestir / iade", () => {
    let user: number;
    beforeEach(async () => {
      user = await newUser("life");
    });

    it("gunluk haktan harcar, kesinlesir; durum 1/10 gosterir", async () => {
      const charge = await reserveOk(db, user, "visual_search");
      expect(charge).toMatchObject({ state: "reserved", fromDaily: 1, fromBonus: 0 });
      expect(await settleCharge(db, charge.id)).toBe(true);
      expect(await settleCharge(db, charge.id)).toBe(false);
      const status = await getEntitlementStatus(db, user);
      expect(status).toMatchObject({ dailyLimit: 10, dailyUsed: 1, dailyRemaining: 9, bonus: 0 });
      expect((await getCharge(db, charge.id))?.state).toBe("settled");
    });

    it("gunluk bitince bonustan harcar ve deftere yazar", async () => {
      await setUsedToday(user, 10);
      await setBonus(user, 2);
      const charge = await reserveOk(db, user, "link_search");
      expect(charge).toMatchObject({ fromDaily: 0, fromBonus: 1 });
      expect(await balanceOf(user)).toBe(1);
      expect(await ledgerOf(user)).toEqual([
        {
          delta: -1,
          requested: -1,
          reason: "search_charge",
          idempotency_key: `charge:${charge.id}`,
        },
      ]);
    });

    it("ikisi de bitince exhausted, hicbir sey yazmaz", async () => {
      await setUsedToday(user, 10);
      const result = await reserveSearch(db, {
        userId: user,
        operation: "visual_search",
        requestKey: key(),
      });
      expect(result.status).toBe("exhausted");
      expect(await findActiveCharge(db, user)).toBeNull();
      const status = await getEntitlementStatus(db, user);
      expect(status.exhausted).toBe(true);
    });

    it("ayni istek anahtari ikinci kez hak almaz (replay)", async () => {
      const requestKey = key();
      const first = await reserveSearch(db, { userId: user, operation: "visual_search", requestKey });
      const second = await reserveSearch(db, { userId: user, operation: "visual_search", requestKey });
      expect(first.status).toBe("reserved");
      expect(second.status).toBe("replay");
      if (first.status === "reserved" && second.status === "replay") {
        expect(second.charge.id).toBe(first.charge.id);
      }
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(1);
    });

    it("suren arama varken farkli anahtar busy doner", async () => {
      const active = await reserveOk(db, user, "visual_search");
      const result = await reserveSearch(db, {
        userId: user,
        operation: "link_search",
        requestKey: key(),
      });
      expect(result.status).toBe("busy");
      await settleCharge(db, active.id);
      expect(
        (await reserveSearch(db, { userId: user, operation: "link_search", requestKey: key() }))
          .status,
      ).toBe("reserved");
    });

    it("iade gunluk ve bonus hakki tam bir kez geri verir; iadeden sonra kesinlesmez", async () => {
      await setUsedToday(user, 10);
      await setBonus(user, 1);
      const charge = await reserveOk(db, user, "visual_search");
      expect(await balanceOf(user)).toBe(0);
      expect(await refundCharge(db, charge.id, "provider_error")).toBe(true);
      expect(await refundCharge(db, charge.id, "provider_error")).toBe(false);
      expect(await settleCharge(db, charge.id)).toBe(false);
      expect(await balanceOf(user)).toBe(1);
      const reasons = (await ledgerOf(user)).map((row) => row.reason);
      expect(reasons).toEqual(["search_charge", "search_refund"]);
      expect((await getCharge(db, charge.id))?.state).toBe("refunded");

      await setUsedToday(user, 3);
      const daily = await reserveOk(db, user, "visual_search");
      await refundCharge(db, daily.id, "internal_error");
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(3);
    });

    it("dunku ayirmanin iadesi dunku satira yazilir, bugune degil", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const result = await reserveSearch(db, {
        userId: user,
        operation: "visual_search",
        requestKey: key(),
        now: yesterday,
      });
      if (result.status !== "reserved") throw new Error(result.status);
      await setUsedToday(user, 4);
      await refundCharge(db, result.charge.id, "internal_error");
      const rows = await owner<{ day: string; used: number }>(
        "SELECT day::text AS day, used FROM ai_quota_day WHERE user_id = $1 ORDER BY day",
        [user],
      );
      expect(rows.map((row) => row.used)).toEqual([0, 4]);
    });

    it("gecmis listesi aramalari ve bonus kazanimlarini gosterir", async () => {
      const charge = await reserveOk(db, user, "visual_search");
      await settleCharge(db, charge.id);
      await db.transaction((tx) => grantFirstFeedbackReward(tx, user));
      const history = await listEntitlementHistory(db, user);
      expect(history.map((item) => item.kind).sort()).toEqual(["bonus", "search"]);
    });
  });

  describe("esanlilik", () => {
    it("20 paralel ayirma: tek aktif arama, geri kalani busy", async () => {
      const user = await newUser("par");
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          reserveSearch(db, { userId: user, operation: "visual_search", requestKey: key() }),
        ),
      );
      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts).toEqual({ reserved: 1, busy: 19 });
      expect((await getEntitlementStatus(db, user)).dailyUsed).toBe(1);
    });

    it("paralel ayir+kesinlestir donguleri limiti ve bakiyeyi asamaz", async () => {
      const user = await newUser("drain");
      await setUsedToday(user, 8);
      await setBonus(user, 3);
      let settled = 0;
      async function worker(): Promise<void> {
        for (let guard = 0; guard < 200; guard++) {
          const r = await reserveSearch(db, {
            userId: user,
            operation: "visual_search",
            requestKey: key(),
          });
          if (r.status === "exhausted") return;
          if (r.status === "reserved") {
            if (await settleCharge(db, r.charge.id)) settled++;
          }
        }
      }
      await Promise.all(Array.from({ length: 10 }, worker));
      expect(settled).toBe(5); // 2 gunluk + 3 bonus
      const status = await getEntitlementStatus(db, user);
      expect(status).toMatchObject({ dailyUsed: 10, bonus: 0, exhausted: true });
    });

    it("ayni anahtarla paralel istekler tek harcama uretir", async () => {
      const user = await newUser("samekey");
      const requestKey = key();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          reserveSearch(db, { userId: user, operation: "visual_search", requestKey }),
        ),
      );
      expect(results.filter((r) => r.status === "reserved")).toHaveLength(1);
      expect(results.filter((r) => r.status === "replay")).toHaveLength(9);
      const [row] = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM ai_search_charge WHERE user_id = $1",
        [user],
      );
      expect(Number(row?.n)).toBe(1);
    });

    it("paralel iadeler tam bir kez geri verir", async () => {
      const user = await newUser("refund");
      await setUsedToday(user, 10);
      await setBonus(user, 1);
      const charge = await reserveOk(db, user, "visual_search");
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => refundCharge(db, charge.id, "provider_error")),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await balanceOf(user)).toBe(1);
    });

    it("paralel ilk geri bildirim odulu tek +3 yazar", async () => {
      const user = await newUser("fb");
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          db.transaction((tx) => grantFirstFeedbackReward(tx, user)).catch((e: Error) => e),
        ),
      );
      expect(results.filter((r) => !(r instanceof Error) && r.status === "granted")).toHaveLength(1);
      expect(await balanceOf(user)).toBe(3);
      expect(await ledgerOf(user)).toHaveLength(1);
    });
  });

  describe("motor kisitlari (uygulama rolu)", () => {
    it("bakiye eksiye, kullanim limitin ustune cikamaz; defter degistirilemez", async () => {
      const user = await newUser("check");
      await setBonus(user, 0);
      await setUsedToday(user, 10);
      await db.transaction((tx) => grantFirstFeedbackReward(tx, user));

      await expect(
        db.execute(sql`UPDATE bonus_account SET balance = -1 WHERE user_id = ${user}`),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(
        db.execute(sql`UPDATE ai_quota_day SET used = daily_limit + 1 WHERE user_id = ${user}`),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(
        db.execute(sql`UPDATE bonus_ledger SET delta = 50 WHERE user_id = ${user}`),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(
        db.execute(sql`DELETE FROM bonus_ledger WHERE user_id = ${user}`),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("ikinci reserved satiri kismi UNIQUE indeks reddeder", async () => {
      const user = await newUser("uniq");
      await reserveOk(db, user, "visual_search");
      await expect(
        db.execute(sql`
          INSERT INTO ai_search_charge (user_id, operation, request_key, cost, day, from_daily, from_bonus)
          VALUES (${user}, 'visual_search', ${key()}, 1, CURRENT_DATE, 1, 0)
        `),
      ).rejects.toMatchObject({ cause: { code: "23505", constraint: "ai_search_charge_one_active" } });
    });
  });

  describe("davet", () => {
    it("baglanir, ilk kesinlesen aramada iki tarafi odullendirir, bir kez", async () => {
      const inviter = await newUser("inviter");
      const invitee = await newUser("invitee");
      const code = await getOrCreateReferralCode(db, inviter);
      expect(await getOrCreateReferralCode(db, inviter)).toBe(code);

      expect(await attachReferral(db, { inviteeUserId: invitee, code: code.toLowerCase() })).toBe(
        "attached",
      );
      expect(await attachReferral(db, { inviteeUserId: invitee, code })).toBe("already_referred");

      // Iade edilen arama nitelemez.
      const refunded = await reserveOk(db, invitee, "visual_search");
      await refundCharge(db, refunded.id, "provider_error");
      expect(await balanceOf(invitee)).toBe(0);

      const first = await reserveOk(db, invitee, "visual_search");
      const settles = await Promise.all(Array.from({ length: 5 }, () => settleCharge(db, first.id)));
      expect(settles.filter(Boolean)).toHaveLength(1);
      expect(await balanceOf(invitee)).toBe(5);
      expect(await balanceOf(inviter)).toBe(10);

      const second = await reserveOk(db, invitee, "visual_search");
      await settleCharge(db, second.id);
      expect(await balanceOf(invitee)).toBe(5);
      expect(await balanceOf(inviter)).toBe(10);

      const [ref] = await owner<{ status: string; qualifying_charge_id: string }>(
        "SELECT status, qualifying_charge_id FROM referral WHERE invitee_user_id = $1",
        [invitee],
      );
      expect(ref).toEqual({ status: "qualified", qualifying_charge_id: first.id });
    });

    it("kendi kendini davet ve gecersiz kod reddedilir", async () => {
      const user = await newUser("self");
      const code = await getOrCreateReferralCode(db, user);
      expect(await attachReferral(db, { inviteeUserId: user, code })).toBe("self");
      expect(await attachReferral(db, { inviteeUserId: user, code: "ZZZZZZZZ" })).toBe(
        "invalid_code",
      );
      expect(await attachReferral(db, { inviteeUserId: user, code: "bad" })).toBe("invalid_code");
    });

    it("davet eden tavana yakinsa odul kirpilir ve istenen tutar kaydedilir", async () => {
      const inviter = await newUser("capinv");
      const invitee = await newUser("capee");
      await setBonus(inviter, 95);
      await attachReferral(db, {
        inviteeUserId: invitee,
        code: await getOrCreateReferralCode(db, inviter),
      });
      const charge = await reserveOk(db, invitee, "link_search");
      await settleCharge(db, charge.id);
      expect(await balanceOf(inviter)).toBe(100);
      const [entry] = await ledgerOf(inviter);
      expect(entry).toMatchObject({ delta: 5, requested: 10, reason: "referral_inviter" });
    });
  });

  describe("durum-bilgili link uzlasmasi", () => {
    async function linkRequest(status: string, ageMs: number, errorCode: string | null = null) {
      const [row] = await owner<{ id: string }>(
        `INSERT INTO link_resolution_request (url_raw, session_id, status, error_code, created_at, finished_at)
         VALUES ('https://example.test/p', 'test', $1, $2, now() - ($3 || ' milliseconds')::interval,
                 CASE WHEN $1 IN ('resolved','failed') THEN now() END)
         RETURNING id`,
        [status, errorCode, String(ageMs)],
      );
      return row?.id as string;
    }

    async function chargeFor(requestId: string, ageMs: number) {
      const user = await newUser("link");
      const charge = await reserveOk(db, user, "link_search");
      await owner(
        "UPDATE ai_search_charge SET link_request_id = $2, created_at = now() - ($3 || ' milliseconds')::interval WHERE id = $1",
        [charge.id, requestId, String(ageMs)],
      );
      return { user, chargeId: charge.id };
    }

    it("resolved -> kesinlesir, failed -> iade, yeni queued -> dokunulmaz, olu queued -> iade", async () => {
      const resolved = await chargeFor(await linkRequest("resolved", 30 * 60_000), 30 * 60_000);
      const failed = await chargeFor(await linkRequest("failed", 1_000, "not_found"), 1_000);
      const young = await linkRequest("processing", 30_000);
      const youngCharge = await chargeFor(young, 30 * 60_000); // harcama eski, is taze
      const dead = await chargeFor(await linkRequest("queued", 5 * 60_000), 5 * 60_000);

      const reqOf = async (chargeId: string) => (await getCharge(db, chargeId))?.linkRequestId as string;
      expect(await reconcileLinkRequestCharge(db, await reqOf(resolved.chargeId))).toBe("settled");
      expect(await reconcileLinkRequestCharge(db, await reqOf(failed.chargeId))).toBe("refunded");
      expect(await reconcileLinkRequestCharge(db, young)).toBe("pending");
      expect(await reconcileLinkRequestCharge(db, await reqOf(dead.chargeId))).toBe("refunded");

      const [deadRow] = await owner<{ refund_reason: string }>(
        "SELECT refund_reason FROM ai_search_charge WHERE id = $1",
        [dead.chargeId],
      );
      expect(deadRow?.refund_reason).toBe("link_stale");
      // Yas tek basina iade etmez: eski harcama + taze is hala reserved.
      expect((await getCharge(db, youngCharge.chargeId))?.state).toBe("reserved");
      await refundCharge(db, youngCharge.chargeId, "internal_error");
    });

    it("supurme eski ayirmalari duruma gore uzlastirir; ikinci kosu hicbir sey yapmaz", async () => {
      const resolved = await chargeFor(await linkRequest("resolved", 40 * 60_000), 40 * 60_000);
      const failed = await chargeFor(
        await linkRequest("failed", 40 * 60_000, "queue_unavailable"),
        40 * 60_000,
      );
      const first = await reconcileStaleCharges(db);
      expect(first.settled).toBeGreaterThanOrEqual(1);
      expect(first.refunded).toBeGreaterThanOrEqual(1);
      expect((await getCharge(db, resolved.chargeId))?.state).toBe("settled");
      const failedCharge = await owner<{ state: string; refund_reason: string }>(
        "SELECT state, refund_reason FROM ai_search_charge WHERE id = $1",
        [failed.chargeId],
      );
      expect(failedCharge[0]).toEqual({ state: "refunded", refund_reason: "queue_unavailable" });
      const again = await reconcileStaleCharges(db);
      expect(again.settled + again.refunded).toBe(0);
    });

    it("busy durumunda bitmis aktif arama uzlastirilir ve yeni arama acilir", async () => {
      const requestId = await linkRequest("resolved", 60_000);
      const { user, chargeId } = await chargeFor(requestId, 60_000);
      const result = await reserveSearchReconciling(db, {
        userId: user,
        operation: "visual_search",
        requestKey: key(),
      });
      expect(result.status).toBe("reserved");
      expect((await getCharge(db, chargeId))?.state).toBe("settled");
    });
  });
});
