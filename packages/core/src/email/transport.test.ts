import { describe, expect, it } from "vitest";
import { SmtpConfigError, smtpConfigFromEnv } from "./transport.ts";

describe("smtpConfigFromEnv", () => {
  it("allows local Mailpit without auth (dev)", () => {
    expect(smtpConfigFromEnv({ SMTP_HOST: "localhost", SMTP_PORT: "1025" })).toEqual({
      host: "localhost",
      port: 1025,
      secure: false,
      requireTLS: false,
    });
  });

  it("allows local relay without auth even under NODE_ENV=production (next start locally)", () => {
    for (const host of ["127.0.0.1", "::1", "mailpit", "LOCALHOST"]) {
      const options = smtpConfigFromEnv({
        SMTP_HOST: host,
        SMTP_PORT: "1025",
        NODE_ENV: "production",
      });
      expect(options.auth).toBeUndefined();
    }
  });

  it("throws in production for a remote host without auth", () => {
    expect(() =>
      smtpConfigFromEnv({
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        NODE_ENV: "production",
      }),
    ).toThrow(/Uretimde SMTP_USER\/SMTP_PASS zorunlu/);
  });

  it("throws outside production for a remote host without auth", () => {
    expect(() => smtpConfigFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587" })).toThrow(
      SmtpConfigError,
    );
  });

  it("throws when only one of SMTP_USER / SMTP_PASS is set", () => {
    expect(() =>
      smtpConfigFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "u" }),
    ).toThrow(/birlikte/);
    expect(() =>
      smtpConfigFromEnv({ SMTP_HOST: "localhost", SMTP_PORT: "1025", SMTP_PASS: "p" }),
    ).toThrow(/birlikte/);
  });

  it("uses implicit TLS on 465 with auth", () => {
    expect(
      smtpConfigFromEnv({
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "465",
        SMTP_USER: "u",
        SMTP_PASS: "p",
        NODE_ENV: "production",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: "u", pass: "p" },
    });
  });

  it("requires STARTTLS on 587 with auth", () => {
    const options = smtpConfigFromEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "u",
      SMTP_PASS: "p",
    });
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(true);
    expect(options.auth).toEqual({ user: "u", pass: "p" });
  });

  it("honours an explicit SMTP_SECURE override", () => {
    const base = { SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p" };
    expect(smtpConfigFromEnv({ ...base, SMTP_PORT: "2465", SMTP_SECURE: "true" }).secure).toBe(
      true,
    );
    const off = smtpConfigFromEnv({ ...base, SMTP_PORT: "465", SMTP_SECURE: "false" });
    expect(off.secure).toBe(false);
    expect(off.requireTLS).toBe(true);
    expect(() => smtpConfigFromEnv({ ...base, SMTP_PORT: "587", SMTP_SECURE: "yes" })).toThrow(
      /SMTP_SECURE/,
    );
  });

  it("rejects invalid ports", () => {
    for (const port of ["abc", "25.5", "-1", "0", "70000", "587x"]) {
      expect(() => smtpConfigFromEnv({ SMTP_HOST: "localhost", SMTP_PORT: port })).toThrow(
        /SMTP_PORT/,
      );
    }
  });

  it("throws when host or port is missing", () => {
    expect(() => smtpConfigFromEnv({ SMTP_PORT: "1025" })).toThrow(/SMTP_HOST/);
    expect(() => smtpConfigFromEnv({ SMTP_HOST: "localhost" })).toThrow(/SMTP_PORT/);
  });

  it("never includes the password in error messages", () => {
    try {
      smtpConfigFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_PASS: "s3cret!" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("s3cret!");
    }
  });
});
