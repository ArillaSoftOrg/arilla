import { describe, expect, it } from "vitest";
import { hasCapability } from "../admin/capabilities.ts";
import type { UserRole } from "../auth/types.ts";
import {
  ADMIN_LOGIN_PATH,
  canAccessProduct,
  EARLY_ACCESS_LOGIN_PATH,
  EARLY_ACCESS_PATH,
  isProductOpen,
  isPublicProductPath,
  postAuthRedirect,
  productAccessRedirect,
  shouldJoinEarlyAccess,
} from "./product-access.ts";

const CLOSED = {};
const OPEN = { PRODUCT_ACCESS: "open" };

describe("isProductOpen", () => {
  it("is open only for an explicit 'open' value", () => {
    expect(isProductOpen(OPEN)).toBe(true);
    expect(isProductOpen({ PRODUCT_ACCESS: " Open " })).toBe(true);
  });

  it.each([undefined, "", "closed", "true", "1", "yes"])("fails closed for %j", (value) => {
    expect(isProductOpen({ PRODUCT_ACCESS: value })).toBe(false);
  });
});

describe("canAccessProduct", () => {
  it.each<[UserRole, boolean]>([
    ["user", false],
    ["creator", false],
    // Karar 0043: lansman öncesi önizleme yalnızca yöneticinin.
    ["moderator", false],
    ["admin", true],
  ])("while closed, %s -> %s", (role, expected) => {
    expect(canAccessProduct({ role }, CLOSED)).toBe(expected);
  });

  it("while closed, anonymous visitors cannot pass", () => {
    expect(canAccessProduct(null, CLOSED)).toBe(false);
    expect(canAccessProduct(undefined, CLOSED)).toBe(false);
  });

  it("an unknown role gets no access", () => {
    expect(canAccessProduct({ role: "superuser" as UserRole }, CLOSED)).toBe(false);
  });

  it("when open, everyone passes", () => {
    expect(canAccessProduct(null, OPEN)).toBe(true);
    expect(canAccessProduct({ role: "user" }, OPEN)).toBe(true);
    expect(canAccessProduct({ role: "moderator" }, OPEN)).toBe(true);
  });

  it("admin-only preview does not touch the moderator's console capabilities", () => {
    expect(hasCapability("moderator", "product.preview")).toBe(false);
    expect(hasCapability("admin", "product.preview")).toBe(true);
    for (const capability of [
      "admin.access",
      "matching.review",
      "dictionary.write",
      "catalog.read",
      "diagnostics.read",
      "merchant.read",
      "ingest.read",
    ] as const) {
      expect([capability, hasCapability("moderator", capability)]).toEqual([capability, true]);
    }
  });
});

describe("redirects", () => {
  it("sends anonymous visitors to the landing and signed-in users to the success page", () => {
    expect(productAccessRedirect(null)).toBe("/");
    expect(productAccessRedirect({ role: "user" })).toBe(EARLY_ACCESS_PATH);
  });

  it("after sign-in a normal user always lands on the success page while closed", () => {
    expect(postAuthRedirect({ role: "user" }, "/alarmlar", CLOSED)).toBe(EARLY_ACCESS_PATH);
    expect(postAuthRedirect({ role: "creator" }, "/", CLOSED)).toBe(EARLY_ACCESS_PATH);
  });

  it("staff (and everyone once open) keep the safe next behavior", () => {
    expect(postAuthRedirect({ role: "admin" }, "/yonetim", CLOSED)).toBe("/yonetim");
    expect(postAuthRedirect({ role: "admin" }, "//evil.example", CLOSED)).toBe("/");
    expect(postAuthRedirect({ role: "user" }, "/alarmlar", OPEN)).toBe("/alarmlar");
    expect(postAuthRedirect({ role: "moderator" }, "/alarmlar", OPEN)).toBe("/alarmlar");
  });

  it("while closed a moderator returns only to the console, never to product pages", () => {
    expect(postAuthRedirect({ role: "moderator" }, "/yonetim/eslestirme", CLOSED)).toBe(
      "/yonetim/eslestirme",
    );
    expect(postAuthRedirect({ role: "moderator" }, "/urun/x", CLOSED)).toBe("/yonetim");
    expect(postAuthRedirect({ role: "moderator" }, "/", CLOSED)).toBe("/yonetim");
    expect(postAuthRedirect({ role: "moderator" }, "//evil.example", CLOSED)).toBe("/yonetim");
  });
});

describe("isPublicProductPath", () => {
  it.each(["/urun/abc", "/kesfet", "/firsatlar", "/ara", "/ara/link", "/git/12"])(
    "%s is a product path",
    (path) => {
      expect(isPublicProductPath(path)).toBe(true);
    },
  );

  it.each(["/", "/giris", "/gizlilik", "/erken-erisim", "/hesap", "/urunler", "/arama"])(
    "%s is not",
    (path) => {
      expect(isPublicProductPath(path)).toBe(false);
    },
  );
});

describe("landing login paths", () => {
  it("early-access CTA reuses the login flow with a safe next", () => {
    expect(EARLY_ACCESS_LOGIN_PATH).toBe("/giris?next=%2Ferken-erisim");
  });

  it("admin entry is the same login flow, no secret parameter", () => {
    expect(ADMIN_LOGIN_PATH).toBe("/giris?next=%2Fyonetim");
    // Yetkisiz hesap next'e dönmez: giriş sonrası başarı ekranı.
    expect(postAuthRedirect({ role: "user" }, "/yonetim", CLOSED)).toBe(EARLY_ACCESS_PATH);
    expect(postAuthRedirect({ role: "admin" }, "/yonetim", CLOSED)).toBe("/yonetim");
  });
});

describe("shouldJoinEarlyAccess", () => {
  it("lists normal accounts while closed, never staff, nobody once open", () => {
    expect(shouldJoinEarlyAccess({ role: "user" }, CLOSED)).toBe(true);
    expect(shouldJoinEarlyAccess({ role: "creator" }, CLOSED)).toBe(true);
    expect(shouldJoinEarlyAccess({ role: "moderator" }, CLOSED)).toBe(false);
    expect(shouldJoinEarlyAccess({ role: "admin" }, CLOSED)).toBe(false);
    expect(shouldJoinEarlyAccess({ role: "user" }, OPEN)).toBe(false);
  });
});
