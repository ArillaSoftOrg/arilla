/**
 * GA4 federe kimlik (karar 0088) — birim. Ağ yok: sahte STS, IAM Credentials
 * ve Data API. Doğrulananlar: kip seçimi ve çakışma reddi, audience biçimi,
 * eksik kimlik, OIDC → STS → bürünme → Data API akışı, belirteç süresi ve
 * yenileme, STS/IAM/GA4 hatalarının ayrı kodlara eşlenmesi, belirteçlerin
 * sonuçta ya da hatada sızmaması.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { getConfigView } from "../admin/config-view.ts";
import { getTrafficSummary, type TrafficCacheStore } from "../admin/traffic.ts";
import { ga4ApiConfigFromEnv } from "./config.ts";
import { clearGa4TokenCache, type Ga4Transport } from "./data-api.ts";
import { parseTrafficRange } from "./reports.ts";

const PROPERTY = "987654321";
const EMAIL = "rapor-okur@ornek-proje.iam.gserviceaccount.com";
const AUDIENCE =
  "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel/providers/vercel-prod";
const ENV = { GA4_PROPERTY_ID: PROPERTY, GA4_CLIENT_EMAIL: EMAIL, GA4_WIF_AUDIENCE: AUDIENCE };
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const OIDC = "eyJ.sahte-vercel-oidc-belirteci.imza";
const FEDERATED = "ya29.sahte-federe-belirtec-ABCDEF";
const IMPERSONATED = "ya29.sahte-burunulmus-belirtec-123456";
const STS = "https://sts.googleapis.com/v1/token";
const IAM = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(EMAIL)}:generateAccessToken`;
const START = Date.parse("2026-10-09T09:00:00Z");
const admin: AdminActor = { userId: 1, role: "admin" };
const range = parseTrafficRange({ gun: "7" }, new Date(START));

interface Call {
  url: string;
  body: string;
  headers: Record<string, string>;
}
type Reply = { status: number; body: unknown } | "timeout";
type Responder = (call: Call, clock: number) => Reply;

const report = { rows: [{ metricValues: [{ value: "5" }] }] };

/** Başarılı akış; bürünülmüş belirteç `expireTime` ile saatten 1 saat sonra biter. */
const ok: Responder = (call, clock) => {
  if (call.url === STS) {
    return {
      status: 200,
      body: {
        access_token: FEDERATED,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3599,
      },
    };
  }
  if (call.url === IAM) {
    return {
      status: 200,
      body: { accessToken: IMPERSONATED, expireTime: new Date(clock + 3_600_000).toISOString() },
    };
  }
  const { requests } = JSON.parse(call.body) as { requests: unknown[] };
  return { status: 200, body: { reports: requests.map(() => report) } };
};

function harness(
  responder: Responder,
  subject: Ga4Transport["subjectToken"] | null = async () => OIDC,
) {
  const calls: Call[] = [];
  const clock = { now: START };
  let subjectCalls = 0;
  const transport: Ga4Transport = {
    now: () => clock.now,
    timeoutMs: 50,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        body: String(init?.body ?? ""),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      const reply = responder(call, clock.now);
      if (reply === "timeout") {
        const error = new Error("zaman aşımı");
        error.name = "TimeoutError";
        throw error;
      }
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch,
    ...(subject
      ? {
          subjectToken: async () => {
            subjectCalls += 1;
            return subject();
          },
        }
      : {}),
  };
  return { calls, clock, transport, subjectCalls: () => subjectCalls };
}

const summary = (transport: Ga4Transport, env: Record<string, string> = ENV) =>
  getTrafficSummary(admin, { range }, { env, transport, store: null, now: () => new Date(START) });

const only = (calls: Call[], url: string) => calls.filter((c) => c.url === url);

beforeEach(() => clearGa4TokenCache());

describe("yapılandırma: iki kip, çakışma reddi", () => {
  it("yalnızca GA4_WIF_AUDIENCE: federe kip, gerçek Google uç noktaları", () => {
    const result = ga4ApiConfigFromEnv(ENV);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.config.auth).toEqual({
      mode: "federated",
      audience: AUDIENCE,
      stsUrl: STS,
      iamCredentialsBase: "https://iamcredentials.googleapis.com/v1",
    });
    expect(result.config.testEndpoint).toBe(false);
  });

  it("yalnızca GA4_PRIVATE_KEY: anahtar kipi (taşınabilirlik yedeği) bozulmadı", () => {
    const { GA4_WIF_AUDIENCE: _, ...rest } = ENV;
    const result = ga4ApiConfigFromEnv({ ...rest, GA4_PRIVATE_KEY: PEM });
    expect(result.status === "ready" && result.config.auth.mode).toBe("key");
  });

  it("anahtar ve federe kimlik birlikte: ikisi de geçersiz, ağ çağrısı yok", async () => {
    const env = { ...ENV, GA4_PRIVATE_KEY: PEM };
    expect(ga4ApiConfigFromEnv(env)).toEqual({
      status: "invalid",
      problems: ["GA4_PRIVATE_KEY", "GA4_WIF_AUDIENCE"],
    });
    const h = harness(ok);
    expect(await summary(h.transport, env)).toEqual({
      state: "invalid_config",
      problems: ["GA4_PRIVATE_KEY", "GA4_WIF_AUDIENCE"],
    });
    expect(h.calls).toHaveLength(0);
    expect(h.subjectCalls()).toBe(0);
  });

  it("biçimsiz audience reddedilir (havuz/sağlayıcı yolu, proje numarası)", () => {
    for (const audience of [
      "https://vercel.com/ekip",
      "//iam.googleapis.com/projects/manicepte/locations/global/workloadIdentityPools/vercel/providers/vercel-prod",
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel",
      `${AUDIENCE}/fazla`,
    ]) {
      expect(ga4ApiConfigFromEnv({ ...ENV, GA4_WIF_AUDIENCE: audience })).toEqual({
        status: "invalid",
        problems: ["GA4_WIF_AUDIENCE"],
      });
    }
  });

  it("mülk ve hesap var ama kimlik bilgisi yok: geçersiz, eksik değişken adlandırılır", () => {
    const { GA4_WIF_AUDIENCE: _, ...rest } = ENV;
    expect(ga4ApiConfigFromEnv(rest)).toEqual({
      status: "invalid",
      problems: ["GA4_WIF_AUDIENCE"],
    });
  });

  it("sahte uç nokta federe kipte de yalnızca yerel adrese bağlanır", () => {
    const result = ga4ApiConfigFromEnv({ ...ENV, GA4_TEST_API_BASE_URL: "http://127.0.0.1:3399" });
    expect(result.status === "ready" && result.config.auth).toEqual({
      mode: "federated",
      audience: AUDIENCE,
      stsUrl: "http://127.0.0.1:3399/sts/v1/token",
      iamCredentialsBase: "http://127.0.0.1:3399/iamcredentials/v1",
    });
  });

  it("yapılandırma görünümü kipi söyler, değer sızdırmaz", () => {
    const federated = new Map(getConfigView(admin, ENV).entries.map((e) => [e.key, e]));
    expect(federated.get("GA4_WIF_AUDIENCE")).toMatchObject({ state: "set", value: AUDIENCE });
    expect(federated.get("GA4_CLIENT_EMAIL")?.note).toContain("Kip: federe (anahtarsız)");
    expect(federated.get("GA4_CLIENT_EMAIL")?.value).toBeNull();
    const conflict = getConfigView(admin, { ...ENV, GA4_PRIVATE_KEY: PEM });
    const byKey = new Map(conflict.entries.map((e) => [e.key, e]));
    expect(byKey.get("GA4_WIF_AUDIENCE")?.state).toBe("invalid");
    expect(byKey.get("GA4_PRIVATE_KEY")?.state).toBe("invalid");
    expect(byKey.get("GA4_CLIENT_EMAIL")?.note).toContain("Kip: çakışma");
    expect(JSON.stringify(conflict)).not.toContain("PRIVATE KEY-----\n");
  });
});

describe("federe akış: OIDC → STS → bürünme → Data API", () => {
  it("başarılı kimlik doğrulama: doğru STS isteği, en dar kapsamla bürünme", async () => {
    const h = harness(ok);
    const result = await summary(h.transport);
    expect(result.state).toBe("ok");
    expect(h.calls.map((c) => c.url)).toEqual([
      STS,
      IAM,
      `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:batchRunReports`,
    ]);

    const [sts, iam, api] = h.calls;
    expect(sts?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(sts?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: AUDIENCE,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: OIDC,
    });
    expect(sts?.headers.authorization).toBeUndefined();

    expect(iam?.headers.authorization).toBe(`Bearer ${FEDERATED}`);
    expect(JSON.parse(iam?.body ?? "{}")).toEqual({
      scope: ["https://www.googleapis.com/auth/analytics.readonly"],
      lifetime: "3600s",
    });

    // Data API yalnızca bürünülmüş (salt okunur) belirteci görür; OIDC ve federe belirteç asla.
    expect(api?.headers.authorization).toBe(`Bearer ${IMPERSONATED}`);
    expect(api?.body).not.toContain(OIDC);
    expect(JSON.stringify(result)).not.toMatch(/ya29|eyJ/);
  });

  it("belirteç bellekte yeniden kullanılır; süresi dolmadan 60 sn önce yenilenir", async () => {
    const h = harness(ok);
    await summary(h.transport);
    h.clock.now = START + 30 * 60_000;
    await summary(h.transport);
    expect(only(h.calls, STS)).toHaveLength(1);
    expect(only(h.calls, IAM)).toHaveLength(1);
    expect(h.subjectCalls()).toBe(1);

    // expireTime = START + 60 dk; 59 dk 30 sn'de yenileme payının içindeyiz.
    h.clock.now = START + 59 * 60_000 + 30_000;
    await summary(h.transport);
    expect(only(h.calls, STS)).toHaveLength(2);
    expect(only(h.calls, IAM)).toHaveLength(2);
    // OIDC belirteci saklanmaz: her yenilemede yeniden istenir.
    expect(h.subjectCalls()).toBe(2);
  });

  it("kısa ömürlü bürünülmüş belirteç: expireTime'a uyulur", async () => {
    const short: Responder = (call, clock) =>
      call.url === IAM
        ? {
            status: 200,
            body: {
              accessToken: IMPERSONATED,
              expireTime: new Date(clock + 120_000).toISOString(),
            },
          }
        : ok(call, clock);
    const h = harness(short);
    await summary(h.transport);
    h.clock.now = START + 61_000;
    await summary(h.transport);
    expect(only(h.calls, STS)).toHaveLength(2);
  });

  it("OIDC belirteci yok, boş ya da sağlayıcı hata veriyor: identity_unavailable, ağ yok", async () => {
    for (const subject of [
      null,
      async () => null,
      async () => "  ",
      async () => {
        throw new Error(`sızmamalı ${OIDC}`);
      },
    ]) {
      clearGa4TokenCache();
      const h = harness(ok, subject);
      const result = await summary(h.transport);
      expect(result).toEqual({ state: "error", error: "identity_unavailable" });
      expect(h.calls).toHaveLength(0);
    }
  });

  it("geçersiz audience (STS 400 invalid_request): federation_rejected, IAM çağrılmaz", async () => {
    const h = harness((call, clock) =>
      call.url === STS
        ? {
            status: 400,
            body: {
              error: "invalid_request",
              error_description: `Invalid value for "audience". ${OIDC}`,
            },
          }
        : ok(call, clock),
    );
    const result = await summary(h.transport);
    expect(result).toEqual({ state: "error", error: "federation_rejected" });
    expect(only(h.calls, IAM)).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("audience");
  });

  it("reddedilen kimlik (öznitelik koşulu ya da süresi geçmiş OIDC, STS invalid_grant)", async () => {
    const h = harness((call, clock) =>
      call.url === STS
        ? {
            status: 400,
            body: {
              error: "invalid_grant",
              error_description: "The given credential is rejected by the attribute condition.",
            },
          }
        : ok(call, clock),
    );
    expect(await summary(h.transport)).toEqual({ state: "error", error: "federation_rejected" });
    expect(only(h.calls, IAM)).toHaveLength(0);
  });

  it("STS sunucu hatası, kota ve zaman aşımı ayrı kodlara düşer", async () => {
    const cases: [Reply, string][] = [
      [{ status: 503, body: { error: "unavailable" } }, "upstream"],
      [{ status: 429, body: { error: "rate_limited" } }, "quota"],
      ["timeout", "timeout"],
      [{ status: 200, body: { token_type: "Bearer" } }, "invalid_response"],
    ];
    for (const [reply, code] of cases) {
      clearGa4TokenCache();
      const h = harness((call, clock) => (call.url === STS ? reply : ok(call, clock)));
      expect(await summary(h.transport)).toEqual({ state: "error", error: code });
      expect(only(h.calls, IAM)).toHaveLength(0);
    }
  });

  it("IAM izni yok (Workload Identity User eksik): impersonation_denied, Data API çağrılmaz", async () => {
    const h = harness((call, clock) =>
      call.url === IAM
        ? {
            status: 403,
            body: {
              error: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: `Permission 'iam.serviceAccounts.getAccessToken' denied on ${EMAIL}`,
              },
            },
          }
        : ok(call, clock),
    );
    const result = await summary(h.transport);
    expect(result).toEqual({ state: "error", error: "impersonation_denied" });
    expect(h.calls.some((c) => c.url.includes(":batchRunReports"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
  });

  it("bürünme başarılı ama mülkte rol yok: GA4 403 permission olarak kalır", async () => {
    const h = harness((call, clock) =>
      call.url.includes(":batchRunReports")
        ? { status: 403, body: { error: { status: "PERMISSION_DENIED" } } }
        : ok(call, clock),
    );
    expect(await summary(h.transport)).toEqual({ state: "error", error: "permission" });
  });

  it("kimlik hatasından sonra bellekteki belirteç kullanılmaz, yeniden değiş tokuş edilir", async () => {
    let deny = false;
    const h = harness((call, clock) =>
      deny && call.url.includes(":batchRunReports")
        ? { status: 401, body: { error: { status: "UNAUTHENTICATED" } } }
        : ok(call, clock),
    );
    await summary(h.transport);
    deny = true;
    expect(await summary(h.transport)).toEqual({ state: "error", error: "auth" });
    deny = false;
    await summary(h.transport);
    expect(only(h.calls, STS)).toHaveLength(2);
  });

  it("hata durumunda son iyi veri eski veri olarak döner (önbellek korunur)", async () => {
    const data = new Map<string, string>();
    const store: TrafficCacheStore = {
      async get(key) {
        return key.endsWith(":stale") ? (data.get(key) ?? null) : null;
      },
      async set(key, value) {
        data.set(key, value);
      },
    };
    const good = harness(ok);
    await getTrafficSummary(
      admin,
      { range },
      { env: ENV, transport: good.transport, store, now: () => new Date(START) },
    );
    clearGa4TokenCache();
    const bad = harness((call, clock) =>
      call.url === STS ? { status: 400, body: { error: "invalid_grant" } } : ok(call, clock),
    );
    const result = await getTrafficSummary(
      admin,
      { range },
      { env: ENV, transport: bad.transport, store, now: () => new Date(START) },
    );
    expect(result.state).toBe("stale");
    expect(result.state === "stale" && result.error).toBe("federation_rejected");
  });
});
