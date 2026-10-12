/**
 * Magaza (host) basina ORTAK istek kapisi - Faz 5 (yogun kullanim).
 *
 * Faz 4'e kadar hiz siniri arama basina `PazaramaClient` icindeydi: N esanli kullanici
 * Pazarama'ya N kat istek demekti; 429 yalnizca o aramayi durduruyor, sonraki arama yine
 * istek atiyordu; Retry-After okunmuyordu. Canli kiyaslamada ~20 dk surekli ~1 istek/sn
 * sonrasinda HTTP 429 alindi (9. oturum).
 *
 * Kapi, host basina:
 *  - HIZ: istek BASLANGICLARI arasi en az `minIntervalMs` (tum kullanicilar ve - Redis
 *    uygulamasinda - tum instance'lar icin ortak slot);
 *  - ESZAMANLILIK: ayni anda en cok `maxConcurrent` istek; fazlasi FIFO kuyrukta bekler;
 *  - KUYRUK: kuyruk `maxQueue`'yu asarsa ya da slot beklemesi `maxWaitMs`'yi asarsa istek
 *    HEMEN reddedilir (kullanici beklemez, siteye yuk binmez);
 *  - DEVRE KESICI: 429/403 -> devre acilir; Retry-After (saniye ya da HTTP tarihi) varsa ona,
 *    yoksa `cooldownMs`'ye uyulur; sure dolunca YARI ACIK: tek bir deneme istegi gecer,
 *    basariliysa kapanir, yine 429 ise sure ikiye katlanarak (en cok `maxCooldownMs`) acilir.
 * Anahtarlar host'a gore oldugundan bir magazanin engeli digerlerini etkilemez.
 * Kullanici, sorgu ya da IP saklanmaz.
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

export type GateDenyReason = "circuit-open" | "queue-full" | "wait-too-long" | "unavailable";

export type GateDecision =
  | { ok: true; waitMs: number; probe: boolean; release(): void }
  | { ok: false; reason: GateDenyReason; retryAtMs: number | null };

export interface HostGate {
  /** Agdan ONCE cagrilir. Izin varsa slot zamanina kadar bekler ve bilet doner. */
  acquire(host: string): Promise<GateDecision>;
  /** 429/403 bildirimi: devre acilir. `retryAfterMs`: Retry-After'dan (yoksa null). */
  trip(host: string, status: number, retryAfterMs: number | null): Promise<void>;
  /** Basarili yanit: yari acik devre kapanir. */
  succeed(host: string): Promise<void>;
}

export interface HostGateOptions {
  minIntervalMs: number;
  maxConcurrent: number;
  maxQueue: number;
  /** Slot beklemesi bundan uzunsa istek reddedilir (kullanici sonsuza dek beklemez). */
  maxWaitMs: number;
  /** Retry-After yoksa devrenin acik kalacagi sure. */
  cooldownMs: number;
  maxCooldownMs: number;
}

export const DEFAULT_GATE_OPTIONS: HostGateOptions = {
  minIntervalMs: 1_000,
  maxConcurrent: 2,
  maxQueue: 20,
  maxWaitMs: 10_000,
  cooldownMs: 15 * 60_000,
  maxCooldownMs: 6 * 60 * 60_000,
};

/**
 * Retry-After: saniye ("120") ya da HTTP tarihi ("Wed, 21 Oct 2026 07:28:00 GMT").
 * Gecersizse null; sonuc [1 sn, 24 sa] araligina kirpilir.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isFinite(at)) ms = at - nowMs;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(24 * 60 * 60_000, Math.max(1_000, ms));
}

interface HostState {
  nextSlot: number;
  /** Kapasite tutan istek sayisi (kuyruktan uyandirilan icin UYANDIRAN ayirir: yaris yok). */
  inFlight: number;
  /** true: kapasite verildi; false: reddedildi (devre acildi). */
  queue: ((granted: boolean) => void)[];
  openUntil: number;
  /** Ust uste acilma sayisi (geri cekilme). */
  trips: number;
  probeInFlight: boolean;
}

/** Tek instance icin bellek ici kapi (testlerde ve tek surecte). */
export class InMemoryHostGate implements HostGate {
  private readonly hosts = new Map<string, HostState>();
  constructor(
    private readonly opts: HostGateOptions = DEFAULT_GATE_OPTIONS,
    private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = {
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  ) {}

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { nextSlot: 0, inFlight: 0, queue: [], openUntil: 0, trips: 0, probeInFlight: false };
      this.hosts.set(host, s);
    }
    return s;
  }

  async acquire(host: string): Promise<GateDecision> {
    const s = this.state(host);
    const now = this.clock.now();
    // Devre kesici.
    let probe = false;
    if (s.openUntil > now) return { ok: false, reason: "circuit-open", retryAtMs: s.openUntil };
    if (s.trips > 0) {
      // Sure doldu: yari acik. Yalnizca TEK deneme istegi gecer.
      if (s.probeInFlight) return { ok: false, reason: "circuit-open", retryAtMs: null };
      s.probeInFlight = true;
      probe = true;
    }
    // Eszamanlilik + kuyruk: kapasite ya hemen alinir ya da uyandiran tarafindan ayrilir.
    if (s.inFlight < this.opts.maxConcurrent) {
      s.inFlight += 1;
    } else {
      if (s.queue.length >= this.opts.maxQueue) {
        if (probe) s.probeInFlight = false;
        return { ok: false, reason: "queue-full", retryAtMs: null };
      }
      const granted = await new Promise<boolean>((resolve) => s.queue.push(resolve));
      if (!granted) {
        if (probe) s.probeInFlight = false;
        return { ok: false, reason: "circuit-open", retryAtMs: s.openUntil };
      }
    }
    const giveBack = () => {
      s.inFlight -= 1;
      if (probe) s.probeInFlight = false;
      this.wakeNext(s);
    };
    // Hiz: slot ayir (senkron). Bekleme cok uzunsa ayirmadan reddet.
    const t = this.clock.now();
    const slot = Math.max(t, s.nextSlot);
    if (slot - t > this.opts.maxWaitMs) {
      giveBack();
      return { ok: false, reason: "wait-too-long", retryAtMs: slot };
    }
    s.nextSlot = slot + this.opts.minIntervalMs;
    if (slot > t) await this.clock.sleep(slot - t);
    // Bekleme sirasinda devre acildiysa istek atilmaz.
    if (s.openUntil > this.clock.now()) {
      giveBack();
      return { ok: false, reason: "circuit-open", retryAtMs: s.openUntil };
    }
    let released = false;
    return {
      ok: true,
      waitMs: slot - t,
      probe,
      release: () => {
        if (released) return;
        released = true;
        s.inFlight -= 1;
        // Deneme istegi ag hatasiyla bittiyse (ne 429 ne basari) hakki geri ver: aksi halde
        // devre sonsuza dek yari acik kilitli kalir.
        if (probe) s.probeInFlight = false;
        this.wakeNext(s);
      },
    };
  }

  private wakeNext(s: HostState): void {
    while (s.inFlight < this.opts.maxConcurrent && s.queue.length > 0) {
      s.inFlight += 1; // bekleyen adina ayrilir
      s.queue.shift()?.(true);
    }
  }

  async trip(host: string, _status: number, retryAfterMs: number | null): Promise<void> {
    const s = this.state(host);
    s.trips += 1;
    const backoff = Math.min(this.opts.maxCooldownMs, this.opts.cooldownMs * 2 ** (s.trips - 1));
    s.openUntil = this.clock.now() + (retryAfterMs ?? backoff);
    s.probeInFlight = false;
    // Kuyruktakiler kapasite almadan reddedilir.
    while (s.queue.length > 0) s.queue.shift()?.(false);
  }

  async succeed(host: string): Promise<void> {
    const s = this.state(host);
    if (s.trips > 0 && s.openUntil <= this.clock.now()) {
      s.trips = 0;
      s.probeInFlight = false;
    }
  }

  /** Testler/izleme icin. */
  snapshot(host: string): Readonly<HostState> {
    return { ...this.state(host), queue: [...this.state(host).queue] };
  }
}

/**
 * Cok instance (ornegin birden cok Vercel ornegi) icin Redis kapisi: hiz, ESZAMANLILIK ve devre
 * durumu Redis'te, tek Lua betiginde ve Redis saatiyle (`TIME`) atomik.
 *
 * Eszamanlilik GLOBAL bir kira (lease) semaforudur: `hostgate:<host>:leases` sirali kumesi
 * (uye = istek kimligi, puan = kira bitisi ms). Her edinmede suresi dolmus kiralar silinir;
 * bilet birakilinca kira hemen silinir. Surec cokerse / bilet birakilamazsa kapasite en gec
 * `leaseMs` sonra kendiliginden geri gelir (`leaseMs` istek zaman asimindan BUYUK olmali).
 * Kapasite doluysa istemci kisa araliklarla yeniden dener; `maxWaitMs` asilirsa ag istegi
 * ATILMADAN reddedilir. Instance basina bekleyen sayisi `maxQueue` ile sinirlidir.
 *
 * Devre kesici: `open` anahtari (PX) aciksa red; sure dolup `trips` hala varsa YARI ACIK:
 * `probe` anahtari `SET NX` ile TUM instance'lar arasinda tek deneme istegine izin verir.
 * Redis'e ulasilamazsa istek REDDEDILIR ("unavailable"): guvenilir sinir yokken siteye
 * istek atilmaz.
 *
 * Anahtarlar: `hostgate:<host>:{slot,open,trips,probe,leases}`. Kullanici/sorgu/IP yok.
 */
export type HostGateRedisClient = Pick<Redis, "eval">;

export interface RedisHostGateOptions extends HostGateOptions {
  /** Kira suresi: istek zaman asimi + pay (varsayilan 20 sn; istemci zaman asimi 12 sn). */
  leaseMs: number;
  /** Kapasite doluyken yeniden deneme araligi ust siniri. */
  pollMs: number;
}

export const DEFAULT_REDIS_GATE_OPTIONS: RedisHostGateOptions = {
  ...DEFAULT_GATE_OPTIONS,
  leaseMs: 20_000,
  pollMs: 100,
};

/**
 * KEYS: slot, open, trips, probe, leases.
 * ARGV: aralik ms, en cok bekleme ms, slot TTL ms, kira kimligi, kira ms, en cok eszamanli.
 * Donus {kod, ms, deneme}: 0 izin (ms = slot beklemesi), 1 devre acik (ms = kalan; 0 = yari acik
 * deneme hakki baskasinda), 2 bekleme cok uzun, 3 kapasite dolu (ms = en erken kira bitisine kalan).
 */
export const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local openTtl = redis.call('PTTL', KEYS[2])
if openTtl > 0 then return {1, openTtl, 0} end
local probe = 0
if redis.call('EXISTS', KEYS[3]) == 1 then
  if redis.call('SET', KEYS[4], ARGV[4], 'NX', 'PX', ARGV[5]) then probe = 1 else return {1, 0, 0} end
end
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now)
if redis.call('ZCARD', KEYS[5]) >= tonumber(ARGV[6]) then
  if probe == 1 then redis.call('DEL', KEYS[4]) end
  local first = redis.call('ZRANGE', KEYS[5], 0, 0, 'WITHSCORES')
  return {3, math.max(0, tonumber(first[2]) - now), 0}
end
local nextSlot = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nextSlot)
local wait = slot - now
if wait > tonumber(ARGV[2]) then
  if probe == 1 then redis.call('DEL', KEYS[4]) end
  return {2, wait, 0}
end
redis.call('SET', KEYS[1], slot + tonumber(ARGV[1]), 'PX', ARGV[3])
redis.call('ZADD', KEYS[5], slot + tonumber(ARGV[5]), ARGV[4])
redis.call('PEXPIRE', KEYS[5], wait + tonumber(ARGV[5]) + 60000)
return {0, wait, probe}
`;

/** KEYS: leases, probe. ARGV: kira kimligi. Kira silinir; deneme hakki bu kiraya aitse geri verilir. */
export const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
`;

/** KEYS: open. Slot beklemesinden sonra: devre bu arada acildiysa istek atilmaz. */
export const CHECK_OPEN_SCRIPT = "return redis.call('PTTL', KEYS[1])";

/** KEYS: open, trips, probe. ARGV: retryAfter ms (0 = yok), cooldown ms, max cooldown ms. */
export const TRIP_SCRIPT = `
local trips = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
local ms = tonumber(ARGV[1])
if ms <= 0 then ms = math.min(tonumber(ARGV[3]), tonumber(ARGV[2]) * (2 ^ (trips - 1))) end
redis.call('SET', KEYS[1], '1', 'PX', math.floor(ms))
redis.call('DEL', KEYS[3])
return math.floor(ms)
`;

/** KEYS: open, trips, probe. Acik devre yoksa geri cekilme ve deneme hakki sifirlanir. */
export const SUCCEED_SCRIPT = `
if redis.call('PTTL', KEYS[1]) > 0 then return 0 end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
return 1
`;

type GateKeys = { slot: string; open: string; trips: string; probe: string; leases: string };

export class RedisHostGate implements HostGate {
  private waiting = 0;
  private readonly opts: RedisHostGateOptions;

  constructor(
    private readonly redis: HostGateRedisClient,
    opts: Partial<RedisHostGateOptions> = {},
    private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = {
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    private readonly newId: () => string = randomUUID,
  ) {
    this.opts = { ...DEFAULT_REDIS_GATE_OPTIONS, ...opts };
  }

  private keys(host: string): GateKeys {
    const k = (s: string) => `hostgate:${host}:${s}`;
    return {
      slot: k("slot"),
      open: k("open"),
      trips: k("trips"),
      probe: k("probe"),
      leases: k("leases"),
    };
  }

  async acquire(host: string): Promise<GateDecision> {
    if (this.waiting >= this.opts.maxQueue) {
      return { ok: false, reason: "queue-full", retryAtMs: null };
    }
    this.waiting += 1;
    try {
      const k = this.keys(host);
      const leaseId = this.newId();
      const started = this.clock.now();
      for (;;) {
        let res: unknown;
        try {
          res = await this.redis.eval(
            ACQUIRE_SCRIPT,
            5,
            k.slot,
            k.open,
            k.trips,
            k.probe,
            k.leases,
            String(this.opts.minIntervalMs),
            String(this.opts.maxWaitMs),
            String(this.opts.maxWaitMs + 60_000),
            leaseId,
            String(this.opts.leaseMs),
            String(this.opts.maxConcurrent),
          );
        } catch {
          return { ok: false, reason: "unavailable", retryAtMs: null };
        }
        const parts = Array.isArray(res) ? (res as unknown[]).map(Number) : [];
        const [code, ms = 0, probe = 0] = parts;
        if (code === 0) {
          if (ms > 0) {
            await this.clock.sleep(ms);
            // Beklerken baska bir instance 429 aldiysa istek ATILMAZ.
            let openTtl: number;
            try {
              openTtl = Number(await this.redis.eval(CHECK_OPEN_SCRIPT, 1, k.open));
            } catch {
              this.releaseLease(k, leaseId);
              return { ok: false, reason: "unavailable", retryAtMs: null };
            }
            if (openTtl > 0) {
              this.releaseLease(k, leaseId);
              return { ok: false, reason: "circuit-open", retryAtMs: this.clock.now() + openTtl };
            }
          }
          let released = false;
          return {
            ok: true,
            waitMs: ms,
            probe: probe === 1,
            release: () => {
              if (released) return;
              released = true;
              this.releaseLease(k, leaseId);
            },
          };
        }
        if (code === 1) {
          return {
            ok: false,
            reason: "circuit-open",
            retryAtMs: ms > 0 ? this.clock.now() + ms : null,
          };
        }
        if (code === 2) {
          return { ok: false, reason: "wait-too-long", retryAtMs: this.clock.now() + ms };
        }
        if (code === 3) {
          // Global kapasite dolu: en erken kira bitisine (ya da poll araligina) kadar bekle.
          const pause = Math.max(10, Math.min(ms, this.opts.pollMs));
          if (this.clock.now() - started + pause > this.opts.maxWaitMs) {
            return { ok: false, reason: "wait-too-long", retryAtMs: null };
          }
          await this.clock.sleep(pause);
          continue;
        }
        return { ok: false, reason: "unavailable", retryAtMs: null };
      }
    } finally {
      this.waiting -= 1;
    }
  }

  /** Kira hemen birakilir; Redis hatasinda kira `leaseMs` sonra kendiliginden duser. */
  private releaseLease(k: GateKeys, leaseId: string): void {
    this.redis.eval(RELEASE_SCRIPT, 2, k.leases, k.probe, leaseId).catch(() => {});
  }

  async trip(host: string, _status: number, retryAfterMs: number | null): Promise<void> {
    const k = this.keys(host);
    try {
      await this.redis.eval(
        TRIP_SCRIPT,
        3,
        k.open,
        k.trips,
        k.probe,
        String(retryAfterMs ?? 0),
        String(this.opts.cooldownMs),
        String(this.opts.maxCooldownMs),
      );
    } catch {
      // Redis yoksa zaten tum istekler "unavailable" ile reddedilir.
    }
  }

  async succeed(host: string): Promise<void> {
    const k = this.keys(host);
    try {
      await this.redis.eval(SUCCEED_SCRIPT, 3, k.open, k.trips, k.probe);
    } catch {
      /* yok sayilir */
    }
  }
}
