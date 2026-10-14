import { describe, expect, it } from "vitest";
import { resolveStatsRange } from "../tracking-links/admin.ts";
import { type FetchLike, UMAMI_MAX_BYTES, UmamiError, umamiGet } from "./client.ts";
import {
  parseBaseUrl,
  parseScriptName,
  parseWebsiteId,
  UMAMI_DEFAULT_SCRIPT,
  type UmamiApiConfig,
  umamiApiFromEnv,
  umamiTrackerFromEnv,
} from "./config.ts";
import {
  fetchAnalyticsReport,
  LAST_GOOD_TTL,
  METRIC_TYPES,
  parseUmamiMetric,
  parseUmamiOverview,
  parseUmamiSeries,
  rangeQuery,
  validateFilters,
} from "./reports.ts";

const SITE = "123e4567-e89b-42d3-a456-426614174000";
const KEY = "umami-test-api-key-1234567890-NOT-REAL";
const config: UmamiApiConfig = {
  baseUrl: "https://analytics.manicepte.com",
  websiteId: SITE,
  apiKey: KEY,
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

class MemoryCache {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _m: "EX", seconds: number) {
    this.store.set(key, value);
    this.ttls.set(key, seconds);
  }
  async del(key: string) {
    this.store.delete(key);
  }
}

describe("yapılandırma", () => {
  it("web sitesi kimliği UUID olmalı", () => {
    expect(parseWebsiteId(SITE.toUpperCase())).toBe(SITE);
    for (const bad of ["", "abc", `${SITE}x`, "<script>", undefined]) {
      expect(parseWebsiteId(bad)).toBeNull();
    }
  });

  it("kök adres: https, yol/sorgu/kimlik/port/IP yok; yerelde http://localhost", () => {
    expect(parseBaseUrl("https://analytics.manicepte.com")).toBe("https://analytics.manicepte.com");
    expect(parseBaseUrl("https://analytics.manicepte.com/")).toBe(
      "https://analytics.manicepte.com",
    );
    expect(parseBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of [
      "http://analytics.manicepte.com",
      "https://analytics.manicepte.com/yol",
      "https://analytics.manicepte.com?x=1",
      "https://u:p@analytics.manicepte.com",
      "https://analytics.manicepte.com:8443",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://intranet",
      "ftp://analytics.manicepte.com",
      "javascript:alert(1)",
      "",
    ]) {
      expect(parseBaseUrl(bad), bad).toBeNull();
    }
  });

  it("betik adı güvenli kümede; aksi halde varsayılan", () => {
    expect(parseScriptName("sayfa-olc.js")).toBe("sayfa-olc.js");
    for (const bad of ["../x.js", "a/b.js", "x.php", "x.js?a=1", "", undefined]) {
      expect(parseScriptName(bad)).toBe(UMAMI_DEFAULT_SCRIPT);
    }
  });

  it("izleyici ayarı anahtar gerektirmez; kimlik ve adres yoksa null", () => {
    expect(umamiTrackerFromEnv({ UMAMI_BASE_URL: config.baseUrl, UMAMI_WEBSITE_ID: SITE })).toEqual(
      {
        baseUrl: config.baseUrl,
        websiteId: SITE,
        scriptUrl: `${config.baseUrl}/script.js`,
      },
    );
    expect(umamiTrackerFromEnv({ UMAMI_BASE_URL: config.baseUrl })).toBeNull();
    expect(umamiTrackerFromEnv({})).toBeNull();
  });

  it("API ayarı: tanımsız / geçersiz (yalnız değişken ADI) / tamam", () => {
    expect(umamiApiFromEnv({})).toEqual({ status: "not_configured" });
    const partial = umamiApiFromEnv({ UMAMI_BASE_URL: config.baseUrl, UMAMI_API_KEY: "kisa" });
    expect(partial).toEqual({
      status: "invalid",
      problems: ["UMAMI_WEBSITE_ID", "UMAMI_API_KEY"],
    });
    expect(JSON.stringify(partial)).not.toContain("kisa");
    const ok = umamiApiFromEnv({
      UMAMI_BASE_URL: config.baseUrl,
      UMAMI_WEBSITE_ID: SITE,
      UMAMI_API_KEY: KEY,
    });
    expect(ok).toEqual({ status: "ok", config });
    expect(
      umamiApiFromEnv({
        UMAMI_BASE_URL: config.baseUrl,
        UMAMI_WEBSITE_ID: SITE,
        UMAMI_API_KEY: "içinde boşluk olan geçersiz anahtar",
      }).status,
    ).toBe("invalid");
  });
});

describe("istemci: zaman aşımı, hata izolasyonu, sır sızıntısı", () => {
  it("Bearer anahtarı ve belgelenmiş yolla çağırır; yönlendirme izlemez", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, init };
      return json({ ok: 1 });
    };
    await umamiGet(config, "/stats", { startAt: 1, endAt: 2, empty: undefined }, { fetchImpl });
    expect(seen?.url).toBe(`${config.baseUrl}/api/websites/${SITE}/stats?startAt=1&endAt=2`);
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(seen?.init.redirect).toBe("error");
    expect(seen?.init.method).toBe("GET");
  });

  it("yanıt vermeyen sunucu zaman aşımına uğrar", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    await expect(
      umamiGet(config, "/stats", {}, { fetchImpl, timeoutMs: 40 }),
    ).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "http"],
    [502, "http"],
  ])("HTTP %i → %s", async (status, kind) => {
    const fetchImpl: FetchLike = async () => new Response("gizli gövde", { status });
    await expect(umamiGet(config, "/stats", {}, { fetchImpl })).rejects.toMatchObject({ kind });
  });

  it("ağ hatası, bozuk JSON ve aşırı büyük yanıt güvenli türlere çevrilir", async () => {
    await expect(
      umamiGet(
        config,
        "/stats",
        {},
        { fetchImpl: async () => Promise.reject(new TypeError("fetch failed")) },
      ),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(
      umamiGet(config, "/stats", {}, { fetchImpl: async () => new Response("<html>") }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(
      umamiGet(
        config,
        "/stats",
        {},
        { fetchImpl: async () => new Response("x".repeat(UMAMI_MAX_BYTES + 10)) },
      ),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  it("hata iletisi anahtarı, adresi ve yanıt gövdesini içermez", async () => {
    for (const fetchImpl of [
      async () => new Response(`Bearer ${KEY} ${config.baseUrl}`, { status: 500 }),
      async () => Promise.reject(new Error(`${KEY} ${config.baseUrl}`)),
    ] as FetchLike[]) {
      try {
        await umamiGet(config, "/stats", {}, { fetchImpl });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UmamiError);
        const text = `${(error as Error).message} ${JSON.stringify(error)}`;
        expect(text).not.toContain(KEY);
        expect(text).not.toContain("analytics.manicepte.com");
        expect(text).not.toContain("gövde");
      }
    }
  });
});

describe("rapor biçim doğrulama", () => {
  it("stats yanıtı: eksik ya da sayı olmayan alan reddedilir; karşılaştırma isteğe bağlı", () => {
    const base = { visitors: 5, visits: 6, pageviews: 9, bounces: 2, totaltime: 120 };
    expect(parseUmamiOverview({ ...base, comparison: { ...base, visitors: 4 } })).toEqual({
      ...base,
      comparison: { ...base, visitors: 4 },
    });
    expect(parseUmamiOverview({ ...base, comparison: { visitors: 1 } }).comparison).toBeNull();
    expect(parseUmamiOverview(base).comparison).toBeNull();
    for (const bad of [null, [], { ...base, visitors: "5" }, { visitors: 1 }, "x"]) {
      expect(() => parseUmamiOverview(bad)).toThrow(UmamiError);
    }
  });

  it("pageviews yanıtı: iki seri birleşir, eksik nokta sıfır", () => {
    expect(
      parseUmamiSeries({
        pageviews: [
          { x: "2026-03-01", y: 3 },
          { x: "2026-03-02", y: 5 },
        ],
        sessions: [{ x: "2026-03-02", y: 2 }],
      }),
    ).toEqual([
      { label: "2026-03-01", pageviews: 3, sessions: 0 },
      { label: "2026-03-02", pageviews: 5, sessions: 2 },
    ]);
    expect(() => parseUmamiSeries({ pageviews: [{ x: 1, y: 1 }], sessions: [] })).toThrow(
      UmamiError,
    );
    expect(() => parseUmamiSeries({ pageviews: "x", sessions: [] })).toThrow(UmamiError);
  });

  it("metrics yanıtı: x null olabilir, satır sayısı sınırlı, bozuk satır reddedilir", () => {
    expect(
      parseUmamiMetric([
        { x: null, y: 4 },
        { x: "TR", y: 9, t: "ignored" },
      ]),
    ).toEqual([
      { label: "", value: 4 },
      { label: "TR", value: 9 },
    ]);
    expect(
      parseUmamiMetric(Array.from({ length: 50 }, (_, i) => ({ x: String(i), y: i }))).length,
    ).toBe(10);
    expect(() => parseUmamiMetric([{ x: "a", y: "1" }])).toThrow(UmamiError);
    expect(() => parseUmamiMetric({})).toThrow(UmamiError);
  });
});

describe("rapor sorguları", () => {
  const range = resolveStatsRange(
    { from: "2026-03-01", to: "2026-03-07" },
    new Date("2026-03-20T12:00:00Z"),
  );

  it("aralık Europe/Istanbul gün sınırlarıdır; kısa aralıkta saatlik birim", () => {
    const q = rangeQuery(range);
    expect(q.startAt).toBe(Date.parse("2026-02-28T21:00:00Z"));
    expect(q.endAt).toBe(Date.parse("2026-03-07T20:59:59.999Z"));
    expect(q.timezone).toBe("Europe/Istanbul");
    expect(q.unit).toBe("day");
    expect(rangeQuery(resolveStatsRange({ from: "2026-03-01", to: "2026-03-02" })).unit).toBe(
      "hour",
    );
  });

  it("süzgeç: yalnızca güvenli kampanya etiketi; başka anahtar atılır", () => {
    expect(validateFilters({ utmCampaign: "yaz-26" })).toEqual({ utmCampaign: "yaz-26" });
    expect(validateFilters({})).toEqual({});
    expect(validateFilters({ utmCampaign: "yaz-26", path: "/x" } as never)).toEqual({
      utmCampaign: "yaz-26",
    });
    for (const bad of ["a&b=1", "a b", "<x>", "", "A", "ç"]) {
      expect(() => validateFilters({ utmCampaign: bad })).toThrow(UmamiError);
    }
  });

  it("yalnız doğrulanmış uç noktalar ve tipler çağrılır; kampanya süzgeci iletilir", async () => {
    const urls: URL[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url);
      urls.push(u);
      if (u.pathname.endsWith("/stats")) {
        return json({ visitors: 1, visits: 1, pageviews: 1, bounces: 0, totaltime: 1 });
      }
      if (u.pathname.endsWith("/pageviews")) return json({ pageviews: [], sessions: [] });
      return json([]);
    };
    const report = await fetchAnalyticsReport(
      config,
      range,
      { utmCampaign: "yaz-26" },
      { fetchImpl, cache: null },
    );
    const paths = urls.map((u) => u.pathname.replace(`/api/websites/${SITE}`, ""));
    expect(new Set(paths)).toEqual(new Set(["/stats", "/pageviews", "/metrics"]));
    expect(
      urls
        .filter((u) => u.pathname.endsWith("/metrics"))
        .map((u) => u.searchParams.get("type"))
        .sort(),
    ).toEqual([...METRIC_TYPES].sort());
    for (const u of urls) {
      expect(u.searchParams.get("utmCampaign")).toBe("yaz-26");
      expect(
        [...u.searchParams.keys()].every((k) =>
          [
            "startAt",
            "endAt",
            "timezone",
            "unit",
            "utmCampaign",
            "compare",
            "type",
            "limit",
          ].includes(k),
        ),
      ).toBe(true);
    }
    expect(report.overview.ok).toBe(true);
    expect(Object.keys(report.metrics).sort()).toEqual([...METRIC_TYPES].sort());
  });

  it("kapsam: yalnızca istenen bölümler çağrılır (kampanya özeti)", async () => {
    const urls: URL[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url);
      urls.push(u);
      if (u.pathname.endsWith("/stats")) {
        return json({ visitors: 1, visits: 1, pageviews: 1, bounces: 0, totaltime: 1 });
      }
      return json([]);
    };
    const report = await fetchAnalyticsReport(
      config,
      range,
      { utmCampaign: "yaz" },
      { fetchImpl, cache: null },
      { series: false, metrics: ["path"] },
    );
    expect(report.series).toBeNull();
    expect(Object.keys(report.metrics)).toEqual(["path"]);
    expect(urls.map((u) => u.pathname.split("/").pop()).sort()).toEqual(["metrics", "stats"]);
  });

  it("bir bölüm düşerse diğerleri görünür (hata izolasyonu)", async () => {
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/stats")) return new Response("x", { status: 500 });
      if (u.searchParams.get("type") === "country") return json({ yanlis: "biçim" });
      if (u.pathname.endsWith("/pageviews")) return json({ pageviews: [], sessions: [] });
      return json([{ x: "a", y: 1 }]);
    };
    const report = await fetchAnalyticsReport(config, range, {}, { fetchImpl, cache: null });
    expect(report.overview).toEqual({ ok: false, error: "http" });
    expect(report.metrics.country).toEqual({ ok: false, error: "invalid_response" });
    expect(report.series?.ok).toBe(true);
    expect(report.metrics.referrer?.ok).toBe(true);
  });

  it("Umami tümden kapalıysa rapor hata türleriyle döner, fırlatmaz", async () => {
    const fetchImpl: FetchLike = async () => Promise.reject(new TypeError("fetch failed"));
    const report = await fetchAnalyticsReport(config, range, {}, { fetchImpl, cache: null });
    expect(report.overview).toEqual({ ok: false, error: "network" });
    expect(Object.values(report.metrics).every((s) => !s?.ok)).toBe(true);
  });
});

describe("önbellek", () => {
  const completed = resolveStatsRange(
    { from: "2026-03-01", to: "2026-03-07" },
    new Date("2026-03-20T12:00:00Z"),
  );
  const ok: FetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/stats"))
      return json({ visitors: 7, visits: 8, pageviews: 9, bounces: 1, totaltime: 3 });
    if (u.pathname.endsWith("/pageviews")) return json({ pageviews: [], sessions: [] });
    return json([]);
  };

  it("tamamlanmış aralık 6 saat, bugünü içeren 5 dk; ikinci çağrı Umami'ye gitmez", async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const counting: FetchLike = async (u, i) => {
      calls++;
      return ok(u, i);
    };
    const now = () => Date.parse("2026-03-20T12:00:00Z");
    await fetchAnalyticsReport(config, completed, {}, { fetchImpl: counting, cache, now });
    const first = calls;
    const freshTtls = [...cache.ttls.entries()]
      .filter(([k]) => k.endsWith(":fresh"))
      .map(([, v]) => v);
    expect(new Set(freshTtls)).toEqual(new Set([6 * 60 * 60]));
    expect(
      [...cache.ttls.entries()]
        .filter(([k]) => k.endsWith(":good"))
        .every(([, v]) => v === LAST_GOOD_TTL),
    ).toBe(true);
    await fetchAnalyticsReport(config, completed, {}, { fetchImpl: counting, cache, now });
    expect(calls).toBe(first);

    const todayRange = resolveStatsRange({ from: "2026-03-18", to: "2026-03-20" }, new Date(now()));
    const cache2 = new MemoryCache();
    await fetchAnalyticsReport(config, todayRange, {}, { fetchImpl: ok, cache: cache2, now });
    expect(
      new Set([...cache2.ttls.entries()].filter(([k]) => k.endsWith(":fresh")).map(([, v]) => v)),
    ).toEqual(new Set([300]));
  });

  it("Umami çökünce son iyi veri 'eski' diye döner", async () => {
    const cache = new MemoryCache();
    const t0 = Date.parse("2026-03-20T12:00:00Z");
    await fetchAnalyticsReport(config, completed, {}, { fetchImpl: ok, cache, now: () => t0 });
    for (const key of [...cache.store.keys()]) if (key.endsWith(":fresh")) cache.store.delete(key);
    const down: FetchLike = async () => Promise.reject(new TypeError("fetch failed"));
    const report = await fetchAnalyticsReport(
      config,
      completed,
      {},
      { fetchImpl: down, cache, now: () => t0 + 1000 },
    );
    expect(report.overview).toMatchObject({ ok: true, stale: true, storedAt: t0 });
    expect(report.overview.ok && report.overview.value.visitors).toBe(7);
  });

  it("farklı kampanya süzgeci farklı önbellek anahtarı kullanır", async () => {
    const cache = new MemoryCache();
    await fetchAnalyticsReport(config, completed, {}, { fetchImpl: ok, cache });
    const before = cache.store.size;
    await fetchAnalyticsReport(config, completed, { utmCampaign: "yaz" }, { fetchImpl: ok, cache });
    expect(cache.store.size).toBe(before * 2);
  });
});
