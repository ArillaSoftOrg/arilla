import { describe, expect, it } from "vitest";
import {
  buildRedirectLocation,
  isReservedSlug,
  normalizeLabel,
  normalizeName,
  normalizeSlug,
  normalizeTarget,
  RESERVED_SLUGS,
  type TargetPolicy,
  TrackingLinkValidationError,
  targetPolicyFromEnv,
} from "./policy.ts";

const policy: TargetPolicy = targetPolicyFromEnv({ APP_URL: "https://manicepte.com" });

describe("slug", () => {
  it("küçük harfe indirger ve kırpar", () => {
    expect(normalizeSlug("  Arda ")).toBe("arda");
    expect(normalizeSlug("sehzade-2")).toBe("sehzade-2");
    expect(normalizeSlug("i")).toBe("i");
  });

  it.each([
    "",
    "-ig",
    "ig-",
    "a_b",
    "a b",
    "ığ",
    "İg",
    "ig.html",
    "../etc",
    "a/b",
    "a".repeat(41),
    "%2e%2e",
  ])("geçersiz biçim reddedilir: %j", (value) => {
    expect(() => normalizeSlug(value)).toThrow(TrackingLinkValidationError);
  });

  it("40 karakterlik slug kabul edilir", () => {
    expect(normalizeSlug("a".repeat(40))).toBe("a".repeat(40));
  });

  it.each(["yonetim", "api", "ara", "urun", "git", "hesap", "giris", "admin", "Q"])(
    "rezerve sistem adı reddedilir: %s",
    (value) => {
      expect(() => normalizeSlug(value)).toThrow(/sistem adresi/);
    },
  );

  it("slug olarak kullanılamayan hiçbir rezerve ad slug biçimini bozmaz", () => {
    for (const reserved of RESERVED_SLUGS) expect(isReservedSlug(reserved)).toBe(true);
  });

  it("sayı olmayan girdi reddedilir", () => {
    expect(() => normalizeSlug(undefined)).toThrow(TrackingLinkValidationError);
    expect(() => normalizeSlug(12)).toThrow(TrackingLinkValidationError);
  });
});

describe("ad, kaynak, kampanya", () => {
  it("adı kırpar ve boşlukları birleştirir", () => {
    expect(normalizeName("  Instagram   bio ")).toBe("Instagram bio");
  });

  it("boş, çok uzun ve yön değiştiren karakterli ad reddedilir", () => {
    expect(() => normalizeName("   ")).toThrow();
    expect(() => normalizeName("a".repeat(81))).toThrow();
    expect(() => normalizeName(`abc${String.fromCharCode(0x202e)}def`)).toThrow();
    expect(() => normalizeName("a\u0000b")).toThrow();
  });

  it("kaynak ve kampanya boşsa null, değilse güvenli etiket", () => {
    expect(normalizeLabel("", "Kaynak")).toBeNull();
    expect(normalizeLabel(undefined, "Kaynak")).toBeNull();
    expect(normalizeLabel(" Instagram ", "Kaynak")).toBe("instagram");
    expect(normalizeLabel("yaz_2026-ig", "Kampanya")).toBe("yaz_2026-ig");
  });

  it.each(["a b", "a&b=c", "<script>", "ç", "-x", "a".repeat(41), "utm=1"])(
    "kaynak/kampanya içinde güvensiz değer reddedilir: %j",
    (value) => {
      expect(() => normalizeLabel(value, "Kampanya")).toThrow(TrackingLinkValidationError);
    },
  );
});

describe("izinli alan adları", () => {
  it("APP_URL ana makinesi ve www eşi", () => {
    expect([...policy.allowedHosts].sort()).toEqual(["manicepte.com", "www.manicepte.com"]);
    const www = targetPolicyFromEnv({ APP_URL: "https://www.manicepte.com" });
    expect([...www.allowedHosts].sort()).toEqual(["manicepte.com", "www.manicepte.com"]);
  });

  it("ek alan adı yalnızca açıkça verilirse eklenir; bozuk ve IP değerler atılır", () => {
    const extended = targetPolicyFromEnv({
      APP_URL: "https://manicepte.com",
      TRACKING_LINK_EXTRA_HOSTS: "kampanya.manicepte.com, 10.0.0.1, evil host, x",
    });
    expect([...extended.allowedHosts].sort()).toEqual([
      "kampanya.manicepte.com",
      "manicepte.com",
      "www.manicepte.com",
    ]);
  });

  it("APP_URL yoksa fırlatır", () => {
    expect(() => targetPolicyFromEnv({})).toThrow(/APP_URL/);
  });
});

describe("hedef doğrulama: kabul", () => {
  it.each([
    ["https://manicepte.com/", "https://manicepte.com/"],
    ["https://MANICEPTE.com/trendler/yaz?a=1", "https://manicepte.com/trendler/yaz?a=1"],
    ["https://www.manicepte.com/blog/yazi", "https://www.manicepte.com/blog/yazi"],
    ["/", "/"],
    ["/trendler/yaz", "/trendler/yaz"],
    ["/erken-erisim?davet=abc", "/erken-erisim?davet=abc"],
  ])("%s", (raw, expected) => {
    expect(normalizeTarget(raw, policy)).toBe(expected);
  });
});

describe("hedef doğrulama: açık yönlendirme, SSRF ve döngü", () => {
  it.each([
    ["dış alan adı", "https://evil.example/"],
    ["benzer alan adı", "https://manicepte.com.evil.example/"],
    ["son ek alan adı", "https://evilmanicepte.com/"],
    ["alt alan adı (izinsiz)", "https://analytics.manicepte.com/"],
    ["kullanıcı bilgisi ile ana makine kandırma", "https://manicepte.com@evil.example/"],
    ["kullanıcı bilgisi", "https://user:pass@manicepte.com/"],
    ["http", "http://manicepte.com/"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["file", "file:///etc/passwd"],
    ["protokol göreli", "//evil.example/x"],
    ["ters eğik çizgi", "https://manicepte.com\\@evil.example/"],
    ["göreli ters eğik çizgi", "/\\evil.example"],
    ["/ ile başlayan //", "///evil.example"],
    ["IPv4", "https://127.0.0.1/"],
    ["IPv4 (ondalıksız)", "https://2130706433/"],
    ["IPv6", "https://[::1]/"],
    ["bulut meta verisi", "https://169.254.169.254/latest/meta-data"],
    ["özel port", "https://manicepte.com:8443/"],
    ["boşluk", "https://manicepte.com/a b"],
    ["satır sonu", "https://manicepte.com/\nHost: evil.example"],
    ["sekme", "https://manicepte.com/a\tb"],
    ["boş", "   "],
    ["düz metin", "evil.example"],
    ["kendi alanında bilinmeyen tek parça (başka slug / döngü)", "/ig"],
    ["tam adresle başka slug", "https://manicepte.com/arda"],
    ["link öneki catch-all", "/https:/evil.example/x"],
    ["çok uzun", `https://manicepte.com/trendler/${"a".repeat(2000)}`],
  ])("%s reddedilir", (_name, raw) => {
    expect(() => normalizeTarget(raw, policy)).toThrow(TrackingLinkValidationError);
  });

  it("hata mesajı girdiyi yansıtmaz", () => {
    try {
      normalizeTarget("https://evil.example/gizli", policy);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("evil.example");
    }
  });

  it("string olmayan girdi reddedilir", () => {
    expect(() => normalizeTarget(undefined, policy)).toThrow(TrackingLinkValidationError);
    expect(() => normalizeTarget({ href: "https://manicepte.com/" }, policy)).toThrow(
      TrackingLinkValidationError,
    );
  });

  it("yerel geliştirmede (http://localhost) http ve port serbest, başka alan adı değil", () => {
    const local = targetPolicyFromEnv({ APP_URL: "http://localhost:3000" });
    expect(normalizeTarget("http://localhost:3000/trendler/x", local)).toBe(
      "http://localhost:3000/trendler/x",
    );
    expect(() => normalizeTarget("http://evil.example/", local)).toThrow();
  });
});

describe("yönlendirme adresi", () => {
  it("göreli hedef APP_URL köküne çözülür", () => {
    expect(buildRedirectLocation({ targetUrl: "/", source: null, campaign: null }, policy)).toBe(
      "https://manicepte.com/",
    );
  });

  it("kaynak ve kampanya UTM olarak eklenir, hedefteki mevcut değere dokunulmaz", () => {
    const url = new URL(
      buildRedirectLocation(
        { targetUrl: "/trendler/yaz?utm_source=eski", source: "instagram", campaign: "yaz-26" },
        policy,
      ) as string,
    );
    expect(url.origin + url.pathname).toBe("https://manicepte.com/trendler/yaz");
    expect(url.searchParams.get("utm_source")).toBe("eski");
    expect(url.searchParams.get("utm_campaign")).toBe("yaz-26");
    expect(url.searchParams.get("utm_medium")).toBe("link");
  });

  it("kaynak/kampanya yoksa hiç UTM eklenmez", () => {
    expect(
      buildRedirectLocation({ targetUrl: "/trendler/yaz", source: null, campaign: null }, policy),
    ).toBe("https://manicepte.com/trendler/yaz");
  });

  it("veritabanı ya da önbellekte bozulmuş hedef yönlendirilmez (null)", () => {
    for (const targetUrl of [
      "https://evil.example/",
      "//evil.example",
      "javascript:alert(1)",
      "/ig",
      "",
    ]) {
      expect(buildRedirectLocation({ targetUrl, source: null, campaign: null }, policy)).toBeNull();
    }
  });
});
