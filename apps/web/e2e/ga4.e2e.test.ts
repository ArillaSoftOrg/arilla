/**
 * GA4 (karar 0087) — gerçek başsız Chrome ile uçtan uca. Google'a HİÇBİR
 * istek gitmez: ölçüm kökenleri CDP ile ağ katmanında engellenir; raporlama
 * için yerel sahte Data API sunucusu açılır.
 *
 * Sunucu şu ortamla başlatılmış olmalı (yoksa ilgili testler atlanır):
 *   GA4_MEASUREMENT_ID=<E2E_GA4_MEASUREMENT_ID ile aynı, sahte G- kimliği>
 *   GA4_PROPERTY_ID / GA4_CLIENT_EMAIL ve kimlik kiplerinden YALNIZCA biri:
 *     anahtar: GA4_PRIVATE_KEY (test için üretilmiş)
 *     federe (karar 0088): GA4_WIF_AUDIENCE=<E2E_GA4_WIF_AUDIENCE>,
 *       VERCEL=1 (yalnızca `next start` ortamında, derlemede DEĞİL) ve
 *       VERCEL_OIDC_TOKEN=<E2E_GA4_OIDC_TOKEN>. Belirteç gerçek `@vercel/oidc`
 *       `getVercelOidcToken()` yolundan okunur; `next start`'ta Vercel istek
 *       bağlamı olmadığından ortam değişkenine düşer. Sahte, imzasız ama
 *       JWT biçimli ve süresi geçmemiş olmalı (kütüphane `exp`'i denetler).
 *   GA4_TEST_API_BASE_URL=http://127.0.0.1:<E2E_GA4_FAKE_PORT>
 * Test sürecine federe kipte ayrıca E2E_GA4_WIF_AUDIENCE ve E2E_GA4_OIDC_TOKEN.
 *
 * Denetlenenler: rızasız ve reddedilmiş durumda betik/istek/dataLayer yok;
 * analitik rızasıyla yalnızca arındırılmış page_view (arama metni, token,
 * e-posta yok); ölçülmeyen yolda betik yüklenmez; rıza geri alınınca ölçüm
 * anında durur ve _ga çerezleri silinir; CSP kamu sayfasında GA4 kökenlerini
 * içerir, yönetimde içermez; /yonetim/trafik sahte veriyle, hata durumunda
 * ve yetkisiz rolde (404); iki tema ve dar ekranda taşma yok.
 */
import { createServer, type Server } from "node:http";
import { generateRawToken, hashToken } from "@arilla/core";
import { fromSelection, rejectAll, serializeConsent } from "@arilla/core/cookie-consent";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, type CdpPage, findChrome } from "./cdp.ts";

function requireLocal(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} tanımlı değil`);
  const host = new URL(value).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); E2E yalnızca yerelde çalışır.`);
  }
  return value;
}

const BASE = requireLocal("E2E_BASE_URL").replace(/\/+$/, "");
const CHROME = findChrome();
const MEASUREMENT_ID = process.env.E2E_GA4_MEASUREMENT_ID ?? "";
const FAKE_PORT = Number(process.env.E2E_GA4_FAKE_PORT ?? 0);
const COLLECTION = Boolean(CHROME && /^G-[A-Z0-9]{6,12}$/.test(MEASUREMENT_ID));
const REPORTING = Boolean(CHROME && FAKE_PORT > 0);
/** Karar 0088: federe kip. Sahte STS yalnızca bu audience ve bu OIDC belirtecini kabul eder. */
const WIF_AUDIENCE = process.env.E2E_GA4_WIF_AUDIENCE ?? "";
const OIDC_TOKEN = process.env.E2E_GA4_OIDC_TOKEN ?? "";
const FEDERATED = Boolean(REPORTING && WIF_AUDIENCE && OIDC_TOKEN);
const FAKE_FEDERATED = "sahte-e2e-federe-belirtec-123456";
const FAKE_ACCESS = "sahte-e2e-belirteci-123456";
const TAG = `ga4e2e${Date.now().toString(36)}`;
const GOOGLE_PATTERNS = [
  "*googletagmanager.com*",
  "*google-analytics.com*",
  "*analytics.google.com*",
];

const analyticsConsent = () =>
  encodeURIComponent(
    serializeConsent(fromSelection({ functional: false, analytics: true, marketing: false })),
  );

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;
const owner = () => {
  ownerPool ??= createDatabase(requireLocal("DATABASE_URL_OWNER")).$client;
  return ownerPool;
};

let browser: Browser | undefined;
let fake: Server | undefined;
const fakeRequests: string[] = [];
const users = { adminId: 0, adminToken: "", moderatorId: 0, moderatorToken: "" };

/** Sahte Data API: toplu isteklerdeki her rapora tanımına göre sabit satırlar. */
function fakeReport(request: {
  dimensions?: { name: string }[];
  metrics: unknown[];
  dateRanges: { startDate: string }[];
}) {
  const dims = (request.dimensions ?? []).map((d) => d.name);
  const values = (list: number[]) =>
    request.metrics.map((_, i) => ({ value: String(list[i] ?? 0) }));
  // Önceki dönem (seçili 28 günden önceki aralık) yarı değerle döner.
  const previous = (request.dateRanges[0]?.startDate ?? "") < "2026-09-11" ? 0.5 : 1;
  const quota = { tokensPerHour: { consumed: 3, remaining: 39_000 } };
  if (dims.length === 0) {
    return {
      rows: [{ metricValues: values([1234 * previous, 400, 2345, 6789, 0.6123]) }],
      propertyQuota: quota,
    };
  }
  const rows: Record<string, [string[], number[]][]> = {
    sessionDefaultChannelGroup: [
      [["Organic Search"], [1200, 900, 0.71]],
      [["Direct"], [800, 600, 0.55]],
    ],
    sessionSource: [
      [
        ["google", "organic"],
        [1100, 850],
      ],
      [
        ["kucuk-site.example", "referral"],
        [3, 2],
      ],
    ],
    pagePath: [
      [["/"], [3000, 900]],
      [["/urun/[slug]"], [1500, 500]],
    ],
    deviceCategory: [
      [["mobile"], [900, 1500]],
      [["desktop"], [334, 845]],
    ],
    country: [
      [["Turkey"], [1200, 2300]],
      [["Iceland"], [2, 2]],
    ],
    region: [
      [["Istanbul"], [700, 1300]],
      [["Bayburt"], [1, 1]],
    ],
  };
  const first = dims[0] ?? "";
  if (first === "date") {
    // Günlük seri: başlangıçtan 28 gün, dalgalı değerler (grafik görsel denetimi için).
    const start = Date.parse(`${request.dateRanges[0]?.startDate}T00:00:00Z`);
    return {
      rows: Array.from({ length: 28 }, (_, i) => ({
        dimensionValues: [
          {
            value: new Date(start + i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""),
          },
        ],
        metricValues: values([
          Math.round((30 + ((i * 7) % 20)) * previous),
          40 + i,
          120 + ((i * 13) % 40),
        ]),
      })),
      propertyQuota: quota,
    };
  }
  if (first === "isoYearIsoWeek" || first === "yearMonth") {
    return { rows: [], propertyQuota: quota };
  }
  return {
    rows: (rows[first] ?? []).map(([dimensionValues, metricValues]) => ({
      dimensionValues: dimensionValues.map((value) => ({ value })),
      metricValues: values(metricValues),
    })),
    propertyQuota: quota,
  };
}

async function waitUntil(page: CdpPage, expression: string, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

const DATA_LAYER = `JSON.stringify((window.dataLayer ?? []).map((entry) => Array.from(entry)))`;

beforeAll(async () => {
  if (!CHROME) return;
  if (REPORTING) {
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        fakeRequests.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        if (req.url === "/token") {
          res.end(JSON.stringify({ access_token: FAKE_ACCESS, expires_in: 3600 }));
          return;
        }
        if (req.url === "/sts/v1/token") {
          const form = new URLSearchParams(body);
          const accepted =
            FEDERATED &&
            form.get("audience") === WIF_AUDIENCE &&
            form.get("subject_token") === OIDC_TOKEN &&
            form.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange";
          if (!accepted) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          res.end(JSON.stringify({ access_token: FAKE_FEDERATED, expires_in: 3600 }));
          return;
        }
        if (req.url?.startsWith("/iamcredentials/v1/projects/-/serviceAccounts/")) {
          if (req.headers.authorization !== `Bearer ${FAKE_FEDERATED}`) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }));
            return;
          }
          res.end(
            JSON.stringify({
              accessToken: FAKE_ACCESS,
              expireTime: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          );
          return;
        }
        if (req.headers.authorization !== `Bearer ${FAKE_ACCESS}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }));
          return;
        }
        const parsed = JSON.parse(body || "{}") as {
          requests?: Parameters<typeof fakeReport>[0][];
        };
        const requests = parsed.requests ?? [];
        if (requests.some((r) => r.dateRanges[0]?.startDate.startsWith("2021-01"))) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "sahte" } }));
          return;
        }
        res.end(JSON.stringify({ reports: requests.map(fakeReport) }));
      });
    });
    await new Promise<void>((resolve) => fake?.listen(FAKE_PORT, "127.0.0.1", resolve));
  }
  const db = owner();
  for (const role of ["admin", "moderator"] as const) {
    const user = await db.query("INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id", [
      `${TAG}-${role}@test.local`,
      role,
    ]);
    const token = generateRawToken();
    await db.query(
      "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
      [user.rows[0].id, hashToken(token)],
    );
    if (role === "admin") {
      users.adminId = Number(user.rows[0].id);
      users.adminToken = token;
    } else {
      users.moderatorId = Number(user.rows[0].id);
      users.moderatorToken = token;
    }
  }
  browser = await Browser.launch(CHROME);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
  if (!CHROME) return;
  const db = owner();
  const ids = [users.adminId, users.moderatorId].filter(Boolean);
  await db.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [ids]);
  await db.query("DELETE FROM app_user WHERE id = ANY($1)", [ids]);
  await ownerPool?.end();
});

async function freshPage(consentCookie: string | null): Promise<CdpPage> {
  if (!browser) throw new Error("tarayıcı yok");
  const page = await browser.newPage();
  await page.blockUrls(GOOGLE_PATTERNS);
  await page.setViewport({ width: 1280, height: 900 });
  if (consentCookie) await page.setCookie(BASE, "cookie_consent", consentCookie);
  return page;
}

describe.skipIf(!COLLECTION)("GA4 toplama - rıza kapısı (gerçek Chrome)", () => {
  it("CSP: kamu sayfasında GA4 kökenleri var, yönetimde yok", async () => {
    const publicCsp = (await fetch(`${BASE}/sss`)).headers.get("content-security-policy") ?? "";
    expect(publicCsp).toContain("https://www.googletagmanager.com");
    const adminCsp =
      (await fetch(`${BASE}/yonetim`, { redirect: "manual" })).headers.get(
        "content-security-policy",
      ) ?? "";
    expect(adminCsp).toContain("frame-ancestors 'none'");
    expect(adminCsp).not.toContain("googletagmanager");
  });

  for (const [name, cookie] of [
    ["rıza yok", null],
    ["tümü reddedildi", encodeURIComponent(serializeConsent(rejectAll()))],
  ] as const) {
    it(`${name}: betik, istek, dataLayer ve _ga çerezi yok`, async () => {
      const page = await freshPage(cookie);
      await page.goto(`${BASE}/ara?q=ali%40ornek.com&utm_source=bulten`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await page.evaluate(`document.getElementById("ga4-gtag") === null`)).toBe(true);
      expect(await page.evaluate(`typeof window.dataLayer`)).toBe("undefined");
      expect(page.requestedUrls.some((url) => /google/.test(new URL(url).hostname))).toBe(false);
      expect(await page.evaluate<string>("document.cookie")).not.toMatch(/(^|; )_ga/);
    });
  }

  it("analitik rızası: yalnızca arındırılmış page_view; arama metni, token, e-posta yok", async () => {
    const page = await freshPage(analyticsConsent());
    await page.goto(
      // /sss ürün erişimi kapalıyken de çizilir (/ara kapalı modda ana sayfaya döner).
      `${BASE}/sss?q=ali%40ornek.com+05321234567&token=gizli-belirtec&utm_source=bulten#cevap`,
    );
    expect(await waitUntil(page, `document.getElementById("ga4-gtag")`)).toBe(true);
    expect(await waitUntil(page, `${DATA_LAYER}.includes("page_view")`)).toBe(true);
    const scriptSrc = await page.evaluate<string>(`document.getElementById("ga4-gtag").src`);
    expect(scriptSrc).toBe(`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`);
    // İstek tarayıcıdan çıkmaya çalıştı ama ağ katmanında engellendi.
    expect(page.requestedUrls.some((url) => url.startsWith(scriptSrc))).toBe(true);

    const entries = JSON.parse(await page.evaluate<string>(DATA_LAYER)) as unknown[][];
    const pageView = entries.find((entry) => entry[0] === "event" && entry[1] === "page_view");
    expect(pageView?.[2]).toMatchObject({
      page_location: `${BASE}/sss?utm_source=bulten`,
      page_title: "/sss",
    });
    const config = entries.find((entry) => entry[0] === "config");
    expect(config?.[1]).toBe(MEASUREMENT_ID);
    expect(config?.[2]).toMatchObject({
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    const events = entries.filter((entry) => entry[0] === "event").map((entry) => entry[1]);
    expect(events).toEqual(["page_view"]);
    const serialized = JSON.stringify(entries);
    for (const leak of ["ornek.com", "%40", "0532", "gizli-belirtec", "token", "q=", "#cevap"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("ölçülmeyen yolda (token taşıyan giriş bağlantısı) betik yüklenmez, ölçüm kapalı", async () => {
    const page = await freshPage(analyticsConsent());
    await page.goto(`${BASE}/giris/dogrula?token=gizli-belirtec`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await page.evaluate(`document.getElementById("ga4-gtag") === null`)).toBe(true);
    expect(await page.evaluate(`window["ga-disable-${MEASUREMENT_ID}"] === true`)).toBe(true);
    expect(page.requestedUrls.some((url) => url.includes("googletagmanager"))).toBe(false);
  });

  it("rıza geri alınınca ölçüm anında durur ve _ga çerezleri silinir", async () => {
    const page = await freshPage(analyticsConsent());
    const suffix = MEASUREMENT_ID.replace(/^G-/, "");
    await page.setCookie(BASE, "_ga", "GA1.1.111.222");
    await page.setCookie(BASE, `_ga_${suffix}`, "GS1.1.333");
    await page.goto(`${BASE}/cerez`);
    expect(await waitUntil(page, `document.getElementById("ga4-gtag")`)).toBe(true);
    expect(await page.evaluate(`window["ga-disable-${MEASUREMENT_ID}"]`)).toBe(false);

    const clicked = await page.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll("#tercihler button")]
        .find((b) => b.textContent.trim() === "Tümünü Reddet");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    expect(await waitUntil(page, `window["ga-disable-${MEASUREMENT_ID}"] === true`)).toBe(true);
    expect(await waitUntil(page, `!/(^|; )_ga/.test(document.cookie)`)).toBe(true);
    const entries = JSON.parse(await page.evaluate<string>(DATA_LAYER)) as unknown[][];
    const last = entries.at(-1);
    expect(last?.[0]).toBe("consent");
    expect(last?.[2]).toMatchObject({ analytics_storage: "denied" });

    // Sonraki gezinmede (yeni yükleme) betik yok, olay yok.
    await page.goto(`${BASE}/sss`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await page.evaluate(`document.getElementById("ga4-gtag") === null`)).toBe(true);
    expect(await page.evaluate(`typeof window.dataLayer`)).toBe("undefined");
  });
});

const OVERFLOW = `document.documentElement.scrollWidth - document.documentElement.clientWidth`;

describe.skipIf(!REPORTING)("/yonetim/trafik - sahte GA4 Data API (gerçek Chrome)", () => {
  it("yönetici: sahte veri, uyarı, grafik, küçük hücre; iki tema ve dar ekranda taşma yok", async () => {
    if (!browser) throw new Error("tarayıcı yok");
    const page = await browser.newPage();
    await page.blockUrls(GOOGLE_PATTERNS);
    await page.setCookie(BASE, "session", users.adminToken);
    await page.setCookie(BASE, "cookie_consent", encodeURIComponent(serializeConsent(rejectAll())));
    for (const scheme of ["light", "dark"] as const) {
      await page.setColorScheme(scheme);
      for (const width of [360, 390, 768, 1440]) {
        await page.setViewport({ width, height: 900, touch: width < 1024 });
        await page.goto(`${BASE}/yonetim/trafik?gun=28&dilim=hafta`);
        // Veri bölümü Suspense ile akar: grafik figürü gelene kadar bekle.
        expect(await waitUntil(page, `document.querySelector("main figure svg[role=img]")`)).toBe(
          true,
        );
        const text = await page.evaluate<string>("document.querySelector('main').innerText");
        expect(text).toContain("Sahte yerel uç nokta");
        expect(text).toContain("1.234");
        expect(text).toContain("Organik arama");
        expect(text).toContain("Diğer");
        expect(text).not.toContain("kucuk-site.example");
        expect(text).not.toContain("Bayburt");
        expect(await page.evaluate<number>(OVERFLOW)).toBeLessThanOrEqual(0);
      }
    }
  });

  it.skipIf(!FEDERATED)(
    "federe kip: OIDC → STS → bürünme; anahtar akışı yok, belirteç sayfaya sızmaz",
    async () => {
      if (!browser) throw new Error("tarayıcı yok");
      const page = await browser.newPage();
      await page.setCookie(BASE, "session", users.adminToken);
      // Önbellek (Redis, tamamlanmış aralık 6 saat) belirteç akışını gizlemesin:
      // her çalıştırmada benzersiz, geçmişte kalan bir özel aralık.
      const start = new Date(Date.UTC(2025, 1, 1) + Math.floor(Math.random() * 300) * 86_400_000);
      const end = new Date(start.getTime() + 13 * 86_400_000);
      const day = (date: Date) => date.toISOString().slice(0, 10);
      await page.goto(`${BASE}/yonetim/trafik?baslangic=${day(start)}&bitis=${day(end)}`);
      expect(await waitUntil(page, `document.querySelector("main figure svg[role=img]")`)).toBe(
        true,
      );
      // Süreç boyunca (önceki testler dahil) anahtar uç noktası hiç çağrılmadı.
      expect(fakeRequests).not.toContain("/token");
      expect(fakeRequests).toContain("/sts/v1/token");
      expect(fakeRequests.some((url) => url.includes(":generateAccessToken"))).toBe(true);
      expect(fakeRequests.some((url) => url.includes(":batchRunReports"))).toBe(true);
      const html = await page.evaluate<string>("document.documentElement.outerHTML");
      for (const secret of [OIDC_TOKEN, FAKE_FEDERATED, FAKE_ACCESS]) {
        expect(html).not.toContain(secret);
      }
      const response = await fetch(`${BASE}/yonetim/ayarlar`, {
        headers: { cookie: `session=${users.adminToken}` },
      });
      const settings = await response.text();
      expect(settings).toContain("Kip: federe (anahtarsız)");
      expect(settings).not.toContain(OIDC_TOKEN);
    },
  );

  it("hata durumu: yetki hatası anlaşılır mesajla, sayı uydurulmaz", async () => {
    if (!browser) throw new Error("tarayıcı yok");
    const page = await browser.newPage();
    await page.setCookie(BASE, "session", users.adminToken);
    await page.goto(`${BASE}/yonetim/trafik?baslangic=2021-01-01&bitis=2021-01-31`);
    expect(await waitUntil(page, `document.querySelector("main [role=alert]")`)).toBe(true);
    const text = await page.evaluate<string>("document.querySelector('main').innerText");
    expect(text).toContain("Servis hesabının bu GA4 mülküne erişimi yok");
    expect(text).not.toContain("1.234");
  });

  it("geçersiz özel aralık uyarıyla varsayılana döner", async () => {
    if (!browser) throw new Error("tarayıcı yok");
    const page = await browser.newPage();
    await page.setCookie(BASE, "session", users.adminToken);
    await page.goto(`${BASE}/yonetim/trafik?baslangic=2026-09-10&bitis=2026-09-01`);
    const text = await page.evaluate<string>("document.querySelector('main').innerText");
    expect(text).toContain("Başlangıç bitişten sonra olamaz.");
  });

  it("genel bakışta trafik özeti; moderatör ve anonim için sayfa yok", async () => {
    const dashboard = await fetch(`${BASE}/yonetim`, {
      headers: { cookie: `session=${users.adminToken}` },
    });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("Site trafiği (7 gün, GA4 rızalı örneklem)");
    const moderator = await fetch(`${BASE}/yonetim/trafik`, {
      headers: { cookie: `session=${users.moderatorToken}` },
      redirect: "manual",
    });
    expect(moderator.status).toBe(404);
    const moderatorDashboard = await fetch(`${BASE}/yonetim`, {
      headers: { cookie: `session=${users.moderatorToken}` },
    });
    expect(await moderatorDashboard.text()).not.toContain("Site trafiği (7 gün");
    const anonymous = await fetch(`${BASE}/yonetim/trafik`, { redirect: "manual" });
    expect([302, 303, 307, 404]).toContain(anonymous.status);
  });
});
