/**
 * Faz 5 dayaniklilik testleri - AG ISTEGI YOK, sanal saat (deterministik).
 * Pazarama'ya hicbir gercek istek atilmaz; yanitlar sahte `fetchImpl`ten gelir.
 */

import { describe, expect, it } from "vitest";
import { discoverPazarama } from "./combined.ts";
import { type FetchText, PazaramaClient } from "./discover.ts";
import {
  DEFAULT_GATE_OPTIONS,
  type GateDecision,
  type HostGateOptions,
  type HostGateRedisClient,
  InMemoryHostGate,
  parseRetryAfter,
  RedisHostGate,
} from "./host-gate.ts";

const O = "https://www.pazarama.com";
const HOST = "www.pazarama.com";

/** Sanal saat: `sleep` zamanlayici kuyruguna girer; `run` zamani en yakin zamanlayiciya atlatir. */
class VirtualClock {
  t = 0;
  private timers: { at: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;
  now = () => this.t;
  sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve });
    });
  /** Mikro gorevleri bosalt (setImmediate tum Promise zincirlerinden sonra calisir). */
  private flush = () => new Promise<void>((r) => setImmediate(r));
  /** `done` true olana kadar zamani ilerlet. */
  async run(done: () => boolean, maxSteps = 100_000): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      await this.flush();
      if (done()) return;
      if (this.timers.length === 0) {
        await this.flush();
        if (done()) return;
        throw new Error("kilitlenme: zamanlayici yok ama is bitmedi");
      }
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift() as { at: number; resolve: () => void };
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    throw new Error("adim siniri");
  }
}

const ld = (name: string, price: number) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name,
    image: "https://img.pzrmcdn.com/a.png",
    offers: {
      price,
      priceCurrency: "TRY",
      seller: "S",
      availability: "https://schema.org/InStock",
    },
  })}</script>`;

/** Sahte Pazarama: 1 liste sayfasi (2 eslesen kart) + 2 urun sayfasi; her yanit `latencyMs` surer. */
function fakeSite(
  clock: VirtualClock,
  opts: {
    latencyMs?: number;
    statusFor?: (url: string, n: number) => number;
    headers?: Record<string, string>;
  } = {},
) {
  const starts: { url: string; at: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const routes: Record<string, string> = {
    [`${O}/ornek/model-k-K1`]:
      `<span>2 ürün</span><a href="/m1-p-10000001" title="Ornek Model X Siyah">x</a><span>1,00 TL</span>` +
      `<a href="/m2-p-10000002" title="Ornek Model X Beyaz">x</a><span>1,00 TL</span>`,
    [`${O}/m1-p-10000001`]: ld("Ornek Model X Siyah", 100),
    [`${O}/m2-p-10000002`]: ld("Ornek Model X Beyaz", 120),
  };
  const fetchImpl: FetchText = async (url) => {
    starts.push({ url, at: clock.now() });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await clock.sleep(opts.latencyMs ?? 300);
      const status = opts.statusFor?.(url, starts.length) ?? (routes[url] ? 200 : 404);
      return {
        status,
        headers: { get: (n: string) => opts.headers?.[n.toLowerCase()] ?? null },
        text: async () => (status === 200 ? (routes[url] ?? "") : ""),
      };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, starts, maxInFlight: () => maxInFlight };
}

function search(clock: VirtualClock, gate: InMemoryHostGate | RedisHostGate, fetchImpl: FetchText) {
  const client = new PazaramaClient({
    userAgent: "TestBot/1.0",
    minIntervalMs: 0, // kapi varken kullanilmaz
    maxRequests: 10,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    gate,
  });
  return discoverPazarama(
    client,
    { query: "Ornek Model X", gtins: [], matchedTitles: ["Ornek Model X"], categoryNames: [] },
    ["/ornek/model-k-K1"],
    { now: clock.now, maxPagesPerPath: 1 },
  );
}

const gateOpts = (o: Partial<HostGateOptions> = {}): HostGateOptions => ({
  ...DEFAULT_GATE_OPTIONS,
  minIntervalMs: 1000,
  maxConcurrent: 2,
  maxQueue: 20,
  maxWaitMs: 10_000,
  ...o,
});

function spacing(starts: { at: number }[]): number {
  const s = starts.map((x) => x.at).sort((a, b) => a - b);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < s.length; i++) min = Math.min(min, (s[i] as number) - (s[i - 1] as number));
  return min;
}

describe("parseRetryAfter", () => {
  it("saniye, HTTP tarihi, gecersiz deger; [1 sn, 24 sa] araligi", () => {
    expect(parseRetryAfter("120", 0)).toBe(120_000);
    expect(parseRetryAfter("0", 0)).toBe(1_000);
    expect(parseRetryAfter("999999", 0)).toBe(24 * 60 * 60_000);
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:30:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfter("yarin", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe("Ortak kapi: esanli kullanicilar (ag yok)", () => {
  it("10 esanli arama: hepsi sonuclanir, BASLANGICLAR arasi >= 1 sn, ayni anda en cok 2 istek", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts(), clock);
    const site = fakeSite(clock);
    const runs = Array.from({ length: 10 }, () => search(clock, gate, site.fetchImpl));
    const reports: Awaited<(typeof runs)[number]>[] = [];
    let done = 0;
    for (const r of runs) {
      r.then((x) => {
        reports.push(x);
        done++;
      });
    }
    await clock.run(() => done === 10);
    expect(reports.every((r) => r.results.length === 2 && r.deniedBy === null)).toBe(true);
    expect(site.starts).toHaveLength(30); // her arama: 1 liste + 2 urun
    expect(spacing(site.starts)).toBeGreaterThanOrEqual(1000);
    expect(site.maxInFlight()).toBeLessThanOrEqual(2);
    // Ilk dogrulanmis urun suresi olculur.
    expect(reports.every((r) => typeof r.timings.firstResultMs === "number")).toBe(true);
  });

  it("50 esanli arama: kuyruk/bekleme siniri asilinca istek ATILMADAN reddedilir; site yuku sinirli", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts({ maxQueue: 20, maxWaitMs: 10_000 }), clock);
    const site = fakeSite(clock);
    const runs = Array.from({ length: 50 }, () => search(clock, gate, site.fetchImpl));
    const reports: Awaited<(typeof runs)[number]>[] = [];
    for (const r of runs) r.then((x) => reports.push(x));
    await clock.run(() => reports.length === 50);
    const denied = reports.filter((r) => r.deniedBy !== null);
    const served = reports.filter((r) => r.deniedBy === null);
    expect(denied.length).toBeGreaterThan(0);
    expect(new Set(denied.map((r) => r.deniedBy))).toEqual(
      new Set(
        denied.map((r) => r.deniedBy).filter((d) => d === "queue-full" || d === "wait-too-long"),
      ),
    );
    expect(served.length).toBeGreaterThan(0);
    // Hiz siniri hicbir an asilmaz; reddedilen aramalarin ag istegi sinirli kalir.
    expect(spacing(site.starts)).toBeGreaterThanOrEqual(1000);
    expect(site.maxInFlight()).toBeLessThanOrEqual(2);
    // Her istek en cok 10 sn bekledi; toplam istek sayisi saniye basina 1'i gecmedi.
    const span =
      Math.max(...site.starts.map((s) => s.at)) - Math.min(...site.starts.map((s) => s.at));
    expect(site.starts.length).toBeLessThanOrEqual(Math.floor(span / 1000) + 1);
  });

  it("kuyruk dolunca (maxQueue) bekleyen eklenmez, aninda queue-full; kuyruktakiler sirayla slot alir", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts({ maxConcurrent: 1, maxQueue: 2 }), clock);
    const decisions: GateDecision[] = [];
    const startedAt: number[] = [];
    for (let i = 0; i < 5; i++) {
      gate.acquire(HOST).then((d) => {
        decisions.push(d);
        if (d.ok) {
          startedAt.push(clock.now());
          d.release();
        }
      });
    }
    await clock.run(() => decisions.length === 5);
    // 1 hemen, 2 kuyrukta (sirayla 1 sn arayla), 2 aninda reddedildi.
    expect(decisions.filter((d) => !d.ok).map((d) => (d.ok ? "" : d.reason))).toEqual([
      "queue-full",
      "queue-full",
    ]);
    expect(startedAt).toEqual([0, 1000, 2000]);
    expect(gate.snapshot(HOST).inFlight).toBe(0);
  });
});

describe("HTTP 429, Retry-After ve devre kesici (ag yok)", () => {
  it("429 + Retry-After 120: devre 120 sn acik; bu surede HICBIR istek atilmaz; sonra tek deneme, basariyla kapanir", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts(), clock);
    let rateLimited = true;
    const site = fakeSite(clock, {
      statusFor: (url) => (rateLimited && url.endsWith("-k-K1") ? 429 : undefined) as number,
      headers: { "retry-after": "120" },
    });
    // statusFor undefined donerse varsayilan yonlendirme kullanilir.
    const first = search(clock, gate, site.fetchImpl);
    let r1: Awaited<typeof first> | null = null;
    first.then((x) => {
      r1 = x;
    });
    await clock.run(() => r1 !== null);
    expect((r1 as unknown as { blockedBy: number }).blockedBy).toBe(429);
    const tripAt = clock.now();
    expect(gate.snapshot(HOST).openUntil).toBe(tripAt + 120_000);

    // Devre acikken baska kullanicinin aramasi: ag istegi yok, aninda red.
    const before = site.starts.length;
    const second = search(clock, gate, site.fetchImpl);
    let r2: Awaited<typeof second> | null = null;
    second.then((x) => {
      r2 = x;
    });
    await clock.run(() => r2 !== null);
    expect((r2 as unknown as { deniedBy: string }).deniedBy).toBe("circuit-open");
    expect(site.starts.length).toBe(before);

    // Sure doldu: yari acik. Ayni anda iki istek: yalnizca BIRI (deneme) gecer.
    clock.t = tripAt + 120_000;
    rateLimited = false;
    const a = gate.acquire(HOST);
    const b = gate.acquire(HOST);
    let da: GateDecision | null = null;
    let db: GateDecision | null = null;
    a.then((d) => {
      da = d;
    });
    b.then((d) => {
      db = d;
    });
    await clock.run(() => da !== null && db !== null);
    const decided = [da, db] as unknown as GateDecision[];
    expect(decided.filter((d) => d.ok && d.probe)).toHaveLength(1);
    expect(decided.filter((d) => !d.ok)).toHaveLength(1);
    // Deneme basarili -> devre kapanir; sonraki istekler normal akar.
    await gate.succeed(HOST);
    for (const d of decided) if (d.ok) d.release();
    expect(gate.snapshot(HOST).trips).toBe(0);
    const third = search(clock, gate, site.fetchImpl);
    let r3: Awaited<typeof third> | null = null;
    third.then((x) => {
      r3 = x;
    });
    await clock.run(() => r3 !== null);
    expect((r3 as unknown as { results: unknown[] }).results).toHaveLength(2);
  });

  it("Retry-After yoksa varsayilan bekleme; art arda 429'da sure ikiye katlanir (tavanli)", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(
      gateOpts({ cooldownMs: 60_000, maxCooldownMs: 150_000 }),
      clock,
    );
    await gate.trip(HOST, 429, null);
    expect(gate.snapshot(HOST).openUntil).toBe(60_000);
    clock.t = 60_000;
    await gate.trip(HOST, 429, null); // yari acik deneme yine 429
    expect(gate.snapshot(HOST).openUntil).toBe(60_000 + 120_000);
    clock.t = 180_000;
    await gate.trip(HOST, 429, null);
    expect(gate.snapshot(HOST).openUntil).toBe(180_000 + 150_000); // tavan
  });

  it("devre acilinca kuyrukta bekleyenler kapasite almadan reddedilir", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts({ maxConcurrent: 1 }), clock);
    const holder = await gate.acquire(HOST);
    const waiting: GateDecision[] = [];
    for (let i = 0; i < 3; i++) gate.acquire(HOST).then((d) => waiting.push(d));
    await clock.run(() => true);
    await gate.trip(HOST, 429, 30_000);
    await clock.run(() => waiting.length === 3);
    expect(waiting.every((d) => !d.ok && d.reason === "circuit-open")).toBe(true);
    if (holder.ok) holder.release();
    expect(gate.snapshot(HOST).inFlight).toBe(0);
  });

  it("baska magazanin (host) kapisi etkilenmez", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts(), clock);
    await gate.trip(HOST, 429, 600_000);
    const other = await gate.acquire("www.baska-magaza.example");
    expect(other.ok).toBe(true);
    const blocked = await gate.acquire(HOST);
    expect(blocked.ok).toBe(false);
  });
});

describe("Zaman asimi ve kaynak hatasi (ag yok)", () => {
  it("zaman asimi (AbortError) istegi duser, bilet geri verilir, siradaki istek akar", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts({ maxConcurrent: 1 }), clock);
    let n = 0;
    const fetchImpl: FetchText = async (url) => {
      n += 1;
      await clock.sleep(100);
      if (n === 1) {
        const e = new Error("timeout");
        e.name = "TimeoutError";
        throw e;
      }
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => (url.includes("-k-") ? "" : ""),
      };
    };
    const client = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 5,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      gate,
    });
    const p1 = client.get(`${O}/a-p-1`);
    const p2 = client.get(`${O}/b-p-2`);
    const out: unknown[] = [];
    p1.then((x) => out.push(x));
    p2.then((x) => out.push(x));
    await clock.run(() => out.length === 2);
    expect(client.log.map((l) => l.status)).toEqual([0, 200]);
    expect(gate.snapshot(HOST).inFlight).toBe(0);
  });

  it("barkod yolu tamamen cokse de SEO yolu sonuc dondurur", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts(), clock);
    const site = fakeSite(clock);
    const failing: FetchText = async (url, init) => {
      if (url.includes("/-p-")) throw new Error("ECONNRESET");
      return site.fetchImpl(url, init);
    };
    const client = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      fetchImpl: failing,
      now: clock.now,
      sleep: clock.sleep,
      gate,
    });
    const run = discoverPazarama(
      client,
      {
        query: "Ornek Model X",
        gtins: ["99999991", "99999992"],
        matchedTitles: ["Ornek Model X"],
        categoryNames: [],
      },
      ["/ornek/model-k-K1"],
      { now: clock.now, maxPagesPerPath: 1, targetResults: 10 },
    );
    let report: Awaited<typeof run> | null = null;
    run.then((r) => {
      report = r;
    });
    await clock.run(() => report !== null);
    const r = report as unknown as {
      results: unknown[];
      blockedBy: number | null;
      deniedBy: string | null;
    };
    expect(r.results).toHaveLength(2);
    expect(r.blockedBy).toBeNull();
    expect(r.deniedBy).toBeNull();
  });
});

describe("Ilk dogrulanmis urun suresi ve onResult (ag yok)", () => {
  it("ilk urun bulundugu an bildirilir; firstResultMs = o an", async () => {
    const clock = new VirtualClock();
    const gate = new InMemoryHostGate(gateOpts(), clock);
    const site = fakeSite(clock, { latencyMs: 300 });
    const seen: number[] = [];
    const client = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      fetchImpl: site.fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      gate,
    });
    const run = discoverPazarama(
      client,
      { query: "Ornek Model X", gtins: [], matchedTitles: ["Ornek Model X"], categoryNames: [] },
      ["/ornek/model-k-K1"],
      { now: clock.now, maxPagesPerPath: 1, onResult: (_r, ms) => seen.push(ms) },
    );
    let report: Awaited<typeof run> | null = null;
    run.then((r) => {
      report = r;
    });
    await clock.run(() => report !== null);
    // Liste (t=0..300), urun 1 (slot 1000, ..1300), urun 2 (slot 2000, ..2300).
    expect(seen).toEqual([1300, 2300]);
    expect(
      (report as unknown as { timings: { firstResultMs: number } }).timings.firstResultMs,
    ).toBe(1300);
  });
});

describe("Redis kapisi: guvenli ret (ag yok, sahte Redis)", () => {
  function fakeRedis(reply: (script: string) => unknown): HostGateRedisClient & { calls: number } {
    const r = {
      calls: 0,
      eval: (async (script: string) => {
        r.calls += 1;
        return reply(script);
      }) as unknown as HostGateRedisClient["eval"],
    };
    return r;
  }
  const clock = () => new VirtualClock();

  it("Redis erisilemezse istek REDDEDILIR ('unavailable'); siteye istek atilmaz", async () => {
    const c = clock();
    const redis = fakeRedis(() => {
      throw new Error("ECONNREFUSED");
    });
    const gate = new RedisHostGate(redis, gateOpts(), c);
    const site = fakeSite(c);
    const run = search(c, gate, site.fetchImpl);
    let report: Awaited<typeof run> | null = null;
    run.then((r) => {
      report = r;
    });
    await c.run(() => report !== null);
    expect((report as unknown as { deniedBy: string }).deniedBy).toBe("unavailable");
    expect(site.starts).toHaveLength(0);
  });

  it("betik kodlari: 1 = devre acik, 2 = bekleme uzun, 0 = izin (bekleme uygulanir)", async () => {
    const c = clock();
    const open = new RedisHostGate(
      fakeRedis(() => [1, 5000]),
      gateOpts(),
      c,
    );
    expect(await open.acquire(HOST)).toMatchObject({
      ok: false,
      reason: "circuit-open",
      retryAtMs: 5000,
    });
    const long = new RedisHostGate(
      fakeRedis(() => [2, 20_000]),
      gateOpts(),
      c,
    );
    expect(await long.acquire(HOST)).toMatchObject({ ok: false, reason: "wait-too-long" });
    const okGate = new RedisHostGate(
      fakeRedis(() => [0, 700]),
      gateOpts(),
      c,
    );
    let d: GateDecision | null = null;
    okGate.acquire(HOST).then((x) => {
      d = x;
    });
    await c.run(() => d !== null);
    expect(d).toMatchObject({ ok: true, waitMs: 700 });
    expect(c.now()).toBe(700);
    const weird = new RedisHostGate(
      fakeRedis(() => "beklenmeyen"),
      gateOpts(),
      c,
    );
    expect(await weird.acquire(HOST)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("Tek kullanici performansi korunur (fixture, sanal saat)", () => {
  it("kapili ve kapisiz (Faz 4b) ayni arama: ayni istek sayisi, toplam sure ve ilk urun suresi", async () => {
    async function runOnce(withGate: boolean) {
      const clock = new VirtualClock();
      const site = fakeSite(clock, { latencyMs: 300 });
      const client = new PazaramaClient({
        userAgent: "TestBot/1.0",
        minIntervalMs: 1000,
        maxRequests: 10,
        fetchImpl: site.fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        ...(withGate ? { gate: new InMemoryHostGate(gateOpts(), clock) } : {}),
      });
      const run = discoverPazarama(
        client,
        {
          query: "Ornek Model X",
          gtins: ["99999991"],
          matchedTitles: ["Ornek Model X"],
          categoryNames: [],
        },
        ["/ornek/model-k-K1"],
        { now: clock.now, maxPagesPerPath: 1, targetResults: 10 },
      );
      let r: Awaited<typeof run> | null = null;
      run.then((x) => {
        r = x;
      });
      await clock.run(() => r !== null);
      const rep = r as unknown as {
        ms: number;
        requests: number;
        results: unknown[];
        timings: { firstResultMs: number };
      };
      return {
        ms: rep.ms,
        requests: rep.requests,
        results: rep.results.length,
        first: rep.timings.firstResultMs,
      };
    }
    const without = await runOnce(false);
    const withGate = await runOnce(true);
    expect(withGate).toEqual(without);
    expect(without.results).toBe(2);
  });
});

describe("Redis kapisi: global kapasite yoklamasi ve ilk urun suresi (sahte Redis, sanal saat)", () => {
  function scripted(replies: unknown[]) {
    const calls: string[] = [];
    const redis = {
      eval: (async (script: string) => {
        calls.push(
          script.includes("TIME") ? "acquire" : script.includes("ZREM") ? "release" : "other",
        );
        return script.includes("TIME") ? (replies.shift() ?? [0, 0, 0]) : 1;
      }) as unknown as HostGateRedisClient["eval"],
    };
    return { redis, calls };
  }

  it("kapasite bossa istek basina TEK Redis cagrisi ve sifir bekleme (ilk urun suresi artmaz)", async () => {
    const clock = new VirtualClock();
    const { redis, calls } = scripted([[0, 0, 0]]);
    const gate = new RedisHostGate(redis, { ...gateOpts(), leaseMs: 20_000, pollMs: 100 }, clock);
    const d = await gate.acquire(HOST);
    expect(d).toMatchObject({ ok: true, waitMs: 0, probe: false });
    expect(clock.now()).toBe(0);
    expect(calls).toEqual(["acquire"]);
    if (d.ok) d.release();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(["acquire", "release"]);
  });

  it("global kapasite dolu (kod 3): kira bitisine/poll'a kadar bekleyip yeniden dener ve gecer", async () => {
    const clock = new VirtualClock();
    const { redis, calls } = scripted([
      [3, 250, 0],
      [3, 40, 0],
      [0, 0, 0],
    ]);
    const gate = new RedisHostGate(redis, { ...gateOpts(), leaseMs: 20_000, pollMs: 100 }, clock);
    let d: GateDecision | null = null;
    gate.acquire(HOST).then((x) => {
      d = x;
    });
    await clock.run(() => d !== null);
    expect(d).toMatchObject({ ok: true });
    expect(clock.now()).toBe(100 + 40); // pollMs ust siniri, sonra kira bitisi
    expect(calls.filter((c) => c === "acquire")).toHaveLength(3);
  });

  it("kapasite hic bosalmazsa maxWaitMs sonunda ag istegi atilmadan 'wait-too-long'", async () => {
    const clock = new VirtualClock();
    const { redis } = scripted(Array.from({ length: 1000 }, () => [3, 5_000, 0]));
    const gate = new RedisHostGate(
      redis,
      { ...gateOpts({ maxWaitMs: 1_000 }), leaseMs: 20_000, pollMs: 100 },
      clock,
    );
    let d: GateDecision | null = null;
    gate.acquire(HOST).then((x) => {
      d = x;
    });
    await clock.run(() => d !== null);
    expect(d).toMatchObject({ ok: false, reason: "wait-too-long" });
    expect(clock.now()).toBeLessThanOrEqual(1_000);
  });

  it("instance basina bekleyen siniri (maxQueue) asilirsa aninda 'queue-full'", async () => {
    const clock = new VirtualClock();
    const { redis } = scripted(Array.from({ length: 1000 }, () => [3, 100, 0]));
    const gate = new RedisHostGate(
      redis,
      { ...gateOpts({ maxQueue: 2, maxWaitMs: 500 }), leaseMs: 20_000, pollMs: 100 },
      clock,
    );
    const out: GateDecision[] = [];
    for (let i = 0; i < 3; i++) gate.acquire(HOST).then((x) => out.push(x));
    await clock.run(() => out.length === 3);
    expect(out.map((d) => (d.ok ? "ok" : d.reason))).toEqual([
      "queue-full",
      "wait-too-long",
      "wait-too-long",
    ]);
  });
});
