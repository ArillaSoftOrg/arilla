/**
 * Erken erisim kaydi - gercek Postgres. Kayit dort giris yolunun ortak
 * adiminda (`createSessionForUser`) yazilir; burada e-posta, telefon/Apple
 * ve Google uzerinden denetlenir. `PRODUCT_ACCESS` her testte acikca
 * ayarlanir.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdminForbiddenError } from "../admin/capabilities.ts";
import { earlyAccessOverview } from "../admin/early-access.ts";
import { signInWithGoogle } from "../auth/google-oauth.ts";
import { signInWithIdentity } from "../auth/identity-sign-in.ts";
import { generateRawToken, hashToken } from "../auth/token.ts";
import { verifyLoginToken } from "../auth/verify-login-token.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { ensureEarlyAccess, getEarlyAccess } from "./early-access.ts";

const suffix = Date.now();
const EMAIL = `ea-email-${suffix}@example.test`;
const EXISTING_EMAIL = `ea-existing-${suffix}@example.test`;
const ADMIN_EMAIL = `ea-admin-${suffix}@example.test`;
const MODERATOR_EMAIL = `ea-moderator-${suffix}@example.test`;
const OPEN_EMAIL = `ea-open-${suffix}@example.test`;
const RACE_SUB = `ea-race-${suffix}`;
const request = { ip: "203.0.113.60", userAgent: "vitest" };

async function rowsFor(userId: number): Promise<{ status: string; created_at: Date }[]> {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "SELECT status, created_at FROM early_access WHERE user_id = $1",
      [userId],
    );
    return res.rows;
  });
}

async function emailLogin(db: Database, email: string) {
  const raw = generateRawToken();
  await withOwnerClient((client) =>
    client.query(
      "INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
      [email, hashToken(raw)],
    ),
  );
  return verifyLoginToken(db, { rawToken: raw, ...request });
}

async function cleanup(): Promise<void> {
  await withOwnerClient(async (client) => {
    const emails = [EMAIL, EXISTING_EMAIL, ADMIN_EMAIL, MODERATOR_EMAIL, OPEN_EMAIL];
    await client.query("DELETE FROM app_user WHERE email = ANY($1)", [emails]);
    await client.query(
      `DELETE FROM app_user WHERE id IN (SELECT user_id FROM user_identity
         WHERE provider = 'apple' AND provider_subject = $1)`,
      [RACE_SUB],
    );
    await client.query("DELETE FROM auth_token WHERE email = ANY($1)", [emails]);
  });
}

describe("erken erisim kaydi - entegrasyon", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(cleanup);

  it("ilk giris (e-posta) kayit acar; tekrar giris ikinci kayit acmaz", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const first = await emailLogin(db, EMAIL);
    const [row] = await rowsFor(first.user.id);
    expect(row?.status).toBe("pending");

    const second = await emailLogin(db, EMAIL);
    expect(second.user.id).toBe(first.user.id);
    const rows = await rowsFor(first.user.id);
    expect(rows).toHaveLength(1);
    // Ilk katilim tarihi korunur.
    expect(rows[0]?.created_at.getTime()).toBe(row?.created_at.getTime());
  });

  it("listeye ilk kez giren mevcut kullanici da kayit alir (Google)", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const existingId = await withOwnerClient(async (client) => {
      const res = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        EXISTING_EMAIL,
      ]);
      return Number(res.rows[0].id);
    });
    expect(await rowsFor(existingId)).toHaveLength(0);

    const result = await signInWithGoogle(db, {
      profile: {
        sub: `ea-google-${suffix}`,
        email: EXISTING_EMAIL,
        emailVerified: true,
        name: null,
        picture: null,
      },
      ...request,
    });
    expect(result.user.id).toBe(existingId);
    expect(await rowsFor(existingId)).toHaveLength(1);
  });

  it("esanli ilk girisler tek kayit olusturur (Apple/telefon yolu)", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        signInWithIdentity(db, {
          provider: "apple",
          subject: RACE_SUB,
          email: null,
          emailVerified: false,
          displayName: null,
          ...request,
        }),
      ),
    );
    const userId = results[0]?.user.id ?? 0;
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    expect(await rowsFor(userId)).toHaveLength(1);
  });

  it("ensureEarlyAccess idempotent: tekrar cagri hata vermez, satir cogalmaz", async () => {
    const user = (await emailLogin(db, EMAIL)).user;
    await Promise.all([ensureEarlyAccess(db, user.id), ensureEarlyAccess(db, user.id)]);
    expect(await rowsFor(user.id)).toHaveLength(1);
    expect((await getEarlyAccess(db, user.id))?.status).toBe("pending");
  });

  it("yetkili (admin) giris listeye yazilmaz", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const adminId = await withOwnerClient(async (client) => {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [ADMIN_EMAIL],
      );
      return Number(res.rows[0].id);
    });
    await emailLogin(db, ADMIN_EMAIL);
    expect(await rowsFor(adminId)).toHaveLength(0);
  });

  it("moderator girisi de listeye yazilmaz (personel; urunu de goremez)", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const modId = await withOwnerClient(async (client) => {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [MODERATOR_EMAIL],
      );
      return Number(res.rows[0].id);
    });
    await emailLogin(db, MODERATOR_EMAIL);
    expect(await rowsFor(modId)).toHaveLength(0);
  });

  it("urun acikken giris listeye yazilmaz", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    const result = await emailLogin(db, OPEN_EMAIL);
    expect(await rowsFor(result.user.id)).toHaveLength(0);
  });

  it("yonetim ozeti: yalnizca yonetici okur, kayitlar gorunur", async () => {
    const overview = await earlyAccessOverview(db, { userId: 1, role: "admin" });
    expect(overview.total).toBeGreaterThanOrEqual(3);
    expect(overview.byStatus.map((row) => row.status)).toContain("pending");
    expect(overview.recent.length).toBeGreaterThan(0);
    expect(Object.keys(overview.recent[0] ?? {}).sort()).toEqual([
      "createdAt",
      "publicId",
      "status",
    ]);

    await expect(earlyAccessOverview(db, { userId: 1, role: "moderator" })).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });
});
