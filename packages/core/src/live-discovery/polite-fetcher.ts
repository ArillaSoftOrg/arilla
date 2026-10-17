/**
 * Nazik HTTP istemcisi. Kurallar:
 *  - durustce kimlik bildiren User-Agent (gizleme, proxy, rotasyon yok);
 *  - her istekten once robots.txt kontrolu;
 *  - istekler arasi en az `minIntervalMs`, toplam `maxRequests` tavani;
 *  - 403/429 (ya da bot-dogrulama sayfasi) gorulunce `blocked` olur ve
 *    sonraki TUM istekler reddedilir; yeniden denenmez, asilmaya calisilmaz.
 */

import { isAllowed, parseRobots, type RobotsRules } from "./robots.ts";

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PoliteFetcherOptions {
  userAgent: string;
  origin: string;
  maxRequests: number;
  minIntervalMs: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type FetchOutcome =
  | { ok: true; status: number; body: string; fetchedAt: string }
  | {
      ok: false;
      reason: "robots-disallowed" | "blocked" | "budget-exhausted" | "http-error" | "network";
      status?: number;
    };

const BOT_WALL = /captcha|cf-chl|are you a robot|robot degilsiniz|access denied|px-captcha/i;

export class PoliteFetcher {
  readonly opts: Required<Omit<PoliteFetcherOptions, "fetchImpl" | "sleep" | "now">> & {
    fetchImpl: FetchLike;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  };
  requestCount = 0;
  blockedBy: { status: number; url: string } | null = null;
  readonly skippedByRobots: string[] = [];
  private lastRequestAt = 0;
  private robots: RobotsRules | null = null;

  constructor(options: PoliteFetcherOptions) {
    this.opts = {
      timeoutMs: 15_000,
      maxBodyBytes: 12_000_000,
      fetchImpl: ((url, init) => fetch(url, { ...init, redirect: "follow" })) as FetchLike,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...options,
    };
  }

  private async rawGet(url: string): Promise<FetchOutcome> {
    if (this.blockedBy) return { ok: false, reason: "blocked", status: this.blockedBy.status };
    if (this.requestCount >= this.opts.maxRequests) {
      return { ok: false, reason: "budget-exhausted" };
    }
    const wait = this.lastRequestAt + this.opts.minIntervalMs - this.opts.now();
    if (this.lastRequestAt > 0 && wait > 0) await this.opts.sleep(wait);
    this.requestCount += 1;
    this.lastRequestAt = this.opts.now();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await this.opts.fetchImpl(url, {
        headers: {
          "user-agent": this.opts.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          "accept-language": "tr-TR,tr;q=0.9",
        },
        signal: ctrl.signal,
      });
      if (res.status === 403 || res.status === 429) {
        this.blockedBy = { status: res.status, url };
        return { ok: false, reason: "blocked", status: res.status };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, reason: "http-error", status: res.status };
      }
      const body = await res.text();
      if (body.length > this.opts.maxBodyBytes) return { ok: false, reason: "http-error" };
      if (body.length < 20_000 && BOT_WALL.test(body)) {
        this.blockedBy = { status: res.status, url };
        return { ok: false, reason: "blocked", status: res.status };
      }
      return { ok: true, status: res.status, body, fetchedAt: new Date().toISOString() };
    } catch {
      return { ok: false, reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** robots.txt'i bir kez yukler; yuklenemezse hicbir sey taranmaz (kapali varsayilan). */
  async loadRobots(): Promise<boolean> {
    const res = await this.rawGet(`${this.opts.origin}/robots.txt`);
    if (!res.ok) return false;
    this.robots = parseRobots(res.body, this.opts.userAgent);
    return true;
  }

  async get(url: string): Promise<FetchOutcome> {
    if (!this.robots) return { ok: false, reason: "robots-disallowed" };
    const u = new URL(url);
    if (u.origin !== this.opts.origin) return { ok: false, reason: "robots-disallowed" };
    if (!isAllowed(this.robots, `${u.pathname}${u.search}`)) {
      this.skippedByRobots.push(url);
      return { ok: false, reason: "robots-disallowed" };
    }
    return this.rawGet(url);
  }
}
