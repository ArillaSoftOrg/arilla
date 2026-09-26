/**
 * Apple ve telefonla giris - gercek Postgres. Redis gerekmez: oran siniri
 * kontrolu enjekte edilir. SMS `DevSmsSender`'in kutusundan okunur.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { signInWithApple } from "./apple-oauth.ts";
import { PhoneCodeInvalidError, requestPhoneLoginCode, signInWithPhone } from "./phone-login.ts";
import { verifySessionToken } from "./session.ts";
import { DevSmsSender } from "./sms.ts";

const suffix = Date.now();
const APPLE_SUB = `test-apple-sub-${suffix}`;
const APPLE_EMAIL = `apple-${suffix}@privaterelay.example.test`;
// +90 555 ... : gercek bir aboneye denk gelmeyen test numarasi.
const PHONE = `+90555${String(suffix).slice(-7)}`;

const noLimit = async () => undefined;
const request = { ip: "203.0.113.7", userAgent: "vitest" };

async function cleanup(): Promise<void> {
  await withOwnerClient(async (client) => {
    const users = `SELECT user_id FROM user_identity
                    WHERE (provider = 'apple' AND provider_subject = $1)
                       OR (provider = 'phone' AND provider_subject = $2)`;
    await client.query(`DELETE FROM session WHERE user_id IN (${users})`, [APPLE_SUB, PHONE]);
    await client.query(`DELETE FROM app_user WHERE id IN (${users})`, [APPLE_SUB, PHONE]);
    await client.query("DELETE FROM phone_login_code WHERE phone = $1", [PHONE]);
  });
}

async function sessionCountFor(provider: string, subject: string): Promise<number> {
  return withOwnerClient(async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM session s
         JOIN user_identity i ON i.user_id = s.user_id
        WHERE i.provider = $1 AND i.provider_subject = $2`,
      [provider, subject],
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

describe("Apple / telefon ile giris - entegrasyon", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it("Apple: ayni sub tekrar giriste ayni kullaniciyi bulur", async () => {
    const claims = {
      sub: APPLE_SUB,
      email: APPLE_EMAIL,
      emailVerified: true,
      isPrivateEmail: true,
    };
    const first = await signInWithApple(db, { claims, displayName: "Ayşe Y.", ...request });
    const second = await signInWithApple(db, { claims, displayName: null, ...request });

    expect(first.isNewUser).toBe(true);
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(first.user.email).toBe(APPLE_EMAIL);
  });

  it("Apple: e-posta donmese de mevcut kimlikle giris yapar, e-postayi silmez", async () => {
    const result = await signInWithApple(db, {
      claims: { sub: APPLE_SUB, email: null, emailVerified: false, isPrivateEmail: false },
      displayName: null,
      ...request,
    });
    expect(result.isNewUser).toBe(false);
    expect(result.user.email).toBe(APPLE_EMAIL);

    const sessionUser = await verifySessionToken(db, result.rawSessionToken);
    expect(sessionUser?.id).toBe(result.user.id);

    const stored = await withOwnerClient((client) =>
      client.query(
        "SELECT email FROM user_identity WHERE provider = 'apple' AND provider_subject = $1",
        [APPLE_SUB],
      ),
    );
    expect(stored.rows[0]?.email).toBe(APPLE_EMAIL);
  });

  it("Telefon: kod duz metin saklanmaz", async () => {
    const sender = new DevSmsSender();
    await requestPhoneLoginCode(db, { phone: PHONE, ip: request.ip }, sender, {
      checkRateLimit: noLimit,
      generateCode: () => "482913",
    });
    const rows = await withOwnerClient((client) =>
      client.query("SELECT code_hash FROM phone_login_code WHERE phone = $1", [PHONE]),
    );
    expect(rows.rows[0]?.code_hash).not.toContain("482913");
    expect(sender.outbox[0]?.to).toBe(PHONE);
    expect(sender.outbox[0]?.body).toContain("482913");
  });

  it("Telefon: kod yanlissa oturum olusmaz", async () => {
    await expect(
      signInWithPhone(
        db,
        { phone: PHONE, code: "000000", ...request },
        { checkRateLimit: noLimit },
      ),
    ).rejects.toBeInstanceOf(PhoneCodeInvalidError);
    expect(await sessionCountFor("phone", PHONE)).toBe(0);
  });

  it("Telefon: kod dogruysa kullanici acilir ve oturum olusur", async () => {
    // Yerel yazimla girilen numara ayni E.164 kimligine cozulur.
    const local = `0${PHONE.slice(3)}`;
    const result = await signInWithPhone(
      db,
      { phone: local, code: "482913", ...request },
      { checkRateLimit: noLimit },
    );
    expect(result.isNewUser).toBe(true);
    expect(result.user.email).toBeNull();
    const sessionUser = await verifySessionToken(db, result.rawSessionToken);
    expect(sessionUser?.id).toBe(result.user.id);
    expect(await sessionCountFor("phone", PHONE)).toBe(1);
  });

  it("Telefon: ayni kod tekrar kullanilamaz", async () => {
    await expect(
      signInWithPhone(
        db,
        { phone: PHONE, code: "482913", ...request },
        { checkRateLimit: noLimit },
      ),
    ).rejects.toBeInstanceOf(PhoneCodeInvalidError);
    expect(await sessionCountFor("phone", PHONE)).toBe(1);
  });

  it("Telefon: yeni kodla tekrar giris ayni kullaniciyi bulur; deneme siniri kodu kilitler", async () => {
    const sender = new DevSmsSender();
    await requestPhoneLoginCode(db, { phone: PHONE, ip: request.ip }, sender, {
      checkRateLimit: noLimit,
      generateCode: () => "111222",
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        signInWithPhone(
          db,
          { phone: PHONE, code: "999999", ...request },
          { checkRateLimit: noLimit },
        ),
      ).rejects.toBeInstanceOf(PhoneCodeInvalidError);
    }
    // Dogru kod bile artik gecmez: kod basina deneme hakki bitti.
    await expect(
      signInWithPhone(
        db,
        { phone: PHONE, code: "111222", ...request },
        { checkRateLimit: noLimit },
      ),
    ).rejects.toBeInstanceOf(PhoneCodeInvalidError);

    await requestPhoneLoginCode(db, { phone: PHONE, ip: request.ip }, sender, {
      checkRateLimit: noLimit,
      generateCode: () => "333444",
    });
    const again = await signInWithPhone(
      db,
      { phone: PHONE, code: "333444", ...request },
      { checkRateLimit: noLimit },
    );
    expect(again.isNewUser).toBe(false);
  });
});
