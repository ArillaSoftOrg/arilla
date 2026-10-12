/**
 * Redis host kapisi, GERCEK yerel Redis ile (Lua betikleri, Redis saati). Pazarama'ya
 * istek ATILMAZ; "istek" sahte bir is yukudur (bekleme). Her test kendi rastgele host adini
 * kullanir ve sonunda anahtarlarini siler. Birden cok `RedisHostGate` = birden cok instance.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getRedis } from "../redis/client.ts";
import { DEFAULT_REDIS_GATE_OPTIONS, type GateDecision, RedisHostGate } from "./host-gate.ts";

const hosts: string[] = [];
function host(): string {
  const h = `test-${Date.now()}-${Math.random().toString(36).slice(2)}.invalid`;
  hosts.push(h);
  return h;
}

afterAll(async () => {
  const keys = hosts.flatMap((h) =>
    ["slot", "open", "trips", "probe", "leases"].map((k) => `hostgate:${h}:${k}`),
  );
  if (keys.length > 0) await getRedis().del(...keys);
  getRedis().disconnect();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = {
  ...DEFAULT_REDIS_GATE_OPTIONS,
  minIntervalMs: 20,
  maxConcurrent: 2,
  maxQueue: 50,
  maxWaitMs: 5_000,
  leaseMs: 2_000,
  pollMs: 10,
};

describe("RedisHostGate: global eszamanlilik ve hiz (yerel Redis, cok instance)", () => {
  it("4 instance x 10 esanli istek: ayni anda en cok 2, baslangiclar >= aralik, hepsi tamamlanir", async () => {
    const h = host();
    const instances = Array.from({ length: 4 }, () => new RedisHostGate(getRedis(), base));
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const work = async (g: RedisHostGate) => {
      const d = await g.acquire(h);
      if (!d.ok) return d.reason;
      starts.push(Date.now());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(60); // sahte istek suresi (aralik 20 ms'den uzun: eszamanlilik siniri devrede)
      inFlight -= 1;
      d.release();
      return "ok";
    };
    const results = await Promise.all(
      instances.flatMap((g) => Array.from({ length: 10 }, () => work(g))),
    );
    expect(results.every((r) => r === "ok")).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    const s = [...starts].sort((a, b) => a - b);
    // Redis saatiyle ayrilan slotlar (20 ms); istemci saatinde sapma payi. Windows zamanlayici
    // cozunurlugu (~15 ms) paralel test yukunde 14 ms gozlemletti (2026-10-12).
    for (let i = 1; i < s.length; i++) {
      expect((s[i] as number) - (s[i - 1] as number)).toBeGreaterThanOrEqual(10);
    }
    await sleep(30);
    expect(await getRedis().zcard(`hostgate:${h}:leases`)).toBe(0); // tum kiralar iade edildi
  });

  it("kapasite dolu ve bekleme siniri asilirsa ag istegi atilmadan 'wait-too-long'", async () => {
    const h = host();
    const opts = { ...base, maxConcurrent: 1, maxWaitMs: 150 };
    const holder = await new RedisHostGate(getRedis(), opts).acquire(h);
    expect(holder.ok).toBe(true);
    const t0 = Date.now();
    const denied = await new RedisHostGate(getRedis(), opts).acquire(h);
    expect(denied).toMatchObject({ ok: false, reason: "wait-too-long" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    if (holder.ok) holder.release();
  });

  it("birakilmayan kira (cokme) leaseMs sonra kendiliginden duser; kapasite geri gelir", async () => {
    const h = host();
    const crashed = new RedisHostGate(getRedis(), { ...base, maxConcurrent: 1, leaseMs: 300 });
    const lost = await crashed.acquire(h); // release CAGRILMIYOR (surec coktu)
    expect(lost.ok).toBe(true);
    const other = new RedisHostGate(getRedis(), {
      ...base,
      maxConcurrent: 1,
      leaseMs: 300,
      maxWaitMs: 2_000,
    });
    const t0 = Date.now();
    const d = await other.acquire(h);
    expect(d.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200); // kira dusene kadar bekledi
    if (d.ok) d.release();
  });

  it("birakilan kiralar iade edilir; iki kez birakmak zararsiz", async () => {
    const h = host();
    const g = new RedisHostGate(getRedis(), base);
    const a = await g.acquire(h);
    const b = await g.acquire(h);
    expect(await getRedis().zcard(`hostgate:${h}:leases`)).toBe(2);
    if (a.ok) a.release();
    if (b.ok) {
      b.release();
      b.release();
    }
    await sleep(50);
    expect(await getRedis().zcard(`hostgate:${h}:leases`)).toBe(0);
  });
});

describe("RedisHostGate: 429/403, Retry-After, devre kesici (yerel Redis)", () => {
  it("429 + Retry-After: devre TUM instance'lar icin acik; sonra yalnizca TEK deneme gecer", async () => {
    const h = host();
    const gates = Array.from({ length: 3 }, () => new RedisHostGate(getRedis(), base));
    await (gates[0] as RedisHostGate).trip(h, 429, 300);
    for (const g of gates) {
      expect(await g.acquire(h)).toMatchObject({ ok: false, reason: "circuit-open" });
    }
    await sleep(350);
    const decisions: GateDecision[] = await Promise.all(gates.map((g) => g.acquire(h)));
    expect(decisions.filter((d) => d.ok && d.probe)).toHaveLength(1);
    expect(decisions.filter((d) => !d.ok)).toHaveLength(2);
    // Deneme basarili -> kapanir, herkes gecer.
    await (gates[1] as RedisHostGate).succeed(h);
    for (const d of decisions) if (d.ok) d.release();
    await sleep(30);
    const after = await Promise.all(gates.map((g) => g.acquire(h)));
    expect(after.every((d) => d.ok)).toBe(true);
    for (const d of after) if (d.ok) d.release();
  });

  it("deneme istegi ag hatasiyla biterse (ne 429 ne basari) hak geri verilir; devre kilitlenmez", async () => {
    const h = host();
    const g = new RedisHostGate(getRedis(), base);
    await g.trip(h, 403, 100);
    await sleep(150);
    const probe = await g.acquire(h);
    expect(probe).toMatchObject({ ok: true, probe: true });
    if (probe.ok) probe.release(); // ag hatasi: trip/succeed yok
    await sleep(30);
    const next = await g.acquire(h);
    expect(next).toMatchObject({ ok: true, probe: true }); // yeni tek deneme
    if (next.ok) next.release();
  });

  it("beklerken baska instance 429 alirsa istek atilmaz ve kira iade edilir", async () => {
    const h = host();
    const slow = new RedisHostGate(getRedis(), { ...base, minIntervalMs: 400, maxConcurrent: 5 });
    const first = await slow.acquire(h);
    const pending = slow.acquire(h); // ~400 ms slot beklemesi
    await sleep(100);
    await new RedisHostGate(getRedis(), base).trip(h, 429, 5_000);
    expect(await pending).toMatchObject({ ok: false, reason: "circuit-open" });
    if (first.ok) first.release();
    await sleep(30);
    expect(await getRedis().zcard(`hostgate:${h}:leases`)).toBe(0);
  });

  it("Retry-After yoksa varsayilan sure, art arda acilmada ikiye katlanir (tavanli)", async () => {
    const h = host();
    const g = new RedisHostGate(getRedis(), { ...base, cooldownMs: 10_000, maxCooldownMs: 15_000 });
    await g.trip(h, 429, null);
    const p1 = await getRedis().pttl(`hostgate:${h}:open`);
    await g.trip(h, 429, null);
    const p2 = await getRedis().pttl(`hostgate:${h}:open`);
    expect(p1).toBeGreaterThan(9_000);
    expect(p1).toBeLessThanOrEqual(10_000);
    expect(p2).toBeGreaterThan(14_000);
    expect(p2).toBeLessThanOrEqual(15_000);
  });

  it("baska host etkilenmez", async () => {
    const h1 = host();
    const h2 = host();
    const g = new RedisHostGate(getRedis(), base);
    await g.trip(h1, 429, 5_000);
    const d = await g.acquire(h2);
    expect(d.ok).toBe(true);
    if (d.ok) d.release();
  });
});
