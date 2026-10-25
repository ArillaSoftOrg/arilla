import { describe, expect, it } from "vitest";
import {
  buildCredentialEmail,
  RESET_PASSWORD_TTL_MINUTES,
  VERIFY_EMAIL_TTL_MINUTES,
} from "./send-credential-email.ts";

const URL_WITH_TOKEN =
  "https://manicepte.example/giris/eposta-dogrula?token=abc_DEF-123&next=%2Fara";

describe("buildCredentialEmail", () => {
  it.each(["verify_email", "reset_password", "account_exists"] as const)(
    "%s: bağlantı hem metinde hem HTML'de bulunur ve HTML'de kaçırılır",
    (kind) => {
      const mail = buildCredentialEmail(kind, URL_WITH_TOKEN);
      expect(mail.text).toContain(URL_WITH_TOKEN);
      // `&` HTML'de `&amp;` olarak yer alır; ham `&next=` HTML'e girmez.
      expect(mail.html).toContain("token=abc_DEF-123&amp;next=%2Fara");
      expect(mail.html).not.toContain("123&next");
      expect(mail.subject).toContain("ManiCepte");
    },
  );

  it("doğrulama bağlantısı 15 dakika, sıfırlama 30 dakika geçerlidir ve metinler birbirine karışmaz", () => {
    expect(VERIFY_EMAIL_TTL_MINUTES).toBe(15);
    expect(RESET_PASSWORD_TTL_MINUTES).toBe(30);
    const verify = buildCredentialEmail("verify_email", URL_WITH_TOKEN);
    expect(verify.text).toContain("15 dakika geçerli");
    expect(verify.html).toContain("15 dakika geçerli");
    expect(verify.text).not.toContain("60 dakika");
    const reset = buildCredentialEmail("reset_password", URL_WITH_TOKEN);
    expect(reset.text).toContain("30 dakika geçerli");
    expect(reset.text).not.toContain("15 dakika");
  });

  it("bağlantıya gömülen kötü niyetli değer HTML olarak yorumlanmaz", () => {
    const mail = buildCredentialEmail(
      "reset_password",
      'https://x.test/?t="><script>alert(1)</script>',
    );
    expect(mail.html).not.toContain("<script>");
  });

  it("geçerlilik süresini ve 'sen yapmadıysan' notunu içerir; ALL CAPS ve yasaklı kelime yok", () => {
    for (const kind of ["verify_email", "reset_password", "account_exists"] as const) {
      const { subject, text } = buildCredentialEmail(kind, URL_WITH_TOKEN);
      expect(text).toMatch(/dakika geçerli/);
      expect(text).toMatch(/yok sayabilirsin/);
      for (const banned of ["satın al", "dupe", "ucuz"]) {
        expect(`${subject} ${text}`.toLowerCase()).not.toContain(banned);
      }
      expect(subject).not.toBe(subject.toUpperCase());
    }
  });

  it("hiçbir renk değeri gömülmez (docs/design.md: renkler belirteçlerden gelir)", () => {
    const { html } = buildCredentialEmail("verify_email", URL_WITH_TOKEN);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("'hesabın zaten var' e-postası yeni hesap açılmadığını söyler ve doğrulama dili kullanmaz", () => {
    const { text } = buildCredentialEmail("account_exists", URL_WITH_TOKEN);
    expect(text).toContain("zaten var");
    expect(text).not.toContain("doğrula");
  });
});
