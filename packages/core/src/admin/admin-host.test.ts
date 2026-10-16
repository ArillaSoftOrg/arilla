import { describe, expect, it } from "vitest";
import {
  type AdminHostPolicy,
  adminHostPolicy,
  authOriginForHost,
  isAdminHostRequest,
  isAdminRequestHost,
  publicSiteHref,
  routeAdminHost,
} from "./admin-host.ts";

const SPLIT: AdminHostPolicy = {
  mode: "split",
  host: "admin.manicepte.com",
  origin: "https://admin.manicepte.com",
};
const PUBLIC = "https://manicepte.com";

function route(policy: AdminHostPolicy, host: string | null, path: string) {
  const url = new URL(path, "http://x");
  return routeAdminHost(policy, {
    host,
    pathname: url.pathname,
    search: url.search,
    publicOrigin: PUBLIC,
  });
}

describe("adminHostPolicy", () => {
  it("tanimsiz ya da bosken shared doner (bugunku davranis)", () => {
    expect(adminHostPolicy({})).toEqual({ mode: "shared" });
    expect(adminHostPolicy({ ADMIN_HOST: "  " })).toEqual({ mode: "shared" });
  });

  it("gecerli ana makineyi kucuk harfe cevirir ve https kokeni uretir", () => {
    expect(adminHostPolicy({ ADMIN_HOST: " Admin.ManiCepte.com " })).toEqual(SPLIT);
  });

  it("uretim disinda port kabul eder ve APP_URL semasini izler", () => {
    expect(
      adminHostPolicy({ ADMIN_HOST: "admin.localhost:3000", APP_URL: "http://localhost:3000" }),
    ).toEqual({
      mode: "split",
      host: "admin.localhost:3000",
      origin: "http://admin.localhost:3000",
    });
    expect(adminHostPolicy({ ADMIN_HOST: "admin.arilla.test" })).toMatchObject({
      origin: "https://admin.arilla.test",
    });
  });

  it("uretimde APP_URL http olsa da koken https'tir", () => {
    expect(
      adminHostPolicy({
        ADMIN_HOST: "admin.manicepte.com",
        APP_URL: "http://manicepte.com",
        VERCEL_ENV: "production",
      }),
    ).toEqual(SPLIT);
  });

  it("protokol, yol, kimlik bilgisi ya da bozuk deger invalid olur (fail-closed)", () => {
    for (const value of [
      "https://admin.manicepte.com",
      "admin.manicepte.com/yonetim",
      "user@admin.manicepte.com",
      "admin..manicepte.com",
      "-admin.manicepte.com",
      "admin.manicepte.com:",
    ]) {
      expect(adminHostPolicy({ ADMIN_HOST: value })).toEqual({ mode: "invalid" });
    }
  });

  it("uretimde yerel ana makine ya da port invalid olur", () => {
    expect(adminHostPolicy({ ADMIN_HOST: "admin.localhost", VERCEL_ENV: "production" })).toEqual({
      mode: "invalid",
    });
    expect(
      adminHostPolicy({ ADMIN_HOST: "admin.manicepte.com:8443", DEPLOY_ENV: "production" }),
    ).toEqual({ mode: "invalid" });
    expect(
      adminHostPolicy({ ADMIN_HOST: "admin.manicepte.com", VERCEL_ENV: "production" }),
    ).toEqual(SPLIT);
  });
});

describe("isAdminRequestHost", () => {
  it("shared her ana makineye, invalid hicbirine izin verir", () => {
    expect(isAdminRequestHost({ mode: "shared" }, "manicepte.com")).toBe(true);
    expect(isAdminRequestHost({ mode: "shared" }, null)).toBe(true);
    expect(isAdminRequestHost({ mode: "invalid" }, "admin.manicepte.com")).toBe(false);
  });

  it("split yalnizca tam eslesen ana makineye izin verir", () => {
    expect(isAdminRequestHost(SPLIT, "admin.manicepte.com")).toBe(true);
    expect(isAdminRequestHost(SPLIT, "ADMIN.manicepte.com")).toBe(true);
    expect(isAdminRequestHost(SPLIT, "manicepte.com")).toBe(false);
    expect(isAdminRequestHost(SPLIT, "www.manicepte.com")).toBe(false);
    expect(isAdminRequestHost(SPLIT, "admin.manicepte.com.evil.test")).toBe(false);
    expect(isAdminRequestHost(SPLIT, "admin.manicepte.com:8443")).toBe(false);
    expect(isAdminRequestHost(SPLIT, null)).toBe(false);
  });
});

describe("routeAdminHost", () => {
  it("shared: hicbir seye dokunmaz", () => {
    expect(route({ mode: "shared" }, "manicepte.com", "/yonetim")).toEqual({
      action: "continue",
    });
  });

  it("invalid: konsol, giris ve API her yerde 404; public site calisir", () => {
    const invalid: AdminHostPolicy = { mode: "invalid" };
    for (const path of ["/yonetim", "/yonetim/giris", "/giris/yonetim", "/api/yonetim/x"]) {
      expect(route(invalid, "manicepte.com", path)).toEqual({ action: "not_found" });
    }
    expect(route(invalid, "manicepte.com", "/ara?q=x")).toEqual({ action: "continue" });
  });

  it("public ana makinede konsol yonetim ana makinesine 308 ile gider", () => {
    expect(route(SPLIT, "manicepte.com", "/yonetim/kullanicilar?q=a")).toEqual({
      action: "redirect",
      location: "https://admin.manicepte.com/yonetim/kullanicilar?q=a",
      status: 308,
    });
    expect(route(SPLIT, "manicepte.com", "/giris/yonetim?next=%2Fyonetim")).toEqual({
      action: "redirect",
      location: "https://admin.manicepte.com/yonetim/giris?next=%2Fyonetim",
      status: 308,
    });
  });

  it("public ana makinede yonetim API'si 404", () => {
    expect(route(SPLIT, "manicepte.com", "/api/yonetim/katalog-toplama")).toEqual({
      action: "not_found",
    });
  });

  it("public ana makinede public yollar ve /yonetim'e benzeyen yollar etkilenmez", () => {
    for (const path of ["/", "/ara", "/giris/google", "/yonetimx", "/urun/a"]) {
      expect(route(SPLIT, "manicepte.com", path)).toEqual({ action: "continue" });
    }
  });

  it("yonetim ana makinesinde kok konsola gider", () => {
    expect(route(SPLIT, "admin.manicepte.com", "/")).toEqual({
      action: "redirect",
      location: "https://admin.manicepte.com/yonetim",
      status: 307,
    });
  });

  it("yonetim ana makinesinde konsol, API, Google girisi ve dosyalar gecer", () => {
    for (const path of [
      "/yonetim",
      "/yonetim/giris",
      "/giris/yonetim",
      "/api/yonetim/katalog-toplama",
      "/giris/google",
      "/giris/google/callback?code=a&state=b",
      "/_next/static/chunks/a.js",
      "/apple-icon.png",
      "/fonts/ibm-plex-sans.woff2",
    ]) {
      expect(route(SPLIT, "admin.manicepte.com", path)).toEqual({ action: "continue" });
    }
  });

  it("yonetim ana makinesinde diger her yol (Apple girisi dahil) public siteye gider", () => {
    expect(route(SPLIT, "admin.manicepte.com", "/urun/kirmizi-elbise?x=1")).toEqual({
      action: "redirect",
      location: "https://manicepte.com/urun/kirmizi-elbise?x=1",
      status: 308,
    });
    for (const path of ["/giris", "/giris/apple", "/giris/telefon", "/hesap", "/yonetimx"]) {
      expect(route(SPLIT, "admin.manicepte.com", path)).toMatchObject({ action: "redirect" });
    }
  });

  it("public koken bilinmiyorsa yonetim ana makinesindeki public yol 404", () => {
    expect(
      routeAdminHost(SPLIT, { host: "admin.manicepte.com", pathname: "/ara", search: "" }),
    ).toEqual({ action: "not_found" });
  });
});

describe("authOriginForHost", () => {
  const appUrl = () => PUBLIC;

  it("yonetim ana makinesindeki giris kendi kokenine doner", () => {
    expect(authOriginForHost(SPLIT, "admin.manicepte.com", appUrl)).toBe(
      "https://admin.manicepte.com",
    );
  });

  it("diger ana makineler ve shared APP_URL kullanir", () => {
    expect(authOriginForHost(SPLIT, "manicepte.com", appUrl)).toBe(PUBLIC);
    expect(authOriginForHost({ mode: "shared" }, "admin.manicepte.com", appUrl)).toBe(PUBLIC);
    expect(authOriginForHost({ mode: "invalid" }, "admin.manicepte.com", appUrl)).toBe(PUBLIC);
  });
});

describe("publicSiteHref / isAdminHostRequest", () => {
  it("split'te public sitenin kokune, aksi halde goreli koke gider", () => {
    expect(publicSiteHref(SPLIT, { APP_URL: PUBLIC })).toBe("https://manicepte.com/");
    expect(publicSiteHref({ mode: "shared" }, { APP_URL: PUBLIC })).toBe("/");
  });

  it("yalnizca split ve eslesen ana makinede true", () => {
    expect(isAdminHostRequest(SPLIT, "admin.manicepte.com")).toBe(true);
    expect(isAdminHostRequest(SPLIT, "manicepte.com")).toBe(false);
    expect(isAdminHostRequest({ mode: "shared" }, "admin.manicepte.com")).toBe(false);
  });
});
