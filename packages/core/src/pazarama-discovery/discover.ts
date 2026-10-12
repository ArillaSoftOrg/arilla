/**
 * Pazarama urun kesfi - SUNUCU tarafinda calisir (Pazarama sayfalari CORS'suz).
 * Iki yol:
 *  1) Barkod: baska bir kaynaktan (HB urun sayfasi `gtin`) gelen barkodla
 *     `/-p-<barkod>` -> urun sayfasi JSON-LD. Sunucuya kullanici sorgusu bile gitmez.
 *  2) SEO sayfasi: sorgu -> marka+kategori sayfasi -> SSR kartlar -> kati eslestirme.
 * Kurallar: durust UA, istekler arasi bekleme, zaman asimi, 403/429'da kalici durma.
 * Arama yolu (`/arama`, `/search`) robots.txt'te yasak; KULLANILMAZ.
 */

import { matchesQuery } from "../live-search-browser/match.ts";
import { type GateDenyReason, type HostGate, parseRetryAfter } from "./host-gate.ts";
import {
  DEFAULT_PAGE_CACHE_TTL,
  type PageCache,
  type PageCacheTtl,
  pageCacheKey,
  ttlFor,
} from "./page-cache.ts";
import {
  barcodeProductUrl,
  DETAIL_STOP,
  LISTING_STOP,
  PAZARAMA_ORIGIN,
  type PazaramaCard,
  type PazaramaProductPage,
  parseListingCards,
  parseProductPage,
} from "./parse.ts";

export type FetchText = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  /** Akis: okuma `stopWhen` saglaninca kesilir (Faz 4). Yoksa `text()` kullanilir. */
  body?: ReadableStream<Uint8Array> | null;
}>;

/** Istek turu: olcum ve okuma kurali icin. */
export type RequestKind = "list" | "detail" | "barcode" | "other";

/** Okunan metin bu kosulu saglayinca akis kesilir (kalan bayt indirilmez). */
export type StopRule = (decodedSoFar: string) => boolean;

/**
 * robots.txt (okundu 2026-10-12): Disallow /arama, /search, /developer/*, /refresh-token,
 * /goruntulediginiz-urunler, /wheel-win, /sikca-sorulan-sorular/, *\/iscep/*, *isplus=1*;
 * Allow /*?sayfa, /*?magaza. Bu istemcinin istedigi yollar (urun, liste, sitemap) icin yeterli.
 */
const ROBOTS_DISALLOW = [
  /^\/arama(\/|\?|$)/,
  /^\/search(\/|\?|$)/,
  /^\/developer\//,
  /^\/refresh-token/,
  /^\/goruntulediginiz-urunler/,
  /^\/wheel-win/,
  /^\/sikca-sorulan-sorular\/./,
  /\/iscep\//,
  /isplus=1/i,
];

/** Yalnizca https://www.pazarama.com, kimlik bilgisi/port yok ve robots'un izin verdigi yol. */
export function isAllowedPazaramaUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.origin !== PAZARAMA_ORIGIN || u.username || u.password) return false;
  const pathWithQuery = `${u.pathname}${u.search}`;
  return !ROBOTS_DISALLOW.some((re) => re.test(pathWithQuery));
}

const MAX_REDIRECTS = 3;
const PAZARAMA_HOST = new URL(PAZARAMA_ORIGIN).host;
/** Arama kabul kapisinin anahtari (host kapisindan ayri sayaclar). */
export const ADMISSION_KEY = `search:${PAZARAMA_HOST}`;

export type GetResult =
  | {
      status: number;
      body: string;
      finalUrl: string;
      /** Govdenin siteden alindigi an (epoch ms). Ortak onbellekten geldiyse o anki ag istegi. */
      fetchedAt: number;
    }
  | { status: number; stop: true; denied?: GateDenyReason };

export interface RequestLogEntry {
  url: string;
  kind: RequestKind;
  status: number;
  /** Hiz siniri slotu icin beklenen sure. */
  waitMs: number;
  /** Istek baslangicindan okumanin bitmesine (ya da kesilmesine) kadar gecen ag suresi. */
  ms: number;
  /** Okunan (acilmis) karakter sayisi. */
  bytes: number;
  /** Okuma `stopWhen` ile erken kesildi mi. */
  truncated: boolean;
}

/**
 * Hiz siniri SLOT ile uygulanir: her istegin BASLANGICI bir oncekinden en az `minIntervalMs`
 * sonradir; boylece iki yol (barkod + SEO) ayni istemciyi eszamanli kullanabilir ama
 * toplam istek hizi asla siniri gecmez (indirmeler ust uste binebilir).
 * Ayni URL bir arama icinde ikinci kez indirilmez (yonlendirme sonrasi adres dahil).
 */
export interface SharedPageOptions {
  cache: PageCache;
  ttl?: PageCacheTtl;
  /** Getiren aramanin kilidi (kapi beklemesi + zaman asimi + pay). Takipci en cok bu kadar bekler. */
  lockMs?: number;
  /** Takipcinin onbellege bakma araligi. */
  pollMs?: number;
}

type OnceResult =
  | { status: number; body: string; location: string | null; fetchedAt: number }
  | { status: number; stop: true; denied?: GateDenyReason };

export class PazaramaClient {
  blockedBy: number | null = null;
  /** Ortak kapinin reddi (devre acik, kuyruk dolu, bekleme uzun, Redis yok): ag istegi ATILMADI. */
  deniedBy: GateDenyReason | null = null;
  requests = 0;
  cacheHits = 0;
  /** Faz 6: ortak (aramalar/instance'lar arasi) onbellekten gelen sayfa sayisi; ag istegi YOK. */
  sharedHits = 0;
  /** Bunlarin kacinda ayni URL'yi getiren baska bir aramayi bekledi (single-flight). */
  coalesced = 0;
  /** Faz 6: arama kabul kapisi bu aramayi reddetti (site istegi baslamadan). */
  admissionDenied = false;
  readonly log: RequestLogEntry[] = [];
  private admission: Promise<boolean> | null = null;
  private admissionTicket: { release(): void } | null = null;
  private nextSlot = 0;
  private readonly cache = new Map<string, Promise<GetResult>>();

  constructor(
    private readonly opts: {
      userAgent: string;
      minIntervalMs: number;
      maxRequests: number;
      timeoutMs?: number;
      fetchImpl?: FetchText;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      /** false: `stopWhen` yok sayilir, sayfanin tamami okunur (kiyaslama icin). */
      cutoff?: boolean;
      /**
       * Faz 5: tum aramalar (ve Redis ile tum instance'lar) icin ORTAK host kapisi. Verilirse
       * hiz siniri/eszamanlilik/devre kesici kapidadir; istemcinin kendi slotu kullanilmaz.
       */
      gate?: HostGate;
      /**
       * Faz 6: ortak, kisa omurlu sayfa onbellegi + single-flight. Ayni URL'yi ayni anda ya da
       * TTL icinde isteyen aramalar tek ag istegini paylasir. Yoksa Faz 5 davranisi.
       */
      pageCache?: SharedPageOptions;
      /**
       * Faz 6: ARAMA duzeyinde kabul (ayni kapi sinifi, ayri anahtar). Ilk ag istegi gerektiginde
       * (onbellek iskasinda) bir kez alinir, `finish()` ile birakilir. Doluysa arama siteye istek
       * ATMADAN durur: asiri yukte baslayip yarida reddedilen aramalarin kapasite yemesi onlenir.
       * Tamamen onbellekten donen aramalar kabul kapisina hic ugramaz.
       */
      admission?: HostGate;
    },
  ) {}

  /** Arama bitti: kabul hakki (varsa) birakilir. Iki kez cagrilabilir. */
  finish(): void {
    this.admissionTicket?.release();
    this.admissionTicket = null;
  }

  private admit(): Promise<boolean> {
    const gate = this.opts.admission;
    if (!gate) return Promise.resolve(true);
    this.admission ??= gate.acquire(ADMISSION_KEY).then(
      (d) => {
        if (d.ok) {
          this.admissionTicket = d;
          return true;
        }
        this.admissionDenied = true;
        this.deniedBy = d.reason;
        return false;
      },
      () => {
        this.admissionDenied = true;
        this.deniedBy = "unavailable";
        return false;
      },
    );
    return this.admission;
  }

  /**
   * Yonlendirmeler elle izlenir (en cok 3): her adim yeniden `isAllowedPazaramaUrl`
   * denetiminden gecer; baska alan adina/izinsiz yola giden yonlendirme izlenmez (SSRF).
   */
  get(url: string, req: { kind?: RequestKind; stopWhen?: StopRule } = {}): Promise<GetResult> {
    if (!isAllowedPazaramaUrl(url)) {
      return Promise.reject(new Error("url not allowed (origin/robots)"));
    }
    const cached = this.cache.get(url);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const pending = this.follow(url, req);
    this.cache.set(url, pending);
    return pending;
  }

  private async follow(
    url: string,
    req: { kind?: RequestKind; stopWhen?: StopRule },
  ): Promise<GetResult> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.once(current, req);
      if ("stop" in res) return res;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.location ? new URL(res.location, current).toString() : null;
        if (!loc || !isAllowedPazaramaUrl(loc)) {
          return { status: res.status, body: "", finalUrl: current, fetchedAt: res.fetchedAt };
        }
        current = loc;
        // Yonlendirme hedefi zaten okunduysa (ornegin SEO kartinin adresi) yeniden indirilmez.
        const known = this.cache.get(current);
        if (known) {
          this.cacheHits += 1;
          return known;
        }
        continue;
      }
      const out = {
        status: res.status,
        body: res.body,
        finalUrl: current,
        fetchedAt: res.fetchedAt,
      };
      if (current !== url) this.cache.set(current, Promise.resolve(out));
      return out;
    }
    return { status: 0, body: "", finalUrl: current, fetchedAt: (this.opts.now ?? Date.now)() };
  }

  /**
   * Faz 6: once ortak onbellek; yoksa single-flight kilidi. Kilidi alan getirir ve saklar; alamayan
   * (ayni URL'yi baska arama getiriyor) kisa araliklarla onbellege bakar. Getiren basarisiz olursa
   * (429, ag hatasi: saklanmaz) kilit birakilir ve takipci kendisi dener; kapi yine karar verir.
   * Onbellek isabeti ag istegi degildir: `maxRequests`'ten dusmez, kapiya ugramaz.
   */
  private async once(
    url: string,
    req: { kind?: RequestKind; stopWhen?: StopRule },
  ): Promise<OnceResult> {
    const shared = this.opts.pageCache;
    if (!shared) return this.onceNetwork(url, req);
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const kind = req.kind ?? "other";
    const cutoffOn = this.opts.cutoff !== false && req.stopWhen !== undefined;
    // Barkod ve detay ayni okuma kuralini kullanir: yonlendirme hedefi ortak anahtarda bulunur.
    const key = pageCacheKey(kind === "barcode" ? "detail" : kind, url, cutoffOn);
    const fromCache = async (): Promise<OnceResult | null> => {
      const hit = await shared.cache.get(key);
      if (!hit) return null;
      this.sharedHits += 1;
      return {
        status: hit.status,
        body: hit.body,
        location: hit.location,
        fetchedAt: hit.fetchedAt,
      };
    };
    const first = await fromCache();
    if (first) return first;
    if (this.blockedBy !== null) return { status: this.blockedBy, stop: true };
    if (this.deniedBy !== null) return { status: 0, stop: true, denied: this.deniedBy };
    if (this.requests >= this.opts.maxRequests) return { status: 0, stop: true };
    const lockMs = shared.lockMs ?? 30_000;
    const pollMs = shared.pollMs ?? 100;
    const waitStarted = now();
    let leader = await shared.cache.lock(key, lockMs);
    while (!leader && now() - waitStarted < lockMs) {
      await sleep(pollMs);
      const hit = await fromCache();
      if (hit) {
        this.coalesced += 1;
        return hit;
      }
      leader = await shared.cache.lock(key, lockMs);
    }
    try {
      const res = await this.onceNetwork(url, req);
      if (!("stop" in res)) {
        const ttl = ttlFor(kind, res.status, shared.ttl ?? DEFAULT_PAGE_CACHE_TTL);
        await shared.cache.set(
          key,
          { status: res.status, body: res.body, location: res.location, fetchedAt: res.fetchedAt },
          ttl,
        );
      }
      return res;
    } finally {
      if (leader) await shared.cache.unlock(key);
    }
  }

  private async onceNetwork(
    url: string,
    req: { kind?: RequestKind; stopWhen?: StopRule },
  ): Promise<OnceResult> {
    if (this.blockedBy !== null) return { status: this.blockedBy, stop: true };
    if (this.deniedBy !== null) return { status: 0, stop: true, denied: this.deniedBy };
    if (this.requests >= this.opts.maxRequests) return { status: 0, stop: true };
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const kind = req.kind ?? "other";
    const waitStarted = now();
    if (!(await this.admit())) {
      return { status: 0, stop: true, denied: this.deniedBy ?? "queue-full" };
    }
    if (this.deniedBy !== null) return { status: 0, stop: true, denied: this.deniedBy };
    let ticket: { release(): void } | null = null;
    if (this.opts.gate) {
      // Ortak kapi: hiz, eszamanlilik, kuyruk ve devre kesici burada.
      const decision = await this.opts.gate.acquire(PAZARAMA_HOST);
      if (!decision.ok) {
        this.deniedBy = decision.reason;
        return { status: 0, stop: true, denied: decision.reason };
      }
      ticket = decision;
      this.requests += 1;
    } else {
      // Slot ayir (senkron; esanli cagrilar ayni slotu alamaz), sonra slotun zamanini bekle.
      this.requests += 1;
      const slot = Math.max(now(), this.nextSlot);
      this.nextSlot = slot + this.opts.minIntervalMs;
      const wait = slot - now();
      if (wait > 0) await sleep(wait);
    }
    const waitMs = now() - waitStarted;
    try {
      return await this.fetchOnce(url, req, kind, waitMs, now);
    } finally {
      ticket?.release();
    }
  }

  private async fetchOnce(
    url: string,
    req: { kind?: RequestKind; stopWhen?: StopRule },
    kind: RequestKind,
    waitMs: number,
    now: () => number,
  ): Promise<OnceResult> {
    const stopWhen = this.opts.cutoff === false ? undefined : req.stopWhen;
    if (this.blockedBy !== null) return { status: this.blockedBy, stop: true };
    const fetchImpl = this.opts.fetchImpl ?? (fetch as unknown as FetchText);
    const started = now();
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": this.opts.userAgent, "accept-language": "tr-TR,tr;q=0.9" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        redirect: "manual",
      });
      if (res.status === 403 || res.status === 429) {
        this.blockedBy = res.status;
        // Ortak devre kesici: Retry-After'a (saniye ya da HTTP tarihi) uyulur.
        await this.opts.gate?.trip(
          PAZARAMA_HOST,
          res.status,
          parseRetryAfter(res.headers?.get("retry-after"), now()),
        );
        this.log.push({
          url,
          kind,
          status: res.status,
          waitMs,
          ms: now() - started,
          bytes: 0,
          truncated: false,
        });
        return { status: res.status, stop: true };
      }
      let body = "";
      let truncated = false;
      if (res.status === 200 && stopWhen && res.body) {
        // Akisla oku; kural saglaninca kes (liste: Nuxt durumundan once, detay: JSON-LD sonrasi).
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
          if (stopWhen(body)) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
        if (!truncated) body += decoder.decode();
      } else if (res.status === 200) {
        body = await res.text();
      }
      this.log.push({
        url,
        kind,
        status: res.status,
        waitMs,
        ms: now() - started,
        bytes: body.length,
        truncated,
      });
      if (res.status < 500) await this.opts.gate?.succeed(PAZARAMA_HOST);
      return {
        status: res.status,
        body,
        location: res.headers?.get("location") ?? null,
        fetchedAt: now(),
      };
    } catch {
      this.log.push({
        url,
        kind,
        status: 0,
        waitMs,
        ms: now() - started,
        bytes: 0,
        truncated: false,
      });
      return { status: 0, body: "", location: null, fetchedAt: now() };
    }
  }
}

export interface BarcodeHit {
  gtin: string;
  url: string;
  page: PazaramaProductPage;
}

/** Barkod listesi -> Pazarama urun sayfalari. 404 ve urun dugumu olmayanlar atlanir. */
export async function lookupByBarcodes(
  client: PazaramaClient,
  gtins: readonly string[],
): Promise<BarcodeHit[]> {
  const hits: BarcodeHit[] = [];
  for (const gtin of new Set(gtins)) {
    const url = barcodeProductUrl(gtin);
    if (!url) continue;
    const res = await client.get(url, { kind: "barcode", stopWhen: DETAIL_STOP });
    if ("stop" in res) break;
    if (res.status !== 200) continue;
    const page = parseProductPage(res.body);
    // Kanonik adres (yonlendirme sonrasi) gosterilir: `/-p-<barkod>` -> `/<ad>-p-<barkod>`.
    if (page) hits.push({ gtin, url: res.finalUrl, page });
  }
  return hits;
}

/** SEO sayfalari (ve izinli `?sayfa=`) -> sorguyla katı eslesen kartlar. */
export async function searchSeoPages(
  client: PazaramaClient,
  query: string,
  paths: readonly string[],
  opts: { pagesPerPath?: number } = {},
): Promise<PazaramaCard[]> {
  const out = new Map<string, PazaramaCard>();
  for (const path of paths) {
    for (let page = 1; page <= (opts.pagesPerPath ?? 1); page++) {
      const url = `${PAZARAMA_ORIGIN}${path}${page > 1 ? `?sayfa=${page}` : ""}`;
      const res = await client.get(url, { kind: "list", stopWhen: LISTING_STOP });
      if ("stop" in res) return [...out.values()];
      if (res.status !== 200) break;
      for (const card of parseListingCards(res.body)) {
        if (card.priceKurus !== null && matchesQuery(card.title, query))
          out.set(card.productUrl, card);
      }
    }
  }
  return [...out.values()];
}

export interface VerifiedCard {
  card: PazaramaCard;
  page: PazaramaProductPage;
}

/**
 * Liste karti fiyati TEK BASINA gosterilmez: canli kontrolde (2026-10-12) 3 kartin 2'si
 * urun sayfasinda stoksuzdu (kart eski fiyat gosteriyordu). Her kart urun sayfasindan
 * dogrulanir; yalnizca stokta ve fiyatli olanlar, URUN SAYFASI fiyatiyla doner.
 */
export async function verifyCards(
  client: PazaramaClient,
  cards: readonly PazaramaCard[],
  opts: { max?: number } = {},
): Promise<VerifiedCard[]> {
  const out: VerifiedCard[] = [];
  for (const card of cards.slice(0, opts.max ?? 3)) {
    const res = await client.get(card.productUrl, { kind: "detail", stopWhen: DETAIL_STOP });
    if ("stop" in res) break;
    if (res.status !== 200) continue;
    const page = parseProductPage(res.body);
    if (page?.availability === "in_stock" && page.priceKurus !== null) out.push({ card, page });
  }
  return out;
}

/**
 * Prototip betiklerinin durust kimligi. Iletisim bilgisi depoya YAZILMAZ: `MANICEPTE_BOT_CONTACT`
 * (ornegin "mailto:..." ya da bir bilgi sayfasi) ortam degiskeninden okunur.
 */
export function prototypeUserAgent(): string {
  const contact = process.env.MANICEPTE_BOT_CONTACT?.trim() || "https://manicepte.com";
  return `ManiCepteBot-prototype/0.1 (+${contact})`;
}
