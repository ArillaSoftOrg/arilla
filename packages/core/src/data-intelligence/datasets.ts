/**
 * Veri seti şemaları ve veri sözlüğü (Faz 3). Sütun listesi AÇIK izin listesidir:
 * burada olmayan sütun çıktıya yazılamaz (`validateRows` reddeder). Olay türleri
 * ayrı satırlarda kalır — görüntüleme, çıkış ve (ileride) arama/satın alma tek
 * ölçüde toplanmaz.
 */
import type { DiDatasetKey } from "@arilla/db";
import type { DataSourceId } from "./policy.ts";

export type ColumnType = "date" | "text" | "integer" | "enum";

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  description: string;
  /** `enum` için izinli değerler. */
  values?: readonly string[];
  /** `text`/`date` için tam eşleşme deseni (slug biçimi: serbest metin yok). */
  pattern?: RegExp;
}

export interface DatasetSpec {
  key: DiDatasetKey;
  title: string;
  specVersion: string;
  description: string;
  sources: readonly DataSourceId[];
  /** Kaynak olay yazılmıyorsa `false`: üretim `blocked` kaydı bırakır, satır uydurulmaz. */
  producible: boolean;
  notProducibleReason?: string;
  /** Her satırı tekilleştiren sütunlar (kalite: tekillik). */
  keyColumns: readonly string[];
  /** Başka bir veri setiyle ortak (birleştirilebilir) niteleyici sütunlar; hafta hariç. */
  linkColumns: readonly string[];
  columns: readonly ColumnSpec[];
  limitations: readonly string[];
}

export const EVENT_TYPES = ["product_view", "merchant_exit"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const USERS_BANDS = ["10-19", "20-49", "50-99", "100+"] as const;

const WEEK: ColumnSpec = {
  name: "week_start",
  type: "date",
  description: "ISO haftasının başlangıcı (Pazartesi), UTC, YYYY-MM-DD.",
  pattern: /^\d{4}-\d{2}-\d{2}$/,
};
const EVENT_TYPE: ColumnSpec = {
  name: "event_type",
  type: "enum",
  description:
    "Olay türü. product_view = ürün sayfası görüntüleme; merchant_exit = mağazaya çıkış. İki tür asla tek satırda toplanmaz.",
  values: EVENT_TYPES,
};
const EVENTS: ColumnSpec = {
  name: "events",
  type: "integer",
  description: `Hücredeki olay sayısı; kişi başına en fazla katkı sınırlıdır (contribution cap).`,
};
const USERS_BAND: ColumnSpec = {
  name: "users_band",
  type: "enum",
  description: "Hücreye katkı veren farklı kişi sayısının bandı. Kesin sayı yayımlanmaz.",
  values: USERS_BANDS,
};
const CATEGORY_PATH: ColumnSpec = {
  name: "category_path",
  type: "text",
  description:
    "Kategori yolunun en çok ilk iki düzeyi (ör. moda/canta). Hassas kategoriler elenir.",
  pattern: /^[a-z0-9][a-z0-9-]{0,59}(\/[a-z0-9][a-z0-9-]{0,59})?$/,
};

export const DATASET_SPECS: Readonly<Record<DiDatasetKey, DatasetSpec>> = {
  category_trends: {
    key: "category_trends",
    title: "Kategori eğilimleri",
    specVersion: "1.0.0",
    description:
      "Haftalık ürün görüntüleme ve mağaza çıkışı hacmi, kategori yoluna göre. Yalnızca k-eşiğini geçen hücreler.",
    sources: ["user_activity_event"],
    producible: true,
    keyColumns: ["week_start", "category_path", "event_type"],
    linkColumns: ["category_path"],
    columns: [WEEK, CATEGORY_PATH, EVENT_TYPE, EVENTS, USERS_BAND],
    limitations: [
      "Kategori, olay anında değil üretim anındaki katalog atamasıdır.",
      "Arama olayları dahil değil (arama olayında kategori yok).",
      "Yalnızca girişli ve analitik rızalı kullanıcılar: tüm trafiği temsil etmez.",
    ],
  },
  brand_interest_trends: {
    key: "brand_interest_trends",
    title: "Marka ilgi eğilimleri",
    specVersion: "1.0.0",
    description:
      "Haftalık ürün görüntüleme ve mağaza çıkışı hacmi, marka slug'ına göre. Yalnızca k-eşiğini geçen hücreler.",
    sources: ["user_activity_event"],
    producible: true,
    keyColumns: ["week_start", "brand_slug", "event_type"],
    linkColumns: ["brand_slug"],
    columns: [
      WEEK,
      {
        name: "brand_slug",
        type: "text",
        description: "Katalogdaki marka slug'ı (besleme kaynaklı; biçimi doğrulanmış).",
        pattern: /^[a-z0-9][a-z0-9-]{0,79}$/,
      },
      EVENT_TYPE,
      EVENTS,
      USERS_BAND,
    ],
    limitations: [
      "Marka, üretim anındaki katalog atamasıdır; markasız ürünler elenir.",
      "Yalnızca girişli ve analitik rızalı kullanıcılar.",
    ],
  },
  price_range_trends: {
    key: "price_range_trends",
    title: "Fiyat aralığı eğilimleri",
    specVersion: "1.0.0",
    description:
      "Haftalık mağaza çıkışı hacmi, kategori ve çıkış anındaki fiyat bandına göre. Fiyat yalnızca çıkış anında kaydedilen değerdir.",
    sources: ["user_activity_event"],
    producible: true,
    keyColumns: ["week_start", "category_path", "price_band", "event_type"],
    linkColumns: ["category_path"],
    columns: [
      WEEK,
      CATEGORY_PATH,
      {
        name: "price_band",
        type: "enum",
        description: "Çıkış anındaki fiyat bandı (TRY, alt sınır dahil üst sınır hariç).",
        values: ["0-250", "250-500", "500-1000", "1000-2500", "2500-5000", "5000-10000", "10000+"],
      },
      { ...EVENT_TYPE, values: ["merchant_exit"] },
      EVENTS,
      USERS_BAND,
    ],
    limitations: [
      "Yalnızca mağaza çıkışı: ürün görüntülemede olay anı fiyatı yok, bu yüzden dahil değil.",
      "Para birimi yalnızca TRY; 1–5.000.000 TL dışı fiyatlar elenir.",
      "Yalnızca girişli ve analitik rızalı kullanıcılar.",
    ],
  },
  alternative_search_trends: {
    key: "alternative_search_trends",
    title: "Alternatif ürün arama eğilimleri",
    specVersion: "1.0.0",
    description: "Alternatif ürün arama/tercih eğilimleri.",
    sources: [],
    producible: false,
    notProducibleReason:
      "no_event_source: alternatives_shown/alternative_clicked yazılmıyor (events.md) ve click.source_similarity_kind'i yazan yüzey yok.",
    keyColumns: [],
    linkColumns: [],
    columns: [],
    limitations: ["Kaynak olay toplanmadığı için üretilemez; satır uydurulmaz."],
  },
};

export const DATASET_KEYS = Object.keys(DATASET_SPECS) as DiDatasetKey[];

export function isDatasetKey(value: unknown): value is DiDatasetKey {
  return typeof value === "string" && Object.hasOwn(DATASET_SPECS, value);
}

/** Veri sözlüğü: dışa aktarılan `data_dictionary.json`'un gövdesi. */
export function dataDictionary(spec: DatasetSpec): {
  dataset: string;
  specVersion: string;
  description: string;
  columns: { name: string; type: ColumnType; description: string; values?: readonly string[] }[];
  limitations: readonly string[];
} {
  return {
    dataset: spec.key,
    specVersion: spec.specVersion,
    description: spec.description,
    columns: spec.columns.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      ...(c.values ? { values: c.values } : {}),
    })),
    limitations: spec.limitations,
  };
}
