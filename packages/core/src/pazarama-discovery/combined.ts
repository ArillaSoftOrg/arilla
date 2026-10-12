/**
 * Pazarama birlesik kesif: (A) barkod + (B) SEO kategori sayfasi, ayni aramada ve ESZAMANLI
 * (ayni istemcinin slot hiz siniri altinda). Girdi tarayicidaki canli aramadan gelir (HB/CS
 * eslesen basliklar, HB GTIN'leri, CS kategori adlari, HB faseti); bu modul yalnizca
 * Pazarama'ya istek atar (sunucu tarafi).
 *
 * Gosterilen her urun Pazarama URUN SAYFASINDAN dogrulanir: ad sorguyla kati eslesmeli
 * (yanlis varyant/kapasite/aksesuar elenir), `InStock` olmali, fiyat urun sayfasindan
 * alinir (liste karti fiyati gosterilmez). Urunler saklanmaz.
 *
 * Faz 3: (1) izinli `?sayfa=` ile siralı (round-robin) sayfalama: tum aday sayfalarin 1.
 * sayfasi HER ZAMAN okunur (ilk basari diger sayfalari elemez); daha derin sayfalara ancak
 * hedef sayida dogrulanmis sonuc yoksa inilir. (2) asama sureleri ayri olculur.
 */

import { matchesQuery } from "../live-search-browser/match.ts";
import type { PazaramaClient } from "./discover.ts";
import type { GateDenyReason } from "./host-gate.ts";
import {
  barcodeProductUrl,
  DETAIL_STOP,
  LISTING_PAGE_SIZE,
  LISTING_STOP,
  PAZARAMA_ORIGIN,
  type PazaramaCard,
  parseListingCards,
  parseListingTotal,
  parseProductPage,
} from "./parse.ts";
import { buildEvidence, type PreparedSeoIndex, rankSeoPages } from "./seo-index.ts";

export interface PazaramaDiscoveryInput {
  query: string;
  /** Baska kaynaktan (HB urun sayfasi) gelen barkodlar. */
  gtins: readonly string[];
  /** HB/CS'de kati eslesen urun basliklari (kategori ve marka kaniti). */
  matchedTitles: readonly string[];
  /** CS `categoryTree` adlari (kategori kaniti). */
  categoryNames: readonly string[];
  /** HB ust duzey kategori faseti (zayif kanit; yalnizca CS kategorisi yoksa). */
  facetNames?: readonly string[];
}

export interface PazaramaResult {
  title: string;
  priceKurus: number;
  currency: "TRY";
  imageUrl: string | null;
  seller: string | null;
  availability: "in_stock";
  productUrl: string;
  /** Urunu bulan yol(lar). */
  via: ("barcode" | "seo")[];
  /** URL'deki `-p-` kimligi (cogu urunde barkod). */
  productId: string;
  /** Kimlik sayisal ise barkod (EAN/UPC); her barkod ayri sonuc (bedenler birlestirilmez). */
  barcode: string | null;
  /**
   * Faz 5: normal ve sepette fiyati AYRI. `priceKurus` urun sayfasi JSON-LD fiyatidir
   * (Pazarama'nin gosterdigi odenecek tutar). JSON-LD fiyati "Sepette" blogundaki fiyata
   * esitse `priceKind: "basket"`: `basketPriceKurus` = o fiyat, `regularPriceKurus` = ustu
   * cizili normal fiyat. Degilse `priceKind: "regular"`, `basketPriceKurus` null.
   */
  priceKind: "regular" | "basket";
  regularPriceKurus: number | null;
  basketPriceKurus: number | null;
  /**
   * Sepet kampanyasinin kosullari (en az sepet tutari, kupon, satici kampanyasi, sure)
   * DOGRULANMADI; her zaman false. Arayuz "Sepette fiyati; kosullar magazada" demeli.
   */
  basketConditionsVerified: false;
  color: string | null;
  /**
   * Faz 6: fiyat/stokun dogrulandigi urun sayfasinin siteden alindigi an (epoch ms). Ortak
   * onbellekten geldiyse arama anindan en cok TTL (60 sn) eskidir; arayuz bunu gosterebilir.
   */
  checkedAtMs: number;
}

export interface PazaramaReport {
  query: string;
  results: PazaramaResult[];
  seoPages: { path: string; score: number }[];
  barcode: { tried: number; pages: number; rejected: { gtin: string; reason: string }[] };
  seo: {
    listPagesRead: number;
    cards: number;
    matchedCards: number;
    verified: number;
    rejected: { productId: string; reason: string }[];
    /** Liste sayfasinin kendi urun sayisi sayesinde istenmeyen (son sayfadan sonraki) sayfa sayisi. */
    pagesSkippedByTotal: number;
    /** Hangi aday yolun hangi sayfasinda kac kati eslesen kart vardi (sayfalama analizi). */
    pageHits: { path: string; page: number; cards: number; matched: number }[];
  };
  /** Faz 4 istek analizi (istemci logundan). */
  http: {
    byKind: Record<string, { requests: number; bytes: number; networkMs: number }>;
    /** Hiz siniri slotu icin toplam bekleme. */
    waitMs: number;
    /** Toplam ag suresi (istekler ust uste binebildiginden duvar saatinden buyuk olabilir). */
    networkMs: number;
    truncated: number;
  };
  /** Asama sureleri (ms). A ve B eszamanli oldugundan toplam, parcalarin toplami degildir. */
  timings: {
    rankMs: number;
    barcodePathMs: number;
    seoPathMs: number;
    listFetchMs: number;
    detailFetchMs: number;
    mergeMs: number;
    totalMs: number;
    /** Ilk dogrulanmis urunun bulundugu an (aramanin basindan); hic yoksa null. */
    firstResultMs: number | null;
  };
  requests: number;
  cacheHits: number;
  /** Faz 6: ortak onbellekten (ag istegi olmadan) gelen sayfa; `coalesced` = esanli istekle paylasilan. */
  sharedHits: number;
  coalesced: number;
  /** Faz 6: arama kabul kapisi doluydu; siteye istek atilmadi (yalnizca onbellekteki sonuclar). */
  admissionDenied: boolean;
  bytes: number;
  blockedBy: number | null;
  /** Ortak kapinin reddi: istek ATILMADI (devre acik, kuyruk dolu, bekleme uzun, Redis yok). */
  deniedBy: GateDenyReason | null;
  stoppedEarly: boolean;
  ms: number;
}

/** Sayisal kimliklerde bastaki sifirlar atilir: HB GTIN "0195949771569" = Pazarama "195949771569". */
export function normalizeProductId(id: string): string {
  return /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

function productIdOf(url: string): string {
  return normalizeProductId(/-p-([A-Za-z0-9]+)(?:$|[?#])/.exec(url)?.[1] ?? url);
}

export interface DiscoverOptions {
  maxBarcodes?: number;
  /** Toplam dogrulanacak urun sayfasi ust siniri (barkod haric). */
  maxVerify?: number;
  /** Aday sayfa basina en derin `?sayfa=`. */
  maxPagesPerPath?: number;
  /** Bu kadar dogrulanmis sonuca ulasinca DERIN sayfalara inilmez (1. sayfalar yine okunur). */
  targetResults?: number;
  /** Aday SEO sayfasi sayisi (Faz 2: 2, Faz 3: 3). */
  seoPageLimit?: number;
  /** false: once barkod, sonra SEO (Faz 2 davranisi; kiyaslama icin). */
  parallel?: boolean;
  /**
   * Faz 4: SEO yolu hedefe ulastiysa kalan barkodlar istenmez; SEO yolunun zaten dogruladigi
   * urunun barkodu tekrar istenmez (erken birlestirme). Varsayilan true.
   */
  barcodeStopAtTarget?: boolean;
  /**
   * Faz 4: barkod yolunda art arda bu kadar iska (404/stoksuz/yanlis varyant) sonrasi kalan
   * barkodlar istenmez. Canli: ayakkabi beden barkodlari ust uste stoksuz (Samba 4/4).
   * undefined = sinirsiz (Faz 3 davranisi).
   */
  barcodeMaxConsecutiveMisses?: number;
  /**
   * Faz 5: her dogrulanmis urun bulundugu AN bildirilir (arayuz ilk urunu tum aramayi
   * beklemeden gosterebilir). Ayni urun ikinci yoldan da bulunursa tekrar cagrilmaz.
   */
  onResult?: (result: PazaramaResult, elapsedMs: number) => void;
  /**
   * Faz 4: liste sayfasinin kendi "N ürün" sayisindan son sayfa hesaplanir; ceil(N/30)'dan
   * sonrasi istenmez (fazla kartlar oneri blogudur). false = Faz 3 davranisi.
   */
  useListingTotal?: boolean;
  now?: () => number;
}

export async function discoverPazarama(
  client: PazaramaClient,
  input: PazaramaDiscoveryInput,
  index: PreparedSeoIndex | readonly string[],
  opts: DiscoverOptions = {},
): Promise<PazaramaReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const results = new Map<string, PazaramaResult>();
  const report: PazaramaReport = {
    query: input.query,
    results: [],
    seoPages: [],
    barcode: { tried: 0, pages: 0, rejected: [] },
    seo: {
      listPagesRead: 0,
      cards: 0,
      matchedCards: 0,
      verified: 0,
      rejected: [],
      pageHits: [],
      pagesSkippedByTotal: 0,
    },
    http: { byKind: {}, waitMs: 0, networkMs: 0, truncated: 0 },
    timings: {
      rankMs: 0,
      barcodePathMs: 0,
      seoPathMs: 0,
      listFetchMs: 0,
      detailFetchMs: 0,
      mergeMs: 0,
      totalMs: 0,
      firstResultMs: null,
    },
    requests: 0,
    cacheHits: 0,
    sharedHits: 0,
    coalesced: 0,
    admissionDenied: false,
    bytes: 0,
    blockedBy: null,
    deniedBy: null,
    stoppedEarly: false,
    ms: 0,
  };
  const target = opts.targetResults ?? 4;
  const addResult = (id: string, r: PazaramaResult) => {
    results.set(id, r);
    const elapsed = now() - started;
    if (report.timings.firstResultMs === null) report.timings.firstResultMs = elapsed;
    try {
      opts.onResult?.(r, elapsed);
    } catch {
      /* cagiranin hatasi aramayi bozmaz */
    }
  };

  // Kategori esleme (yerel, ag yok).
  const tRank = now();
  const ev = buildEvidence(
    input.query,
    input.matchedTitles,
    input.categoryNames,
    input.facetNames ?? [],
  );
  report.seoPages = rankSeoPages(input.query, index, ev, { limit: opts.seoPageLimit ?? 3 });
  report.timings.rankMs = now() - tRank;

  const timed = async <T>(key: "listFetchMs" | "detailFetchMs", fn: () => Promise<T>) => {
    const t = now();
    try {
      return await fn();
    } finally {
      report.timings[key] += now() - t;
    }
  };

  // A) Barkod yolu.
  const barcodePath = async () => {
    const t = now();
    try {
      const gtins = [...new Set(input.gtins)].slice(0, opts.maxBarcodes ?? 4);
      report.barcode.tried = gtins.length;
      let misses = 0;
      for (const gtin of gtins) {
        if (
          opts.barcodeMaxConsecutiveMisses !== undefined &&
          misses >= opts.barcodeMaxConsecutiveMisses
        ) {
          report.barcode.rejected.push({ gtin, reason: "skipped-after-misses" });
          continue;
        }
        const url = barcodeProductUrl(gtin);
        if (!url) continue;
        if (opts.barcodeStopAtTarget !== false) {
          if (results.has(normalizeProductId(gtin))) continue; // SEO zaten dogruladi
          if (results.size >= target) break; // hedef doldu; kalan barkodlar gereksiz
        }
        const res = await timed("detailFetchMs", () =>
          client.get(url, { kind: "barcode", stopWhen: DETAIL_STOP }),
        );
        if ("stop" in res) break;
        const p = res.status === 200 ? parseProductPage(res.body) : null;
        if (!p) {
          misses += 1;
          continue;
        }
        report.barcode.pages += 1;
        // Once stok: stoksuz sayfalarda JSON-LD adi cogu zaman bos (canli: Samba barkodlari).
        if (p.availability !== "in_stock" || p.priceKurus === null) {
          misses += 1;
          report.barcode.rejected.push({ gtin, reason: p.availability });
        } else if (!p.title || !matchesQuery(p.title, input.query)) {
          misses += 1;
          report.barcode.rejected.push({ gtin, reason: `title-mismatch: ${p.title ?? "-"}` });
        } else {
          misses = 0;
          const id = productIdOf(res.finalUrl);
          const known = results.get(id);
          if (known) {
            if (!known.via.includes("barcode")) known.via.push("barcode");
          } else {
            addResult(id, {
              title: p.title,
              priceKurus: p.priceKurus,
              currency: "TRY",
              imageUrl: p.imageUrl,
              seller: p.seller,
              availability: "in_stock",
              productUrl: res.finalUrl,
              via: ["barcode"],
              productId: id,
              barcode: /^\d{8,14}$/.test(id) ? id : null,
              priceKind: p.priceKind,
              regularPriceKurus: p.regularPriceKurus,
              basketPriceKurus: p.basketPriceKurus,
              basketConditionsVerified: false,
              color: p.color,
              checkedAtMs: res.fetchedAt,
            });
          }
        }
      }
    } catch {
      report.barcode.rejected.push({ gtin: "*", reason: "error" });
    } finally {
      report.timings.barcodePathMs = now() - t;
    }
  };

  // B) SEO yolu: siralı sayfalama + kart basina urun sayfasi dogrulamasi.
  const seoPath = async () => {
    const t = now();
    try {
      const seenCards = new Set<string>();
      let verifyBudget = opts.maxVerify ?? 6;
      const maxPages = opts.maxPagesPerPath ?? 3;
      const active = report.seoPages.map((p) => p.path);
      /** Yol basina son sayfa (liste sayfasinin kendi urun sayisindan). */
      const lastPage = new Map<string, number>();
      for (let page = 1; page <= maxPages && active.length > 0; page++) {
        // Derin sayfalara yalnizca hedef dolmadiysa inilir; 1. sayfalar hep okunur.
        if (page > 1 && results.size >= target) {
          report.stoppedEarly = true;
          break;
        }
        for (const path of [...active]) {
          if (client.blockedBy !== null) return;
          const last = lastPage.get(path);
          if (last !== undefined && page > last) {
            active.splice(active.indexOf(path), 1);
            report.seo.pagesSkippedByTotal += 1;
            continue;
          }
          const sep = path.includes("?") ? "&" : "?";
          const url = `${PAZARAMA_ORIGIN}${path}${page > 1 ? `${sep}sayfa=${page}` : ""}`;
          const res = await timed("listFetchMs", () =>
            client.get(url, { kind: "list", stopWhen: LISTING_STOP }),
          );
          if ("stop" in res) return;
          report.seo.listPagesRead += 1;
          const cards = res.status === 200 ? parseListingCards(res.body) : [];
          if (page === 1 && opts.useListingTotal !== false) {
            const total = res.status === 200 ? parseListingTotal(res.body) : null;
            if (total !== null)
              lastPage.set(path, Math.max(1, Math.ceil(total / LISTING_PAGE_SIZE)));
          }
          // Bos/son sayfa: bu yol icin daha derine inme.
          if (cards.length === 0) active.splice(active.indexOf(path), 1);
          report.seo.cards += cards.length;
          const fresh: PazaramaCard[] = [];
          let matchedHere = 0;
          for (const c of cards) {
            const cid = normalizeProductId(c.productId);
            if (seenCards.has(cid)) continue;
            seenCards.add(cid);
            if (c.priceKurus === null || !matchesQuery(c.title, input.query)) continue;
            report.seo.matchedCards += 1;
            matchedHere += 1;
            const known = results.get(cid);
            if (known) {
              if (!known.via.includes("seo")) known.via.push("seo");
              continue;
            }
            fresh.push(c);
          }
          report.seo.pageHits.push({ path, page, cards: cards.length, matched: matchedHere });
          for (const card of fresh) {
            if (verifyBudget <= 0) break;
            verifyBudget -= 1;
            const d = await timed("detailFetchMs", () =>
              client.get(card.productUrl, { kind: "detail", stopWhen: DETAIL_STOP }),
            );
            if ("stop" in d) return;
            const page2 = d.status === 200 ? parseProductPage(d.body) : null;
            const title = page2?.title ?? null;
            if (page2?.availability !== "in_stock" || page2.priceKurus === null) {
              report.seo.rejected.push({
                productId: card.productId,
                reason: page2 ? page2.availability : `http-${d.status}`,
              });
            } else if (!title || !matchesQuery(title, input.query)) {
              report.seo.rejected.push({
                productId: card.productId,
                reason: `title-mismatch: ${title}`,
              });
            } else {
              report.seo.verified += 1;
              const id = productIdOf(d.finalUrl);
              const known = results.get(id) ?? results.get(normalizeProductId(card.productId));
              if (known) {
                if (!known.via.includes("seo")) known.via.push("seo");
              } else {
                addResult(id, {
                  title,
                  priceKurus: page2.priceKurus,
                  currency: "TRY",
                  imageUrl: page2.imageUrl ?? card.imageUrl,
                  seller: page2.seller,
                  availability: "in_stock",
                  productUrl: d.finalUrl,
                  via: ["seo"],
                  productId: id,
                  barcode: /^\d{8,14}$/.test(id) ? id : null,
                  priceKind: page2.priceKind,
                  regularPriceKurus: page2.regularPriceKurus,
                  basketPriceKurus: page2.basketPriceKurus,
                  basketConditionsVerified: false,
                  color: page2.color,
                  checkedAtMs: d.fetchedAt,
                });
              }
            }
          }
        }
      }
    } catch {
      report.seo.rejected.push({ productId: "*", reason: "error" });
    } finally {
      report.timings.seoPathMs = now() - t;
    }
  };

  // Iki yol eszamanli; biri hata verirse/yavaslarsa digeri etkilenmez (hiz siniri ortak).
  try {
    if (opts.parallel === false) {
      await barcodePath();
      await seoPath();
    } else {
      await Promise.all([barcodePath(), seoPath()]);
    }
  } finally {
    client.finish();
  }

  const tMerge = now();
  report.results = [...results.values()].sort((a, b) => a.priceKurus - b.priceKurus);
  report.timings.mergeMs = now() - tMerge;
  report.requests = client.requests;
  report.cacheHits = client.cacheHits;
  report.sharedHits = client.sharedHits;
  report.coalesced = client.coalesced;
  report.admissionDenied = client.admissionDenied;
  report.bytes = client.log.reduce((s, r) => s + r.bytes, 0);
  for (const r of client.log) {
    const k = report.http.byKind[r.kind] ?? { requests: 0, bytes: 0, networkMs: 0 };
    report.http.byKind[r.kind] = k;
    k.requests += 1;
    k.bytes += r.bytes;
    k.networkMs += r.ms;
    report.http.waitMs += r.waitMs;
    report.http.networkMs += r.ms;
    if (r.truncated) report.http.truncated += 1;
  }
  report.blockedBy = client.blockedBy;
  report.deniedBy = client.deniedBy;
  report.ms = now() - started;
  report.timings.totalMs = report.ms;
  return report;
}
