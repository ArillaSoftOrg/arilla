import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  changePassword,
  checkResetTokenUsable,
  confirmEmailVerification,
  registerWithPassword,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  signInWithPassword,
} from "./email-password.ts";
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidEmailError,
  PasswordPolicyError,
  PrivateRelayEmailError,
} from "./password-errors.ts";
import { RateLimitExceededError } from "./rate-limit.ts";
import { createSessionForUser, verifySessionToken } from "./session.ts";
import { hashToken } from "./token.ts";
import { TokenAlreadyUsedError, TokenExpiredError } from "./verify-login-token.ts";

/**
 * Gerçek Postgres + Redis (oran sınırı) + Mailpit gerektirir. Mailpit HTTP
 * adresi `MAILPIT_API` (varsayılan http://localhost:8025): ileti makineden çıkmaz.
 */
const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025";
const PASSWORD = "Mavi-Kedi-Pazar-42";
const NEW_PASSWORD = "Yeni-Sifre-Hazir-77";

const suffix = Date.now();
let counter = 0;
const created: string[] = [];

function freshEmail(label: string): string {
  const email = `pw-${label}-${suffix}-${counter++}@example.test`;
  created.push(email);
  return email;
}

/** Her test ayrı IP kullanır: IP başına saatlik tavan testler arası sızmasın. */
function freshIp(): string {
  counter += 1;
  return `198.51.100.${(suffix + counter) % 250}`;
}

async function latestMailLink(
  email: string,
  pathPrefix: string,
): Promise<{ url: string; token: string }> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const body = (await search.json()) as { messages?: { ID: string }[] };
    const id = body.messages?.[0]?.ID;
    if (id) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
        Text: string;
      };
      const match = new RegExp(`https?://\\S+${pathPrefix}\\S*`).exec(message.Text);
      if (match) {
        const url = match[0];
        return { url, token: new URL(url).searchParams.get("token") ?? "" };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`e-posta gelmedi: ${email}`);
}

async function mailCount(email: string): Promise<number> {
  const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return ((await search.json()) as { messages?: unknown[] }).messages?.length ?? 0;
}

const owner = <T>(sql: string, params: unknown[] = []) =>
  withOwnerClient(async (client) => (await client.query(sql, params)).rows as T[]);

async function insertUser(email: string, role = "user"): Promise<number> {
  const rows = await owner<{ id: string }>(
    "INSERT INTO app_user (email, email_verified_at, role) VALUES ($1, now(), $2) RETURNING id",
    [email, role],
  );
  return Number(rows[0]?.id);
}

describe("e-posta + şifre akışı - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM email_credential_token WHERE email = ANY($1)", [created]);
      await client.query("DELETE FROM app_user WHERE email = ANY($1)", [created]);
    });
  });

  async function registerAndConfirm(email: string, ip = freshIp()) {
    await registerWithPassword(db, { email, password: PASSWORD, displayName: "Test Kişi", ip });
    const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
    return confirmEmailVerification(db, { rawToken: token, ip, userAgent: "vitest" });
  }

  describe("kayıt ve e-posta doğrulama", () => {
    it("kayıt anında hesap AÇMAZ; bekleyen özet token satırında, düz metin hiçbir yerde yok", async () => {
      const email = freshEmail("pending");
      await registerWithPassword(db, { email, password: PASSWORD, ip: freshIp() });

      expect(await owner("SELECT id FROM app_user WHERE email = $1", [email])).toHaveLength(0);
      const tokens = await owner<{
        purpose: string;
        token_hash: string;
        pending_password_hash: string;
      }>("SELECT * FROM email_credential_token WHERE email = $1", [email]);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.purpose).toBe("verify_email");
      expect(tokens[0]?.pending_password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
      expect(tokens[0]?.token_hash).toBe(hashToken(token));
      expect(token).not.toBe(tokens[0]?.token_hash);
      expect(JSON.stringify(tokens)).not.toContain(PASSWORD);
    });

    it("doğrulama hesabı, şifre kaydını ve oturumu tek işlemde açar", async () => {
      const email = freshEmail("verify");
      const result = await registerAndConfirm(email);

      expect(result.isNewUser).toBe(true);
      expect(result.user.email).toBe(email);
      const user = await owner<{ email_verified_at: Date | null; display_name: string }>(
        "SELECT email_verified_at, display_name FROM app_user WHERE email = $1",
        [email],
      );
      expect(user[0]?.email_verified_at).not.toBeNull();
      expect(user[0]?.display_name).toBe("Test Kişi");
      expect(
        await owner("SELECT 1 FROM password_credential WHERE user_id = $1", [result.user.id]),
      ).toHaveLength(1);
      expect((await verifySessionToken(db, result.rawSessionToken))?.id).toBe(result.user.id);
    });

    it("kullanılmış token ikinci kez çalışmaz", async () => {
      const email = freshEmail("reuse");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
      await confirmEmailVerification(db, { rawToken: token, ip, userAgent: null });
      await expect(
        confirmEmailVerification(db, { rawToken: token, ip, userAgent: null }),
      ).rejects.toThrow(TokenAlreadyUsedError);
    });

    it("süresi dolmuş token reddedilir ve hesap açılmaz", async () => {
      const email = freshEmail("expired");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
      await owner(
        "UPDATE email_credential_token SET expires_at = now() - interval '1 minute' WHERE email = $1",
        [email],
      );

      await expect(
        confirmEmailVerification(db, { rawToken: token, ip, userAgent: null }),
      ).rejects.toThrow(TokenExpiredError);
      expect(await owner("SELECT id FROM app_user WHERE email = $1", [email])).toHaveLength(0);
    });

    it("sıfırlama token'ı doğrulama amacıyla kullanılamaz (amaca özel)", async () => {
      const email = freshEmail("purpose");
      await insertUser(email);
      const ip = freshIp();
      await requestPasswordReset(db, { email, ip });
      const { token } = await latestMailLink(email, "/giris/sifre-sifirla");
      await expect(
        confirmEmailVerification(db, { rawToken: token, ip, userAgent: null }),
      ).rejects.toThrow();
    });

    it("alıcı ayrıştıran karakterli adresler reddedilir (iki alıcıya e-posta gitmez)", async () => {
      for (const bad of [
        "x,victim@example.test",
        "x;y@example.test",
        "<x>@example.test",
        'a"b@example.test',
      ]) {
        await expect(
          registerWithPassword(db, { email: bad, password: PASSWORD, ip: freshIp() }),
        ).rejects.toThrow(InvalidEmailError);
      }
    });

    it("zayıf şifre ve Apple gizli adresi reddedilir; token yazılmaz", async () => {
      const email = freshEmail("weak");
      await expect(
        registerWithPassword(db, { email, password: "kisa", ip: freshIp() }),
      ).rejects.toThrow(PasswordPolicyError);
      await expect(
        registerWithPassword(db, {
          email: freshEmail("relay").replace("@example.test", "@privaterelay.appleid.com"),
          password: PASSWORD,
          ip: freshIp(),
        }),
      ).rejects.toThrow(PrivateRelayEmailError);
      expect(
        await owner("SELECT 1 FROM email_credential_token WHERE email = $1", [email]),
      ).toHaveLength(0);
    });

    it("yeni doğrulama token'ı 15 dakika, sıfırlama token'ı 30 dakika geçerlidir", async () => {
      const email = freshEmail("ttl");
      await registerWithPassword(db, { email, password: PASSWORD, ip: freshIp() });
      const verify = await owner<{ minutes: number }>(
        "SELECT extract(epoch FROM (expires_at - created_at)) / 60 AS minutes FROM email_credential_token WHERE email = $1 AND purpose = 'verify_email'",
        [email],
      );
      expect(Math.round(Number(verify[0]?.minutes))).toBe(15);

      const known = freshEmail("ttl-reset");
      const result = await registerAndConfirm(known);
      expect(result.user.email).toBe(known);
      await requestPasswordReset(db, { email: known, ip: freshIp() });
      const reset = await owner<{ minutes: number }>(
        "SELECT extract(epoch FROM (expires_at - created_at)) / 60 AS minutes FROM email_credential_token WHERE email = $1 AND purpose = 'reset_password' AND consumed_at IS NULL",
        [known],
      );
      expect(Math.round(Number(reset[0]?.minutes))).toBe(30);
    });

    it("önceden verilmiş (eski süreli) token'ın kayıtlı süresi korunur", async () => {
      const email = freshEmail("legacy-ttl");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
      // 60 dakikalık eski süre: kalan 50 dakika hâlâ geçerli olmalı.
      await owner(
        "UPDATE email_credential_token SET created_at = now() - interval '10 minutes', expires_at = now() + interval '50 minutes' WHERE email = $1",
        [email],
      );
      const ok = await confirmEmailVerification(db, { rawToken: token, ip, userAgent: null });
      expect(ok.user.email).toBe(email);
    });

    it("süresi dolan doğrulama bağlantısı yeniden gönderilir; yeni bağlantı hesabı açar", async () => {
      const email = freshEmail("expired-resend");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const expired = await latestMailLink(email, "/giris/eposta-dogrula");
      await owner(
        "UPDATE email_credential_token SET expires_at = now() - interval '1 minute' WHERE email = $1",
        [email],
      );
      await expect(
        confirmEmailVerification(db, { rawToken: expired.token, ip, userAgent: null }),
      ).rejects.toThrow(TokenExpiredError);

      await resendVerificationEmail(db, { email, ip });
      for (let i = 0; i < 30 && (await mailCount(email)) < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const fresh = await latestMailLink(email, "/giris/eposta-dogrula");
      expect(fresh.token).not.toBe(expired.token);
      const ok = await confirmEmailVerification(db, { rawToken: fresh.token, ip, userAgent: null });
      expect(ok.user.email).toBe(email);
    });

    it("ad alanı olmadan kayıt çalışır; görünen ad boş kalır", async () => {
      const email = freshEmail("noname");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
      const ok = await confirmEmailVerification(db, { rawToken: token, ip, userAgent: null });
      const rows = await owner<{ display_name: string | null }>(
        "SELECT display_name FROM app_user WHERE id = $1",
        [ok.user.id],
      );
      expect(rows[0]?.display_name).toBeNull();
    });

    it("yeniden gönder: eski token geçersiz olur, yenisi çalışır; bekleyen kayıt yoksa sessizce biter", async () => {
      const email = freshEmail("resend");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const first = await latestMailLink(email, "/giris/eposta-dogrula");
      await resendVerificationEmail(db, { email, ip });
      // Mailpit en yeni iletiyi ilk sırada döner; iki ileti gelene kadar bekle.
      for (let i = 0; i < 30 && (await mailCount(email)) < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const second = await latestMailLink(email, "/giris/eposta-dogrula");
      expect(second.token).not.toBe(first.token);

      await expect(
        confirmEmailVerification(db, { rawToken: first.token, ip, userAgent: null }),
      ).rejects.toThrow(TokenAlreadyUsedError);
      const ok = await confirmEmailVerification(db, {
        rawToken: second.token,
        ip,
        userAgent: null,
      });
      expect(ok.user.email).toBe(email);

      const stranger = freshEmail("resend-none");
      await resendVerificationEmail(db, { email: stranger, ip });
      expect(await mailCount(stranger)).toBe(0);
    });
  });

  describe("hesap bütünlüğü", () => {
    it("var olan (ör. Google) hesabın adresiyle kayıt: yeni şifre KABUL EDİLMEZ, yalnızca 'hesabın var' e-postası gider", async () => {
      const email = freshEmail("existing");
      const userId = await insertUser(email);
      await owner(
        "INSERT INTO user_identity (user_id, provider, provider_subject, email, email_verified) VALUES ($1, 'google', $2, $3, true)",
        [userId, `g-${suffix}-${counter}`, email],
      );
      const ip = freshIp();

      await expect(
        registerWithPassword(db, { email, password: PASSWORD, ip }),
      ).resolves.toBeUndefined();

      const tokens = await owner<{ purpose: string; pending_password_hash: string | null }>(
        "SELECT purpose, pending_password_hash FROM email_credential_token WHERE email = $1",
        [email],
      );
      expect(tokens).toEqual([{ purpose: "reset_password", pending_password_hash: null }]);
      expect(
        await owner("SELECT 1 FROM password_credential WHERE user_id = $1", [userId]),
      ).toHaveLength(0);
      await expect(
        signInWithPassword(db, { email, password: PASSWORD, ip, userAgent: null }),
      ).rejects.toThrow(InvalidCredentialsError);
      expect(await owner("SELECT id FROM app_user WHERE email = $1", [email])).toHaveLength(1);
    });

    it("doğrulama beklerken adres Google ile hesaba dönüşürse şifre bağlanmaz", async () => {
      const email = freshEmail("race");
      const ip = freshIp();
      await registerWithPassword(db, { email, password: PASSWORD, ip });
      const { token } = await latestMailLink(email, "/giris/eposta-dogrula");
      const userId = await insertUser(email);

      await expect(
        confirmEmailVerification(db, { rawToken: token, ip, userAgent: null }),
      ).rejects.toThrow(EmailAlreadyRegisteredError);
      expect(
        await owner("SELECT 1 FROM password_credential WHERE user_id = $1", [userId]),
      ).toHaveLength(0);
      expect(await owner("SELECT id FROM app_user WHERE email = $1", [email])).toHaveLength(1);
    });

    it("kayıt var olan ve olmayan adres için aynı sonucu verir (hesap varlığı sızmaz)", async () => {
      const known = freshEmail("enum-known");
      await insertUser(known);
      const unknown = freshEmail("enum-unknown");
      const ip = freshIp();
      const a = await registerWithPassword(db, { email: known, password: PASSWORD, ip });
      const b = await registerWithPassword(db, { email: unknown, password: PASSWORD, ip });
      expect(a).toBe(b);
      expect(await mailCount(known)).toBe(1);
      expect(await mailCount(unknown)).toBe(1);
    });

    it("yalnızca Google'la açılmış hesap, e-postadaki sıfırlama bağlantısıyla şifre belirleyebilir", async () => {
      const email = freshEmail("google-sets");
      const userId = await insertUser(email);
      const ip = freshIp();
      await requestPasswordReset(db, { email, ip });
      const { token } = await latestMailLink(email, "/giris/sifre-sifirla");
      await resetPasswordWithToken(db, { rawToken: token, newPassword: NEW_PASSWORD });

      const signedIn = await signInWithPassword(db, {
        email,
        password: NEW_PASSWORD,
        ip,
        userAgent: null,
      });
      expect(signedIn.user.id).toBe(userId);
      expect(signedIn.isNewUser).toBe(false);
    });

    it("personel hesabı şifreyle giremez ve sıfırlama e-postası almaz", async () => {
      const email = freshEmail("staff");
      const userId = await insertUser(email, "admin");
      await owner("INSERT INTO password_credential (user_id, password_hash) VALUES ($1, $2)", [
        userId,
        "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$c29tZWhhc2hzb21laGFzaHNvbWVoYXNoc29tZWhhc2g",
      ]);
      const ip = freshIp();
      await expect(
        signInWithPassword(db, { email, password: PASSWORD, ip, userAgent: null }),
      ).rejects.toThrow(InvalidCredentialsError);
      await requestPasswordReset(db, { email, ip });
      expect(await mailCount(email)).toBe(0);
    });
  });

  describe("giriş", () => {
    it("doğru şifre oturum açar; yanlış şifre ve olmayan hesap aynı hatayı verir", async () => {
      const email = freshEmail("login");
      const ip = freshIp();
      await registerAndConfirm(email, ip);

      const ok = await signInWithPassword(db, {
        email: email.toUpperCase(),
        password: PASSWORD,
        ip,
        userAgent: "vitest",
      });
      expect(ok.user.email).toBe(email);
      expect(ok.isNewUser).toBe(false);
      expect((await verifySessionToken(db, ok.rawSessionToken))?.id).toBe(ok.user.id);

      const wrong = await signInWithPassword(db, {
        email,
        password: "Yanlis-Sifre-123",
        ip,
        userAgent: null,
      }).catch((e) => e);
      const missing = await signInWithPassword(db, {
        email: freshEmail("nobody"),
        password: PASSWORD,
        ip,
        userAgent: null,
      }).catch((e) => e);
      expect(wrong).toBeInstanceOf(InvalidCredentialsError);
      expect(missing).toBeInstanceOf(InvalidCredentialsError);
      expect(wrong.message).toBe(missing.message);
    });

    it("kaba kuvvet: aynı e-posta+IP için 5 denemeden sonra şifre denenmeden oran sınırı", async () => {
      const email = freshEmail("brute");
      const ip = freshIp();
      await registerAndConfirm(email, ip);
      for (let i = 0; i < 4; i++) {
        // registerAndConfirm giriş saymaz; kalan denemeler yanlış şifre.
        await expect(
          signInWithPassword(db, { email, password: `Yanlis-Deneme-${i}-xx`, ip, userAgent: null }),
        ).rejects.toThrow(InvalidCredentialsError);
      }
      await expect(
        signInWithPassword(db, { email, password: `Yanlis-Deneme-5-xx`, ip, userAgent: null }),
      ).rejects.toThrow(InvalidCredentialsError);
      // 6. deneme: doğru şifre bile sınıra takılır.
      await expect(
        signInWithPassword(db, { email, password: PASSWORD, ip, userAgent: null }),
      ).rejects.toThrow(RateLimitExceededError);
    });

    it("giriş denemeleri başka IP'den gelen meşru kullanıcıyı çiftle kilitlemez", async () => {
      const email = freshEmail("pair");
      const attackerIp = freshIp();
      await registerAndConfirm(email, attackerIp);
      for (let i = 0; i < 5; i++) {
        await signInWithPassword(db, {
          email,
          password: "Yanlis-Sifre-9999",
          ip: attackerIp,
          userAgent: null,
        }).catch(() => undefined);
      }
      const ok = await signInWithPassword(db, {
        email,
        password: PASSWORD,
        ip: freshIp(),
        userAgent: null,
      });
      expect(ok.user.email).toBe(email);
    });
  });

  describe("şifre sıfırlama", () => {
    it("sıfırlama şifreyi değiştirir, TÜM eski oturumları kapatır, token tek kullanımlıktır", async () => {
      const email = freshEmail("reset");
      const ip = freshIp();
      const first = await registerAndConfirm(email, ip);
      const other = await signInWithPassword(db, {
        email,
        password: PASSWORD,
        ip,
        userAgent: null,
      });

      await requestPasswordReset(db, { email, ip });
      const { token } = await latestMailLink(email, "/giris/sifre-sifirla");
      await checkResetTokenUsable(db, token);
      await resetPasswordWithToken(db, { rawToken: token, newPassword: NEW_PASSWORD });

      expect(await verifySessionToken(db, first.rawSessionToken)).toBeNull();
      expect(await verifySessionToken(db, other.rawSessionToken)).toBeNull();
      await expect(
        signInWithPassword(db, { email, password: PASSWORD, ip: freshIp(), userAgent: null }),
      ).rejects.toThrow(InvalidCredentialsError);
      await expect(
        signInWithPassword(db, { email, password: NEW_PASSWORD, ip: freshIp(), userAgent: null }),
      ).resolves.toMatchObject({ isNewUser: false });
      await expect(
        resetPasswordWithToken(db, { rawToken: token, newPassword: "Baska-Bir-Sifre-55" }),
      ).rejects.toThrow(TokenAlreadyUsedError);
    });

    it("zayıf yeni şifre token'ı tüketmez; tekrar denenebilir", async () => {
      const email = freshEmail("reset-weak");
      await insertUser(email);
      await requestPasswordReset(db, { email, ip: freshIp() });
      const { token } = await latestMailLink(email, "/giris/sifre-sifirla");
      await expect(
        resetPasswordWithToken(db, { rawToken: token, newPassword: "123" }),
      ).rejects.toThrow(PasswordPolicyError);
      await expect(
        resetPasswordWithToken(db, { rawToken: token, newPassword: NEW_PASSWORD }),
      ).resolves.toBeUndefined();
    });

    it("var olmayan adres için sessizce biter: e-posta gitmez, hata yok", async () => {
      const email = freshEmail("reset-none");
      await expect(requestPasswordReset(db, { email, ip: freshIp() })).resolves.toBeUndefined();
      expect(await mailCount(email)).toBe(0);
      expect(
        await owner("SELECT 1 FROM email_credential_token WHERE email = $1", [email]),
      ).toHaveLength(0);
    });

    it("süresi dolmuş sıfırlama token'ı reddedilir", async () => {
      const email = freshEmail("reset-expired");
      await insertUser(email);
      await requestPasswordReset(db, { email, ip: freshIp() });
      const { token } = await latestMailLink(email, "/giris/sifre-sifirla");
      await owner(
        "UPDATE email_credential_token SET expires_at = now() - interval '1 minute' WHERE email = $1",
        [email],
      );
      await expect(
        resetPasswordWithToken(db, { rawToken: token, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(TokenExpiredError);
    });

    it("aynı adrese ardışık istek oran sınırına takılır", async () => {
      const email = freshEmail("reset-rate");
      await insertUser(email);
      const ip = freshIp();
      await requestPasswordReset(db, { email, ip });
      await expect(requestPasswordReset(db, { email, ip })).rejects.toThrow(RateLimitExceededError);
    });
  });

  describe("şifre değiştirme", () => {
    it("mevcut şifre doğrulanır; bu oturum kalır, diğerleri kapanır", async () => {
      const email = freshEmail("change");
      const ip = freshIp();
      const current = await registerAndConfirm(email, ip);
      const other = await signInWithPassword(db, {
        email,
        password: PASSWORD,
        ip,
        userAgent: null,
      });

      await expect(
        changePassword(db, {
          userId: current.user.id,
          currentSessionToken: current.rawSessionToken,
          currentPassword: "Yanlis-Mevcut-Sifre-1",
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toThrow(InvalidCredentialsError);

      const revoked = await changePassword(db, {
        userId: current.user.id,
        currentSessionToken: current.rawSessionToken,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(revoked).toBe(1);
      expect(await verifySessionToken(db, current.rawSessionToken)).not.toBeNull();
      expect(await verifySessionToken(db, other.rawSessionToken)).toBeNull();
      await expect(
        signInWithPassword(db, { email, password: NEW_PASSWORD, ip: freshIp(), userAgent: null }),
      ).resolves.toMatchObject({ isNewUser: false });
    });

    it("şifresi olmayan hesap (yalnız Google) bu yolu kullanamaz", async () => {
      const email = freshEmail("change-nopw");
      const userId = await insertUser(email);
      await expect(
        changePassword(db, {
          userId,
          currentSessionToken: "x",
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it("mevcut şifre denemeleri kullanıcı başına sınırlıdır", async () => {
      const email = freshEmail("change-rate");
      const current = await registerAndConfirm(email);
      const attempt = () =>
        changePassword(db, {
          userId: current.user.id,
          currentSessionToken: current.rawSessionToken,
          currentPassword: "Yanlis-Mevcut-Sifre-1",
          newPassword: NEW_PASSWORD,
        });
      for (let i = 0; i < 5; i++) await expect(attempt()).rejects.toThrow(InvalidCredentialsError);
      await expect(attempt()).rejects.toThrow(RateLimitExceededError);
    });
  });

  it("createSessionForUser oturumu mevcut ortak modelle yazar (OAuth regresyonu: sağlayıcı alanı bozulmadı)", async () => {
    const email = freshEmail("shared");
    const userId = await insertUser(email);
    const raw = await db.transaction((tx) =>
      createSessionForUser(tx, {
        userId,
        role: "user",
        ip: null,
        userAgent: null,
        provider: "google",
        isNewUser: false,
      }),
    );
    expect((await verifySessionToken(db, raw))?.id).toBe(userId);
  });
});
