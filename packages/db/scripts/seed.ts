/**
 * Gelistirme tohum verisi (A3).
 *
 * Amac: arayuz gelistirmesi gercek feed beklemeden baslayabilsin. Uretilen
 * katalog SAHTEDIR; magaza adlari ve alan adlari `.example` uzantilidir,
 * gercek bir siteyi taklit etmez.
 *
 * Uretilenler:
 *   3 merchant, 12 brand, kategori agaci, 200 product, 400 offer,
 *   beden varyantlari, 60 gunluk fiyat gecmisi.
 *
 * `product_price_stats` ve `similarity_edge` BURADA URETILMEZ — onlar B5'in
 * isi (services/ingest/similarity). Tohumdan sonra `python -m enrich` ve
 * `python -m similarity` calistirin.
 *
 * Iki ozel durum bilerek uretilir:
 *   1. Fiyat gecmisi 60 gun geriye gider, yani BIRDEN FAZLA AYA yayilir ve
 *      partition sinirini gercekten gecer. Gerekli gecmis partition'lar
 *      `ensureMonthlyPartitions` ile acilir — aksi halde satirlar
 *      `price_point_default` icine duser ve kritik uyari uretirdi.
 *   2. Birkac teklifte liste fiyati indirimden hemen once yukseltilir.
 *      B5 bunu `list_price_inflated` olarak TESPIT EDER; tohum bayragi elle
 *      koymaz, yalnizca tespit edilebilir bir fiyat gecmisi uretir.
 *
 * Sozluk kurallari (docs/glossary.md) tohum metinlerinde de gecerlidir:
 * "satin al", "dupe" ve "ucuz" kelimeleri kullanilmaz.
 */
import type { Client } from "pg";
import { ensureMonthlyPartitions } from "./ensure-partitions.ts";
import { isLocal, ownerUrl, withClient } from "./lib.ts";

const HISTORY_DAYS = 60;
const PRODUCT_COUNT = 200;
const OFFER_COUNT = 400;
/** Sabit tohum: her kosu ayni katalogu uretir, arayuz gelistirmesi kaymaz. */
const RANDOM_SEED = 20260907;

/**
 * Gorsel URL tabani. Varsayilan `.example` alan adlari cozulmez; B3'u yerel
 * fixture sunucusuna yoneltmek icin `SEED_IMAGE_BASE_URL` verilir.
 */
const IMAGE_BASE = (process.env.SEED_IMAGE_BASE_URL ?? "").replace(/\/+$/, "");

/** Gorsel adresi: taban verilmisse ona, verilmemisse magazanin alan adina. */
function imageUrl(domain: string, path: string): string {
  return IMAGE_BASE ? `${IMAGE_BASE}/img/${path}` : `https://${domain}/img/${path}`;
}

// --- deterministik rastgelelik ----------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(RANDOM_SEED);

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("bos listeden secim yapilamaz");
  return item;
}

function intBetween(min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

function slugify(value: string): string {
  const map: Record<string, string> = {
    ç: "c",
    ğ: "g",
    ı: "i",
    ö: "o",
    ş: "s",
    ü: "u",
    Ç: "c",
    Ğ: "g",
    İ: "i",
    Ö: "o",
    Ş: "s",
    Ü: "u",
  };
  return value
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (char) => map[char] ?? char)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- toplu insert ------------------------------------------------------------

async function insertRows(
  client: Client,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(20000 / columns.length));
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
      params,
    );
  }
}

// --- katalog tanimlari -------------------------------------------------------

const MERCHANTS = [
  { slug: "moda-deposu", name: "Moda Deposu", domain: "modadeposu.example", rate: 600 },
  { slug: "stil-sepeti", name: "Stil Sepeti", domain: "stilsepeti.example", rate: 450 },
  { slug: "trend-vitrin", name: "Trend Vitrin", domain: "trendvitrin.example", rate: 800 },
] as const;

const BRANDS = [
  "Ayda",
  "Marmara Atolye",
  "Kuzey Deri",
  "Ela Studio",
  "Nar Cicegi",
  "Vira",
  "Solen",
  "Deniz Kabugu",
  "Peri Kozmetik",
  "Lodos",
  "Ipek Yolu",
  "Zeytin",
] as const;

type CategoryDef = {
  slug: string;
  name: string;
  path: string;
  parent?: string;
  discoverable: boolean;
  sizes: readonly string[];
  minPrice: number;
  maxPrice: number;
  titles: readonly string[];
};

const APPAREL_SIZES = ["XS", "S", "M", "L", "XL"] as const;
const SHOE_SIZES = ["36", "37", "38", "39", "40", "41", "42"] as const;

/** Elektronik kategorisi YOKTUR — komisyon ekonomisi orada calismiyor. */
const CATEGORIES: readonly CategoryDef[] = [
  {
    slug: "moda",
    name: "Moda",
    path: "moda",
    discoverable: true,
    sizes: [],
    minPrice: 0,
    maxPrice: 0,
    titles: [],
  },
  {
    slug: "ayakkabi",
    name: "Ayakkabi",
    path: "moda/ayakkabi",
    parent: "moda",
    discoverable: true,
    sizes: SHOE_SIZES,
    minPrice: 89900,
    maxPrice: 399900,
    titles: [
      "Suet Spor Ayakkabi",
      "Deri Loafer",
      "Bilekli Bot",
      "Sandalet",
      "Kosu Ayakkabisi",
      "Babet",
    ],
  },
  {
    slug: "canta",
    name: "Canta",
    path: "moda/canta",
    parent: "moda",
    discoverable: true,
    sizes: ["Tek ebat"],
    minPrice: 59900,
    maxPrice: 299900,
    titles: ["Deri Omuz Cantasi", "Baget Canta", "Sirt Cantasi", "El Cantasi", "Postaci Cantasi"],
  },
  {
    slug: "ust-giyim",
    name: "Ust giyim",
    path: "moda/ust-giyim",
    parent: "moda",
    discoverable: true,
    sizes: APPAREL_SIZES,
    minPrice: 39900,
    maxPrice: 149900,
    titles: [
      "Oversize Triko Kazak",
      "Basic Tisort",
      "Poplin Gomlek",
      "Kaskorse Body",
      "Sweatshirt",
    ],
  },
  {
    slug: "elbise",
    name: "Elbise",
    path: "moda/elbise",
    parent: "moda",
    discoverable: true,
    sizes: APPAREL_SIZES,
    minPrice: 59900,
    maxPrice: 199900,
    titles: ["Midi Saten Elbise", "Gomlek Elbise", "Triko Elbise", "Askili Yazlik Elbise"],
  },
  {
    slug: "dis-giyim",
    name: "Dis giyim",
    path: "moda/dis-giyim",
    parent: "moda",
    discoverable: true,
    sizes: APPAREL_SIZES,
    minPrice: 99900,
    maxPrice: 499900,
    titles: ["Yagmurluk Trenckot", "Kapitone Mont", "Yun Kaban", "Deri Ceket"],
  },
  {
    slug: "kozmetik",
    name: "Kozmetik",
    path: "kozmetik",
    discoverable: true,
    sizes: [],
    minPrice: 0,
    maxPrice: 0,
    titles: [],
  },
  {
    slug: "parfum",
    name: "Parfum",
    path: "kozmetik/parfum",
    parent: "kozmetik",
    discoverable: true,
    sizes: [],
    minPrice: 49900,
    maxPrice: 249900,
    titles: ["Cicek Notali Parfum", "Odunsu Parfum", "Turunc Notali Parfum"],
  },
  {
    slug: "cilt-bakimi",
    name: "Cilt bakimi",
    path: "kozmetik/cilt-bakimi",
    parent: "kozmetik",
    discoverable: true,
    sizes: [],
    minPrice: 19900,
    maxPrice: 89900,
    titles: ["Nemlendirici Krem", "Temizleme Jeli", "Gunes Koruyucu", "Serum"],
  },
  // is_discoverable = FALSE: kesfet akisina girmez. Isimsiz gosterim tek
  // basina yeterli koruma degildir (docs/schema.sql).
  {
    slug: "ic-giyim",
    name: "Ic giyim",
    path: "ic-giyim",
    discoverable: false,
    sizes: APPAREL_SIZES,
    minPrice: 14900,
    maxPrice: 59900,
    titles: ["Pamuklu Takim", "Sutyen", "Bralet"],
  },
];

const COLORS = [
  "Siyah",
  "Bej",
  "Lacivert",
  "Beyaz",
  "Kahverengi",
  "Yesil",
  "Bordo",
  "Gri",
] as const;

const LEAF_CATEGORIES = CATEGORIES.filter((category) => category.titles.length > 0);

// --- tarih yardimcilari ------------------------------------------------------

const TODAY = new Date();
/** Gecmis gozlemler gece toplu isini taklit eder: 03:00 UTC. */
function observationDate(daysAgo: number): Date {
  const date = new Date(
    Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() - daysAgo, 3, 0, 0),
  );
  return date;
}

const HISTORY_START = observationDate(HISTORY_DAYS - 1);

// --- fiyat serisi ------------------------------------------------------------

type PricePointRow = { price: number; listPrice: number | null; inStock: boolean };

/** Kurusa yuvarla; para her zaman tamsayi, asla float. */
function kurus(value: number): number {
  return Math.round(value / 100) * 100;
}

/**
 * Normal seri: hafif dalgalanma, arada birkac gercek indirim.
 *
 * `inflated` seri: liste fiyati 12 gun once yukseltilir, 8 gun once fiyat
 * duser. Vitrindeki indirim yuzdesi buyuk gorunur ama gercek fiyat 60 gunun
 * ortalamasinin altina inmemistir — `docs/architecture.md` icindeki sahte
 * indirim sinyalinin tarif ettigi durum.
 */
function buildSeries(basePrice: number, inflated: boolean): PricePointRow[] {
  const series: PricePointRow[] = [];
  let price = basePrice;
  let listPrice = kurus(basePrice * 1.05);

  for (let index = 0; index < HISTORY_DAYS; index++) {
    const daysAgo = HISTORY_DAYS - 1 - index;

    if (inflated) {
      if (daysAgo === 12) listPrice = kurus(basePrice * 1.45);
      if (daysAgo === 8) price = kurus(basePrice * 0.82);
    } else {
      if (rng() < 0.06) price = kurus(price * (0.82 + rng() * 0.1));
      else if (rng() < 0.05) price = kurus(Math.min(basePrice * 1.08, price * 1.06));
      else price = kurus(price * (0.995 + rng() * 0.01));
      listPrice = kurus(Math.max(listPrice, price * 1.03));
    }

    series.push({
      price,
      listPrice,
      inStock: rng() > 0.05,
    });
  }
  return series;
}

// --- ana akis ----------------------------------------------------------------

await withClient(ownerUrl(), async (client) => {
  const url = ownerUrl();
  if (!isLocal(url) && !process.argv.includes("--force")) {
    throw new Error(
      "Tohum verisi yalnizca yerel veritabaninda calisir. Baska bir sunucuda " +
        "calistirmak icin --force gerekir; bu islem katalogu SILER.",
    );
  }

  // --- temizlik ---
  // CASCADE, product ve offer'a referans veren kullanici tablolarini da
  // bosaltir (saved_item, alert, click, product_view, collection_item, ...).
  // Gelistirme veritabaninda beklenen davranis budur.
  console.log("Mevcut katalog siliniyor...");
  await client.query(`
    TRUNCATE price_point, product_price_stats, similarity_edge, match_candidate,
             variant_stock_event, offer_variant, offer,
             product_slug_history, product, brand, category, merchant,
             -- embedding ve generated_content POLIMORFIKTIR: target_id bir
             -- foreign key DEGIL (offer/product/query gosterebiliyor), bu
             -- yuzden CASCADE onlara dokunmaz. RESTART IDENTITY yeni
             -- offer'lara ayni ID'leri verdigi icin, temizlenmezlerse eski
             -- vektorler sessizce BASKA urunlere yapisir. Sessiz yanlis veri,
             -- eksik veriden kotudur.
             embedding, generated_content
    RESTART IDENTITY CASCADE
  `);

  // --- gecmis partition'lari ---
  // 60 gunluk gecmis birden fazla aya yayilir. O aylarin partition'lari
  // yoksa satirlar default'a duser ve kritik uyari uretir.
  const created = await ensureMonthlyPartitions(client, HISTORY_START, TODAY);
  console.log(
    created.length > 0
      ? `Gecmis partition'lari acildi: ${created.join(", ")}`
      : "Gecmis partition'lari zaten mevcut.",
  );

  // --- merchant ---
  await insertRows(
    client,
    "merchant",
    [
      "slug",
      "name",
      "domain",
      "source_type",
      "feed_url",
      "refresh_minutes",
      "affiliate_network",
      "affiliate_status",
      "commission_rate_bp",
      "deeplink_template",
      "trust_score",
    ],
    MERCHANTS.map((merchant, index) => [
      merchant.slug,
      merchant.name,
      merchant.domain,
      "xml_feed",
      `https://${merchant.domain}/feed.xml`,
      360,
      "ornek-ag",
      "active",
      merchant.rate,
      `https://${merchant.domain}/git?u={url}&ref={click_id}`,
      70 + index * 5,
    ]),
  );
  const merchantRows = (
    await client.query<{ id: string; slug: string }>("SELECT id, slug FROM merchant ORDER BY id")
  ).rows;
  const merchantIds = merchantRows.map((row) => Number(row.id));
  const merchantBySlug = new Map<string, (typeof MERCHANTS)[number]>(
    MERCHANTS.map((merchant) => [merchant.slug, merchant]),
  );
  const merchantById = new Map(
    merchantRows.map((row) => [Number(row.id), merchantBySlug.get(row.slug)]),
  );

  // --- brand ---
  await insertRows(
    client,
    "brand",
    ["slug", "name", "name_norm"],
    BRANDS.map((name) => [slugify(name), name, slugify(name).replace(/-/g, "")]),
  );
  const brandIds = (
    await client.query<{ id: string }>("SELECT id FROM brand ORDER BY id")
  ).rows.map((row) => Number(row.id));

  // --- category ---
  for (const category of CATEGORIES) {
    await client.query(
      `INSERT INTO category (slug, name, parent_id, path, is_discoverable)
       VALUES ($1, $2, (SELECT id FROM category WHERE slug = $3), $4, $5)`,
      [category.slug, category.name, category.parent ?? null, category.path, category.discoverable],
    );
  }
  const categoryIds = new Map(
    (await client.query<{ id: string; slug: string }>("SELECT id, slug FROM category")).rows.map(
      (row) => [row.slug, Number(row.id)],
    ),
  );

  // --- product ---
  // Ayni modelin farkli renkleri ayni model_key'i paylasir; product renk
  // duzeyinde kanoniktir (docs/glossary.md).
  type ProductSeed = {
    slug: string;
    category: CategoryDef;
    basePrice: number;
    modelKey: string;
  };

  const productSeeds: ProductSeed[] = [];
  const productRows: unknown[][] = [];
  const usedSlugs = new Set<string>();
  let modelCounter = 0;

  while (productSeeds.length < PRODUCT_COUNT) {
    const category = pick(LEAF_CATEGORIES);
    const titleBase = pick(category.titles);
    const brandIndex = intBetween(0, brandIds.length - 1);
    const brandName = BRANDS[brandIndex] ?? "Ayda";
    modelCounter++;
    const modelKey = `mdl-${String(modelCounter).padStart(4, "0")}`;
    const colorCount = Math.min(intBetween(1, 3), PRODUCT_COUNT - productSeeds.length);
    const colors = [...COLORS].sort(() => rng() - 0.5).slice(0, colorCount);
    const basePrice = kurus(intBetween(category.minPrice, category.maxPrice));

    for (const color of colors) {
      const title = `${brandName} ${titleBase} ${color}`;
      let slug = slugify(title);
      let suffix = 2;
      while (usedSlugs.has(slug)) slug = `${slugify(title)}-${suffix++}`;
      usedSlugs.add(slug);

      productSeeds.push({ slug, category, basePrice, modelKey });
      productRows.push([
        slug,
        title,
        brandIds[brandIndex] ?? null,
        categoryIds.get(category.slug) ?? null,
        // Turkiye'de barkod siklikla bos; ucte birine veriyoruz.
        rng() < 0.33 ? String(8680000000000 + productSeeds.length) : null,
        modelKey,
        color,
        JSON.stringify({ renk: color, kategori: category.path }),
        imageUrl(MERCHANTS[0]?.domain ?? "modadeposu.example", `${slug}.jpg`),
      ]);
    }
  }

  await insertRows(
    client,
    "product",
    [
      "slug",
      "title",
      "brand_id",
      "category_id",
      "gtin",
      "model_key",
      "color",
      "attributes",
      "primary_image_url",
    ],
    productRows,
  );
  const productIds = new Map(
    (await client.query<{ id: string; slug: string }>("SELECT id, slug FROM product")).rows.map(
      (row) => [row.slug, Number(row.id)],
    ),
  );

  // --- offer ---
  // Her urun en az bir teklif alir; kalan teklifler rastgele urunlere dagilir,
  // boylece bazi urunlerde magaza karsilastirmasi olur.
  type OfferSeed = {
    externalId: string;
    merchantId: number;
    product: ProductSeed;
    basePrice: number;
  };
  const offerSeeds: OfferSeed[] = [];

  for (let index = 0; index < OFFER_COUNT; index++) {
    const product = productSeeds[index % productSeeds.length];
    if (!product) continue;
    const merchantId = merchantIds[index % merchantIds.length];
    if (merchantId === undefined) continue;
    // Ayni urun farkli magazada farkli fiyatlanir: karsilastirma anlamli olsun.
    const basePrice = kurus(product.basePrice * (0.88 + rng() * 0.28));
    offerSeeds.push({
      externalId: `ext-${String(index + 1).padStart(5, "0")}`,
      merchantId,
      product,
      basePrice,
    });
  }

  // Sahte indirim vitrinini test edebilmek icin birkac teklif isaretlenir.
  const inflatedOfferIndexes = new Set([3, 17, 42, 99, 250]);

  await insertRows(
    client,
    "offer",
    [
      "merchant_id",
      "product_id",
      "external_id",
      "url",
      "title_raw",
      "brand_raw",
      "category_raw",
      "image_url",
      "current_price",
      "list_price",
      "in_stock",
      "shipping_days",
      "shipping_cost",
      "free_shipping_threshold",
      "discovery_source",
      "first_seen_at",
    ],
    offerSeeds.map((offer, index) => {
      const inflated = inflatedOfferIndexes.has(index);
      const series = buildSeries(offer.basePrice, inflated);
      const last = series[series.length - 1];
      const merchant = merchantById.get(offer.merchantId);
      return [
        offer.merchantId,
        productIds.get(offer.product.slug) ?? null,
        offer.externalId,
        `https://${merchant?.domain ?? "modadeposu.example"}/urun/${offer.product.slug}`,
        offer.product.slug.replace(/-/g, " "),
        null,
        offer.product.category.path,
        imageUrl(merchant?.domain ?? "modadeposu.example", `${offer.externalId}.jpg`),
        last?.price ?? offer.basePrice,
        last?.listPrice ?? null,
        last?.inStock ?? true,
        intBetween(1, 5),
        // Kargo dahil toplam siralamayi anlamli kilar: en ucuz gorunen her
        // zaman en ucuz degildir.
        rng() < 0.4 ? 0 : kurus(intBetween(2900, 8900)),
        kurus(intBetween(15000, 50000)),
        rng() < 0.05 ? "user_link" : "feed",
        HISTORY_START,
      ];
    }),
  );

  const offerIds = new Map(
    (
      await client.query<{ id: string; external_id: string }>("SELECT id, external_id FROM offer")
    ).rows.map((row) => [row.external_id, Number(row.id)]),
  );

  // --- offer_variant + variant_stock_event ---
  const variantRows: unknown[][] = [];
  for (const offer of offerSeeds) {
    const offerId = offerIds.get(offer.externalId);
    if (offerId === undefined) continue;
    for (const size of offer.product.category.sizes) {
      variantRows.push([
        offerId,
        `${offer.externalId}-${slugify(size)}`,
        size,
        slugify(size),
        rng() > 0.25,
      ]);
    }
  }
  await insertRows(
    client,
    "offer_variant",
    ["offer_id", "external_id", "size_label", "size_norm", "in_stock"],
    variantRows,
  );

  // Stok olaylari yalnizca durum DEGISTIGINDE yazilir; her kosuda yazilirsa
  // tablo siser (docs/architecture.md). Birkac varyanta gecmis olay veriyoruz.
  const variants = (
    await client.query<{ id: string; in_stock: boolean }>(
      "SELECT id, in_stock FROM offer_variant ORDER BY id LIMIT 300",
    )
  ).rows;
  const stockEventRows: unknown[][] = [];
  for (const variant of variants) {
    if (rng() > 0.4) continue;
    const wentOutAt = observationDate(intBetween(10, 40));
    stockEventRows.push([Number(variant.id), false, wentOutAt]);
    if (variant.in_stock) {
      stockEventRows.push([Number(variant.id), true, observationDate(intBetween(1, 9))]);
    }
  }
  await insertRows(
    client,
    "variant_stock_event",
    ["variant_id", "in_stock", "observed_at"],
    stockEventRows,
  );

  // --- price_point ---
  // Fiyat degismemis olsa bile satir yazilir: surekliligin kendisi veridir.
  console.log(`Fiyat gecmisi yaziliyor (${HISTORY_DAYS} gun x ${offerSeeds.length} teklif)...`);
  const priceRows: unknown[][] = [];
  offerSeeds.forEach((offer, index) => {
    const offerId = offerIds.get(offer.externalId);
    if (offerId === undefined) return;
    const series = buildSeries(offer.basePrice, inflatedOfferIndexes.has(index));
    series.forEach((point, dayIndex) => {
      priceRows.push([
        offerId,
        observationDate(HISTORY_DAYS - 1 - dayIndex),
        point.price,
        point.listPrice,
        point.inStock,
      ]);
    });
  });
  await insertRows(
    client,
    "price_point",
    ["offer_id", "observed_at", "price", "list_price", "in_stock"],
    priceRows,
  );

  // --- product denormalizasyonu ---
  await client.query(`
    UPDATE product p SET
      min_price        = agg.min_price,
      max_price        = agg.max_price,
      offer_count      = agg.offer_count,
      in_stock_count   = agg.in_stock_count,
      price_updated_at = now()
    FROM (
      SELECT product_id,
             min(current_price) AS min_price,
             max(current_price) AS max_price,
             count(*)::int      AS offer_count,
             count(*) FILTER (WHERE in_stock)::int AS in_stock_count
        FROM offer
       WHERE product_id IS NOT NULL AND is_active
       GROUP BY product_id
    ) agg
    WHERE p.id = agg.product_id
  `);

  // --- product_price_stats ve similarity_edge BURADA URETILMEZ ---
  //
  // Ikisi de B5'in (services/ingest/similarity) isi. Tohum da hesaplasaydi
  // ayni mantik iki yerde yasar ve ayrisirdi; ustelik tohumun urettigi
  // `list_price_inflated` gercek algoritmanin sonucu degil, elle secilmis
  // birkac urundu.
  //
  // Tohumdan sonra calistirin:
  //   python -m enrich --kind both     (embedding'ler)
  //   python -m similarity             (kenarlar + fiyat istatistikleri)

  // --- ozet ---
  const summary = await client.query<{ label: string; count: string }>(`
    SELECT 'merchant' AS label, count(*)::text FROM merchant
    UNION ALL SELECT 'brand', count(*)::text FROM brand
    UNION ALL SELECT 'category', count(*)::text FROM category
    UNION ALL SELECT 'product', count(*)::text FROM product
    UNION ALL SELECT 'offer', count(*)::text FROM offer
    UNION ALL SELECT 'offer_variant', count(*)::text FROM offer_variant
    UNION ALL SELECT 'variant_stock_event', count(*)::text FROM variant_stock_event
    UNION ALL SELECT 'price_point', count(*)::text FROM price_point
    UNION ALL SELECT 'product_price_stats', count(*)::text FROM product_price_stats
    UNION ALL SELECT 'similarity_edge', count(*)::text FROM similarity_edge
  `);

  console.log("\nTohum verisi hazir:");
  for (const row of summary.rows) {
    console.log(`  ${row.label.padEnd(22)} ${row.count}`);
  }

  const months = await client.query<{ partition: string; count: string }>(`
    SELECT c.relname AS partition, (
      SELECT count(*)::text FROM price_point pp
       WHERE pp.tableoid = c.oid
    ) AS count
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'price_point'::regclass
    ORDER BY c.relname
  `);
  console.log("\nFiyat gecmisinin partition dagilimi:");
  for (const row of months.rows) {
    console.log(`  ${row.partition.padEnd(22)} ${row.count}`);
  }
  console.log(
    "\nSonraki adim — bu tablolari tohum DOLDURMAZ:\n" +
      "  python -m enrich --kind both   embedding'ler\n" +
      "  python -m similarity           similarity_edge + product_price_stats",
  );
});
