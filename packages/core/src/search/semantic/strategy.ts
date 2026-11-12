/**
 * Anlamsal aday arama STRATEJI SECICI (karar 0188). Saf fonksiyon: veritabani, ag, model ya da
 * saat okumaz (zaman `now` ile verilir). Canli aramaya BAGLI DEGILDIR; `semantic-candidates.ts`
 * bugunku yolu (global KNN + sonradan filtre) kullanmaya devam eder.
 *
 * Neden (E3-d.1, 50.200 gercek BGE-M3 vektoru, yerel olcum):
 * - Global HNSW + kategori filtresi, sorgu kategoriyle celisince Recall@10 0,22-0,66'ya duser ve
 *   sonuc eksik kalir (orta kategoride sorgularin %36'si < 10 sonuc).
 * - Kategoriye ozgu kismi (partial) HNSW ayni durumda ef_search 400 ile 0,97-0,997 verir.
 * - B-tree + kesin siralama ~2 bin satira kadar < 10 ms ve tam dogru.
 * - Fiyat filtresi anlamdan bagimsizdir; global HNSW yeterlidir (0,975).
 *
 * Kurallar (ozet):
 * 1. Yalniz istenen model ve indeks surumune ait, HAZIR (`ready`) indeksler aday olur; farkli
 *    vektor uzaylari (ornek jina-embeddings-v3 ve bge-m3) asla karistirilmaz.
 * 2. Kullanicinin ACIKCA sectigi kategori kesin kosuldur; sorgudan TAHMIN edilen kategori varsayilan
 *    olarak kesin filtreye donusmez (siralama sinyali olur).
 * 3. Envanter bilinmiyorsa, istatistik eski/gecersizse ya da uygun indeks yoksa guvenli geri donus:
 *    bugunku davranis (`legacy_postfilter`). Hicbir zaman eksik/uyumsuz indeks secilmez.
 * 4. Kismi indeks secildiginde kategori SQL'e beyaz listeden SABIT yazilmalidir (ya da
 *    `plan_cache_mode = force_custom_plan`): kategori parametre olup genel plan kullanilirsa
 *    PostgreSQL kismi indeksi KULLANAMAZ (E3-d.1'de olculdu).
 *
 * Bu modul SQL uretmez. Gelecekteki SQL entegrasyonu `IndexDescriptor.scope.value`'yu yalniz
 * `isSafeCategoryLiteral` dogrulamasindan sonra ve envanterden (kullanici girdisinden degil) kullanir.
 */

export type CategorySource = "explicit" | "inferred";

export type IndexKind = "global_hnsw" | "partial_hnsw" | "binary_hnsw" | "btree_category";

export type IndexState = "building" | "ready" | "invalid" | "retired";

export type IndexScope =
  | { type: "global" }
  | { type: "category_top"; value: string }
  | { type: "category_path"; value: string }
  | { type: "category_null" };

/** Indeks envanteri satiri (gelecekte `embedding_index` benzeri bir tablodan okunur). */
export interface IndexDescriptor {
  /** Veritabanindaki indeks adi; SQL'e yalniz bu envanterden girer. */
  id: string;
  kind: IndexKind;
  /** Vektor uzayi kimligi (= `model_version`). `btree_category` icin `null`. */
  modelVersion: string | null;
  /** Indeks surumu (m/ef_construction/opclass degisince artar). `btree_category` icin `null`. */
  indexVersion: string | null;
  scope: IndexScope;
  state: IndexState;
  /** Binary + yeniden siralama icin: kalite (ANN isabeti) bu indeksle olculup onaylandi mi? */
  qualityVerified?: boolean;
}

export interface CategoryStat {
  /** Kategori yolu, ornek `giyim/ust-giyim` ya da ust kategori `giyim`. */
  path: string;
  /** Bu kategoride (alt kategoriler dahil) aranabilir urun sayisi. */
  rows: number;
  /** Istatistigin hesaplandigi an. */
  computedAt: Date;
}

export interface StrategyConfig {
  /** Bu sayiya kadar (dahil) satir: B-tree + kesin siralama. E3-d.1: ~2 bin (< 10 ms). */
  exactMaxRows: number;
  /** Bundan eski kategori istatistigi kullanilmaz. */
  statsMaxAgeMs: number;
  /** Global HNSW ef_search (E3-d: 100-200 -> Recall@10 0,97-0,99). */
  efSearchGlobal: number;
  /** Kismi HNSW ef_search (E3-d.1: 400 -> celisen sorguda 0,971). */
  efSearchPartial: number;
  /** Binary + yeniden siralama aday sayisi (E3-d: 400 -> 0,98-0,995). */
  binaryRerankK: number;
  /** Binary HNSW stratejisine izin (varsayilan kapali; yalniz dogrulanmis indekste). */
  allowBinary: boolean;
  /** Tahmin edilen kategoride kategorisiz urunler ikincil aday kaynagi olabilir mi? */
  uncategorizedAsSecondary: boolean;
}

export const DEFAULT_STRATEGY_CONFIG: Readonly<StrategyConfig> = Object.freeze({
  exactMaxRows: 2000,
  statsMaxAgeMs: 24 * 60 * 60 * 1000,
  efSearchGlobal: 150,
  efSearchPartial: 400,
  binaryRerankK: 400,
  allowBinary: false,
  uncategorizedAsSecondary: true,
});

export interface StrategyInput {
  /** Sorgu vektorunun uzayi; yalniz bu modele ait indeksler kullanilir. */
  modelVersion: string;
  /** Beklenen indeks surumu; verilirse farkli surumdeki indeks kullanilmaz. */
  indexVersion?: string;
  category: { path: string; source: CategorySource } | null;
  /** Fiyat araligi var mi (anlamdan bagimsiz filtre; global HNSW ile uyumlu). */
  hasPriceFilter: boolean;
  /** `null`: envanter bilinmiyor (bugunku durum) -> guvenli geri donus. */
  inventory: readonly IndexDescriptor[] | null;
  /** `null`: istatistik yok. Anahtar kategori yolu. */
  categoryStats: ReadonlyMap<string, CategoryStat> | null;
  now: Date;
  config?: Partial<StrategyConfig>;
}

export type StrategyKind =
  | "legacy_postfilter"
  | "global_hnsw"
  | "partial_hnsw"
  | "exact_btree"
  | "binary_rerank";

export type UncategorizedPolicy = "included" | "excluded" | "secondary_candidates";

export interface StrategyDecision {
  strategy: StrategyKind;
  /** Kullanilacak indeks (`legacy_postfilter` icin `null`). */
  indexId: string | null;
  efSearch: number | null;
  rerankK: number | null;
  /** Kategori nasil uygulanir: kesin filtre, yalniz siralama sinyali ya da yok. */
  categoryMode: "hard" | "soft" | "none";
  categoryPath: string | null;
  uncategorized: UncategorizedPolicy;
  /** Kismi indeks secildiyse SQL'de kategori SABIT olmali (genel plan riski). */
  requiresCategoryLiteral: boolean;
  /** Secim ideal degilse (geri donus) true. */
  degraded: boolean;
  reasons: string[];
}

const CATEGORY_LITERAL = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** SQL'e sabit olarak yazilabilecek kategori yolu mu (yalniz kucuk harf, rakam, `-`, `/`). */
export function isSafeCategoryLiteral(value: string): boolean {
  return value.length > 0 && value.length <= 200 && CATEGORY_LITERAL.test(value);
}

export function resolveStrategyConfig(partial: Partial<StrategyConfig> = {}): StrategyConfig {
  const config = { ...DEFAULT_STRATEGY_CONFIG, ...partial };
  const positiveInt = (n: number) => Number.isInteger(n) && n > 0;
  if (
    !positiveInt(config.exactMaxRows) ||
    !positiveInt(config.statsMaxAgeMs) ||
    !positiveInt(config.efSearchGlobal) ||
    !positiveInt(config.efSearchPartial) ||
    !positiveInt(config.binaryRerankK) ||
    config.efSearchGlobal > 1000 ||
    config.efSearchPartial > 1000
  ) {
    throw new RangeError("gecersiz strateji yapilandirmasi");
  }
  return config;
}

function topLevel(path: string): string {
  return path.split("/")[0] ?? path;
}

/** Bu sorgunun vektor uzayinda, hazir ve (istenirse) ayni surumdeki indeksler. */
function usable(input: StrategyInput, reasons: string[]): IndexDescriptor[] {
  const out: IndexDescriptor[] = [];
  for (const index of input.inventory ?? []) {
    if (index.state !== "ready") {
      reasons.push(`indeks_hazir_degil:${index.id}`);
      continue;
    }
    if (index.kind !== "btree_category") {
      if (index.modelVersion !== input.modelVersion) {
        reasons.push(`model_uyusmuyor:${index.id}`);
        continue;
      }
      if (input.indexVersion !== undefined && index.indexVersion !== input.indexVersion) {
        reasons.push(`surum_uyusmuyor:${index.id}`);
        continue;
      }
    }
    if (index.scope.type !== "global" && index.scope.type !== "category_null") {
      if (!isSafeCategoryLiteral(index.scope.value)) {
        reasons.push(`guvensiz_kapsam:${index.id}`);
        continue;
      }
    }
    out.push(index);
  }
  return out;
}

function base(
  input: StrategyInput,
  categoryMode: StrategyDecision["categoryMode"],
  uncategorized: UncategorizedPolicy,
  reasons: string[],
): StrategyDecision {
  return {
    strategy: "legacy_postfilter",
    indexId: null,
    efSearch: null,
    rerankK: null,
    categoryMode,
    categoryPath: input.category?.path ?? null,
    uncategorized,
    requiresCategoryLiteral: false,
    degraded: true,
    reasons,
  };
}

function unfiltered(
  input: StrategyInput,
  indexes: IndexDescriptor[],
  config: StrategyConfig,
  decision: StrategyDecision,
): StrategyDecision {
  const global = indexes.find((i) => i.kind === "global_hnsw" && i.scope.type === "global");
  if (global) {
    decision.reasons.push(input.hasPriceFilter ? "fiyat_filtresi_global_uyumlu" : "filtresiz");
    return {
      ...decision,
      strategy: "global_hnsw",
      indexId: global.id,
      efSearch: config.efSearchGlobal,
      degraded: false,
    };
  }
  const binary = indexes.find(
    (i) => i.kind === "binary_hnsw" && i.scope.type === "global" && i.qualityVerified === true,
  );
  if (config.allowBinary && binary) {
    decision.reasons.push("global_hnsw_yok_binary_dogrulanmis");
    return {
      ...decision,
      strategy: "binary_rerank",
      indexId: binary.id,
      efSearch: config.binaryRerankK,
      rerankK: config.binaryRerankK,
      degraded: false,
    };
  }
  decision.reasons.push("uygun_global_indeks_yok");
  return decision;
}

/** Strateji secer. Yan etkisizdir; ayni girdi her zaman ayni ciktiyi verir. */
export function selectSemanticStrategy(input: StrategyInput): StrategyDecision {
  const config = resolveStrategyConfig(input.config);
  const reasons: string[] = [];
  const explicit = input.category?.source === "explicit";
  const inferred = input.category?.source === "inferred";
  const categoryMode = explicit ? "hard" : inferred ? "soft" : "none";
  const uncategorized: UncategorizedPolicy = explicit
    ? "excluded"
    : inferred && config.uncategorizedAsSecondary
      ? "secondary_candidates"
      : "included";
  const decision = base(input, categoryMode, uncategorized, reasons);

  if (input.category && !isSafeCategoryLiteral(input.category.path)) {
    reasons.push("gecersiz_kategori_yolu");
    // Gecersiz yol hicbir indeksle eslestirilmez; acik kategoride bugunku yol (sonradan filtre).
    return { ...decision, categoryMode: "none", categoryPath: null, uncategorized: "included" };
  }
  if (input.inventory === null) {
    reasons.push("envanter_bilinmiyor");
    return decision;
  }
  const indexes = usable(input, reasons);

  // Kategori yok ya da yalniz tahmin: kesin filtre yok -> filtresiz strateji (kategori siralamada).
  if (!explicit) {
    if (inferred) reasons.push("tahmin_edilen_kategori_kesin_filtre_degil");
    return unfiltered(input, indexes, config, decision);
  }

  const path = input.category?.path as string;
  const stat = input.categoryStats?.get(path);
  const statOk =
    stat !== undefined &&
    Number.isInteger(stat.rows) &&
    stat.rows >= 0 &&
    !Number.isNaN(stat.computedAt.getTime()) &&
    input.now.getTime() - stat.computedAt.getTime() <= config.statsMaxAgeMs &&
    stat.computedAt.getTime() <= input.now.getTime();
  const partial = indexes.find(
    (i) =>
      i.kind === "partial_hnsw" &&
      ((i.scope.type === "category_path" && i.scope.value === path) ||
        (i.scope.type === "category_top" && i.scope.value === path && topLevel(path) === path)),
  );
  const btree = indexes.find((i) => i.kind === "btree_category");
  const partialDecision = (why: string): StrategyDecision => {
    reasons.push(why);
    return {
      ...decision,
      strategy: "partial_hnsw",
      indexId: (partial as IndexDescriptor).id,
      efSearch: config.efSearchPartial,
      requiresCategoryLiteral: true,
      degraded: false,
    };
  };

  if (!statOk) {
    reasons.push(
      stat === undefined ? "kategori_istatistigi_yok" : "kategori_istatistigi_eski_ya_da_gecersiz",
    );
    // Boyut bilinmeden kesin siralama secilmez (cok buyuk olabilir). Kismi indeks boyuttan
    // bagimsiz dogru ve hizli oldugu icin guvenlidir; yoksa bugunku yol.
    if (partial) return partialDecision("istatistiksiz_kismi_indeks");
    return decision;
  }
  if (stat.rows === 0) {
    reasons.push("kategori_bos");
    if (btree) {
      return { ...decision, strategy: "exact_btree", indexId: btree.id, degraded: false };
    }
    return decision;
  }
  if (stat.rows <= config.exactMaxRows) {
    if (btree) {
      reasons.push(`kucuk_kategori:${stat.rows}<=${config.exactMaxRows}`);
      return { ...decision, strategy: "exact_btree", indexId: btree.id, degraded: false };
    }
    if (partial) return partialDecision("btree_yok_kismi_indeks");
    reasons.push("kucuk_kategori_btree_yok");
    return decision;
  }
  if (partial) return partialDecision(`buyuk_kategori:${stat.rows}>${config.exactMaxRows}`);
  const binary = indexes.find(
    (i) =>
      i.kind === "binary_hnsw" &&
      i.qualityVerified === true &&
      i.scope.type !== "global" &&
      i.scope.type !== "category_null" &&
      i.scope.value === path,
  );
  if (config.allowBinary && binary) {
    reasons.push("kismi_binary_dogrulanmis");
    return {
      ...decision,
      strategy: "binary_rerank",
      indexId: binary.id,
      efSearch: config.binaryRerankK,
      rerankK: config.binaryRerankK,
      requiresCategoryLiteral: true,
      degraded: false,
    };
  }
  // Global HNSW + filtre bilerek SECILMEZ (E3-d.1: celisen sorguda eksik sonuc).
  reasons.push("buyuk_kategori_kismi_indeks_yok");
  return decision;
}
