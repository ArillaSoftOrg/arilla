import { describe, expect, it } from "vitest";
import type { UserRole } from "../auth/types.ts";
import {
  canAccessProduct,
  EARLY_ACCESS_PATH,
  isProductOpen,
  isPublicProductPath,
  postAuthRedirect,
  productAccessRedirect,
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
    ["moderator", true],
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
    expect(postAuthRedirect({ role: "moderator" }, "//evil.example", CLOSED)).toBe("/");
    expect(postAuthRedirect({ role: "user" }, "/alarmlar", OPEN)).toBe("/alarmlar");
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
