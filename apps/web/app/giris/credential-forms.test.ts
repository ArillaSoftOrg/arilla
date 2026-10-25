import { EARLY_ACCESS_SIGNUP_PATH } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Sunucu eylemleri (veritabanı, çerez) yalnızca form gönderiminde çalışır; burada sadece görünüm.
vi.mock("./credential-actions.ts", () => ({
  forgotPasswordAction: vi.fn(),
  loginAction: vi.fn(),
  registerAction: vi.fn(),
  resendVerificationAction: vi.fn(),
  resetPasswordAction: vi.fn(),
}));

import { PasswordInput } from "@arilla/ui";
import {
  ForgotPasswordForm,
  LoginForm,
  RegisterForm,
  ResendVerificationForm,
  ResetPasswordForm,
} from "./credential-forms-client.tsx";
import { LoginFormClient } from "./login-form-client.tsx";

const html = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

/** Ham `<input ...>` etiketini ada göre bulur. */
function inputTag(markup: string, name: string): string {
  const tag = [...markup.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(`name="${name}"`));
  if (!tag) throw new Error(`input yok: ${name}`);
  return tag;
}

describe("PasswordInput (şifre göster/gizle)", () => {
  const base = { label: "Şifre", name: "password" } as const;

  it("varsayılan gizli: type=password, düğme erişilebilir ve formu göndermez", () => {
    const markup = html(createElement(PasswordInput, base));
    const input = inputTag(markup, "password");
    expect(input).toContain('type="password"');
    const button = /<button\b[^>]*>/.exec(markup)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="Şifreyi göster"');
    expect(button).toContain('aria-pressed="false"');
    const inputId = /id="([^"]+)"/.exec(input)?.[1];
    expect(button).toContain(`aria-controls="${inputId}"`);
    // Etiket girdiye bağlı; simge dekoratif.
    expect(markup).toContain(`for="${inputId}"`);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("görünürken type=text, düğme 'gizle' der ve basılı durumu bildirir", () => {
    const markup = html(createElement(PasswordInput, { ...base, visible: true }));
    expect(inputTag(markup, "password")).toContain('type="text"');
    expect(markup).toContain('aria-label="Şifreyi gizle"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("autoComplete, ipucu ve hata girdiye bağlanır; girdi yazım denetimine girmez", () => {
    const markup = html(
      createElement(PasswordInput, {
        ...base,
        autoComplete: "new-password",
        hint: "En az 10 karakter.",
        error: "Şifre çok kısa.",
      }),
    );
    const input = inputTag(markup, "password");
    expect(input).toContain('autoComplete="new-password"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('spellCheck="false"');
    expect(input).toMatch(/aria-describedby="[^"]*-hint [^"]*-error"/);
  });
});

describe("kimlik formları: autocomplete ve şifre alanları", () => {
  it("giriş: e-posta + current-password, göster/gizle var, ad alanı yok", () => {
    const markup = html(createElement(LoginForm, { next: "/" }));
    expect(inputTag(markup, "email")).toContain('autoComplete="email"');
    expect(inputTag(markup, "password")).toContain('autoComplete="current-password"');
    expect(inputTag(markup, "password")).toContain('type="password"');
    expect(markup).toContain("Şifreyi göster");
    expect(markup).not.toContain('name="name"');
  });

  it("kayıt: yalnızca e-posta ve şifre; new-password, güçlü şifre oluştur, ad alanı yok", () => {
    const markup = html(createElement(RegisterForm, { next: "/erken-erisim" }));
    expect(inputTag(markup, "email")).toBeTruthy();
    const password = inputTag(markup, "password");
    expect(password).toContain('autoComplete="new-password"');
    expect(password).toContain('type="password"');
    expect(markup).toContain("Güçlü şifre oluştur");
    expect(markup).toContain("Şifreyi göster");
    expect(markup).toContain("Hesap oluştur");
    expect(markup).not.toContain('name="name"');
    expect(markup).not.toContain("Adın");
    // Oluşturulmamış şifre için "kopyala" gösterilmez.
    expect(markup).not.toContain("Şifreyi kopyala");
    // Dönüş yolu form içinde taşınır.
    expect(markup).toContain('name="next" value="/erken-erisim"');
  });

  it("şifre sıfırlama: iki new-password alanı, güçlü şifre oluştur ve göster/gizle", () => {
    const markup = html(createElement(ResetPasswordForm, { token: "tkn" }));
    expect(inputTag(markup, "password")).toContain('autoComplete="new-password"');
    expect(inputTag(markup, "confirm")).toContain('autoComplete="new-password"');
    expect(markup).toContain("Güçlü şifre oluştur");
    expect(markup.match(/aria-label="Şifreyi göster"/g)).toHaveLength(2);
  });

  it("şifre içermeyen formlarda göster/gizle yok", () => {
    expect(html(createElement(ForgotPasswordForm))).not.toContain("Şifreyi göster");
    expect(html(createElement(ResendVerificationForm, { next: "/" }))).not.toContain(
      "Şifreyi göster",
    );
  });

  it("şifre alanı varsayılan değer taşımaz (SSR çıktısında şifre yok)", () => {
    const markup = html(createElement(RegisterForm, { next: "/" }));
    expect(inputTag(markup, "password")).not.toMatch(/value="[^"]/);
  });
});

describe("giriş seçenekleri: erken erişim kayıt niyeti", () => {
  const availability = { google: true, apple: true, email: true };

  it("kayıt niyetiyle e-posta seçeneği kayıt ekranına gider, next korunur", () => {
    const markup = html(LoginFormClient({ next: "/erken-erisim", availability, signup: true }));
    expect(markup).toContain('href="/giris/kayit?next=%2Ferken-erisim"');
    expect(markup).not.toContain("/giris/eposta");
  });

  it("normal girişte e-posta seçeneği giriş ekranına gider", () => {
    const markup = html(LoginFormClient({ next: "/", availability }));
    expect(markup).toContain('href="/giris/eposta"');
    expect(markup).not.toContain("/giris/kayit");
  });

  it("Google ve Apple bağlantıları iki durumda da aynıdır (regresyon)", () => {
    const signup = html(LoginFormClient({ next: "/erken-erisim", availability, signup: true }));
    const login = html(LoginFormClient({ next: "/erken-erisim", availability }));
    for (const markup of [signup, login]) {
      expect(markup).toContain('href="/giris/google?next=%2Ferken-erisim"');
      expect(markup).toContain('href="/giris/apple?next=%2Ferken-erisim"');
      expect(markup).toContain("Google ile devam edin");
      expect(markup).toContain("Apple ile devam edin");
    }
  });

  it("erken erişim kayıt yolu giriş ekranına kayıt niyetini ve next'i taşır", () => {
    const url = new URL(EARLY_ACCESS_SIGNUP_PATH, "http://x");
    expect(url.pathname).toBe("/giris");
    expect(url.searchParams.get("kayit")).toBe("1");
    expect(url.searchParams.get("next")).toBe("/erken-erisim");
  });
});
