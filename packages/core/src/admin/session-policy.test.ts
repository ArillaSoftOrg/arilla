import { describe, expect, it } from "vitest";
import { postAuthRedirect } from "../access/product-access.ts";
import { safeRedirectPath } from "../auth/safe-redirect.ts";
import {
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_SESSION_MAX_AGE_MS,
  adminLoginPath,
  evaluateAdminSession,
  FRESH_AUTH_MAX_AGE_MS,
  isFreshAuth,
  safeAdminNext,
} from "./session-policy.ts";

const now = new Date("2026-09-28T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("evaluateAdminSession", () => {
  it("accepts a recent, active session", () => {
    expect(evaluateAdminSession({ createdAt: ago(HOUR), lastUsedAt: ago(MINUTE) }, now)).toBe("ok");
  });

  it("expires after 12 hours even when active", () => {
    expect(ADMIN_SESSION_MAX_AGE_MS).toBe(12 * HOUR);
    expect(
      evaluateAdminSession({ createdAt: ago(12 * HOUR + 1), lastUsedAt: ago(MINUTE) }, now),
    ).toBe("expired");
    expect(evaluateAdminSession({ createdAt: ago(12 * HOUR), lastUsedAt: ago(MINUTE) }, now)).toBe(
      "ok",
    );
  });

  it("ends after 30 idle minutes", () => {
    expect(ADMIN_IDLE_TIMEOUT_MS).toBe(30 * MINUTE);
    expect(evaluateAdminSession({ createdAt: ago(HOUR), lastUsedAt: ago(31 * MINUTE) }, now)).toBe(
      "idle",
    );
    expect(evaluateAdminSession({ createdAt: ago(HOUR), lastUsedAt: ago(29 * MINUTE) }, now)).toBe(
      "ok",
    );
  });

  it("fails safe without timestamps", () => {
    expect(evaluateAdminSession({}, now)).toBe("expired");
  });
});

describe("isFreshAuth", () => {
  it("allows high-impact actions only within an hour of sign-in", () => {
    expect(FRESH_AUTH_MAX_AGE_MS).toBe(HOUR);
    expect(isFreshAuth(ago(59 * MINUTE), now)).toBe(true);
    expect(isFreshAuth(ago(61 * MINUTE), now)).toBe(false);
    expect(isFreshAuth(undefined, now)).toBe(false);
  });
});

describe("admin next", () => {
  it.each([
    ["/yonetim/magazalar?sayfa=2", "/yonetim/magazalar?sayfa=2"],
    ["/yonetim", "/yonetim"],
    ["/kaydettiklerim", "/yonetim"],
    ["//evil.example/yonetim", "/yonetim"],
    ["https://evil.example/yonetim", "/yonetim"],
    ["/yonetim/giris", "/yonetim"],
    [null, "/yonetim"],
  ])("safeAdminNext(%j) -> %s", (raw, expected) => {
    expect(safeAdminNext(raw)).toBe(expected);
  });

  it("builds the admin login path with reason and safe next", () => {
    expect(adminLoginPath("/yonetim")).toBe("/yonetim/giris");
    expect(adminLoginPath("/yonetim/sozluk", "bosta")).toBe(
      "/yonetim/giris?next=%2Fyonetim%2Fsozluk&neden=bosta",
    );
    expect(adminLoginPath("https://evil.example", "sure")).toBe("/yonetim/giris?neden=sure");
  });

  it("never loops back to a login screen", () => {
    expect(safeRedirectPath("/yonetim/giris?next=/yonetim")).toBe("/");
    expect(safeRedirectPath("/giris")).toBe("/");
  });
});

describe("postAuthRedirect with admin intent", () => {
  const OPEN = { PRODUCT_ACCESS: "open" };
  const CLOSED = {};

  it("staff go to the admin next", () => {
    expect(postAuthRedirect({ role: "admin" }, "/yonetim/denetim", CLOSED)).toBe(
      "/yonetim/denetim",
    );
    expect(postAuthRedirect({ role: "moderator" }, "/yonetim/eslestirme", CLOSED)).toBe(
      "/yonetim/eslestirme",
    );
  });

  it("a normal user coming from the admin login is not sent into the admin area", () => {
    expect(postAuthRedirect({ role: "user" }, "/yonetim", CLOSED)).toBe("/erken-erisim");
    expect(postAuthRedirect({ role: "user" }, "/yonetim/magazalar", OPEN)).toBe("/");
    expect(postAuthRedirect({ role: "creator" }, "/kaydettiklerim", OPEN)).toBe("/kaydettiklerim");
  });
});
