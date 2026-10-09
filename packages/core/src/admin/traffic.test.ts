/**
 * GA4 trafik raporları (karar 0087) — birim. Ağ yok: sahte taşıyıcı. Anahtar
 * test sırasında üretilir (gerçek kimlik bilgisi yok). Doğrulananlar: yetki
 * reddi ağdan önce, yapılandırma durumları, JWT imzası, belirteç önbelleği,
 * hata eşleme (sır sızmadan), önbellek / eski veri / kota koruması,
 * küçük hücre kuralı ve tarih aralıkları.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ga4ApiConfigFromEnv } from "../analytics-ga4/config.ts";
import { clearGa4TokenCache, type Ga4Transport } from "../analytics-ga4/data-api.ts";
import {
  bucketKey,
  bucketsOf,
  parseBreakdown,
  parseGranularity,
  parseTrafficRange,
  TrafficRangeError,
} from "../analytics-ga4/reports.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  getTrafficOverview,
  getTrafficSummary,
  TRAFFIC_QUOTA_FLOOR,
  type TrafficCacheStore,
} from "./traffic.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PROPERTY = "987654321";
const EMAIL = "rapor-okur@ornek-proje.iam.gserviceaccount.com";
const ENV = {
  GA4_PROPERTY_ID: PROPERTY,
  GA4_CLIENT_EMAIL: EMAIL,
  // Vercel biçimi: satır sonları kaçışlı.
  GA4_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
};
const ACCESS_TOKEN = "ya29.sahte-erisim-belirteci-123456";
const NOW = new Date("2026-10-09T09:00:00Z");
const admin: AdminActor = { userId: 1, role: "admin" };

interface Call {
  url: string;
  body: string;
  headers: Record<string, string>;
}

type Responder = (call: Call) => { status: number; body: unknown } | "timeout";

function report(request: Record<string, unknown>) {
  const dims = ((request.dimensions as { name: string }[] | undefined) ?? []).map((d) => d.name);
  const metricCount = (request.metrics as unknown[]).length;
  const quota = {
    tokensPerDay: { consumed: 10, remaining: 199_000 },
    tokensPerHour: { consumed: 10, remaining: 39_000 },
    tokensPerProjectPerHour: { consumed: 10, remaining: 13_000 },
  };
  const metricValues = (values: number[]) =>
    Array.from({ length: metricCount }, (_, i) => ({ value: String(values[i] ?? 0) }));
  const start = (request.dateRanges as { startDate: string }[])[0]?.startDate ?? "";
  const previous = start < "2026-09-11";
  if (dims.length === 0) {
    const base = previous ? 50 : 100;
    return {
      rows: [{ metricValues: metricValues([base, base / 2, base * 2, base * 5, 0.6]) }],
      propertyQuota: quota,
    };
  }
  if (dims[0] === "date") {
    return {
      rows: [
        {
          dimensionValues: [{ value: previous ? "20260814" : "20261001" }],
          metricValues: metricValues([7, 9, 30]),
        },
      ],
      propertyQuota: quota,
    };
  }
  if (dims[0] === "country") {
    return {
      rows: [
        { dimensionValues: [{ value: "Turkey" }], metricValues: metricValues([90, 120]) },
        { dimensionValues: [{ value: "Germany" }], metricValues: metricValues([6, 8]) },
        { dimensionValues: [{ value: "Iceland" }], metricValues: metricValues([1, 1]) },
        { dimensionValues: [{ value: "Malta" }], metricValues: metricValues([2, 3]) },
      ],
      propertyQuota: quota,
    };
  }
  if (dims[0] === "sessionSource") {
    return {
      rows: [
        {
          dimensionValues: [{ value: "google" }, { value: "organic" }],
          metricValues: metricValues([80, 60]),
        },
        {
          dimensionValues: [{ value: "kisisel-blog.example" }, { value: "referral" }],
          metricValues: metricValues([2, 1]),
        },
      ],
      propertyQuota: quota,
    };
  }
  return {
    rows: [{ dimensionValues: [{ value: "(not set)" }], metricValues: metricValues([5, 4, 0.5]) }],
    propertyQuota: quota,
  };
}

const ok: Responder = (call) => {
  if (call.url.endsWith("/token")) {
    return { status: 200, body: { access_token: ACCESS_TOKEN, expires_in: 3600 } };
  }
  const body = JSON.parse(call.body) as { requests: Record<string, unknown>[] };
  return { status: 200, body: { reports: body.requests.map(report) } };
};

function transport(responder: Responder, calls: Call[]): Ga4Transport {
  return {
    now: () => NOW.getTime(),
    timeoutMs: 50,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        body: String(init?.body ?? ""),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      const result = responder(call);
      if (result === "timeout") {
        const error = new Error("zaman aşımı");
        error.name = "TimeoutError";
        throw error;
      }
      return new Response(JSON.stringify(result.body), { status: result.status });
    }) as typeof fetch,
  };
}

function memoryStore(): TrafficCacheStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

const range = parseTrafficRange({ gun: "28" }, NOW);
const input = { range, granularity: "gun" as const };

beforeEach(() => clearGa4TokenCache());

describe("yetki ve yapılandırma", () => {
  it("yönetici dışı her rol ağdan önce reddedilir", async () => {
    const calls: Call[] = [];
    for (const role of ["moderator", "creator", "user"] as const) {
      const actor = { userId: 2, role };
      await expect(
        getTrafficOverview(actor, input, { env: ENV, transport: transport(ok, calls) }),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(
        getTrafficSummary(actor, { range }, { env: ENV, transport: transport(ok, calls) }),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
    }
    expect(calls).toHaveLength(0);
  });

  it("yapılandırılmamış ya da geçersizse ağ çağrısı yok, yalnızca değişken ADLARI döner", async () => {
    const calls: Call[] = [];
    const none = await getTrafficOverview(admin, input, {
      env: {},
      transport: transport(ok, calls),
    });
    expect(none).toEqual({
      state: "not_configured",
      missing: ["GA4_PROPERTY_ID", "GA4_CLIENT_EMAIL", "GA4_PRIVATE_KEY"],
    });
    const bad = await getTrafficOverview(admin, input, {
      env: {
        ...ENV,
        GA4_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----bozuk-SIR",
        GA4_PROPERTY_ID: "G-1",
      },
      transport: transport(ok, calls),
    });
    expect(bad).toEqual({
      state: "invalid_config",
      problems: ["GA4_PROPERTY_ID", "GA4_PRIVATE_KEY"],
    });
    expect(JSON.stringify(bad)).not.toContain("SIR");
    expect(calls).toHaveLength(0);
  });

  it("sahte uç nokta yalnızca yerel adres olabilir", () => {
    const remote = ga4ApiConfigFromEnv({
      ...ENV,
      GA4_TEST_API_BASE_URL: "https://saldirgan.example",
    });
    expect(remote).toEqual({ status: "invalid", problems: ["GA4_TEST_API_BASE_URL"] });
    const local = ga4ApiConfigFromEnv({ ...ENV, GA4_TEST_API_BASE_URL: "http://127.0.0.1:3399/x" });
    expect(local.status === "ready" && local.config.dataApiBase).toBe(
      "http://127.0.0.1:3399/v1beta",
    );
    const real = ga4ApiConfigFromEnv(ENV);
    expect(real.status === "ready" && real.config.dataApiBase).toBe(
      "https://analyticsdata.googleapis.com/v1beta",
    );
  });
});

describe("Data API istemcisi", () => {
  it("JWT RS256 imzalı, salt okunur kapsam; belirteç bellekte bir kez alınır", async () => {
    const calls: Call[] = [];
    const deps = { env: ENV, transport: transport(ok, calls), store: null, now: () => NOW };
    await getTrafficSummary(admin, { range }, deps);
    await getTrafficSummary(admin, { range }, deps);
    const tokenCalls = calls.filter((c) => c.url.endsWith("/token"));
    expect(tokenCalls).toHaveLength(1);
    const assertion = new URLSearchParams(tokenCalls[0]?.body).get("assertion") ?? "";
    const [header, claims, signature] = assertion.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toMatchObject({
      iss: EMAIL,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token",
    });
    const api = calls.filter((c) => c.url.includes(":batchRunReports"));
    expect(api[0]?.url).toBe(
      `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:batchRunReports`,
    );
    expect(api[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    const body = JSON.parse(api[0]?.body ?? "{}") as { requests: Record<string, unknown>[] };
    expect(body.requests).toHaveLength(2);
    expect(body.requests.every((r) => r.returnPropertyQuota === true)).toBe(true);
  });

  it("tam görünüm: iki toplu istek (5+5), tanımlı metrik/boyutlar, yorum ve önceki dönem", async () => {
    const calls: Call[] = [];
    const result = await getTrafficOverview(admin, input, {
      env: ENV,
      transport: transport(ok, calls),
      store: null,
      now: () => NOW,
    });
    const api = calls.filter((c) => c.url.includes(":batchRunReports"));
    expect(api.map((c) => (JSON.parse(c.body) as { requests: unknown[] }).requests.length)).toEqual(
      [5, 5],
    );
    const names = new Set(
      api.flatMap((c) =>
        (
          JSON.parse(c.body) as {
            requests: { metrics: { name: string }[]; dimensions?: { name: string }[] }[];
          }
        ).requests.flatMap((r) => [
          ...r.metrics.map((m) => m.name),
          ...(r.dimensions ?? []).map((d) => d.name),
        ]),
      ),
    );
    expect([...names].sort()).toEqual(
      [
        "activeUsers",
        "country",
        "date",
        "deviceCategory",
        "engagementRate",
        "newUsers",
        "pagePath",
        "region",
        "screenPageViews",
        "sessionDefaultChannelGroup",
        "sessionMedium",
        "sessionSource",
        "sessions",
      ].sort(),
    );
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.data.totals.current).toEqual({
      users: 100,
      newUsers: 50,
      sessions: 200,
      pageViews: 500,
      engagementRate: 0.6,
    });
    expect(result.data.totals.previous.users).toBe(50);
    // 28 günlük seri: eksik günler 0 ile dolar, değer olan gün yerinde.
    expect(result.data.series).toHaveLength(28);
    expect(result.data.series.find((p) => p.key === "20261001")?.current.users).toBe(7);
    expect(result.data.series[0]?.previous?.users).toBe(7);
    // Küçük hücre: 5 kullanıcının altındaki ülke ve kaynak "Diğer"e katılır.
    expect(result.data.countries.rows.map((r) => r.label)).toEqual(["Turkey", "Germany", "Diğer"]);
    expect(result.data.countries.suppressedRows).toBe(2);
    expect(result.data.sources.rows.map((r) => r.label)).toEqual(["google", "Diğer"]);
    expect(JSON.stringify(result.data)).not.toContain("kisisel-blog");
    expect(result.data.pages.rows[0]?.label).toBe("(belirsiz)");
  });

  it("hata kodları sabit; mesajda belirteç, anahtar, mülk ya da e-posta yok", async () => {
    const cases: [Responder, string][] = [
      [() => ({ status: 401, body: { error: "invalid_grant", error_description: EMAIL } }), "auth"],
      [
        (c) =>
          c.url.endsWith("/token")
            ? ok(c)
            : { status: 403, body: { error: { status: "PERMISSION_DENIED", message: PROPERTY } } },
        "permission",
      ],
      [
        (c) =>
          c.url.endsWith("/token")
            ? ok(c)
            : { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
        "quota",
      ],
      [(c) => (c.url.endsWith("/token") ? ok(c) : { status: 503, body: {} }), "upstream"],
      [(c) => (c.url.endsWith("/token") ? ok(c) : "timeout"), "timeout"],
      [
        (c) => (c.url.endsWith("/token") ? ok(c) : { status: 200, body: { reports: [] } }),
        "invalid_response",
      ],
    ];
    for (const [responder, code] of cases) {
      clearGa4TokenCache();
      const result = await getTrafficSummary(
        admin,
        { range },
        {
          env: ENV,
          transport: transport(responder, []),
          store: null,
        },
      );
      expect(result).toEqual({ state: "error", error: code });
      for (const secret of [ACCESS_TOKEN, PROPERTY, EMAIL, "PRIVATE KEY"]) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    }
  });
});

describe("önbellek, eski veri ve kota koruması", () => {
  it("ikinci istek önbellekten; ağ çağrısı yok; Redis anahtarında mülk kimliği açık değil", async () => {
    const calls: Call[] = [];
    const store = memoryStore();
    const deps = { env: ENV, transport: transport(ok, calls), store, now: () => NOW };
    const first = await getTrafficSummary(admin, { range }, deps);
    const count = calls.length;
    const second = await getTrafficSummary(admin, { range }, deps);
    expect(first.state === "ok" && first.cached).toBe(false);
    expect(second.state === "ok" && second.cached).toBe(true);
    expect(calls.length).toBe(count);
    for (const key of store.data.keys()) expect(key).not.toContain(PROPERTY);
  });

  it("hata olursa son iyi veri 'eski' olarak döner", async () => {
    const store = memoryStore();
    await getTrafficSummary(admin, { range }, { env: ENV, transport: transport(ok, []), store });
    // Taze kopya düşmüş gibi: yalnızca eski kopya kalsın.
    for (const key of [...store.data.keys()]) {
      if (!key.endsWith(":stale") && !key.endsWith(":quota")) store.data.delete(key);
    }
    clearGa4TokenCache();
    const failing: Responder = (c) =>
      c.url.endsWith("/token") ? ok(c) : { status: 503, body: {} };
    const result = await getTrafficSummary(
      admin,
      { range },
      {
        env: ENV,
        transport: transport(failing, []),
        store,
      },
    );
    expect(result.state).toBe("stale");
    if (result.state === "stale") {
      expect(result.error).toBe("upstream");
      expect(result.data.totals.current.users).toBe(100);
    }
  });

  it("kalan kota eşiğin altındaysa istek atılmaz", async () => {
    const store = memoryStore();
    const lowQuota: Responder = (c) => {
      const base = ok(c);
      if (c.url.endsWith("/token") || base === "timeout") return base;
      const reports = (base.body as { reports: { propertyQuota: Record<string, unknown> }[] })
        .reports;
      for (const r of reports) {
        r.propertyQuota = {
          tokensPerProjectPerHour: { remaining: TRAFFIC_QUOTA_FLOOR.projectHour - 1 },
        };
      }
      return base;
    };
    await getTrafficSummary(
      admin,
      { range },
      { env: ENV, transport: transport(lowQuota, []), store },
    );
    const calls: Call[] = [];
    const other = parseTrafficRange({ gun: "7" }, NOW);
    const result = await getTrafficSummary(
      admin,
      { range: other },
      {
        env: ENV,
        transport: transport(ok, calls),
        store,
      },
    );
    expect(result).toEqual({ state: "error", error: "quota_guard" });
    expect(calls).toHaveLength(0);
  });

  it("önbellek deposu hata verirse görünüm yine döner", async () => {
    const broken: TrafficCacheStore = {
      get: async () => {
        throw new Error("redis yok");
      },
      set: async () => {
        throw new Error("redis yok");
      },
    };
    const result = await getTrafficSummary(
      admin,
      { range },
      {
        env: ENV,
        transport: transport(ok, []),
        store: broken,
      },
    );
    expect(result.state).toBe("ok");
  });
});

describe("tarih aralığı ve kovalar", () => {
  it("hazır aralık bugünü (İstanbul) dışarıda bırakır; önceki dönem bitişik ve eşit", () => {
    // 9 Ekim 02:30 İstanbul = 8 Ekim 23:30 UTC: "bugün" İstanbul'a göre 9 Ekim.
    const r = parseTrafficRange({ gun: "7" }, new Date("2026-10-08T23:30:00Z"));
    expect(r.current).toEqual({ start: "2026-10-02", end: "2026-10-08" });
    expect(r.previous).toEqual({ start: "2026-09-25", end: "2026-10-01" });
    expect(parseTrafficRange({ gun: "999" }, NOW).preset).toBe(28);
  });

  it("özel aralık doğrulanır", () => {
    const r = parseTrafficRange({ baslangic: "2026-09-01", bitis: "2026-09-10" }, NOW);
    expect(r).toMatchObject({
      preset: null,
      days: 10,
      previous: { start: "2026-08-22", end: "2026-08-31" },
    });
    for (const bad of [
      { baslangic: "2026-09-10", bitis: "2026-09-01" },
      { baslangic: "2026-02-30", bitis: "2026-03-01" },
      { baslangic: "2026-10-01", bitis: "2026-10-20" },
      { baslangic: "2024-01-01", bitis: "2026-01-02" },
      { baslangic: "2019-12-31", bitis: "2020-01-02" },
      { baslangic: "1' OR 1=1", bitis: "2026-01-01" },
    ]) {
      expect(() => parseTrafficRange(bad, NOW)).toThrow(TrafficRangeError);
    }
  });

  it("ISO hafta yıl sınırında doğru; kovalar sıralı ve tekil", () => {
    expect(bucketKey("2026-01-01", "hafta")).toBe("202601");
    expect(bucketKey("2027-01-01", "hafta")).toBe("202653");
    expect(bucketKey("2026-10-09", "ay")).toBe("202610");
    expect(bucketsOf({ start: "2026-09-28", end: "2026-10-11" }, "hafta")).toEqual([
      "202640",
      "202641",
    ]);
    expect(parseGranularity(undefined, 90)).toBe("hafta");
    expect(parseGranularity("ay", 7)).toBe("ay");
    expect(parseGranularity("yil", 200)).toBe("ay");
  });

  it("küçük hücre: eşik birincil kullanıcı metriğine göre", () => {
    const parsed = parseBreakdown(
      {
        rows: [
          {
            dimensionValues: [{ value: "İstanbul" }],
            metricValues: [{ value: "40" }, { value: "50" }],
          },
          {
            dimensionValues: [{ value: "Bayburt" }],
            metricValues: [{ value: "4" }, { value: "9" }],
          },
        ],
      },
      { suppressBelow: 5 },
    );
    expect(parsed).toEqual({
      rows: [
        { label: "İstanbul", detail: null, primary: 40, secondary: 50 },
        { label: "Diğer", detail: null, primary: 4, secondary: 9 },
      ],
      suppressedRows: 1,
    });
  });
});
