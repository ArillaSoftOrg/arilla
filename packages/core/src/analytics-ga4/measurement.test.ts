/**
 * GA4 arındırma (karar 0087). GA4'e giden her değer bu fonksiyonlardan
 * geçer: arama metni, token, kimlik, e-posta, telefon hiçbir yoldan çıkmaz.
 */
import { describe, expect, it } from "vitest";
import {
  ga4ConfigParams,
  ga4CookieNames,
  ga4DisableKey,
  OTHER_PATH,
  parseMeasurementId,
  sanitizePage,
  sanitizePagePath,
  sanitizeReferrer,
  sanitizeUtmValue,
} from "./measurement.ts";

const ORIGIN = "https://manicepte.example";

describe("ölçüm kimliği", () => {
  it("yalnızca G- biçimi kabul edilir", () => {
    expect(parseMeasurementId("G-ABC123DEF4")).toBe("G-ABC123DEF4");
    expect(parseMeasurementId(" g-abc123def4 ")).toBe("G-ABC123DEF4");
    for (const bad of [undefined, null, "", "UA-1234-1", "G-12", 'G-ABC"><script>', "AW-123456"]) {
      expect(parseMeasurementId(bad)).toBeNull();
    }
  });

  it("çerez adları ve devre dışı anahtarı", () => {
    expect(ga4CookieNames("G-ABC123DEF4")).toEqual(["_ga", "_ga_ABC123DEF4"]);
    expect(ga4DisableKey("G-ABC123DEF4")).toBe("ga-disable-G-ABC123DEF4");
  });
});

describe("sayfa yolu", () => {
  it("kamu yolları aynen, sondaki eğik çizgi atılır", () => {
    expect(sanitizePagePath("/")).toBe("/");
    expect(sanitizePagePath("/ara")).toBe("/ara");
    expect(sanitizePagePath("/trendler/")).toBe("/trendler");
    expect(sanitizePagePath("/urun/peri-kozmetik-parfum-50-ml")).toBe(
      "/urun/peri-kozmetik-parfum-50-ml",
    );
    expect(sanitizePagePath("/blog/sonbahar-moda")).toBe("/blog/sonbahar-moda");
  });

  it("yönetim, API, token ve auth alt yolları hiç ölçülmez", () => {
    for (const path of [
      "/yonetim",
      "/yonetim/kullanicilar/3e18-ab",
      "/Yonetim/trafik",
      "/api/cron/x",
      "/abonelik-iptali",
      "/giris/dogrula",
      "/giris/google/callback",
      "/giris/yonetim",
    ]) {
      expect(sanitizePagePath(path)).toBeNull();
    }
    expect(sanitizePagePath("/giris")).toBe("/giris");
  });

  it("kimlik taşıyan yollar şablona iner", () => {
    expect(sanitizePagePath("/sohbet/8c1f0d2e-1234-4abc-9def-001122334455")).toBe("/sohbet/[id]");
    expect(sanitizePagePath("/sohbet/12345")).toBe("/sohbet/[id]");
    expect(sanitizePagePath("/sohbet/yeni")).toBe("/sohbet/yeni");
  });

  it("slug biçiminde olmayan içerik yolu ve bilinmeyen her yol genele iner", () => {
    expect(sanitizePagePath("/urun/Ali Veli@ornek.com")).toBe("/urun/[slug]");
    expect(sanitizePagePath("/urun/05321234567")).toBe("/urun/[slug]");
    expect(sanitizePagePath("/urun/telefon-5321234567")).toBe("/urun/[slug]");
    expect(sanitizePagePath("/urun/iphone-15-128-gb")).toBe("/urun/iphone-15-128-gb");
    // Link arama catch-all'u: yolun kendisi kullanıcı girdisidir.
    expect(sanitizePagePath("/https://www.trendyol.com/x-p-123?boutiqueId=9")).toBe(OTHER_PATH);
    expect(sanitizePagePath("/ali%40ornek.com")).toBe(OTHER_PATH);
    expect(sanitizePagePath("/urun/a/b")).toBe(OTHER_PATH);
    expect(sanitizePagePath("/%E0%A4%A")).toBe(OTHER_PATH);
  });
});

describe("tam adres", () => {
  it("arama metni ve tüm sorgu parametreleri atılır; yalnızca güvenli UTM kalır", () => {
    const page = sanitizePage(
      `${ORIGIN}/ara?q=ali%40ornek.com+0532+123+45+67&token=abc&session_id=s1&utm_source=newsletter&utm_campaign=ekim-2026#sonuc`,
      ORIGIN,
    );
    expect(page).toEqual({
      location: `${ORIGIN}/ara?utm_source=newsletter&utm_campaign=ekim-2026`,
      path: "/ara",
      title: "/ara",
    });
  });

  it("kişisel veri taşıyan UTM değeri atılır", () => {
    expect(sanitizeUtmValue("newsletter")).toBe("newsletter");
    expect(sanitizeUtmValue("ali@ornek.com")).toBeNull();
    expect(sanitizeUtmValue("ali%40ornek.com")).toBeNull();
    expect(sanitizeUtmValue("05321234567")).toBeNull();
    expect(sanitizeUtmValue("<script>")).toBeNull();
    expect(sanitizeUtmValue("x".repeat(101))).toBeNull();
    const page = sanitizePage(`${ORIGIN}/?utm_source=ali@ornek.com&utm_medium=email`, ORIGIN);
    expect(page?.location).toBe(`${ORIGIN}/?utm_medium=email`);
  });

  it("başka köken ve ölçülmeyen yol için null", () => {
    expect(sanitizePage("https://baska.example/ara", ORIGIN)).toBeNull();
    expect(sanitizePage(`${ORIGIN}/giris/dogrula?token=gizli`, ORIGIN)).toBeNull();
    expect(sanitizePage(`${ORIGIN}/yonetim/trafik`, ORIGIN)).toBeNull();
  });

  it("başlık belge başlığı değil, arındırılmış yoldur", () => {
    expect(sanitizePage(`${ORIGIN}/sohbet/42`, ORIGIN)?.title).toBe("/sohbet/[id]");
  });
});

describe("yönlendiren", () => {
  it("dış: yalnızca köken; iç: arındırılmış yol; diğer: boş", () => {
    expect(sanitizeReferrer("https://www.google.com/search?q=ali+veli", ORIGIN)).toBe(
      "https://www.google.com",
    );
    expect(sanitizeReferrer(`${ORIGIN}/ara?q=gizli`, ORIGIN)).toBe(`${ORIGIN}/ara`);
    expect(sanitizeReferrer(`${ORIGIN}/giris/dogrula?token=t`, ORIGIN)).toBe("");
    expect(sanitizeReferrer("android-app://com.x", ORIGIN)).toBe("");
    expect(sanitizeReferrer("", ORIGIN)).toBe("");
  });
});

describe("gtag yapılandırması", () => {
  it("otomatik sayfa görüntüleme, Google sinyalleri ve reklam kişiselleştirmesi kapalı", () => {
    expect(ga4ConfigParams(true)).toMatchObject({
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_domain: "none",
      cookie_flags: "SameSite=Lax;Secure",
    });
    expect(ga4ConfigParams(false).cookie_flags).toBe("SameSite=Lax");
  });
});
