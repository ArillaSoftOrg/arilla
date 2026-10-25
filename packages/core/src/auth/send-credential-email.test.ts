import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCredentialEmail, type CredentialEmailKind } from "./send-credential-email.ts";
import { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_MINUTES } from "./token-ttl.ts";

const URL_WITH_TOKEN =
  "https://manicepte.example/giris/eposta-dogrula?token=abc_DEF-123&next=%2Fara";

const LINK_KINDS = [
  "verify_email",
  "welcome",
  "reset_password",
  "add_password",
  "account_exists",
] as const satisfies readonly CredentialEmailKind[];
const ALL_KINDS = [...LINK_KINDS, "password_changed"] as const;

const SUBJECTS: Record<CredentialEmailKind, string> = {
  verify_email: "ManiCepte hesabını doğrula",
  welcome: "ManiCepte'ye hoş geldin",
  reset_password: "ManiCepte şifreni sıfırla",
  password_changed: "ManiCepte şifren değiştirildi",
  add_password: "ManiCepte hesabına şifre ekle",
  account_exists: "ManiCepte hesabın zaten var",
};

afterEach(() => vi.restoreAllMocks());

describe("buildCredentialEmail", () => {
  it.each(ALL_KINDS)("%s: konu istenen metindir", (kind) => {
    expect(buildCredentialEmail(kind, URL_WITH_TOKEN).subject).toBe(SUBJECTS[kind]);
  });

  it.each(LINK_KINDS)(
    "%s: bağlantı hem metinde hem HTML'de bulunur ve HTML'de kaçırılır",
    (kind) => {
      const mail = buildCredentialEmail(kind, URL_WITH_TOKEN);
      expect(mail.text).toContain(URL_WITH_TOKEN);
      expect(mail.html).toContain("token=abc_DEF-123&amp;next=%2Fara");
      expect(mail.html).not.toContain("123&next");
      // Düğme + düz metin bağlantısı: href iki kez.
      expect(mail.html.split('href="https://manicepte.example/giris/').length - 1).toBe(2);
    },
  );

  it("şifre değişikliği bildirimi bağlantı ve hassas bilgi taşımaz", () => {
    const mail = buildCredentialEmail("password_changed");
    expect(mail.html).not.toMatch(/href=/);
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.text).toContain("yanıtlayarak");
  });

  it("bağlantı gerektiren şablon bağlantısız çağrılırsa hata verir", () => {
    expect(() => buildCredentialEmail("reset_password")).toThrow();
  });

  it("bağlantıya gömülen kötü niyetli değer HTML olarak yorumlanmaz", () => {
    const mail = buildCredentialEmail(
      "reset_password",
      'https://x.test/?t="><script>alert(1)</script>',
    );
    expect(mail.html).not.toContain("<script>alert");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("doğrulama metni gerçek token süresiyle aynı süreyi söyler", () => {
    const { text, html } = buildCredentialEmail("verify_email", URL_WITH_TOKEN);
    expect(text).toContain(`${VERIFY_EMAIL_TTL_MINUTES} dakika geçerli`);
    expect(html).toContain(`${VERIFY_EMAIL_TTL_MINUTES} dakika geçerli`);
  });

  it.each(["reset_password", "add_password", "account_exists"] as const)(
    "%s: metin gerçek sıfırlama token süresini söyler",
    (kind) => {
      const { text, html } = buildCredentialEmail(kind, URL_WITH_TOKEN);
      expect(text).toContain(`${RESET_PASSWORD_TTL_MINUTES} dakika geçerli`);
      expect(html).toContain(`${RESET_PASSWORD_TTL_MINUTES} dakika geçerli`);
    },
  );

  it("süre sabitleri sunucudaki token süreleriyle aynıdır (60 / 30)", () => {
    expect(VERIFY_EMAIL_TTL_MINUTES).toBe(60);
    expect(RESET_PASSWORD_TTL_MINUTES).toBe(30);
  });

  it.each(["verify_email", "reset_password", "add_password", "account_exists"] as const)(
    "%s: 'sen yapmadıysan yok say' uyarısı vardır",
    (kind) => {
      expect(buildCredentialEmail(kind, URL_WITH_TOKEN).text).toMatch(/yok sayabilirsin/);
    },
  );

  it.each(ALL_KINDS)("%s: HTML ve düz metin aynı başlığı taşır", (kind) => {
    const mail = buildCredentialEmail(kind, URL_WITH_TOKEN);
    const title = mail.text.split("\n")[0] ?? "";
    expect(title.length).toBeGreaterThan(3);
    expect(mail.html).toContain(title.replace(/'/g, "&#39;"));
  });

  it.each(ALL_KINDS)("%s: yasaklı kelime, ALL CAPS ve harici bağımlılık yok", (kind) => {
    const { subject, text, html } = buildCredentialEmail(kind, URL_WITH_TOKEN);
    for (const banned of ["satın al", "dupe", "ucuz"]) {
      expect(`${subject} ${text}`.toLowerCase()).not.toContain(banned);
    }
    expect(subject).not.toBe(subject.toUpperCase());
    expect(html).not.toMatch(/<script|<link|<img|@import|url\(/i);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("max-width:600px");
    expect(html).toContain('lang="tr"');
  });

  it("hoş geldin e-postası reklam/pazarlama dili taşımaz ve erken erişimi belirtir", () => {
    const { text } = buildCredentialEmail("welcome", URL_WITH_TOKEN);
    for (const phrase of ["kampanya", "indirim", "fırsat", "bülten", "abone"]) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
    expect(text).toContain("erken erişim");
  });

  it("'hesabın zaten var' e-postası yeni hesap açılmadığını söyler ve doğrulama dili kullanmaz", () => {
    const { text } = buildCredentialEmail("account_exists", URL_WITH_TOKEN);
    expect(text).toContain("zaten var");
    expect(text).not.toContain("doğrula");
  });

  it("şifre ekleme e-postası hesabın birleşmediğini, aynı kaldığını söyler", () => {
    const { text } = buildCredentialEmail("add_password", URL_WITH_TOKEN);
    expect(text).toContain("yeni hesap açılmaz");
  });
});
