import { describe, expect, it } from "vitest";
import {
  type DiscoveryEnv,
  runDiscovery,
  SITEMAP_INDEX_KEY,
  SITEMAP_ORIGIN,
} from "./discovery-logic.ts";

// Sentetik sitemap'ler: gercek Hepsiburada verisi degildir; Hepsiburada'ya istek ATILMAZ.
const F1 = "sitemaps/product/sitemap_1.xml";
const F2 = "sitemaps/product/sitemap_2.xml";
const index = `<sitemapindex>${[F1, F2].map((k) => `<sitemap><loc>${SITEMAP_ORIGIN}/${k}</loc></sitemap>`).join("")}</sitemapindex>`;
const urlset = (ids: string[]) =>
  `<urlset>${ids.map((i) => `<url><loc>${SITEMAP_ORIGIN}/u-${i}-pm-HBC${i}</loc><image:image><image:loc>https://productimages.hepsiburada.net/${i}.jpg</image:loc><image:title>Urun ${i}</image:title></image:image></url>`).join("")}<url><loc>${SITEMAP_ORIGIN}/kategori</loc></url></urlset>`;

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

type Files = Record<string, { status: number; text?: string }>;

function fakeEnv(
  files: Files,
  over: Partial<DiscoveryEnv> = {},
  denyReserve?: { after: number; code: string },
) {
  const calls: {
    fetch: string[];
    api: Record<string, unknown>[];
    sleeps: number[];
    reserved: number[];
  } = {
    fetch: [],
    api: [],
    sleeps: [],
    reserved: [],
  };
  let reservedTotal = 0;
  const units: { unitKey: string }[] = [];
  const done = new Set<string>();
  let bytes = 0;
  const env: DiscoveryEnv = {
    source: "hepsiburada",
    delayMs: 2000,
    maxDecodedBytesPerFile: 10_000_000,
    now: () => new Date("2026-10-20T10:00:00Z"),
    log: () => {},
    shouldStop: () => false,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    async fetchSource(url) {
      calls.fetch.push(url);
      const f = files[url.slice(SITEMAP_ORIGIN.length + 1)] ?? { status: 404 };
      return { status: f.status, body: f.text === undefined ? null : stream(f.text) };
    },
    async api(body) {
      if (body.op === "discovery_reserve") {
        // Her kaynak isteginden ONCE: o ana kadar atilan fetch sayisini kaydet (karar 0123).
        calls.reserved.push(calls.fetch.length);
        reservedTotal += 1;
        if (denyReserve && reservedTotal > denyReserve.after) {
          return { ok: false, status: 429, data: { error: denyReserve.code } };
        }
        return { ok: true, status: 200, data: { requestsReserved: reservedTotal } };
      }
      calls.api.push(body);
      switch (body.op) {
        case "start":
          return { ok: true, status: 200, data: { id: 7, maxRequests: 500 } };
        case "discovery_approve":
          return { ok: true, status: 200, data: { approvedBytes: body.bytes } };
        case "discovery_plan":
          for (const k of body.keys as string[]) {
            if (!units.some((u) => u.unitKey === k)) units.push({ unitKey: k });
          }
          return { ok: true, status: 200, data: { planned: 1, alreadyPlanned: 0 } };
        case "discovery_next":
          return {
            ok: true,
            status: 200,
            data: { units: units.filter((u) => !done.has(u.unitKey)).slice(0, 1) },
          };
        case "discovery_batch":
          if (body.status === "done" || body.status === "empty") done.add(body.unitKey as string);
          bytes += Number(body.bytesReceived);
          return {
            ok: true,
            status: 200,
            data: {
              inserted: (body.items as unknown[]).length,
              seenAgain: 0,
              rejected: 0,
              bytesDownloaded: bytes,
            },
          };
        case "discovery_progress":
          return {
            ok: true,
            status: 200,
            data: { uniqueProducts: 3, unitsByStatus: { done: done.size } },
          };
        default:
          return { ok: true, status: 200, data: {} };
      }
    },
    ...over,
  };
  return { env, calls };
}

const opts = {
  approveBytes: 1_000_000,
  transferOrigin: "admin_wifi" as const,
  maxFilesThisSession: 10,
  resumeRun: null,
};

describe("runDiscovery istek rezervasyonu (karar 0123)", () => {
  const files: Files = {
    [SITEMAP_INDEX_KEY]: { status: 200, text: index },
    [F1]: { status: 200, text: urlset(["1", "2"]) },
    [F2]: { status: 200, text: urlset(["3"]) },
  };

  it("her kaynak isteginden ONCE rezerve eder (n. fetch icin n. rezervasyon once gelir)", async () => {
    const { env, calls } = fakeEnv(files);
    await runDiscovery(env, opts);
    // 3 fetch icin 3 rezervasyon; i. rezervasyon aninda yalniz i-1 fetch atilmis olmali.
    expect(calls.reserved).toEqual([0, 1, 2]);
    expect(calls.fetch).toHaveLength(3);
  });

  it("gunluk kota reddederse kaynaga istek ATILMAZ, koşu açık kalır", async () => {
    const { env, calls } = fakeEnv(
      files,
      {},
      { after: 1, code: "collection_quota_daily_requests" },
    );
    expect(await runDiscovery(env, opts)).toBe("daily_quota");
    expect(calls.fetch).toHaveLength(1); // yalniz rezerve edilen ilk istek
    expect(calls.api.some((b) => b.op === "close")).toBe(false);
  });

  it("aylik kota reddederse temiz durur", async () => {
    const { env, calls } = fakeEnv(
      files,
      {},
      { after: 0, code: "collection_quota_monthly_requests" },
    );
    expect(await runDiscovery(env, opts)).toBe("monthly_quota");
    expect(calls.fetch).toHaveLength(0);
  });

  it("baska bir rezervasyon hatasinda istek atilmaz ve hata doner", async () => {
    const { env, calls } = fakeEnv(files, {}, { after: 0, code: "request_budget_exceeded" });
    expect(await runDiscovery(env, opts)).toBe("error");
    expect(calls.fetch).toHaveLength(0);
  });

  it("devamda rezerve sayaci sunucudaki degerden baslar; rezerve butce dolunca durur", async () => {
    const { env, calls } = fakeEnv(files);
    const reason = await runDiscovery(env, {
      ...opts,
      resumeRun: {
        id: 7,
        requestsMade: 4,
        requestsReserved: 5,
        maxRequests: 5,
        bytesDownloaded: 0,
        approvedBytes: 1_000_000,
      },
    });
    expect(reason).toBe("budget");
    expect(calls.fetch).toHaveLength(0);
    expect(calls.reserved).toHaveLength(0);
  });

  it("indeksteki .xml.gz urun sitemap dosyalarini da planlar", async () => {
    const gzIndex = `<sitemapindex><sitemap><loc>${SITEMAP_ORIGIN}/sitemaps/product/a.xml.gz</loc></sitemap></sitemapindex>`;
    const { env, calls } = fakeEnv({ [SITEMAP_INDEX_KEY]: { status: 200, text: gzIndex } });
    await runDiscovery(env, { ...opts, maxFilesThisSession: 1 });
    const plan = calls.api.filter((b) => b.op === "discovery_plan").at(-1);
    expect(plan?.keys).toEqual(["sitemaps/product/a.xml.gz"]);
  });
});

describe("runDiscovery", () => {
  it("indeksi okur, dosyalari tek tek bekleyerek indirir, kimlikleri yollar ve kosuyu kapatir", async () => {
    const { env, calls } = fakeEnv({
      [SITEMAP_INDEX_KEY]: { status: 200, text: index },
      [F1]: { status: 200, text: urlset(["1", "2"]) },
      [F2]: { status: 200, text: urlset(["3"]) },
    });
    expect(await runDiscovery(env, opts)).toBe("completed");
    expect(calls.fetch).toEqual([
      `${SITEMAP_ORIGIN}/${SITEMAP_INDEX_KEY}`,
      `${SITEMAP_ORIGIN}/${F1}`,
      `${SITEMAP_ORIGIN}/${F2}`,
    ]);
    expect(calls.sleeps).toEqual([2000, 2000]); // ilk istekten once beklenmez
    const batches = calls.api.filter((b) => b.op === "discovery_batch");
    expect(batches.map((b) => (b.items as unknown[]).length)).toEqual([0, 2, 1]);
    // fiyat alani yok, kategori adresi atildi
    const rec = ((batches[1]?.items ?? []) as Record<string, unknown>[]).at(0);
    expect(rec).toMatchObject({ externalId: "HBC1", codeKind: "pm", sourceUnitKey: F1 });
    expect("priceMinor" in (rec as object)).toBe(false);
    expect(calls.api.at(-1)).toMatchObject({ op: "close", outcome: "completed" });
    // onay, ilk indirmeden once
    expect(calls.api.findIndex((b) => b.op === "discovery_approve")).toBeLessThan(
      calls.api.findIndex((b) => b.op === "discovery_batch"),
    );
  });

  it("onay reddedilirse hicbir dosya indirilmez", async () => {
    const { env, calls } = fakeEnv({});
    const api = env.api;
    env.api = async (b) =>
      b.op === "discovery_approve"
        ? { ok: false, status: 400, data: { error: "download_exceeds_policy" } }
        : api(b);
    expect(await runDiscovery(env, opts)).toBe("error");
    expect(calls.fetch).toHaveLength(0);
  });

  it("403/429/503, HTML sayfasi ya da yapi yoksa DURUR; yeniden denemez", async () => {
    for (const bad of [
      { status: 403, text: "" },
      { status: 429, text: "" },
      { status: 503, text: "" },
      { status: 200, text: "<!doctype html><html>Dogrulama</html>" },
      { status: 200, text: "merhaba" },
    ]) {
      const { env, calls } = fakeEnv({ [SITEMAP_INDEX_KEY]: bad });
      expect(await runDiscovery(env, opts)).toBe("blocked");
      expect(calls.fetch).toHaveLength(1);
      const batch = calls.api.find((b) => b.op === "discovery_batch");
      expect(batch?.status).toBe("blocked");
      expect(calls.api.at(-1)).toMatchObject({ op: "close", outcome: "aborted" });
    }
  });

  it("kesilmis dosya basarisiz sayilir, kayit yollanmaz, kosu acik kalir", async () => {
    const cut = urlset(["1", "2"]).slice(0, -30);
    const { env, calls } = fakeEnv({
      [SITEMAP_INDEX_KEY]: { status: 200, text: index },
      [F1]: { status: 200, text: cut },
    });
    expect(await runDiscovery(env, opts)).toBe("error");
    const last = calls.api.filter((b) => b.op === "discovery_batch").at(-1);
    expect(last).toMatchObject({ status: "failed", errorCode: "truncated", items: [] });
    expect(calls.api.some((b) => b.op === "close")).toBe(false);
  });

  it("onayli bayt tavani indirme sirasinda uygulanir", async () => {
    const { env, calls } = fakeEnv({
      [SITEMAP_INDEX_KEY]: { status: 200, text: index },
      [F1]: { status: 200, text: urlset(["1", "2", "3", "4", "5"]) },
    });
    const reason = await runDiscovery(env, { ...opts, approveBytes: index.length + 200 });
    expect(reason).toBe("bytes");
    const last = calls.api.filter((b) => b.op === "discovery_batch").at(-1);
    expect(last).toMatchObject({ status: "failed", errorCode: "decoded_limit", items: [] });
    expect(Number(last?.bytesReceived)).toBeLessThanOrEqual(index.length + 200);
  });

  it("oturum dosya sinirinda ya da duraklatmada kosu acik kalir", async () => {
    const files = {
      [SITEMAP_INDEX_KEY]: { status: 200, text: index },
      [F1]: { status: 200, text: urlset(["1"]) },
      [F2]: { status: 200, text: urlset(["2"]) },
    };
    const a = fakeEnv(files);
    expect(await runDiscovery(a.env, { ...opts, maxFilesThisSession: 2 })).toBe("session_limit");
    expect(a.calls.fetch).toHaveLength(2);
    expect(a.calls.api.some((b) => b.op === "close")).toBe(false);
    const b = fakeEnv(files, { shouldStop: () => true });
    expect(await runDiscovery(b.env, opts)).toBe("paused");
    expect(b.calls.fetch).toHaveLength(0);
  });

  it("kota reddi kosu baslatmaz ve kaynaga istek atmaz", async () => {
    const { env, calls } = fakeEnv({});
    env.api = async () => ({
      ok: false,
      status: 429,
      data: { error: "collection_quota_interval" },
    });
    expect(await runDiscovery(env, opts)).toBe("error");
    expect(calls.fetch).toHaveLength(0);
  });

  it("sunucu partiyi reddederse (disk tavani vb.) durur", async () => {
    const { env } = fakeEnv({ [SITEMAP_INDEX_KEY]: { status: 200, text: index } });
    const api = env.api;
    env.api = async (b) =>
      b.op === "discovery_batch"
        ? { ok: false, status: 507, data: { error: "database_size_limit" } }
        : api(b);
    expect(await runDiscovery(env, opts)).toBe("error");
  });
});
