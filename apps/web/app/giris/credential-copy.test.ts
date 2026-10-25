import { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_MINUTES } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_COPY as COPY, LOGIN_PAGE_NOTICES } from "./credential-copy.ts";

describe("e-posta doğrulama metinleri", () => {
  it("kayıt sonrası bilgilendirme istenen metindir", () => {
    expect(COPY.checkEmailBody).toBe(
      "Hesabını doğrulaman için e-posta adresine bir bağlantı gönderdik. Bağlantı 15 dakika geçerlidir. E-posta birkaç dakika içinde ulaşmazsa spam klasörünü kontrol edebilirsin.",
    );
  });

  it("arayüzdeki süre sunucudaki token süresiyle aynıdır (15 dakika)", () => {
    expect(VERIFY_EMAIL_TTL_MINUTES).toBe(15);
    for (const text of [COPY.checkEmailBody, COPY.resentBody, COPY.verifyExpired]) {
      expect(text).toContain(`${VERIFY_EMAIL_TTL_MINUTES} dakika`);
      expect(text).not.toContain("60 dakika");
    }
  });

  it("şifre sıfırlama süresi değişmedi (30 dakika) ve doğrulama metniyle karışmaz", () => {
    expect(RESET_PASSWORD_TTL_MINUTES).toBe(30);
    expect(COPY.forgotSentBody).toContain("30 dakika");
    expect(COPY.setupDone).toContain("30 dakika");
    expect(COPY.forgotSentBody).not.toContain("doğrula");
    expect(COPY.forgotSentBody).not.toContain("15 dakika");
    expect(COPY.checkEmailBody).not.toContain("şifre");
    expect(COPY.checkEmailBody).not.toContain("30 dakika");
  });

  it("doğrulama bağlantısı sonuçları şifre sıfırlama metinlerinden ayrıdır", () => {
    expect(LOGIN_PAGE_NOTICES.suresi_doldu).toBe(COPY.verifyExpired);
    expect(LOGIN_PAGE_NOTICES.gecersiz).toBe(COPY.verifyInvalid);
    expect(COPY.verifyExpired).not.toBe(COPY.tokenExpired);
    expect(COPY.verifyExpired).toContain("yeni bir doğrulama bağlantısı");
  });

  it("ad alanı metni kalmadı; yasaklı kelime ve ALL CAPS yok", () => {
    expect("nameLabel" in COPY).toBe(false);
    for (const value of Object.values(COPY)) {
      const lower = value.toLowerCase();
      for (const banned of ["satın al", "dupe", "ucuz"]) expect(lower).not.toContain(banned);
      expect(value).not.toBe(value.toUpperCase());
    }
  });
});
