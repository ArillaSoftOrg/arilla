/**
 * Anlamsal arama hangi indeksi okuyacak (karar 0181): `embedding_index` tablosundaki `active`
 * satir. Gecis Python tarafinda tek islemde yapilir (`python -m enrich.index activate`); bu modul
 * yalnizca okur ve kisa sureli (surec geneli) onbellekler. Model cagirmaz.
 *
 * Guvenlik: tablo adi ve boyut SQL'e yalnizca `QUERYABLE_INDEXES` beyaz listesinden girer.
 * Aktif model TS'nin sorgu vektoru uretebildigi bir model degilse (ornegin yalniz Python'da
 * calisan yerel CPU modeli) sonuc `null`dur: golge olcum `no_vector` yazar, sorgu karismaz.
 *
 * Kayit defteri paritesi: `active-index.test.ts`, `services/ingest/enrich/model_registry.json`
 * ile model/boyut/gorev/tablo uyumunu dogrular (Python ve TS birbirini cagirmaz; dosya testte okunur).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { DEFAULT_SEMANTIC_MODEL, isValidModelVersion } from "./config.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type SemanticTable =
  | "product_text_embedding"
  | "product_text_embedding_d384"
  | "product_text_embedding_d1024";

/** SQL'e girebilen tablolar (tek beyaz liste; semantic-candidates ve inventory buradan okur). */
export const SEMANTIC_TABLES: readonly SemanticTable[] = [
  "product_text_embedding",
  "product_text_embedding_d384",
  "product_text_embedding_d1024",
];

/** Sorgu vektorunu kim uretir: Jina API ya da kendi servisimiz (`remote_http`, karar 0182/0196). */
export type QueryProvider = "jina" | "remote_http";

/**
 * Sonuc birlestirme: `rrf_gate` Jina icin kalibre (mutlak kosinus kapisi + RRF, karar 0170/0178);
 * `conditional_hybrid` BGE-M3 icin (karar 0196): BGE'de alakasiz urunler de 0,45-0,61 kosinus alir,
 * mutlak esik calismaz; lexical sonuclar korunur, anlamsal eklemeler sorgu-ici goreli esikle girer.
 */
export type FusionKind = "rrf_gate" | "conditional_hybrid";

/** `remote_http` sorgu servisi: adres ve anahtar ORTAM DEGISKENI adlari (degerler kodda yok). */
export interface QueryEndpointSpec {
  urlEnv: string;
  tokenEnv: string;
  /** Servisin bildirdigi model adi; yanitta ayni olmali (kayit defteri `endpoint.served_model`). */
  servedModel: string;
}

export interface SemanticIndex {
  modelVersion: string;
  table: SemanticTable;
  dimensions: number;
  /** Jina `task` (sorgu tarafi); `remote_http`te yalniz kayit icin ("query"). */
  queryTask: string;
  /** Varsayilan `jina`. */
  provider?: QueryProvider;
  /** `provider = remote_http` icin zorunlu. */
  endpoint?: QueryEndpointSpec;
  /** Varsayilan `rrf_gate`. */
  fusion?: FusionKind;
}

/** TS'nin sorgu vektoru uretebildigi modeller (uzak API). Yerel CPU modelleri burada YOK. */
export const QUERYABLE_INDEXES: Readonly<Record<string, SemanticIndex>> = {
  "jina-embeddings-v3": {
    modelVersion: "jina-embeddings-v3",
    table: "product_text_embedding",
    dimensions: 768,
    queryTask: "retrieval.query",
    provider: "jina",
    fusion: "rrf_gate",
  },
  /**
   * BGE-M3 (karar 0196): sorgu AYRI TEI servisinden (`EMBED_BGE_M3_QUERY_URL`), onek yok, CLS havuzlama.
   * Bu satir sorgulanabilirligi tanimlar; sunum yine hazir HNSW indeksi, saglikli servis ve gecen
   * kanarya ister (kayit defterinde model `disabled` kaldikca hicbir sey kendiliginden acilmaz).
   */
  "bge-m3-5617a9f6": {
    modelVersion: "bge-m3-5617a9f6",
    table: "product_text_embedding_d1024",
    dimensions: 1024,
    queryTask: "query",
    provider: "remote_http",
    endpoint: {
      urlEnv: "EMBED_BGE_M3_QUERY_URL",
      tokenEnv: "EMBED_BGE_M3_QUERY_TOKEN",
      servedModel: "BAAI/bge-m3",
    },
    fusion: "conditional_hybrid",
  },
};

export const DEFAULT_SEMANTIC_INDEX: SemanticIndex = QUERYABLE_INDEXES[
  DEFAULT_SEMANTIC_MODEL
] as SemanticIndex;

export type IndexResolution =
  | { index: SemanticIndex; source: "env" | "db" | "fallback" }
  | { index: null; reason: "unsupported_model" | "no_active_index"; modelVersion: string };

type ActiveRow = {
  model_version: string;
  storage_table: string;
  dimensions: number;
};

/** Aktif satir degisimi en gec bu sure sonra gorulur. */
export const ACTIVE_INDEX_TTL_MS = 60_000;

let cached: { at: number; value: ActiveRow | null } | null = null;

/** Testler icin: surec geneli onbellegi bosaltir. */
export function resetActiveIndexCache(): void {
  cached = null;
}

async function defaultReadActive(db: Database): Promise<ActiveRow | null> {
  const rows = await db.execute<ActiveRow>(sql`
    SELECT model_version, storage_table, dimensions
      FROM embedding_index
     WHERE target = 'product_text' AND state = 'active'
  `);
  const row = rows.rows[0];
  return row ? { ...row, dimensions: Number(row.dimensions) } : null;
}

/** Satir beyaz listedeki bir indeksle birebir ortusuyorsa onu doner. */
export function indexForRow(row: ActiveRow): SemanticIndex | null {
  const known = QUERYABLE_INDEXES[row.model_version];
  if (!known) return null;
  return known.table === row.storage_table && known.dimensions === row.dimensions ? known : null;
}

export interface ResolveDeps {
  env?: Env;
  now?: () => number;
  readActive?: (db: Database) => Promise<ActiveRow | null>;
}

/**
 * Oncelik: `SEMANTIC_EMBEDDING_MODEL` (acik ayar; 0178'deki anlamiyla) > `embedding_index` aktif satiri >
 * varsayilan. Tablo okunamazsa (ornegin migration oncesi) varsayilana duser; hic firlatmaz.
 */
export async function resolveSemanticIndex(
  db: Database,
  deps: ResolveDeps = {},
): Promise<IndexResolution> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const override = env.SEMANTIC_EMBEDDING_MODEL?.trim();
  if (override && isValidModelVersion(override)) {
    // 0178 davranisi korunur: listede olmayan ad varsayilan 768'lik tabloda o `model_version`
    // ile aranir (satirlar model adina gore suzulur; baska modelin vektoru karismaz).
    const index = QUERYABLE_INDEXES[override] ?? {
      ...DEFAULT_SEMANTIC_INDEX,
      modelVersion: override,
    };
    return { index, source: "env" };
  }

  let row: ActiveRow | null;
  if (cached && now() - cached.at < ACTIVE_INDEX_TTL_MS) {
    row = cached.value;
  } else {
    try {
      row = await (deps.readActive ?? defaultReadActive)(db);
    } catch {
      return { index: DEFAULT_SEMANTIC_INDEX, source: "fallback" };
    }
    cached = { at: now(), value: row };
  }
  if (row === null) {
    return { index: null, reason: "no_active_index", modelVersion: DEFAULT_SEMANTIC_MODEL };
  }
  const index = indexForRow(row);
  return index
    ? { index, source: "db" }
    : { index: null, reason: "unsupported_model", modelVersion: row.model_version };
}
