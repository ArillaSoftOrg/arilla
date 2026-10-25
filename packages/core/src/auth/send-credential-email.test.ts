import { describe, expect, it } from "vitest";
import { buildCredentialEmail } from "./send-credential-email.ts";

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
