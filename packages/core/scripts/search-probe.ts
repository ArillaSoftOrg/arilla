/**
 * Salt okunur arama ve bulunabilirlik olcumu (uretimde guvenli, dusuk yuk).
 *
 * /ara ile AYNI yol (`peekQuery` + `searchWithFallback`, 5 sn sorgu siniri) ve sohbetin
 * katalog yolu (`searchByIntent`, 4 sn) gercek kodla calisir. Model cagrisi YOKTUR: sohbet
 * olcumu yorumlanmis niyetin katalog aramasidir, Gemini yorumu degil.
 *
 * Guvenlik:
 * - Oturum `default_transaction_read_only=on` (+ 15 sn statement_timeout) ile acilir ve
 *   dogrulanir; herhangi bir yazim
 *   veritabani tarafindan reddedilir. `query_resolution` onbellegi okunur, yazilmaz.
 * - Tek baglanti, sorgular ardisik, aralarinda `PROBE_DELAY_MS` (varsayilan 1000) bekleme.
 * - `/git/<teklif>` cagrilmaz (click satiri yazar); cikis baglantisi `buildDeeplink` ile
 *   sahte bir click kimligiyle hesaplanip DOGRULANIR, hicbir yere istek atilmaz.
 * - Katalog eksiklikleri TABLESAMPLE ile tahmin edilir (`PROBE_SAMPLE_PCT`, varsayilan 1).
 *
 * Calistirma: docs/ops.md "Arama ve bulunabilirlik olcumu". Yerel:
 *   DATABASE_URL=... node --experimental-transform-types --no-warnings scripts/search-probe.ts
 * Ortam: PROBE_QUERIES ("|" ile ayrilmis), PROBE_ROUNDS (2), PROBE_DELAY_MS, PROBE_MERCHANT
 * (aliexpress), PROBE_SAMPLE_PCT, PROBE_RECALL_N (20; 0 = kapali), PROBE_JSON=1 (sonda JSON).
 *
 * Bulunabilirlik (recall): magazanin yayindaki urunlerinden orneklenen N tanesi kendi
 * basliginin ilk kelimeleriyle /ara yolunda aranir; ilk 24 kartta cikmayanlar raporlanir.
 */
import { pathToFileURL } from "node:url";
import { createDatabase, type Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { buildDeeplink } from "../src/attribution/build-deeplink.ts";
import { emptyIntent } from "../src/chat/intent.ts";
import { searchByIntent } from "../src/chat/search-adapter.ts";
import { resolveProductSlug } from "../src/product/resolve-product-slug.ts";
import { createSeedAliasSource } from "../src/search/fallback/aliases.ts";
import { searchWithFallback } from "../src/search/fallback/pipeline.ts";
import {
  createPostgresSearchProvider,
  TEXT_SEARCH_TIMEOUT_MS,
} from "../src/search/fallback/postgres-provider.ts";
import { peekQuery } from "../src/search/query-resolution.ts";
import type { SearchResultItem } from "../src/search/result-types.ts";

const DEFAULT_QUERIES = [
  "kulaklık",
  "bluetooth kulaklık",
  "telefon kılıfı",
  "iphone 15 kılıf",
  "akıllı saat",
  "powerbank",
  "type c kablo",
  "ekran koruyucu",
  "led şerit",
  "kablosuz mouse",
  "mekanik klavye",
  "laptop çantası",
  "sırt çantası",
  "kadın çanta",
  "cüzdan",
  "güneş gözlüğü",
  "spor ayakkabı",
  "kamp lambası",
  "matkap ucu seti",
  "mutfak tartısı",
  "silikon kalıp",
  "makyaj fırçası",
  "saç maşası",
  "uzaktan kumandalı araba",
  "drone",
  "tripod",
  "aksiyon kamerası",
  "araç telefon tutucu",
  "phone case",
  "smart watch",
  "wireless earbuds",
  "qzxwvkj", // kontrol: sonuc beklenmez
];

const PAGE_SIZE = 24; // /ara ile ayni
const LINK_CHECKS_PER_QUERY = 3;

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number): number => {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const QUERIES = process.env.PROBE_QUERIES
  ? process.env.PROBE_QUERIES.split("|")
      .map((q) => q.trim())
      .filter(Boolean)
  : DEFAULT_QUERIES;
const ROUNDS = Math.max(1, Math.floor(num("PROBE_ROUNDS", 2)));
const DELAY_MS = num("PROBE_DELAY_MS", 1000);
const MERCHANT = env("PROBE_MERCHANT", "aliexpress");
const SAMPLE_PCT = Math.min(10, Math.max(0.01, num("PROBE_SAMPLE_PCT", 1)));
const RECALL_N = Math.min(100, Math.floor(num("PROBE_RECALL_N", 20)));
const RECALL_WORDS = 5;
const PROBE_CLICK_ID = "probe-0000-0000";

/** Baglanti dizesine salt okunur oturum secenegi ekler (her baglanti, her islem). */
export function readOnlyUrl(url: string): string {
  const u = new URL(url);
  // Salt okunur + oturum ust siniri (katalog ozeti); aramanin kendi SET LOCAL siniri (5/4 sn) gecerli.
  const extra = "-c default_transaction_read_only=on -c statement_timeout=15000";
  const current = u.searchParams.get("options");
  u.searchParams.delete("options");
  // pg `+`'yi bosluga cevirmez (URLSearchParams oyle kodlar): %20 ile elle eklenir.
  const value = encodeURIComponent(current ? `${current} ${extra}` : extra);
  return `${u.toString()}${u.search ? "&" : "?"}options=${value}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - start), value };
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string }; message?: string };
    const code = e.cause?.code ?? e.code;
    return {
      ms: Math.round(performance.now() - start),
      error: code === "57014" ? "timeout" : (code ?? e.message ?? "error"),
    };
  }
}

interface CardStats {
  items: number;
  fromMerchant: number;
  withPrice: number;
  /** Fiyat yurt disi teklifin kurla TL'ye cevrilmis hali (karar 0129). */
  foreignConverted: number;
  /** TL fiyati yok, yalniz orijinal para birimi (kur yok, karar 0132). */
  foreignPriceOnly: number;
  noPrice: number;
  withBrand: number;
  withCategory: number;
  withImage: number;
}

export function cardStats(
  items: readonly SearchResultItem[],
  merchantName: string | null,
): CardStats {
  const s: CardStats = {
    items: items.length,
    fromMerchant: 0,
    withPrice: 0,
    foreignConverted: 0,
    foreignPriceOnly: 0,
    noPrice: 0,
    withBrand: 0,
    withCategory: 0,
    withImage: 0,
  };
  for (const item of items) {
    if (merchantName && item.merchantName === merchantName) s.fromMerchant++;
    if (item.minPrice !== null) {
      s.withPrice++;
      if (item.foreignPrice) s.foreignConverted++;
    } else if (item.foreignPrice) s.foreignPriceOnly++;
    else s.noPrice++;
    if (item.brandName) s.withBrand++;
    if (item.categoryPath) s.withCategory++;
    if (item.primaryImageUrl) s.withImage++;
  }
  return s;
}

interface LinkCheck {
  slug: string;
  productPage: "found" | "redirect" | "not_found" | "error";
  offerId: string | null;
  merchant: string | null;
  outbound: "affiliate" | "plain" | "invalid" | "no_offer";
  host: string | null;
  detail?: string;
}

/**
 * `buildDeeplink` sonucunun dogrulamasi (saf; /git cagrilmaz). Affiliate adres https olmali,
 * click kimligini ve hedefi (kodlanmis `offer.url` ya da `affiliate_url` tabani) icermeli.
 * Probe'un magazasi icin duz adres (`plain`) affiliate'in kapali oldugu anlamina gelir.
 */
export function classifyOutbound(
  target: string,
  offer: { url: string; affiliateUrl: string | null },
  clickId: string,
): Pick<LinkCheck, "outbound" | "host" | "detail"> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return { outbound: "invalid", host: null, detail: "gecersiz URL" };
  }
  if (u.protocol !== "https:") return { outbound: "invalid", host: u.host, detail: "https degil" };
  if (target === offer.url) return { outbound: "plain", host: u.host };
  if (!target.includes(encodeURIComponent(clickId)) && !target.includes(clickId)) {
    return { outbound: "invalid", host: u.host, detail: "click_id sablona yerlesmedi" };
  }
  const embedsTarget =
    target.includes(encodeURIComponent(offer.url)) ||
    (offer.affiliateUrl !== null && target.startsWith(offer.affiliateUrl));
  if (!embedsTarget) {
    return { outbound: "invalid", host: u.host, detail: "hedef urun adresi baglantida yok" };
  }
  return { outbound: "affiliate", host: u.host };
}

/** Kartin /urun/<slug> hedefi ve urun sayfasindaki /git/<teklif> cikisinin gidecegi adres. */
async function checkLinks(db: Database, item: SearchResultItem): Promise<LinkCheck> {
  const check: LinkCheck = {
    slug: item.slug,
    productPage: "error",
    offerId: null,
    merchant: null,
    outbound: "no_offer",
    host: null,
  };
  try {
    const resolved = await resolveProductSlug(db, item.slug);
    check.productPage = resolved.status as LinkCheck["productPage"];
  } catch (error) {
    check.detail = (error as Error).message.slice(0, 120);
  }
  const rows = await db.execute<{
    id: string;
    url: string;
    affiliate_url: string | null;
    affiliate_status: "none" | "pending" | "active" | "suspended";
    deeplink_template: string | null;
    merchant: string;
  }>(sql`
    SELECT o.id::text, o.url, o.affiliate_url, m.affiliate_status, m.deeplink_template,
           m.slug AS merchant
      FROM offer o JOIN merchant m ON m.id = o.merchant_id
     WHERE o.product_id = ${item.productId} AND o.is_active AND m.is_active
     ORDER BY (o.currency <> 'TRY'), o.current_price NULLS LAST, o.id
     LIMIT 1`);
  const offer = rows.rows[0];
  if (!offer) return check;
  check.offerId = offer.id;
  check.merchant = offer.merchant;
  try {
    const target = buildDeeplink({
      affiliateStatus: offer.affiliate_status,
      deeplinkTemplate: offer.deeplink_template,
      offerUrl: offer.url,
      affiliateUrl: offer.affiliate_url,
      clickId: PROBE_CLICK_ID,
    });
    Object.assign(
      check,
      classifyOutbound(
        target,
        { url: offer.url, affiliateUrl: offer.affiliate_url },
        PROBE_CLICK_ID,
      ),
    );
  } catch (error) {
    check.outbound = "invalid";
    check.detail = (error as Error).message.slice(0, 120);
  }
  return check;
}

interface QueryResult {
  query: string;
  round: number;
  ara: {
    ms: number;
    error?: string;
    mode?: string;
    stage?: string;
    total?: number;
    totalCapped?: boolean;
    cards?: CardStats;
  };
  sohbet: { ms: number; error?: string; items?: number; droppedForPrice?: number };
  links?: LinkCheck[];
}

async function catalogGaps(db: Database, merchantId: number) {
  const states = await db.execute<{ state: string; n: string }>(sql`
    SELECT publication_state AS state, count(*)::text AS n FROM product
     WHERE source_merchant_id = ${merchantId} GROUP BY 1 ORDER BY 1`);
  const sample = await db.execute<Record<string, string>>(
    sql.raw(`
    SELECT count(*)::text AS sampled,
           count(*) FILTER (WHERE p.brand_id IS NULL)::text AS no_brand,
           count(*) FILTER (WHERE p.category_id IS NULL)::text AS no_category,
           count(*) FILTER (WHERE p.primary_image_url IS NULL OR btrim(p.primary_image_url) = '')::text AS no_image,
           count(*) FILTER (WHERE p.min_price IS NULL)::text AS no_try_price,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM offer o WHERE o.product_id = p.id AND o.is_active AND o.current_price > 0))::text AS no_active_priced_offer,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM offer o WHERE o.product_id = p.id AND o.is_active AND o.currency <> 'TRY'))::text AS foreign_offer
      FROM product p TABLESAMPLE SYSTEM (${SAMPLE_PCT})
     WHERE p.source_merchant_id = ${merchantId} AND p.publication_state = 'published'`),
  );
  const fx = await db.execute<{ quote_date: string | null; age_days: string | null }>(sql`
    SELECT max(effective_date)::text AS quote_date, (current_date - max(effective_date))::text AS age_days
      FROM fx_rate WHERE base = 'USD' AND quote = 'TRY' AND rate_kind = 'forex_selling'`);
  return { states: states.rows, sample: sample.rows[0] ?? null, fx: fx.rows[0] ?? null };
}

/** Magazanin affiliate yapilandirmasi; sablonun yalniz host'u yazilir (kimlikler degil). */
async function merchantAffiliate(db: Database, merchantId: number) {
  const rows = await db.execute<{
    affiliate_status: string;
    deeplink_template: string | null;
    is_active: boolean;
  }>(
    sql`SELECT affiliate_status, deeplink_template, is_active FROM merchant WHERE id = ${merchantId}`,
  );
  const m = rows.rows[0];
  if (!m) return null;
  return {
    affiliateStatus: m.affiliate_status,
    hasTemplate: m.deeplink_template !== null,
    templateHost: m.deeplink_template ? templateHost(m.deeplink_template) : null,
    isActive: m.is_active,
  };
}

/** Sablonun host'u; yer tutucular (`{url}`) bosaltilir. Sorgu parametreleri yazilmaz. */
export function templateHost(template: string): string {
  try {
    return new URL(template.replaceAll(/\{[a-z_]+\}/g, "")).host || "(sablon basta yer tutucu)";
  } catch {
    return "(sablon basta yer tutucu)";
  }
}

/** Baslik -> kullanicinin yazacagi kisa sorgu (ilk kelimeler, harf/rakam). */
export function titleQuery(title: string, words = RECALL_WORDS): string {
  return (title.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, words).join(" ");
}

interface RecallMiss {
  slug: string;
  query: string;
  mode: string | null;
  total: number | null;
  error?: string;
}

async function recallCheck(db: Database, merchantId: number) {
  let rows = (
    await db.execute<{ id: string; slug: string; title: string }>(
      sql.raw(`
      SELECT id::text, slug, title FROM product TABLESAMPLE SYSTEM (0.05)
       WHERE source_merchant_id = ${merchantId} AND publication_state = 'published'
       LIMIT ${RECALL_N}`),
    )
  ).rows;
  if (rows.length === 0) {
    // Kucuk katalogda TABLESAMPLE bos donebilir: en yeni N urun (birincil anahtar).
    rows = (
      await db.execute<{ id: string; slug: string; title: string }>(sql`
        SELECT id::text, slug, title FROM product
         WHERE source_merchant_id = ${merchantId} AND publication_state = 'published'
         ORDER BY id DESC LIMIT ${RECALL_N}`)
    ).rows;
  }
  const positions: number[] = [];
  const misses: RecallMiss[] = [];
  for (const row of rows) {
    const query = titleQuery(row.title);
    if (!query) continue;
    const res = await timed(async () => {
      const { parsed } = await peekQuery(db, query);
      return searchWithFallback(
        createPostgresSearchProvider(db, { statementTimeoutMs: TEXT_SEARCH_TIMEOUT_MS }),
        { parsed: { ...parsed, sort: "balanced" }, sort: "balanced", page: 1, pageSize: PAGE_SIZE },
        { aliases: createSeedAliasSource() },
      );
    });
    const index = res.value?.items.findIndex((i) => i.productId === Number(row.id)) ?? -1;
    if (index >= 0) positions.push(index + 1);
    else
      misses.push({
        slug: row.slug,
        query,
        mode: res.value?.mode ?? null,
        total: res.value?.total ?? null,
        error: res.error,
      });
    await sleep(DELAY_MS);
  }
  const tried = positions.length + misses.length;
  return {
    tried,
    found: positions.length,
    recallPct: tried ? Math.round((100 * positions.length) / tried) : null,
    medianPosition: percentile(positions, 0.5),
    misses,
  };
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL tanimli degil");
    return 2;
  }
  // Web konteynerinin havuz ayari ezilir: olcum tek baglantiyla, ardisik calisir.
  process.env.DATABASE_APPLICATION_NAME = "arilla-search-probe";
  process.env.DATABASE_POOL_MAX = "1";
  const db = createDatabase(readOnlyUrl(url));

  const ro = await db.execute<{ ro: string }>(
    sql`SELECT current_setting('default_transaction_read_only') AS ro`,
  );
  if (ro.rows[0]?.ro !== "on") {
    console.error("oturum salt okunur DEGIL: olcum baslatilmaz");
    return 2;
  }
  const merchant = await db.execute<{ id: string; name: string }>(
    sql`SELECT id::text, name FROM merchant WHERE slug = ${MERCHANT}`,
  );
  const merchantId = merchant.rows[0] ? Number(merchant.rows[0].id) : null;
  const merchantName = merchant.rows[0]?.name ?? null;
  console.log(
    `salt okunur oturum OK | ${QUERIES.length} sorgu x ${ROUNDS} tur, ${DELAY_MS} ms ara | magaza ${MERCHANT} (${merchantName ?? "yok"})`,
  );

  const results: QueryResult[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (const query of QUERIES) {
      const ara = await timed(async () => {
        const { parsed } = await peekQuery(db, query);
        return searchWithFallback(
          createPostgresSearchProvider(db, { statementTimeoutMs: TEXT_SEARCH_TIMEOUT_MS }),
          {
            parsed: { ...parsed, sort: "balanced" },
            sort: "balanced",
            page: 1,
            pageSize: PAGE_SIZE,
          },
          { aliases: createSeedAliasSource() },
        );
      });
      await sleep(DELAY_MS);
      const chat = await timed(() => searchByIntent(db, emptyIntent(query)));
      const outcome = ara.value;
      const result: QueryResult = {
        query,
        round,
        ara: {
          ms: ara.ms,
          error: ara.error,
          mode: outcome?.mode,
          stage: outcome?.trace.stage,
          total: outcome?.total,
          totalCapped: outcome?.totalCapped,
          cards: outcome ? cardStats(outcome.items, merchantName) : undefined,
        },
        sohbet: {
          ms: chat.ms,
          error: chat.error,
          items: chat.value?.outcome.items.length,
          droppedForPrice: chat.value?.droppedForPrice,
        },
      };
      if (round === 1 && outcome && outcome.items.length > 0) {
        result.links = [];
        for (const item of outcome.items.slice(0, LINK_CHECKS_PER_QUERY)) {
          result.links.push(await checkLinks(db, item));
        }
      }
      results.push(result);
      const c = result.ara.cards;
      console.log(
        [
          `t${round}`,
          query.padEnd(26),
          `ara ${String(ara.ms).padStart(5)}ms ${ara.error ?? outcome?.mode ?? "-"}`,
          `kart ${c?.items ?? 0}${result.ara.totalCapped ? " (1000+)" : ""}`,
          c
            ? `fiyat TL ${c.withPrice} (kurla ${c.foreignConverted}) / yalniz USD ${c.foreignPriceOnly} / yok ${c.noPrice}`
            : "",
          c ? `marka ${c.withBrand} kat ${c.withCategory}` : "",
          `sohbet ${String(chat.ms).padStart(5)}ms ${chat.error ?? `${result.sohbet.items ?? 0} urun`}`,
        ].join(" | "),
      );
      await sleep(DELAY_MS);
    }
  }

  const warm = results.filter((r) => r.round === ROUNDS);
  const araMs = warm.filter((r) => !r.ara.error).map((r) => r.ara.ms);
  const chatMs = warm.filter((r) => !r.sohbet.error).map((r) => r.sohbet.ms);
  const links = results.flatMap((r) => r.links ?? []);
  const zero = warm
    .filter((r) => !r.ara.error && (r.ara.cards?.items ?? 0) === 0)
    .map((r) => r.query);
  const summary = {
    araMs: {
      p50: percentile(araMs, 0.5),
      p95: percentile(araMs, 0.95),
      max: Math.max(0, ...araMs),
    },
    sohbetMs: {
      p50: percentile(chatMs, 0.5),
      p95: percentile(chatMs, 0.95),
      max: Math.max(0, ...chatMs),
    },
    errors: warm
      .filter((r) => r.ara.error || r.sohbet.error)
      .map((r) => `${r.query}: ${r.ara.error ?? r.sohbet.error}`),
    zeroResultQueries: zero,
    links: {
      checked: links.length,
      productPageFound: links.filter((l) => l.productPage === "found").length,
      outbound: Object.fromEntries(
        ["affiliate", "plain", "invalid", "no_offer"].map((k) => [
          k,
          links.filter((l) => l.outbound === k).length,
        ]),
      ),
      hosts: [...new Set(links.map((l) => l.host).filter(Boolean))],
      problems: links.filter(
        (l) =>
          l.productPage !== "found" ||
          l.outbound === "invalid" ||
          l.outbound === "no_offer" ||
          (l.merchant === MERCHANT && l.outbound === "plain"),
      ),
    },
    slowest: [...results]
      .sort((a, b) => b.ara.ms - a.ara.ms)
      .slice(0, 5)
      .map((r) => ({ query: r.query, round: r.round, araMs: r.ara.ms, sohbetMs: r.sohbet.ms })),
    affiliate: merchantId === null ? null : await merchantAffiliate(db, merchantId),
    catalog: merchantId === null ? null : await catalogGaps(db, merchantId),
    recall: merchantId === null || RECALL_N === 0 ? null : await recallCheck(db, merchantId),
  };

  console.log("\n== ozet (son tur)");
  console.log(
    `/ara     p50 ${summary.araMs.p50} ms, p95 ${summary.araMs.p95} ms, en kotu ${summary.araMs.max} ms`,
  );
  console.log(
    `sohbet   p50 ${summary.sohbetMs.p50} ms, p95 ${summary.sohbetMs.p95} ms, en kotu ${summary.sohbetMs.max} ms`,
  );
  console.log(`hata: ${summary.errors.length ? summary.errors.join("; ") : "yok"}`);
  console.log(`sonucsuz sorgu: ${zero.length ? zero.join(", ") : "yok"}`);
  console.log(
    `en yavas: ${summary.slowest.map((x) => `${x.query} (t${x.round}) ${x.araMs}/${x.sohbetMs} ms`).join("; ")}`,
  );
  if (summary.affiliate) {
    const a = summary.affiliate;
    const warn = a.affiliateStatus !== "active" ? " -> cikislar duz adres, gelir yok" : "";
    console.log(
      `affiliate (${MERCHANT}): durum ${a.affiliateStatus}, sablon ${a.hasTemplate ? `var (${a.templateHost})` : "YOK"}, magaza ${a.isActive ? "aktif" : "PASIF"}${warn}`,
    );
  }
  console.log(
    `baglanti: ${summary.links.productPageFound}/${summary.links.checked} urun sayfasi bulundu; cikis ${JSON.stringify(summary.links.outbound)}; host ${summary.links.hosts.join(", ")}`,
  );
  for (const p of summary.links.problems) console.log(`  sorun: ${JSON.stringify(p)}`);
  if (summary.catalog) {
    console.log(
      `katalog (${MERCHANT}): ${summary.catalog.states.map((s) => `${s.state}=${s.n}`).join(" ")}`,
    );
    console.log(`  orneklem %${SAMPLE_PCT}: ${JSON.stringify(summary.catalog.sample)}`);
    console.log(`  USD/TRY kuru: ${JSON.stringify(summary.catalog.fx)}`);
  }
  if (summary.recall) {
    const r = summary.recall;
    console.log(
      `bulunabilirlik: ${r.found}/${r.tried} urun kendi basligiyla ilk ${PAGE_SIZE} kartta (%${r.recallPct}), medyan sira ${r.medianPosition}`,
    );
    for (const m of r.misses) console.log(`  gorunmeyen: ${JSON.stringify(m)}`);
  }
  if (process.env.PROBE_JSON === "1") console.log(JSON.stringify({ summary, results }));
  return summary.errors.length > 0 || summary.links.problems.length > 0 ? 1 : 0;
}

const entry = process.argv[1] ?? "";
if (import.meta.url === pathToFileURL(entry).href || entry.endsWith("search-probe.mjs")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
