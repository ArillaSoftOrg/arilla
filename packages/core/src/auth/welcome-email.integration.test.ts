import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getSmtpTransport } from "../email/transport.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { signInWithGoogle } from "./google-oauth.ts";
import { signInWithIdentity } from "./identity-sign-in.ts";
import { requestLoginLink } from "./request-login-link.ts";
import { verifyLoginToken } from "./verify-login-token.ts";

/**
 * Hoş geldin e-postası yalnızca ilk hesap oluşturmada (Google, Apple, e-posta
 * bağlantısı) gider; tekrar giriş, mevcut hesapla eşleşme, doğrulanmamış adres ve
 * Apple gizli aktarma adresi için gitmez; gönderim hatası girişi bozmaz.
 * Postgres + Redis + Mailpit gerekir (`MAILPIT_API`, varsayılan http://localhost:8025).
 */
const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025";
const WELCOME = "ManiCepte'ye hoş geldin";
const suffix = Date.now();
let counter = 0;
const created: string[] = [];

function freshEmail(label: string): string {
  const email = `wlc-${label}-${suffix}-${counter++}@example.test`;
  created.push(email);
  return email;
}

function freshIp(): string {
  counter += 1;
  return `192.0.2.${(suffix + counter) % 250}`;
}

async function messages(email: string): Promise<{ ID: string; Subject: string }[]> {
  const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return ((await search.json()) as { messages?: { ID: string; Subject: string }[] }).messages ?? [];
}

async function waitForSubject(email: string, subject: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const hit = (await messages(email)).find((m) => m.Subject === subject);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`e-posta gelmedi: ${email} / ${subject}`);
}

async function welcomeCount(email: string): Promise<number> {
  return (await messages(email)).filter((m) => m.Subject === WELCOME).length;
}

const owner = <T>(sql: string, params: unknown[] = []) =>
  withOwnerClient(async (client) => (await client.query(sql, params)).rows as T[]);

function googleProfile(email: string, sub: string, emailVerified = true) {
  return { sub, email, emailVerified, name: "Test Kişi", picture: null };
}

describe("hoş geldin e-postası - ilk hesap oluşturma", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM auth_token WHERE email = ANY($1)", [created]);
      await client.query("DELETE FROM app_user WHERE email = ANY($1)", [created]);
    });
  });

  it("Google ilk girişte bir kez gider; tekrar girişte gitmez", async () => {
    const email = freshEmail("google");
    const sub = `g-${suffix}-${counter}`;
    const first = await signInWithGoogle(db, {
      profile: googleProfile(email, sub),
      ip: freshIp(),
      userAgent: null,
    });
    expect(first.isNewUser).toBe(true);
    await waitForSubject(email, WELCOME);

    const again = await signInWithGoogle(db, {
      profile: googleProfile(email, sub),
      ip: freshIp(),
      userAgent: null,
    });
    expect(again.isNewUser).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await welcomeCount(email)).toBe(1);
  });

  it("mevcut hesapla eşleşen Google girişi (hesap birleşmesi) hoş geldin göndermez", async () => {
    const email = freshEmail("existing");
    await owner("INSERT INTO app_user (email, email_verified_at) VALUES ($1, now())", [email]);

    const result = await signInWithGoogle(db, {
      profile: googleProfile(email, `g-${suffix}-${counter}`),
      ip: freshIp(),
      userAgent: null,
    });

    expect(result.isNewUser).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await welcomeCount(email)).toBe(0);
  });

  it("Apple (doğrulanmış gerçek adres) ilk girişte gider", async () => {
    const email = freshEmail("apple");
    const result = await signInWithIdentity(db, {
      provider: "apple",
      subject: `a-${suffix}-${counter}`,
      email,
      emailVerified: true,
      displayName: null,
      ip: freshIp(),
      userAgent: null,
    });
    expect(result.isNewUser).toBe(true);
    await waitForSubject(email, WELCOME);
  });

  it("Apple gizli aktarma adresi ve e-postasız girişte gitmez; hesap yine açılır", async () => {
    const relay = `wlc-${suffix}-${counter++}@privaterelay.appleid.com`;
    const withRelay = await signInWithIdentity(db, {
      provider: "apple",
      subject: `a-${suffix}-${counter}`,
      email: relay,
      emailVerified: true,
      displayName: null,
      ip: freshIp(),
      userAgent: null,
    });
    expect(withRelay.isNewUser).toBe(true);
    created.push(relay);

    const noEmail = await signInWithIdentity(db, {
      provider: "apple",
      subject: `a-${suffix}-${counter++}`,
      email: null,
      emailVerified: false,
      displayName: null,
      ip: freshIp(),
      userAgent: null,
    });
    expect(noEmail.isNewUser).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await welcomeCount(relay)).toBe(0);
  });

  it("e-posta giriş bağlantısıyla ilk hesap açılınca bir kez gider", async () => {
    const email = freshEmail("magic");
    const tokenOf = async (): Promise<string> => {
      const before = (await messages(email)).length;
      await requestLoginLink(db, { email, ip: freshIp() });
      for (let attempt = 0; attempt < 40; attempt++) {
        const all = await messages(email);
        if (all.length > before) {
          const message = (await (
            await fetch(`${MAILPIT}/api/v1/message/${all[0]?.ID}`)
          ).json()) as {
            Text: string;
          };
          return /token=([^&\s]+)/.exec(message.Text)?.[1] ?? "";
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("giriş e-postası gelmedi");
    };

    const first = await verifyLoginToken(db, {
      rawToken: await tokenOf(),
      ip: freshIp(),
      userAgent: null,
    });
    expect(first.isNewUser).toBe(true);
    await waitForSubject(email, WELCOME);

    expect(await welcomeCount(email)).toBe(1);
  });

  it("SMTP hatası girişi engellemez ve hoş geldin kaybolur (en fazla bir kez)", async () => {
    const email = freshEmail("smtpfail");
    vi.spyOn(getSmtpTransport(), "sendMail").mockRejectedValue(
      Object.assign(new Error("boom"), { code: "ECONNECTION" }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await signInWithGoogle(db, {
      profile: googleProfile(email, `g-${suffix}-${counter}`),
      ip: freshIp(),
      userAgent: null,
    });

    expect(result.isNewUser).toBe(true);
    expect(result.rawSessionToken).toBeTruthy();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain(email);
    expect(await welcomeCount(email)).toBe(0);
  });

  it("takılan SMTP girişi dakikalarca bekletmez (yanıt ~4 sn'de döner)", async () => {
    const email = freshEmail("smtphang");
    vi.spyOn(getSmtpTransport(), "sendMail").mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const result = await signInWithGoogle(db, {
      profile: googleProfile(email, `g-${suffix}-${counter}`),
      ip: freshIp(),
      userAgent: null,
    });

    expect(result.isNewUser).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15000);
});
