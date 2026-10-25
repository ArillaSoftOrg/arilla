import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getSmtpTransport } from "../email/transport.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  changePassword,
  confirmEmailVerification,
  registerWithPassword,
  requestPasswordReset,
  resetPasswordWithToken,
} from "./email-password.ts";
import { sendCredentialNoticeBestEffort } from "./send-credential-email.ts";

/**
 * İşlemsel e-posta şablonlarının gerçek SMTP (Mailpit) üzerinden uçtan uca
 * doğrulaması: konu, gönderen, Reply-To, tetikleyici ve içerik. İletiler
 * makineden çıkmaz; adresler `example.test`. Postgres + Redis + Mailpit gerekir
 * (`MAILPIT_API`, varsayılan http://localhost:8025).
 */
const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025";
const PASSWORD = "Mavi-Kedi-Pazar-42";
const NEW_PASSWORD = "Yeni-Sifre-Hazir-77";

const suffix = Date.now();
let counter = 0;
const created: string[] = [];

function freshEmail(label: string): string {
  const email = `tpl-${label}-${suffix}-${counter++}@example.test`;
  created.push(email);
  return email;
}

function freshIp(): string {
  counter += 1;
  return `203.0.113.${(suffix + counter) % 250}`;
}

interface MailMessage {
  Subject: string;
  Text: string;
  HTML: string;
  From: { Address: string; Name: string };
  ReplyTo: { Address: string }[];
}

/** `subject` içeren ilk iletiyi bekler (Mailpit arama gecikmesine dayanıklı). */
async function waitForMail(email: string, subject: string): Promise<MailMessage> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const body = (await search.json()) as { messages?: { ID: string; Subject: string }[] };
    const hit = body.messages?.find((m) => m.Subject === subject);
    if (hit)
      return (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as MailMessage;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`e-posta gelmedi: ${email} / ${subject}`);
}

async function subjectsFor(email: string): Promise<string[]> {
  const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  const body = (await search.json()) as { messages?: { Subject: string }[] };
  return (body.messages ?? []).map((m) => m.Subject);
}

const owner = <T>(sql: string, params: unknown[] = []) =>
  withOwnerClient(async (client) => (await client.query(sql, params)).rows as T[]);

function linkIn(message: MailMessage, pathPrefix: string): string {
  const match = new RegExp(`https?://\\S+${pathPrefix}\\S*`).exec(message.Text);
  if (!match) throw new Error("bağlantı yok");
  return match[0];
}

describe("işlemsel e-posta şablonları - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM email_credential_token WHERE email = ANY($1)", [created]);
      await client.query("DELETE FROM app_user WHERE email = ANY($1)", [created]);
    });
  });

  it("kayıt → doğrulama e-postası, onay → hoş geldin; gönderen ve Reply-To yapılandırmadan gelir", async () => {
    const email = freshEmail("flow");
    const ip = freshIp();
    await registerWithPassword(db, { email, password: PASSWORD, displayName: "Test", ip });

    const verify = await waitForMail(email, "ManiCepte hesabını doğrula");
    expect(verify.From.Address).toBe(process.env.EMAIL_FROM?.match(/<(.+)>/)?.[1]);
    expect(verify.ReplyTo.map((r) => r.Address)).toEqual([process.env.EMAIL_REPLY_TO]);
    expect(verify.Text).toContain("60 dakika geçerli");
    expect(verify.HTML).toContain("prefers-color-scheme:dark");
    // Düz metinde bağlantı var; şifre hiçbir iletide yok.
    expect(verify.Text + verify.HTML).not.toContain(PASSWORD);

    const url = linkIn(verify, "/giris/eposta-dogrula");
    const token = new URL(url).searchParams.get("token") ?? "";
    await confirmEmailVerification(db, { rawToken: token, ip, userAgent: "vitest" });

    const welcome = await waitForMail(email, "ManiCepte'ye hoş geldin");
    expect(welcome.ReplyTo.map((r) => r.Address)).toEqual([process.env.EMAIL_REPLY_TO]);
    expect(welcome.Text + welcome.HTML).not.toContain(token);
    expect(welcome.Text + welcome.HTML).not.toContain(PASSWORD);
  });

  it("Google/Apple hesabı (şifresiz) şifre sıfırlama isterse 'şifre ekle' e-postası gider; hesap birleşmez, yeni hesap açılmaz", async () => {
    const email = freshEmail("addpw");
    const rows = await owner<{ id: string }>(
      "INSERT INTO app_user (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [email],
    );
    const userId = Number(rows[0]?.id);
    await owner(
      "INSERT INTO user_identity (user_id, provider, provider_subject, email, email_verified) VALUES ($1, 'google', $2, $3, true)",
      [userId, `g-${suffix}-${counter}`, email],
    );

    await requestPasswordReset(db, { email, ip: freshIp() });
    const mail = await waitForMail(email, "ManiCepte hesabına şifre ekle");
    expect(mail.Text).toContain("30 dakika geçerli");
    expect(mail.Text).toContain("yeni hesap açılmaz");

    const token = new URL(linkIn(mail, "/giris/sifre-sifirla")).searchParams.get("token") ?? "";
    await resetPasswordWithToken(db, { rawToken: token, newPassword: NEW_PASSWORD });

    const changed = await waitForMail(email, "ManiCepte şifren değiştirildi");
    expect(changed.HTML).not.toMatch(/href=/);
    expect(changed.Text + changed.HTML).not.toContain(NEW_PASSWORD);
    expect(changed.Text + changed.HTML).not.toContain(token);
    expect(await owner("SELECT 1 FROM app_user WHERE email = $1", [email])).toHaveLength(1);
  });

  it("şifresi olan hesap için sıfırlama e-postası 'şifreni sıfırla' konusuyla gider", async () => {
    const email = freshEmail("reset");
    const ip = freshIp();
    await registerWithPassword(db, { email, password: PASSWORD, ip });
    const verify = await waitForMail(email, "ManiCepte hesabını doğrula");
    const token = new URL(linkIn(verify, "/giris/eposta-dogrula")).searchParams.get("token") ?? "";
    await confirmEmailVerification(db, { rawToken: token, ip, userAgent: "vitest" });

    await requestPasswordReset(db, { email, ip: freshIp() });
    const mail = await waitForMail(email, "ManiCepte şifreni sıfırla");
    expect(mail.Text).toContain("30 dakika geçerli");
    expect(await subjectsFor(email)).not.toContain("ManiCepte hesabına şifre ekle");
  });

  it("oturum açıkken şifre değişince bildirim gider ve şifre içermez", async () => {
    const email = freshEmail("change");
    const ip = freshIp();
    await registerWithPassword(db, { email, password: PASSWORD, ip });
    const verify = await waitForMail(email, "ManiCepte hesabını doğrula");
    const token = new URL(linkIn(verify, "/giris/eposta-dogrula")).searchParams.get("token") ?? "";
    const session = await confirmEmailVerification(db, {
      rawToken: token,
      ip,
      userAgent: "vitest",
    });

    await changePassword(db, {
      userId: session.user.id,
      currentSessionToken: session.rawSessionToken,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    const changed = await waitForMail(email, "ManiCepte şifren değiştirildi");
    expect(changed.Text + changed.HTML).not.toContain(PASSWORD);
    expect(changed.Text + changed.HTML).not.toContain(NEW_PASSWORD);
  });

  it("bilgilendirme e-postası gönderilemezse işlem bozulmaz; yalnızca hata kodu loglanır", async () => {
    vi.spyOn(getSmtpTransport(), "sendMail").mockRejectedValueOnce(
      Object.assign(new Error("boom to secret@example.test"), { code: "ECONNECTION" }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendCredentialNoticeBestEffort({ kind: "password_changed", email: "secret@example.test" }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain("ECONNECTION");
    expect(logged).not.toContain("secret@example.test");
  });
});
