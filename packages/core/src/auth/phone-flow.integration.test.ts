/**
 * Telefonla giris - P0/P1 testlerinin (esanli deneme, tekrar kullanim)
 * tamamlayicisi: sure dolumu, saglayici hatasi, Netgsm adaptoru, oturum ve
 * erken erisim. Gercek Postgres; SMS saglayicisi sahte (`fetch` enjekte),
 * gercek SMS gitmez. Oran siniri enjekte edilir (Redis testi web tarafinda).
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  PhoneCodeInvalidError,
  requestPhoneLoginCode,
  signInWithPhone,
  UnsupportedPhoneCountryError,
} from "./phone-login.ts";
import { verifySessionToken } from "./session.ts";
import { DevSmsSender, SmsDeliveryError } from "./sms.ts";
import { NetgsmSmsSender } from "./sms-netgsm.ts";

const suffix = Date.now();
const phone = (n: number) => `+90554${String(suffix + n).slice(-7)}`;
const noLimit = async () => undefined;
const request = { ip: "203.0.113.130", userAgent: "vitest" };
const netgsmConfig = { usercode: "8500000000", password: "test-only", msgheader: "MANICEPTE" };
const used: string[] = [];

function netgsm(code: string) {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(
      { code, jobId: code === "00" ? "1" : undefined },
      { status: code === "00" ? 200 : 406 },
    );
  }) as typeof fetch;
  return { sender: new NetgsmSmsSender(netgsmConfig, impl), bodies };
}

async function rows(p: string) {
  return withOwnerClient(
    async (c) =>
      (await c.query("SELECT consumed_at, attempts FROM phone_login_code WHERE phone = $1", [p]))
        .rows,
  );
}

describe("telefonla giris - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query(
        `DELETE FROM app_user WHERE id IN (SELECT user_id FROM user_identity
           WHERE provider = 'phone' AND provider_subject = ANY($1))`,
        [used],
      );
      await c.query("DELETE FROM phone_login_code WHERE phone = ANY($1)", [used]);
    });
  });

  it("Netgsm ile basarili giris: ulusal numara, oturum ve erken erisim", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const p = phone(1);
    used.push(p);
    const { sender, bodies } = netgsm("00");
    await requestPhoneLoginCode(db, { phone: `0${p.slice(3)}`, ip: request.ip }, sender, {
      checkRateLimit: noLimit,
      generateCode: () => "135790",
    });
    expect(bodies[0]).toMatchObject({ msgheader: "MANICEPTE", no: p.slice(3) });
    expect(String(bodies[0]?.msg)).toContain("135790");

    const result = await signInWithPhone(
      db,
      { phone: p, code: "135790", ...request },
      { checkRateLimit: noLimit },
    );
    expect(result.isNewUser).toBe(true);
    expect((await verifySessionToken(db, result.rawSessionToken))?.id).toBe(result.user.id);
    const ea = await withOwnerClient((c) =>
      c.query("SELECT count(*)::int n FROM early_access WHERE user_id = $1", [result.user.id]),
    );
    expect(ea.rows[0]?.n).toBe(1);
  });

  it("saglayici hatasi: kod kullanilamaz kalir, oturum acilamaz", async () => {
    const p = phone(2);
    used.push(p);
    const { sender } = netgsm("30");
    const error = await requestPhoneLoginCode(db, { phone: p, ip: null }, sender, {
      checkRateLimit: noLimit,
      generateCode: () => "246802",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(SmsDeliveryError);
    expect((await rows(p))[0]?.consumed_at).not.toBeNull();
    await expect(
      signInWithPhone(db, { phone: p, code: "246802", ...request }, { checkRateLimit: noLimit }),
    ).rejects.toBeInstanceOf(PhoneCodeInvalidError);
  });

  it("suresi dolmus kod gecmez", async () => {
    const p = phone(3);
    used.push(p);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await requestPhoneLoginCode(db, { phone: p, ip: null }, new DevSmsSender(), {
      checkRateLimit: noLimit,
      generateCode: () => "111333",
      now: past,
    });
    await expect(
      signInWithPhone(db, { phone: p, code: "111333", ...request }, { checkRateLimit: noLimit }),
    ).rejects.toBeInstanceOf(PhoneCodeInvalidError);
  });

  it("desteklenmeyen ulke: veritabanina yazilmaz, SMS gitmez", async () => {
    const { sender, bodies } = netgsm("00");
    await expect(
      requestPhoneLoginCode(db, { phone: "+442079460958", ip: null }, sender, {
        checkRateLimit: noLimit,
      }),
    ).rejects.toBeInstanceOf(UnsupportedPhoneCountryError);
    expect(bodies).toHaveLength(0);
    expect(await rows("+442079460958")).toHaveLength(0);
  });
});
