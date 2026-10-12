/**
 * Faz 6 kapasite testleri - AG ISTEGI YOK, sanal saat (deterministik).
 *
 * Sahte Pazarama, Faz 4b canli olcumunun istek profiline gore kalibre edildi: sorgu basina
 * 2 liste sayfasi ("45 ürün"), 5 kart (1'i eslesmez), 1 stoksuz urun, 4 barkod (1'i SEO
 * kartiyla ayni urune 301, 1'i ek urune 301, 2'si 404). Tek kullanicida ~10-11 istek/arama
 * (canli: 11,4). Kapi canli ayarlarla: 1 istek/sn, eszamanli 2, kuyruk 20, en cok 10 sn bekleme.
 *
 * Olculen: tamamlanan/reddedilen arama, kapi beklemesi, ilk dogrulanmis urun suresi, siteye
 * giden istek; ortak sayfa onbellegi + single-flight ile ve onsuz.
 */

import { describe, expect, it } from "vitest";
import { discoverPazarama, type PazaramaReport } from "./combined.ts";
import { ADMISSION_KEY, type FetchText, PazaramaClient } from "./discover.ts";
import { DEFAULT_GATE_OPTIONS, InMemoryHostGate } from "./host-gate.ts";
import { InMemoryPageCache, type PageCache, RedisPageCache } from "./page-cache.ts";

const O = "https://www.pazarama.com";

class VirtualClock {
  t = 0;
  private timers: { at: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;
  now = () => this.t;
  sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve });
    });
  private flush = () => new Promise<void>((r) => setImmediate(r));
  async run(done: () => boolean, maxSteps = 2_000_000): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      await this.flush();
      if (done()) return;
      if (this.timers.length === 0) {
        await this.flush();
        if (done()) return;
        throw new Error("kilitlenme: zamanlayici yok ama is bitmedi");
      }
      // En erken zamanlayici (kucuk kuyrukta dogrusal arama siralamadan ucuz).
      let k = 0;
      for (let j = 1; j < this.timers.length; j++) {
        const a = this.timers[j] as { at: number; seq: number };
        const b = this.timers[k] as { at: number; seq: number };
        if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) k = j;
      }
      const next = this.timers.splice(k, 1)[0] as { at: number; resolve: () => void };
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    throw new Error("adim siniri");
  }
}

const WORDS = ["Alfa", "Beta", "Gama", "Delta", "Epsilon", "Zeta", "Teta", "Kappa"];
const QUERIES = WORDS.map((w) => `Ornek ${w} X`);

const ld = (name: string, price: number, inStock = true) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name,
    image: "https://img.pzrmcdn.com/a.png",
    offers: {
      price,
      priceCurrency: "TRY",
      seller: "S",
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  })}</script>`;

interface QuerySpec {
  query: string;
  path: string;
  gtins: string[];
}

/** Kimlik = 10.000.000 + v*1000 + i*100 + k (v: urun ailesi varyanti, i: sorgu, k: urun). */
const idOf = (v: number, i: number, k: number) => String(10_000_000 + v * 1000 + i * 100 + k);

/** Sorgu i'nin v. "ailesi": v=0 populer/tekrarlanan; v>0 hic paylasilmayan farkli urunler. */
function specFor(i: number, v: number): QuerySpec {
  const w = WORDS[i] as string;
  return {
    query: QUERIES[i] as string,
    path: `/ornek/${w.toLowerCase()}-k-K${i}${v > 0 ? `V${v}` : ""}`,
    gtins: [idOf(v, i, 1), idOf(v, i, 7), idOf(v, i, 6), idOf(v, i, 8)],
  };
}

function route(url: string): { status: number; body?: string; location?: string } {
  const path = url.slice(O.length);
  const list = /^\/ornek\/([a-z]+)-k-K(\d)(?:V(\d+))?(\?sayfa=2)?$/.exec(path);
  if (list) {
    const i = Number(list[2]);
    const v = Number(list[3] ?? 0);
    const w = WORDS[i] as string;
    const card = (k: number, t = `Ornek ${w} X Renk${k}`) =>
      `<a href="/u${k}-p-${idOf(v, i, k)}" title="${t}">x</a><span>1,00 TL</span>`;
    return list[4]
      ? { status: 200, body: `${card(4)}${card(5)}` }
      : {
          status: 200,
          body: `<span>45 ürün</span>${card(1)}${card(2)}${card(3, "Baska Bir Sey")}`,
        };
  }
  const product = /^\/u(\d)-p-(\d{8})$/.exec(path);
  const barcode = /^\/-p-(\d{8})$/.exec(path);
  const n = Number((product ?? barcode)?.[product ? 2 : 1] ?? Number.NaN) - 10_000_000;
  if (!Number.isFinite(n)) return { status: 404 };
  const v = Math.floor(n / 1000);
  const i = Math.floor((n % 1000) / 100);
  const k = n % 100;
  const w = WORDS[i];
  if (!w) return { status: 404 };
  if (barcode) {
    // 1. barkod -> SEO karti 1 ile ayni urun; 3. -> yalnizca barkodla bulunan urun 6; digerleri 404.
    return k === 1 || k === 6
      ? { status: 301, location: `/u${k}-p-${idOf(v, i, k)}` }
      : { status: 404 };
  }
  if (Number(product?.[1]) !== k || k < 1 || k > 6) return { status: 404 };
  return { status: 200, body: ld(`Ornek ${w} X Renk${k}`, 1000 + k * 10, k !== 2) };
}

function buildSite(clock: VirtualClock, latencyMs: number) {
  const specs = WORDS.map((_, i) => specFor(i, 0));
  let requests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const starts: number[] = [];
  const fetchImpl: FetchText = async (url) => {
    requests += 1;
    starts.push(clock.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await clock.sleep(latencyMs);
      const r = route(url);
      return {
        status: r.status,
        headers: {
          get: (n: string) => (n.toLowerCase() === "location" ? (r.location ?? null) : null),
        },
        text: async () => r.body ?? "",
      };
    } finally {
      inFlight -= 1;
    }
  };
  return {
    specs,
    fetchImpl,
    requests: () => requests,
    maxInFlight: () => maxInFlight,
    starts,
  };
}

/** Canli ayarlar (scripts/pazarama-live-server.ts SERVER_CONFIG). */
const DISCOVER = {
  maxBarcodes: 4,
  maxVerify: 6,
  maxPagesPerPath: 3,
  targetResults: 4,
  seoPageLimit: 3,
  useListingTotal: true,
  barcodeMaxConsecutiveMisses: 2,
};

type Mode = "faz5" | "cache" | "cache+kabul";

function runSearch(
  clock: VirtualClock,
  site: ReturnType<typeof buildSite>,
  gate: InMemoryHostGate,
  spec: QuerySpec,
  cache: PageCache | null,
  admission: InMemoryHostGate | null = null,
): Promise<PazaramaReport> {
  const client = new PazaramaClient({
    userAgent: "TestBot/1.0",
    minIntervalMs: 0,
    maxRequests: 24,
    fetchImpl: site.fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    gate,
    pageCache: cache ? { cache, lockMs: 30_000, pollMs: 100 } : undefined,
    admission: admission ?? undefined,
  });
  return discoverPazarama(
    client,
    { query: spec.query, gtins: spec.gtins, matchedTitles: [spec.query], categoryNames: [] },
    [spec.path],
    { ...DISCOVER, now: clock.now },
  );
}

/** Arama kabul kapisi: ayni kapi sinifi; hiz yok, en cok `k` esanli ag arayan arama, kuyruk yok. */
const admissionGate = (clock: VirtualClock, k: number) =>
  new InMemoryHostGate(
    { ...DEFAULT_GATE_OPTIONS, minIntervalMs: 0, maxConcurrent: k, maxQueue: 0, maxWaitMs: 0 },
    clock,
  );

/** Deterministik sozde rastgele (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mix = "popular" | "uniform" | "mixed" | "distinct";

interface LoadResult {
  users: number;
  mix: Mix;
  mode: Mode;
  started: number;
  completed: number;
  /** Kapi (kuyruk/bekleme) ya da kabul reddi. */
  rejected: number;
  /** Bunlarin kaci kabul kapisinda, siteye istek atmadan. */
  rejectedAtAdmission: number;
  /** Reddedilen aramalarin harcadigi site istegi (bosa giden kapasite). */
  wastedRequests: number;
  siteRequests: number;
  reqPerSearch: number;
  reqPerCompleted: number;
  completedPerMin: number;
  /** Ag istegi basina kapi (hiz/kuyruk) beklemesi. */
  waitMsAvg: number;
  firstMedian: number | null;
  firstP95: number | null;
  sharedHits: number;
  coalesced: number;
  maxInFlight: number;
  minSpacing: number;
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
};

/**
 * Kapali dongu: her kullanici sure boyunca arama yapar, aramalar arasi 5-15 sn dusunme.
 * "popular": aramalarin %60'i ilk 2 sorgu; "uniform": 8 sorgu esit; "mixed": %30 bu 8 sorgu,
 * %70 hic tekrarlanmayan urun; "distinct": her arama benzersiz (paylasim yok; alt sinir).
 */
async function loadTest(
  users: number,
  mix: Mix,
  mode: Mode,
  durationMs = 5 * 60_000,
  admissionK = 2,
): Promise<LoadResult> {
  const clock = new VirtualClock();
  const site = buildSite(clock, 500);
  const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
  const cache = mode === "faz5" ? null : new InMemoryPageCache(clock.now);
  const admission = mode === "cache+kabul" ? admissionGate(clock, admissionK) : null;
  const rand = rng(users * 7919 + mix.length);
  const reports: PazaramaReport[] = [];
  let distinctSeq = 0;
  const unique = (): QuerySpec => {
    // Ayni yapi, farkli urun kimlikleri ve sayfalari: hicbir sayfa paylasilmaz.
    distinctSeq += 1;
    return specFor(distinctSeq % WORDS.length, distinctSeq);
  };
  const pick = (): QuerySpec => {
    if (mix === "distinct") return unique();
    if (mix === "mixed" && rand() < 0.7) return unique();
    if (mix === "popular" && rand() < 0.6) return site.specs[Math.floor(rand() * 2)] as QuerySpec;
    return site.specs[Math.floor(rand() * site.specs.length)] as QuerySpec;
  };
  let active = users;
  const user = async () => {
    await clock.sleep(Math.floor(rand() * 10_000)); // kademeli baslangic
    while (clock.now() < durationMs) {
      reports.push(await runSearch(clock, site, gate, pick(), cache, admission));
      await clock.sleep(5_000 + Math.floor(rand() * 10_000));
    }
    active -= 1;
  };
  for (let u = 0; u < users; u++) void user();
  await clock.run(() => active === 0);

  const ok = (r: PazaramaReport) => r.deniedBy === null && r.blockedBy === null;
  const completed = reports.filter(ok);
  const rejected = reports.filter((r) => !ok(r));
  const netRequests = reports.reduce((s, r) => s + r.requests, 0);
  const firsts = completed.flatMap((r) =>
    r.timings.firstResultMs === null ? [] : [r.timings.firstResultMs],
  );
  const sortedStarts = [...site.starts].sort((a, b) => a - b);
  let minSpacing = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sortedStarts.length; i++)
    minSpacing = Math.min(
      minSpacing,
      (sortedStarts[i] as number) - (sortedStarts[i - 1] as number),
    );
  const minutes = clock.now() / 60_000;
  return {
    users,
    mix,
    mode,
    started: reports.length,
    completed: completed.length,
    rejected: rejected.length,
    rejectedAtAdmission: rejected.filter((r) => r.admissionDenied).length,
    wastedRequests: rejected.reduce((s, r) => s + r.requests, 0),
    siteRequests: site.requests(),
    reqPerSearch: site.requests() / Math.max(1, reports.length),
    reqPerCompleted: site.requests() / Math.max(1, completed.length),
    completedPerMin: completed.length / minutes,
    waitMsAvg: reports.reduce((s, r) => s + r.http.waitMs, 0) / Math.max(1, netRequests),
    firstMedian: pct(firsts, 50),
    firstP95: pct(firsts, 95),
    sharedHits: reports.reduce((s, r) => s + r.sharedHits, 0),
    coalesced: reports.reduce((s, r) => s + r.coalesced, 0),
    maxInFlight: site.maxInFlight(),
    minSpacing,
  };
}

describe("Faz 6: tek arama, onbellek dogrulugu bozmaz", () => {
  it("soguk onbellek: ayni urun/fiyat, istek artmaz, ilk urun gecikmez", async () => {
    const run = async (withCache: boolean) => {
      const clock = new VirtualClock();
      const site = buildSite(clock, 500);
      const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
      const cache = withCache ? new InMemoryPageCache(clock.now) : null;
      let report: PazaramaReport | null = null;
      void runSearch(clock, site, gate, site.specs[0] as QuerySpec, cache).then((r) => {
        report = r;
      });
      await clock.run(() => report !== null);
      return { report: report as unknown as PazaramaReport, requests: site.requests() };
    };
    const a = await run(false);
    const b = await run(true);
    // Onbellek sorgusu (asenkron) iki yolun istek sirasini degistirebilir; urunler, fiyatlar ve
    // istek sayisi ayni, ilk urun daha gec DEGIL. `checkedAtMs` sira farkiyla kayabilir.
    const strip = (r: PazaramaReport) => r.results.map(({ checkedAtMs: _c, ...rest }) => rest);
    expect(strip(b.report)).toEqual(strip(a.report));
    // Ayni arama icindeki esanli ayni sayfa (barkod 301 hedefi = SEO karti) de tek istege iner.
    expect(b.requests).toBeLessThanOrEqual(a.requests);
    expect(b.report.timings.firstResultMs as number).toBeLessThanOrEqual(
      a.report.timings.firstResultMs as number,
    );
    console.log(
      `soguk tek arama: istek ${a.requests}/${b.requests}, ilk urun ${a.report.timings.firstResultMs}/${b.report.timings.firstResultMs} ms, toplam ${a.report.ms}/${b.report.ms} ms (onbelleksiz/onbellekli)`,
    );
    expect(a.report.results.map((r) => r.productId)).toEqual([
      "10000001",
      "10000004",
      "10000005",
      "10000006",
    ]);
    // Kalibrasyon: canli Faz 4b ortalamasi 11,4 istek/arama.
    expect(a.requests).toBeGreaterThanOrEqual(8);
    expect(a.requests).toBeLessThanOrEqual(12);
  });

  it("sicak onbellek: ikinci kullanici ag istegi atmadan AYNI urunleri, fiyatlari, gorselleri alir", async () => {
    const clock = new VirtualClock();
    const site = buildSite(clock, 500);
    const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
    const cache = new InMemoryPageCache(clock.now);
    const spec = site.specs[1] as QuerySpec;
    const out: PazaramaReport[] = [];
    void runSearch(clock, site, gate, spec, cache).then((r) => out.push(r));
    await clock.run(() => out.length === 1);
    const coldRequests = site.requests();
    void runSearch(clock, site, gate, spec, cache).then((r) => out.push(r));
    await clock.run(() => out.length === 2);
    const [cold, warm] = out as [PazaramaReport, PazaramaReport];
    expect(site.requests()).toBe(coldRequests); // ikinci arama: 0 ag istegi
    expect(warm.requests).toBe(0);
    const strip = (r: PazaramaReport) => r.results.map(({ checkedAtMs: _c, ...rest }) => rest);
    expect(strip(warm)).toEqual(strip(cold));
    // Fiyatin alindigi an acik: sicak sonuc soguk aramanin ag istegi anini tasir.
    expect(warm.results.map((r) => r.checkedAtMs)).toEqual(cold.results.map((r) => r.checkedAtMs));
    expect(warm.timings.firstResultMs).toBe(0);
  });

  it("TTL dolunca yeniden getirilir (urun sayfasi 60 sn'den eski fiyat gostermez)", async () => {
    const clock = new VirtualClock();
    const site = buildSite(clock, 500);
    const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
    const cache = new InMemoryPageCache(clock.now);
    const spec = site.specs[2] as QuerySpec;
    const out: PazaramaReport[] = [];
    void runSearch(clock, site, gate, spec, cache).then((r) => out.push(r));
    await clock.run(() => out.length === 1);
    const n1 = site.requests();
    let woke = false;
    void clock.sleep(61_000).then(() => {
      woke = true;
    });
    await clock.run(() => woke);
    void runSearch(clock, site, gate, spec, cache).then((r) => out.push(r));
    await clock.run(() => out.length === 2);
    const second = out[1] as PazaramaReport;
    expect(second.requests).toBeGreaterThan(0); // urun sayfalari yeniden alindi
    for (const r of second.results) expect(clock.now() - r.checkedAtMs).toBeLessThanOrEqual(60_000);
    expect(site.requests()).toBeGreaterThan(n1);
  });

  it("esanli ayni sorgu (single-flight): 10 kullanici, istek sayisi tek aramayla ayni", async () => {
    const clock = new VirtualClock();
    const site = buildSite(clock, 500);
    const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
    const cache = new InMemoryPageCache(clock.now);
    const out: PazaramaReport[] = [];
    for (let i = 0; i < 10; i++)
      void runSearch(clock, site, gate, site.specs[3] as QuerySpec, cache).then((r) => out.push(r));
    await clock.run(() => out.length === 10);
    expect(out.every((r) => r.deniedBy === null && r.results.length === 4)).toBe(true);
    expect(site.requests()).toBeLessThanOrEqual(11);
    expect(out.reduce((s, r) => s + r.coalesced, 0)).toBeGreaterThan(0);
    const ids = out.map((r) => r.results.map((x) => `${x.productId}:${x.priceKurus}`).join());
    expect(new Set(ids).size).toBe(1);
  });

  it("onbellek hatasi (Redis yok) iska sayilir; arama ag yoluyla ayni sonucu verir", async () => {
    const broken = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
    };
    const clock = new VirtualClock();
    const site = buildSite(clock, 500);
    const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
    const out: PazaramaReport[] = [];
    void runSearch(
      clock,
      site,
      gate,
      site.specs[0] as QuerySpec,
      new RedisPageCache(broken as never),
    ).then((r) => out.push(r));
    await clock.run(() => out.length === 1);
    expect(out[0]?.results.map((r) => r.productId)).toEqual([
      "10000001",
      "10000004",
      "10000005",
      "10000006",
    ]);
  });

  it("429/ag hatasi saklanmaz; 200/404/301 saklanir", async () => {
    const { ttlFor, DEFAULT_PAGE_CACHE_TTL: T } = await import("./page-cache.ts");
    expect(ttlFor("detail", 429, T)).toBe(0);
    expect(ttlFor("detail", 403, T)).toBe(0);
    expect(ttlFor("detail", 0, T)).toBe(0);
    expect(ttlFor("detail", 503, T)).toBe(0);
    expect(ttlFor("detail", 200, T)).toBe(60_000);
    expect(ttlFor("list", 200, T)).toBe(120_000);
    expect(ttlFor("barcode", 404, T)).toBe(60_000);
    expect(ttlFor("barcode", 301, T)).toBe(3_600_000);
  });
});

describe("Faz 6: arama kabul kapisi", () => {
  it("dolu iken yeni arama siteye istek atmadan reddedilir; onbellekteki arama kabule ugramaz", async () => {
    const clock = new VirtualClock();
    const site = buildSite(clock, 500);
    const gate = new InMemoryHostGate({ ...DEFAULT_GATE_OPTIONS }, clock);
    const cache = new InMemoryPageCache(clock.now);
    const admission = admissionGate(clock, 1);
    const out: PazaramaReport[] = [];
    const go = (spec: QuerySpec) =>
      void runSearch(clock, site, gate, spec, cache, admission).then((r) => out.push(r));
    go(site.specs[0] as QuerySpec);
    go(site.specs[1] as QuerySpec); // ayni anda farkli sorgu: kabul dolu
    await clock.run(() => out.length === 2);
    const denied = out.find((r) => r.admissionDenied) as PazaramaReport;
    expect(denied.requests).toBe(0);
    expect(denied.deniedBy).toBe("queue-full");
    expect(out.find((r) => !r.admissionDenied)?.results).toHaveLength(4);
    // Kabul birakildi; ayni sorgu tekrar: tamamen onbellekten, kabul gerekmez.
    go(site.specs[0] as QuerySpec);
    await clock.run(() => out.length === 3);
    expect(out[2]?.requests).toBe(0);
    expect(out[2]?.admissionDenied).toBe(false);
    expect(out[2]?.results).toHaveLength(4);
    expect(admission.snapshot(ADMISSION_KEY).inFlight).toBe(0);
  });
});

describe("Faz 6: yuk testi 1/10/50/100 esanli kullanici (5 sanal dk, ag yok)", () => {
  it("faz5 vs onbellek vs onbellek+kabul; hiz siniri hicbir senaryoda asilmaz", {
    timeout: 300_000,
  }, async () => {
    const rows: LoadResult[] = [];
    for (const users of [1, 10, 50, 100]) {
      for (const mix of ["popular", "uniform", "mixed", "distinct"] as const) {
        for (const mode of ["faz5", "cache", "cache+kabul"] as const) {
          if (users === 1 && mix !== "uniform" && mix !== "distinct") continue;
          rows.push(await loadTest(users, mix, mode));
        }
      }
    }
    // Rapor tablosu (arastirma gunlugune aktarilir).
    console.log(
      [
        "users mix      mode        start done  rej rejAdm wasted req/arama req/tamam tamam/dk kapiBek ilkMed ilkP95 ortak birles",
        ...rows.map((r) =>
          [
            String(r.users).padStart(5),
            r.mix.padEnd(8),
            r.mode.padEnd(11),
            String(r.started).padStart(5),
            String(r.completed).padStart(4),
            String(r.rejected).padStart(4),
            String(r.rejectedAtAdmission).padStart(6),
            String(r.wastedRequests).padStart(6),
            r.reqPerSearch.toFixed(2).padStart(9),
            r.reqPerCompleted.toFixed(2).padStart(9),
            r.completedPerMin.toFixed(1).padStart(8),
            Math.round(r.waitMsAvg).toString().padStart(7),
            String(r.firstMedian ?? "-").padStart(6),
            String(r.firstP95 ?? "-").padStart(6),
            String(r.sharedHits).padStart(5),
            String(r.coalesced).padStart(6),
          ].join(" "),
        ),
      ].join("\n"),
    );
    for (const r of rows) {
      expect(r.minSpacing).toBeGreaterThanOrEqual(1000); // 1 istek/sn hic asilmadi
      expect(r.maxInFlight).toBeLessThanOrEqual(2);
      if (r.users === 1) expect(r.rejected).toBe(0);
    }
    const find = (u: number, m: Mix, mode: Mode) =>
      rows.find((r) => r.users === u && r.mix === m && r.mode === mode) as LoadResult;
    for (const u of [10, 50, 100]) {
      for (const m of ["popular", "uniform", "mixed"] as const) {
        expect(find(u, m, "cache").reqPerCompleted).toBeLessThan(
          find(u, m, "faz5").reqPerCompleted,
        );
      }
      for (const m of ["popular", "uniform", "mixed", "distinct"] as const) {
        const adm = find(u, m, "cache+kabul");
        const base = find(u, m, "faz5");
        // Kabul kapisiyla reddedilen arama siteye hic istek atmaz (bosa kapasite yok).
        expect(adm.wastedRequests).toBe(0);
        // Ilk dogrulanmis urun suresi (p95) kuyruk birikmedigi icin kisalir.
        expect(adm.firstP95 as number).toBeLessThan(base.firstP95 as number);
        if (u >= 50) {
          // Asiri yukte Faz 5 coker (aramalar yarida reddedilir); kabul kapisi tamamlanani artirir.
          expect(adm.completed).toBeGreaterThan(base.completed);
        }
      }
    }
  });
});
