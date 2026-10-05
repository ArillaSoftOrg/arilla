/**
 * `/yonetim/katalog/kalite` (docs/decisions/0053): katalog veri kalitesi
 * bulguları. SALT OKUNUR. Her denetim kendi `readOnly` işleminde, zaman
 * aşımlı ve sınırlı çalışır (en çok `QUALITY_SAMPLE_LIMIT` örnek varlık);
 * çalıştırılamayan denetim sessizce sağlıklı sayılmaz, `unknown` olur.
 *
 * Kurallar kaynaktan türetilir, tahmin edilmez:
 * - barkod geçerliliği: `services/ingest/collect/identifiers.py` `gtin_valid`
 * - barkod çatışması: `resolve/score.py` `veto_reason` (iki geçerli farklı
 *   barkod farklı üründür)
 * - eşleşmemiş teklif durumları: `resolve/pipeline.py` — varsayılan koşu her
 *   eşleşmemiş aktif teklife ya aday yazar ya yeni ürün açar; reddedilen
 *   ürün bir daha önerilmez (0040)
 * - bayat teklif: `catalog.ts` `STALE_OFFER_DAYS`
 *
 * Önemler abartılmaz (karar 0052): beklenen yaşam döngüsü `info`,
 * kullanıcıya yanlış/eksik veri gösterebilecek durum `warning`.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability, type Capability } from "./capabilities.ts";
import { STALE_OFFER_DAYS, validGtinSql } from "./catalog.ts";
import { type AdminFinding, type Severity, sortFindings } from "./severity.ts";

export const QUALITY_SAMPLE_LIMIT = 10;
/** Tek denetimin zaman aşımı. */
export const QUALITY_CHECK_TIMEOUT_MS = 4_000;
/** Bütün rapor için bütçe: aşılırsa kalan denetimler çalıştırılmaz (`unknown`). */
export const QUALITY_REPORT_BUDGET_MS = 15_000;
/** Aynı anda çalışan denetim (havuz varsayılanı 5 bağlantı). */
const QUALITY_CONCURRENCY = 2;

/** Eksik alan payı bunu aşarsa uyarı; altı bilgi. */
export const MISSING_FIELD_WARN_SHARE = 0.2;
/** Bir mağaza aynı ürünü bu kadar ya da daha çok aktif teklifle listeliyorsa. */
export const SAME_PRODUCT_LISTING_MIN = 3;
/** "Çoğu eşleşmemiş" mağaza: en az bu kadar aktif teklif ve bu paydan fazla eşleşmemiş. */
export const MOSTLY_UNMATCHED_MIN_OFFERS = 20;
export const MOSTLY_UNMATCHED_SHARE = 0.5;
/** Adaysız teklif bu süreden uzun bekliyorsa uyarı. */
export const NO_CANDIDATE_WARN_MS = 48 * 60 * 60 * 1000;

export interface QualitySample {
  label: string;
  detail: string | null;
  href: string | null;
  /** `href`i açmak için gereken yetenek (gösterim koşulu; hedef sayfa ayrıca ister). */
  capability: Capability | null;
}

export interface CatalogQualityFinding extends AdminFinding {
  /** Etkilenen varlık sayısı; denetim çalışmadıysa `null`. */
  count: number | null;
  samples: QualitySample[];
}

export interface CatalogQualityReport {
  findings: CatalogQualityFinding[];
  checkedAt: Date;
}

// ---------------------------------------------------------------------------
// Saf sınıflandırma (birim testli)
// ---------------------------------------------------------------------------

/** GS1 kontrol basamağı — `collect/identifiers.py` `gtin_valid` ile aynı. */
export function isValidGtin(code: string | null | undefined): boolean {
  if (!code || !/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const check = digits[digits.length - 1];
  const body = digits.slice(0, -1).reverse();
  const total = body.reduce((sum, d, i) => sum + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === check;
}

/** Eksik alan: yok → sağlıklı; pay eşiği aşarsa uyarı; aksi bilgi. */
export function missingFieldSeverity(count: number, total: number): Severity {
  if (count <= 0) return "healthy";
  if (total > 0 && count / total >= MISSING_FIELD_WARN_SHARE) return "warning";
  return "info";
}

/** Var olduğu anda düzeltilmesi gereken veri hatası (geçersiz/çatışan barkod, yinelenen barkod, bayat teklif). */
export function defectSeverity(count: number): Severity {
  return count > 0 ? "warning" : "healthy";
}

/** Beklenen yaşam döngüsü ya da olası (kanıtlanmamış) sorun. */
export function noticeSeverity(count: number): Severity {
  return count > 0 ? "info" : "healthy";
}

export type UnmatchedOfferState =
  | "in_queue"
  | "no_candidate"
  | "rejected_only"
  | "decided_unlinked";

/**
 * Eşleşmemiş aktif teklifin aday durumu. Sıra önemli: insan/makine kabulü
 * olan ama bağlı olmayan teklif tutarsızlıktır ve her şeyin önüne geçer.
 */
export function classifyUnmatchedOffer(counts: {
  pending: number;
  rejected: number;
  decided: number;
}): UnmatchedOfferState {
  if (counts.decided > 0) return "decided_unlinked";
  if (counts.pending > 0) return "in_queue";
  if (counts.rejected > 0) return "rejected_only";
  return "no_candidate";
}

/** Adaysız teklif: biri 48 saatten uzun bekliyorsa uyarı, aksi bilgi. */
export function noCandidateSeverity(count: number, oldestMs: number | null): Severity {
  if (count <= 0) return "healthy";
  return oldestMs !== null && oldestMs >= NO_CANDIDATE_WARN_MS ? "warning" : "info";
}

export function isMostlyUnmatched(active: number, unmatched: number): boolean {
  return active >= MOSTLY_UNMATCHED_MIN_OFFERS && unmatched / active > MOSTLY_UNMATCHED_SHARE;
}

function fmtCount(n: number): string {
  return n.toLocaleString("tr-TR");
}

function percent(part: number, total: number): string {
  if (total <= 0) return "%0";
  return `%${Math.round((part / total) * 100)}`;
}

function q(value: string): string {
  return encodeURIComponent(value.slice(0, 80));
}

const PRODUCTS = "/yonetim/katalog/urunler";
const OFFERS = "/yonetim/katalog/teklifler";

function productSample(id: number, title: string, detail: string | null = null): QualitySample {
  return {
    label: `#${id} ${title.slice(0, 120)}`,
    detail,
    href: `${PRODUCTS}/${id}`,
    capability: "catalog.read",
  };
}

function offerSample(
  id: number,
  merchantId: number,
  title: string,
  detail: string | null,
): QualitySample {
  return {
    label: `Teklif #${id} ${title.slice(0, 120)}`,
    detail,
    href: `${OFFERS}?durum=all&magaza=${merchantId}&q=%23${id}`,
    capability: "catalog.read",
  };
}

function merchantSample(slug: string, name: string, detail: string): QualitySample {
  return {
    label: name,
    detail,
    href: `/yonetim/magazalar/${encodeURIComponent(slug)}`,
    capability: "merchant.read",
  };
}

type FindingInput = Omit<CatalogQualityFinding, "evidenceAt" | "capability" | "href"> & {
  href?: string | null;
  capability?: Capability | null;
  evidenceAt?: Date | null;
};

function finding(input: FindingInput): CatalogQualityFinding {
  return {
    href: null,
    capability: null,
    evidenceAt: null,
    ...input,
  };
}

// ---------------------------------------------------------------------------
// Denetimler
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof readOnly>[2]>[0];

export interface QualityCheck {
  /** Çalıştırılamazsa üretilecek bulguların anahtarı ve başlığı. */
  keys: { key: string; title: string }[];
  run: (tx: Tx) => Promise<CatalogQualityFinding[]>;
}

async function rows<T>(tx: Tx, query: SQL): Promise<T[]> {
  const result = await tx.execute<T & Record<string, unknown>>(query);
  return result.rows as T[];
}

const productFields: QualityCheck = {
  keys: [
    { key: "catalog.product_no_brand", title: "Markasız ürünler" },
    { key: "catalog.product_no_category", title: "Kategorisiz ürünler" },
    { key: "catalog.product_no_image", title: "Görselsiz ürünler" },
  ],
  run: async (tx) => {
    const [totals] = await rows<{
      total: string;
      no_brand: string;
      no_category: string;
      no_image: string;
    }>(
      tx,
      sql`SELECT count(*) AS total,
                 count(*) FILTER (WHERE brand_id IS NULL) AS no_brand,
                 count(*) FILTER (WHERE category_id IS NULL) AS no_category,
                 count(*) FILTER (WHERE primary_image_url IS NULL) AS no_image
            FROM product`,
    );
    const total = Number(totals?.total ?? 0);
    const sample = async (condition: SQL) =>
      (
        await rows<{ id: string; title: string }>(
          tx,
          sql`SELECT id, title FROM product WHERE ${condition} ORDER BY id DESC LIMIT ${QUALITY_SAMPLE_LIMIT}`,
        )
      ).map((r) => productSample(Number(r.id), r.title));

    const noBrand = Number(totals?.no_brand ?? 0);
    const noCategory = Number(totals?.no_category ?? 0);
    const noImage = Number(totals?.no_image ?? 0);
    return [
      finding({
        key: "catalog.product_no_brand",
        severity: missingFieldSeverity(noBrand, total),
        title: `${fmtCount(noBrand)} ürün markasız`,
        meaning:
          "Marka eşleştirmede kimliktir: markasız ürüne gelen teklif hiçbir skorla otomatik kabul edilmez (karar 0034), insan kuyruğuna düşer; marka vetosu da çalışmaz.",
        evidence: `${fmtCount(noBrand)} / ${fmtCount(total)} ürün (${percent(noBrand, total)}).`,
        action:
          "Örnek ürünlerin tekliflerinde marka alanını kontrol et; mağaza markayı başka alanda gönderiyorsa sözlüğe marka ekle ya da feed eşlemesini düzelttir.",
        href: noBrand > 0 ? `${PRODUCTS}?kalite=no_brand` : null,
        capability: "catalog.read",
        count: noBrand,
        samples: noBrand > 0 ? await sample(sql`brand_id IS NULL`) : [],
      }),
      finding({
        key: "catalog.product_no_category",
        severity: missingFieldSeverity(noCategory, total),
        title: `${fmtCount(noCategory)} ürün kategorisiz`,
        meaning:
          "Kategori yalnızca var olan yola bağlanır, yoktan açılmaz (karar 0017). Kategorisiz ürün kategori sayfalarında ve keşfette görünmez.",
        evidence: `${fmtCount(noCategory)} / ${fmtCount(total)} ürün (${percent(noCategory, total)}).`,
        action:
          "Mağazanın ham kategori metnini ya da feed ayarındaki kategori ipucunu (category_hint) mevcut bir kategori yoluna eşlet.",
        href: noCategory > 0 ? `${PRODUCTS}?kalite=no_category` : null,
        capability: "catalog.read",
        count: noCategory,
        samples: noCategory > 0 ? await sample(sql`category_id IS NULL`) : [],
      }),
      finding({
        key: "catalog.product_no_image",
        severity: missingFieldSeverity(noImage, total),
        title: `${fmtCount(noImage)} ürün görselsiz`,
        meaning:
          "Ürün kartı ve ürün sayfası görselsiz görünür; görsel arama ve görsel benzerlik bu ürünü bulamaz.",
        evidence: `${fmtCount(noImage)} / ${fmtCount(total)} ürün (${percent(noImage, total)}).`,
        action: "Örnek ürünlerin tekliflerinde görsel adresi olup olmadığını kontrol et.",
        href: noImage > 0 ? `${PRODUCTS}?kalite=no_image` : null,
        capability: "catalog.read",
        count: noImage,
        samples: noImage > 0 ? await sample(sql`primary_image_url IS NULL`) : [],
      }),
    ];
  },
};

const duplicateGtin: QualityCheck = {
  keys: [{ key: "catalog.duplicate_gtin", title: "Aynı barkodu taşıyan ürünler" }],
  run: async (tx) => {
    const found = await rows<{ gtin: string; n: string; ids: string[]; groups: string }>(
      tx,
      sql`SELECT gtin, count(*) AS n, (array_agg(id ORDER BY id))[1:5] AS ids,
                 count(*) OVER () AS groups
            FROM product WHERE gtin IS NOT NULL
           GROUP BY gtin HAVING count(*) > 1
           ORDER BY count(*) DESC, gtin
           LIMIT ${QUALITY_SAMPLE_LIMIT}`,
    );
    const groups = Number(found[0]?.groups ?? 0);
    return [
      finding({
        key: "catalog.duplicate_gtin",
        severity: defectSeverity(groups),
        title: `${fmtCount(groups)} barkod birden fazla üründe`,
        meaning:
          "Barkod bir ticari ürünü tekil tanımlar. Aynı barkodlu iki ürün aynı ürünün iki kaydıdır: teklifler bölünür, fiyat karşılaştırması eksik kalır ve kesin kimlik kanalı yeni teklifi hangisine bağlayacağını keyfi seçer.",
        evidence: groups > 0 ? `${fmtCount(groups)} barkod grubu.` : null,
        action:
          "Örnek grupları karşılaştır. Gerçekten aynı ürünse birleştirme ayrı bir karar ister (catalog.write yok); bulguyu yöneticiye ilet.",
        href: groups > 0 ? `${PRODUCTS}?sorun=duplicate_gtin` : null,
        capability: "catalog.read",
        count: groups,
        samples: found.map((r) => ({
          label: `Barkod ${r.gtin}`,
          detail: `${fmtCount(Number(r.n))} ürün: ${r.ids.map((id) => `#${id}`).join(", ")}`,
          href: `${PRODUCTS}?q=${q(r.gtin)}`,
          capability: "catalog.read" as const,
        })),
      }),
    ];
  },
};

const probableDuplicates: QualityCheck = {
  keys: [{ key: "catalog.probable_duplicate", title: "Olası çift ürün kaydı" }],
  run: async (tx) => {
    // Ürün renk düzeyinde kanonik (0005): marka + katlanmış başlık + renk aynıysa.
    const found = await rows<{ title: string; n: string; ids: string[]; groups: string }>(
      tx,
      sql`SELECT min(title) AS title, count(*) AS n, (array_agg(id ORDER BY id))[1:5] AS ids,
                 count(*) OVER () AS groups
            FROM product
           WHERE brand_id IS NOT NULL
           GROUP BY brand_id, lower(btrim(title)), lower(coalesce(color, ''))
          HAVING count(*) > 1
           ORDER BY count(*) DESC, min(id)
           LIMIT ${QUALITY_SAMPLE_LIMIT}`,
    );
    const groups = Number(found[0]?.groups ?? 0);
    return [
      finding({
        key: "catalog.probable_duplicate",
        severity: noticeSeverity(groups),
        title: `${fmtCount(groups)} olası çift ürün grubu`,
        meaning:
          "Aynı marka, aynı başlık ve aynı renkte birden fazla ürün var. Çoğu zaman aynı ürünün iki kaydıdır; ama başlıkta yazmayan bir fark (ör. hacim) olabilir, bu yüzden kesin değildir.",
        evidence: groups > 0 ? `${fmtCount(groups)} grup (marka + başlık + renk).` : null,
        action:
          "Örnek grupların tekliflerini ve varyant barkodlarını karşılaştır; gerçekten aynıysa yöneticiye ilet.",
        count: groups,
        samples: found.map((r) => ({
          label: r.title.slice(0, 120),
          detail: `${fmtCount(Number(r.n))} ürün: ${r.ids.map((id) => `#${id}`).join(", ")}`,
          href: `${PRODUCTS}?q=${q(r.title)}`,
          capability: "catalog.read" as const,
        })),
      }),
    ];
  },
};

const noActiveOffers: QualityCheck = {
  keys: [{ key: "catalog.product_no_active_offer", title: "Aktif teklifi olmayan ürünler" }],
  run: async (tx) => {
    const condition = sql`NOT EXISTS (SELECT 1 FROM offer o WHERE o.product_id = p.id AND o.is_active)`;
    const [total] = await rows<{ n: string }>(
      tx,
      sql`SELECT count(*) AS n FROM product p WHERE ${condition}`,
    );
    const n = Number(total?.n ?? 0);
    const samples =
      n > 0
        ? await rows<{ id: string; title: string }>(
            tx,
            sql`SELECT p.id, p.title FROM product p WHERE ${condition} ORDER BY p.id DESC LIMIT ${QUALITY_SAMPLE_LIMIT}`,
          )
        : [];
    return [
      finding({
        key: "catalog.product_no_active_offer",
        severity: noticeSeverity(n),
        title: `${fmtCount(n)} ürünün aktif teklifi yok`,
        meaning:
          "Ürün aramada ve karşılaştırmada fiyatsız kalır. Mağaza ürünü feed'den çıkardığında beklenen bir durumdur; ürün sayfası adresi korunur (301 kuralı).",
        evidence:
          n > 0 ? `${fmtCount(n)} ürün (canlı teklif satırlarından, fiyat özetinden değil).` : null,
        action:
          "Bilgi amaçlı. Çok sayıda ve yeni ürünse ilgili mağazanın son toplamasını kontrol et.",
        href: n > 0 ? `${PRODUCTS}?sorun=no_active_offer` : null,
        capability: "catalog.read",
        count: n,
        samples: samples.map((r) => productSample(Number(r.id), r.title)),
      }),
    ];
  },
};

const offerGtins: QualityCheck = {
  keys: [
    { key: "catalog.invalid_gtin", title: "Geçersiz barkod" },
    { key: "catalog.gtin_conflict", title: "Ürün barkoduyla çatışan teklif barkodu" },
  ],
  run: async (tx) => {
    const offerGtin = sql`(o.attributes_raw->>'gtin')`;
    const invalidOffer = sql`o.is_active AND o.attributes_raw ? 'gtin' AND NOT ${validGtinSql(offerGtin)}`;
    const invalidProduct = sql`p.gtin IS NOT NULL AND NOT ${validGtinSql(sql`p.gtin`)}`;
    const conflict = sql`o.is_active AND o.product_id IS NOT NULL AND p.gtin IS NOT NULL
      AND o.attributes_raw ? 'gtin' AND ${offerGtin} <> p.gtin
      AND ${validGtinSql(offerGtin)} AND ${validGtinSql(sql`p.gtin`)}`;

    const [counts] = await rows<{ invalid_offers: string; conflicts: string }>(
      tx,
      sql`SELECT count(*) FILTER (WHERE ${invalidOffer}) AS invalid_offers,
                 count(*) FILTER (WHERE ${conflict}) AS conflicts
            FROM offer o LEFT JOIN product p ON p.id = o.product_id
           WHERE o.is_active AND o.attributes_raw ? 'gtin'`,
    );
    const [productCount] = await rows<{ n: string }>(
      tx,
      sql`SELECT count(*) AS n FROM product p WHERE ${invalidProduct}`,
    );
    const invalidOffers = Number(counts?.invalid_offers ?? 0);
    const conflicts = Number(counts?.conflicts ?? 0);
    const invalidProducts = Number(productCount?.n ?? 0);

    type OfferRow = { id: string; merchant_id: string; title_raw: string; gtin: string };
    const invalidOfferRows =
      invalidOffers > 0
        ? await rows<OfferRow>(
            tx,
            sql`SELECT o.id, o.merchant_id, o.title_raw, ${offerGtin} AS gtin
                  FROM offer o WHERE ${invalidOffer} ORDER BY o.id DESC LIMIT ${QUALITY_SAMPLE_LIMIT}`,
          )
        : [];
    const invalidProductRows =
      invalidProducts > 0
        ? await rows<{ id: string; title: string; gtin: string }>(
            tx,
            sql`SELECT p.id, p.title, p.gtin FROM product p WHERE ${invalidProduct}
                 ORDER BY p.id DESC LIMIT ${QUALITY_SAMPLE_LIMIT}`,
          )
        : [];
    const conflictRows =
      conflicts > 0
        ? await rows<
            OfferRow & { product_id: string; product_gtin: string; product_title: string }
          >(
            tx,
            sql`SELECT o.id, o.merchant_id, o.title_raw, ${offerGtin} AS gtin, p.id AS product_id,
                       p.gtin AS product_gtin, p.title AS product_title
                  FROM offer o JOIN product p ON p.id = o.product_id
                 WHERE ${conflict} ORDER BY o.id DESC LIMIT ${QUALITY_SAMPLE_LIMIT}`,
          )
        : [];

    const invalidTotal = invalidOffers + invalidProducts;
    return [
      finding({
        key: "catalog.invalid_gtin",
        severity: defectSeverity(invalidTotal),
        title: `${fmtCount(invalidTotal)} geçersiz barkod`,
        meaning:
          "Barkodun uzunluğu ya da GS1 kontrol basamağı tutmuyor. Geçersiz barkod kesin kimlik kanalında yanlış eşleşmeye ya da kaçan eşleşmeye yol açar; ürün barkodu teklif barkodundan eşitlendiği için ürüne de taşınabilir.",
        evidence: `${fmtCount(invalidOffers)} aktif teklif, ${fmtCount(invalidProducts)} ürün.`,
        action:
          "Mağazanın feed'inde barkod alanının gerçekten barkod taşıdığını (SKU ya da iç kod değil) kontrol et; mağaza bağlayıcısının barkodu doğrulamadan yazdığı yolu bildir.",
        href: invalidOffers > 0 ? `${OFFERS}?durum=invalid_gtin` : null,
        capability: "catalog.read",
        count: invalidTotal,
        samples: [
          ...invalidOfferRows.map((r) =>
            offerSample(
              Number(r.id),
              Number(r.merchant_id),
              r.title_raw,
              `Barkod: ${r.gtin.slice(0, 40)}`,
            ),
          ),
          ...invalidProductRows.map((r) =>
            productSample(Number(r.id), r.title, `Ürün barkodu: ${r.gtin.slice(0, 40)}`),
          ),
        ].slice(0, QUALITY_SAMPLE_LIMIT),
      }),
      finding({
        key: "catalog.gtin_conflict",
        severity: defectSeverity(conflicts),
        title: `${fmtCount(conflicts)} teklifin barkodu bağlı olduğu ürününkinden farklı`,
        meaning:
          "İki geçerli ve farklı barkod farklı üründür: resolver bu çifti bugün veto eder. Bağ ya yanlış (elle onay ya da eski kural) ya da ürün barkodu eşitlemesi bu tekliften sonra çalışmamış.",
        evidence: conflicts > 0 ? `${fmtCount(conflicts)} aktif teklif.` : null,
        action:
          "Örnek ürünün tekliflerini ve barkodlarını incele. Bağ yanlışsa eşleştirme geçmişinden kararı bul ve yöneticiye ilet; değilse barkod eşitlemesini (collect.identifiers) çalıştırt.",
        count: conflicts,
        samples: conflictRows.map((r) =>
          productSample(
            Number(r.product_id),
            r.product_title,
            `Teklif #${r.id} barkodu ${r.gtin.slice(0, 40)} · ürün barkodu ${r.product_gtin.slice(0, 40)}`,
          ),
        ),
      }),
    ];
  },
};

const merchantOffers: QualityCheck = {
  keys: [
    { key: "catalog.stale_offers", title: "Bayat teklifler" },
    { key: "catalog.inactive_offers", title: "Açık mağazalarda pasif teklifler" },
    { key: "catalog.inactive_merchant_active_offers", title: "Kapalı mağazada aktif teklif" },
    { key: "catalog.merchant_mostly_unmatched", title: "Tekliflerinin çoğu eşleşmemiş mağazalar" },
  ],
  run: async (tx) => {
    const perMerchant = await rows<{
      id: string;
      slug: string;
      name: string;
      merchant_active: boolean;
      active: string;
      stale: string;
      inactive: string;
      unmatched: string;
    }>(
      tx,
      sql`SELECT m.id, m.slug, m.name, m.is_active AS merchant_active,
                 count(*) FILTER (WHERE o.is_active) AS active,
                 count(*) FILTER (WHERE o.is_active
                   AND o.last_seen_at < now() - (${STALE_OFFER_DAYS} * interval '1 day')) AS stale,
                 count(*) FILTER (WHERE NOT o.is_active) AS inactive,
                 count(*) FILTER (WHERE o.is_active AND o.product_id IS NULL) AS unmatched
            FROM merchant m JOIN offer o ON o.merchant_id = m.id
           GROUP BY m.id
           LIMIT 2000`,
    );
    const ms = perMerchant.map((r) => ({
      id: Number(r.id),
      slug: r.slug,
      name: r.name,
      merchantActive: r.merchant_active,
      active: Number(r.active),
      stale: Number(r.stale),
      inactive: Number(r.inactive),
      unmatched: Number(r.unmatched),
    }));
    const open = ms.filter((m) => m.merchantActive);
    const closed = ms.filter((m) => !m.merchantActive && m.active > 0);
    const sum = (list: typeof ms, f: (m: (typeof ms)[number]) => number) =>
      list.reduce((acc, m) => acc + f(m), 0);
    const top = (list: typeof ms, f: (m: (typeof ms)[number]) => number) =>
      [...list]
        .filter((m) => f(m) > 0)
        .sort((a, b) => f(b) - f(a) || a.name.localeCompare(b.name, "tr"))
        .slice(0, QUALITY_SAMPLE_LIMIT);

    const staleTotal = sum(open, (m) => m.stale);
    const openActive = sum(open, (m) => m.active);
    const inactiveTotal = sum(open, (m) => m.inactive);
    const closedActive = sum(closed, (m) => m.active);
    const mostly = open.filter((m) => isMostlyUnmatched(m.active, m.unmatched));

    return [
      finding({
        key: "catalog.stale_offers",
        severity: defectSeverity(staleTotal),
        title: `${fmtCount(staleTotal)} aktif teklif ${STALE_OFFER_DAYS} gündür feed'de görülmedi`,
        meaning:
          "Açık mağazanın aktif teklifi son toplamalarda görülmüyor: fiyat ve stok bilgisi eskimiş olabilir ve kullanıcıya gösteriliyor.",
        evidence: `${fmtCount(staleTotal)} / ${fmtCount(openActive)} aktif teklif (${percent(staleTotal, openActive)}).`,
        action:
          "Örnek mağazaların son toplama koşusuna bak; toplama başarısızsa veri toplama sayfasından nedenini bul.",
        href: staleTotal > 0 ? `${OFFERS}?durum=stale` : null,
        capability: "catalog.read",
        count: staleTotal,
        samples: top(open, (m) => m.stale).map((m) => ({
          label: m.name,
          detail: `${fmtCount(m.stale)} bayat / ${fmtCount(m.active)} aktif teklif`,
          href: `${OFFERS}?durum=stale&magaza=${m.id}`,
          capability: "catalog.read" as const,
        })),
      }),
      finding({
        key: "catalog.inactive_offers",
        severity: noticeSeverity(inactiveTotal),
        title: `Açık mağazalarda ${fmtCount(inactiveTotal)} pasif teklif`,
        meaning:
          "Mağaza ürünü feed'den çıkarınca teklif pasifleşir; fiyat geçmişi korunur. Beklenen yaşam döngüsüdür, oran ani artarsa feed bozulmuş olabilir.",
        evidence: `${fmtCount(inactiveTotal)} pasif, ${fmtCount(openActive)} aktif teklif.`,
        action: "Bilgi amaçlı. Bir mağazada pasif oranı aniden yükseldiyse feed'ini kontrol et.",
        href: inactiveTotal > 0 ? `${OFFERS}?durum=inactive` : null,
        capability: "catalog.read",
        count: inactiveTotal,
        samples: top(open, (m) => m.inactive).map((m) => ({
          label: m.name,
          detail: `${fmtCount(m.inactive)} pasif / ${fmtCount(m.active)} aktif teklif`,
          href: `${OFFERS}?durum=inactive&magaza=${m.id}`,
          capability: "catalog.read" as const,
        })),
      }),
      finding({
        key: "catalog.inactive_merchant_active_offers",
        severity: noticeSeverity(closedActive),
        title: `Kapalı ${fmtCount(closed.length)} mağazada ${fmtCount(closedActive)} aktif teklif`,
        meaning:
          "Arama kapalı mağazanın tekliflerini zaten göstermez; teklifler mağaza yeniden açılırsa aynen döner. Fiyatları bu arada güncellenmez.",
        evidence: closedActive > 0 ? `${fmtCount(closedActive)} teklif.` : null,
        action: "Bilgi amaçlı. Mağaza kalıcı olarak kapandıysa bunu mağaza sayfasında not et.",
        count: closedActive,
        samples: top(closed, (m) => m.active).map((m) =>
          merchantSample(m.slug, m.name, `${fmtCount(m.active)} aktif teklif, mağaza kapalı`),
        ),
      }),
      finding({
        key: "catalog.merchant_mostly_unmatched",
        severity: noticeSeverity(mostly.length),
        title: `${fmtCount(mostly.length)} mağazanın aktif tekliflerinin çoğu eşleşmemiş`,
        meaning: `En az ${MOSTLY_UNMATCHED_MIN_OFFERS} aktif teklifi olan ve ${percent(MOSTLY_UNMATCHED_SHARE, 1)}'den fazlası hiçbir ürüne bağlı olmayan mağaza. Eşleşmemiş teklif aramada görünmez; çoğunlukla eşleştirme işi son toplamadan sonra çalışmamıştır.`,
        evidence:
          mostly.length > 0
            ? `${fmtCount(sum(mostly, (m) => m.unmatched))} eşleşmemiş teklif.`
            : null,
        action:
          "Eşleştirme işini (python -m resolve) bu mağaza için çalıştırt; aynı mağaza tekrar listelenirse aşağıdaki adaysız teklifleri incele.",
        count: mostly.length,
        samples: mostly
          .sort((a, b) => b.unmatched - a.unmatched)
          .slice(0, QUALITY_SAMPLE_LIMIT)
          .map((m) => ({
            label: m.name,
            detail: `${fmtCount(m.unmatched)} / ${fmtCount(m.active)} aktif teklif eşleşmemiş (${percent(m.unmatched, m.active)})`,
            href: `${OFFERS}?durum=unmatched&magaza=${m.id}`,
            capability: "catalog.read" as const,
          })),
      }),
    ];
  },
};

const UNMATCHED_STATE_SQL = sql`CASE
  WHEN c.decided > 0 THEN 'decided_unlinked'
  WHEN c.pending > 0 THEN 'in_queue'
  WHEN c.rejected > 0 THEN 'rejected_only'
  ELSE 'no_candidate' END`;

const unmatchedOffers: QualityCheck = {
  keys: [
    { key: "catalog.unmatched_no_candidate", title: "Adaysız eşleşmemiş teklifler" },
    { key: "catalog.unmatched_rejected_only", title: "Bütün adayları reddedilmiş teklifler" },
    { key: "catalog.unmatched_decided", title: "Kabul edilmiş ama bağlanmamış teklifler" },
  ],
  run: async (tx) => {
    const base = sql`
      SELECT o.id, o.merchant_id, o.title_raw, o.first_seen_at, ${UNMATCHED_STATE_SQL} AS state,
             c.rejected
        FROM offer o
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE mc.status = 'pending') AS pending,
                 count(*) FILTER (WHERE mc.status = 'rejected') AS rejected,
                 count(*) FILTER (WHERE mc.status IN ('accepted', 'auto_accepted')) AS decided
            FROM match_candidate mc WHERE mc.offer_id = o.id
        ) c ON true
       WHERE o.product_id IS NULL AND o.is_active`;
    const agg = await rows<{ state: UnmatchedOfferState; n: string; oldest: string | null }>(
      tx,
      sql`SELECT state, count(*) AS n, min(first_seen_at) AS oldest FROM (${base}) u GROUP BY state`,
    );
    const samples = await rows<{
      id: string;
      merchant_id: string;
      title_raw: string;
      first_seen_at: string;
      state: UnmatchedOfferState;
      rejected: string;
    }>(
      tx,
      sql`SELECT * FROM (
            SELECT u.*, row_number() OVER (PARTITION BY u.state ORDER BY u.first_seen_at, u.id) AS rn
              FROM (${base}) u WHERE u.state <> 'in_queue'
          ) x WHERE x.rn <= ${QUALITY_SAMPLE_LIMIT} ORDER BY x.state, x.rn`,
    );
    const now = Date.now();
    const byState = new Map(agg.map((r) => [r.state, r]));
    const count = (s: UnmatchedOfferState) => Number(byState.get(s)?.n ?? 0);
    const oldest = (s: UnmatchedOfferState) => {
      const value = byState.get(s)?.oldest;
      return value ? new Date(value) : null;
    };
    const sampleFor = (s: UnmatchedOfferState) =>
      samples
        .filter((r) => r.state === s)
        .map((r) => {
          const days = Math.floor((now - new Date(r.first_seen_at).getTime()) / 86_400_000);
          const rejected = Number(r.rejected);
          return offerSample(
            Number(r.id),
            Number(r.merchant_id),
            r.title_raw,
            `${days} gündür görülüyor${rejected > 0 ? ` · ${rejected} aday reddedildi` : ""}`,
          );
        });

    const noCandidate = count("no_candidate");
    const noCandidateOldest = oldest("no_candidate");
    const rejectedOnly = count("rejected_only");
    const decided = count("decided_unlinked");
    const inQueue = count("in_queue");
    return [
      finding({
        key: "catalog.unmatched_no_candidate",
        severity: noCandidateSeverity(
          noCandidate,
          noCandidateOldest ? now - noCandidateOldest.getTime() : null,
        ),
        title: `${fmtCount(noCandidate)} eşleşmemiş aktif teklifin hiç adayı yok`,
        meaning:
          "Varsayılan eşleştirme koşusu her eşleşmemiş aktif teklife ya aday yazar ya da yeni ürün açıp bağlar. Hiç aday kaydı olmayan teklife o koşu henüz ulaşmamıştır: teklif son koşudan sonra gelmiş, koşu kotası (500 teklif) dolmuş, koşu yeni ürün açmadan (--no-create) çalışmış ya da bu teklifte hata vermiştir. Teklif aramada görünmez.",
        evidence:
          noCandidate > 0
            ? `${fmtCount(noCandidate)} teklif; ayrıca ${fmtCount(inQueue)} teklif insan kuyruğunda.`
            : `${fmtCount(inQueue)} eşleşmemiş teklif insan kuyruğunda.`,
        action:
          "Eşleştirme işini (python -m resolve) çalıştırt. Aynı teklifler bir koşudan sonra hâlâ adaysızsa koşu çıktısındaki hata satırlarına bak.",
        href: noCandidate > 0 ? `${OFFERS}?durum=no_candidate` : null,
        capability: "catalog.read",
        evidenceAt: noCandidateOldest,
        count: noCandidate,
        samples: sampleFor("no_candidate"),
      }),
      finding({
        key: "catalog.unmatched_rejected_only",
        severity: noticeSeverity(rejectedOnly),
        title: `${fmtCount(rejectedOnly)} teklifin bütün adayları reddedildi`,
        meaning:
          "Moderatör bu tekliflerin önerilen ürünlerini reddetti. Resolver reddedilen ürünü bir daha önermez (karar 0040); sonraki koşuda ya başka bir aday yazar ya da yeni ürün açar. Koşu yapılmadıkça teklif eşleşmemiş kalır.",
        evidence: rejectedOnly > 0 ? `${fmtCount(rejectedOnly)} teklif.` : null,
        action:
          "Eşleştirme işini çalıştırt. Aynı teklif tekrar tekrar burada kalıyorsa ret nedenlerini (eşleştirme geçmişi) ve teklif verisini incele.",
        href: rejectedOnly > 0 ? `${OFFERS}?durum=rejected_only` : null,
        capability: "catalog.read",
        evidenceAt: oldest("rejected_only"),
        count: rejectedOnly,
        samples: sampleFor("rejected_only"),
      }),
      finding({
        key: "catalog.unmatched_decided",
        severity: defectSeverity(decided),
        title: `${fmtCount(decided)} teklifin kabul edilmiş adayı var ama ürüne bağlı değil`,
        meaning:
          "Kabul (insan ya da otomatik) teklifi aynı işlemde ürüne bağlar. Kabul edilmiş adayı olup bağlı olmayan teklif tutarsız veridir; teklif aramada görünmez.",
        evidence: decided > 0 ? `${fmtCount(decided)} teklif.` : null,
        action:
          "Örnek teklifleri yöneticiye ilet; bağın neden kaldırıldığı denetim kaydından izlenmeli.",
        count: decided,
        samples: sampleFor("decided_unlinked"),
      }),
    ];
  },
};

const sameProductListings: QualityCheck = {
  keys: [
    { key: "catalog.merchant_same_product", title: "Aynı ürünü çok kez listeleyen mağazalar" },
  ],
  run: async (tx) => {
    const found = await rows<{
      merchant_id: string;
      merchant_name: string;
      product_id: string;
      product_title: string;
      n: string;
      pairs: string;
    }>(
      tx,
      sql`SELECT g.merchant_id, m.name AS merchant_name, g.product_id, p.title AS product_title,
                 g.n, g.pairs
            FROM (
              SELECT merchant_id, product_id, count(*) AS n, count(*) OVER () AS pairs
                FROM offer WHERE is_active AND product_id IS NOT NULL
               GROUP BY merchant_id, product_id
              HAVING count(*) >= ${SAME_PRODUCT_LISTING_MIN}
               ORDER BY count(*) DESC, merchant_id, product_id
               LIMIT ${QUALITY_SAMPLE_LIMIT}
            ) g
            JOIN merchant m ON m.id = g.merchant_id
            JOIN product p ON p.id = g.product_id
           ORDER BY g.n DESC, g.merchant_id, g.product_id`,
    );
    const pairs = Number(found[0]?.pairs ?? 0);
    return [
      finding({
        key: "catalog.merchant_same_product",
        severity: noticeSeverity(pairs),
        title: `${fmtCount(pairs)} mağaza-ürün çiftinde ${SAME_PRODUCT_LISTING_MIN}+ aktif teklif`,
        meaning:
          "Bir mağaza aynı kanonik ürünü pratikte tek kayıtla satar; resolver metin/görsel yolunda aynı mağazanın zaten bağlı olduğu ürünü önermez. Barkodla bağlanan kopyalar meşru olabilir (aynı barkod), ama çok sayıda kopya renk/beden kardeşlerinin tek ürüne toplandığını gösterebilir.",
        evidence: pairs > 0 ? `${fmtCount(pairs)} çift.` : null,
        action:
          "Örnek ürünün tekliflerini aç; renk ya da hacim farklıysa bağlar yanlıştır, yöneticiye ilet.",
        count: pairs,
        samples: found.map((r) =>
          productSample(
            Number(r.product_id),
            r.product_title,
            `${r.merchant_name}: ${fmtCount(Number(r.n))} aktif teklif`,
          ),
        ),
      }),
    ];
  },
};

export const CATALOG_QUALITY_CHECKS: readonly QualityCheck[] = [
  unmatchedOffers,
  offerGtins,
  duplicateGtin,
  merchantOffers,
  productFields,
  noActiveOffers,
  probableDuplicates,
  sameProductListings,
];

function unknownFindings(check: QualityCheck, at: Date): CatalogQualityFinding[] {
  return check.keys.map(({ key, title }) =>
    finding({
      key,
      severity: "unknown",
      title: `${title}: denetim çalıştırılamadı`,
      meaning:
        "Denetim zaman aşımına uğradı ya da hata verdi. Sonuç sağlıklı sayılmaz; yalnızca bilinmiyor.",
      evidence: null,
      action: "Sayfayı daha sonra yenile. Sürekli tekrarlanıyorsa sorgu planını yöneticiye bildir.",
      evidenceAt: at,
      count: null,
      samples: [],
    }),
  );
}

/**
 * Bütün denetimler. Her biri ayrı salt okunur işlemde (`QUALITY_CHECK_TIMEOUT_MS`),
 * en çok `QUALITY_CONCURRENCY` tanesi aynı anda; toplam bütçe aşılırsa
 * kalanlar `unknown` döner.
 */
export async function getCatalogQualityReport(
  db: Database,
  actor: AdminActor,
  options: { checks?: readonly QualityCheck[]; timeoutMs?: number; budgetMs?: number } = {},
): Promise<CatalogQualityReport> {
  assertCapability(actor, "catalog.read");
  const checks = options.checks ?? CATALOG_QUALITY_CHECKS;
  const timeoutMs = options.timeoutMs ?? QUALITY_CHECK_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? QUALITY_REPORT_BUDGET_MS;
  const started = Date.now();
  const checkedAt = new Date();
  const results: CatalogQualityFinding[][] = new Array(checks.length);

  let next = 0;
  async function worker(): Promise<void> {
    while (next < checks.length) {
      const index = next++;
      const check = checks[index];
      if (!check) continue;
      if (Date.now() - started > budgetMs) {
        results[index] = unknownFindings(check, checkedAt);
        continue;
      }
      try {
        results[index] = await readOnly(db, timeoutMs, (tx) => check.run(tx));
      } catch {
        results[index] = unknownFindings(check, checkedAt);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(QUALITY_CONCURRENCY, checks.length) }, worker));

  return { findings: sortFindings(results.flat()), checkedAt };
}
