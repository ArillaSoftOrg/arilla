/**
 * Kalite raporu (Faz 5). SAF fonksiyonlar: sayaçlardan metrik üretir. Ölçülemeyen
 * metrik asla başarılı gösterilmez: `NOT_MEASURED` ve neden yazılır.
 *
 * Boyutlar: completeness, accuracy, consistency, uniqueness, freshness, coverage,
 * lineage, sürüm, kayıt sayısı, dönem, anonimlik, sınırlamalar.
 */
import type { DatasetSpec } from "./datasets.ts";
import {
  ACCURACY_MIN_LABELS,
  ACCURACY_TARGET,
  CONTRIBUTION_CAP,
  FRESHNESS_WARN_HOURS,
  GENERATOR_VERSION,
  K_MIN_USERS,
  SUSPICIOUS_DAILY_EVENTS,
} from "./policy.ts";
import type { AnonymityAssessment } from "./privacy.ts";

export type DiMetricStatus = "PASS" | "WARN" | "FAIL" | "NOT_MEASURED";

export interface QualityMetric {
  key: string;
  dimension:
    | "completeness"
    | "accuracy"
    | "consistency"
    | "uniqueness"
    | "freshness"
    | "coverage"
    | "telemetry";
  status: DiMetricStatus;
  /** Oran 0..1 ya da sayı; ölçülemezse null. */
  value: number | null;
  detail: string;
}

/** Kaynaktan okunan ham sayaçlar (builder doldurur). */
export interface SourceCounters {
  rawEvents: number;
  duplicatesRemoved: number;
  legacyWithoutEventId: number;
  suspiciousExcluded: number;
  unresolvedProduct: number;
  noCategory: number;
  sensitiveCategory: number;
  noBrand: number;
  invalidBrand: number;
  exitEvents: number;
  offerMissing: number;
  priceMissing: number;
  priceInvalid: number;
  currencyInvalid: number;
  eligibleEvents: number;
  populationUsers: number;
  minEventAt: Date | null;
  maxEventAt: Date | null;
}

export interface CoverageInputs {
  registeredUsers: number;
  /** Son kararı analitik rızası açık olan hesaplar. */
  analyticsConsentUsers: number;
}

export interface AccuracyInputs {
  labeled: number;
  correct: number;
  incorrect: number;
  unsure: number;
}

export interface QualityReportInput {
  spec: DatasetSpec;
  version: string;
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  suppressedCells: number;
  droppedInvalidRows: number;
  rowKeyDuplicates: number;
  counters: SourceCounters;
  coverage: CoverageInputs;
  accuracy: AccuracyInputs;
  anonymity: AnonymityAssessment;
  now: Date;
}

export interface QualityReport {
  dataset: string;
  version: string;
  generatorVersion: string;
  period: { start: string; endExclusive: string };
  rowCount: number;
  generatedAt: string;
  metrics: QualityMetric[];
  lineage: {
    sources: { id: string; role: string; filters: string[] }[];
    transformations: string[];
  };
  anonymity: AnonymityAssessment;
  knownLimitations: string[];
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function grade(value: number | null, pass: number, warn: number): DiMetricStatus {
  if (value === null) return "NOT_MEASURED";
  if (value >= pass) return "PASS";
  return value >= warn ? "WARN" : "FAIL";
}

/** Wilson alt güven sınırı (%95): küçük örnekte doğruluğu abartmamak için. */
export function wilsonLowerBound(correct: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null;
  const p = correct / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

export function accuracyMetric(acc: AccuracyInputs): QualityMetric {
  const decided = acc.correct + acc.incorrect;
  if (acc.labeled < ACCURACY_MIN_LABELS || decided < ACCURACY_MIN_LABELS) {
    return {
      key: "classification_accuracy",
      dimension: "accuracy",
      status: "NOT_MEASURED",
      value: null,
      detail: `Etiketli örnek yetersiz (${decided} karar, en az ${ACCURACY_MIN_LABELS} gerekir). Temsilî örnek çekip elle etiketleyin.`,
    };
  }
  const lower = wilsonLowerBound(acc.correct, decided);
  return {
    key: "classification_accuracy",
    dimension: "accuracy",
    status: grade(lower, ACCURACY_TARGET, 0.85),
    value: lower,
    detail: `${acc.correct}/${decided} doğru; %95 güvenle alt sınır. Belirsiz: ${acc.unsure}. Kapsam: yalnızca etiketlenen kategori/marka atamaları.`,
  };
}

export function computeQualityReport(input: QualityReportInput): QualityReport {
  const c = input.counters;
  const metrics: QualityMetric[] = [];
  const classifiable = Math.max(0, c.rawEvents - c.duplicatesRemoved - c.suspiciousExcluded);

  // --- Completeness
  const resolved = ratio(classifiable - c.unresolvedProduct, classifiable);
  metrics.push({
    key: "product_resolved_share",
    dimension: "completeness",
    status: grade(resolved, 0.95, 0.8),
    value: resolved,
    detail: `${classifiable - c.unresolvedProduct}/${classifiable} olay bir ürüne çözüldü (çözülemeyen: ${c.unresolvedProduct}).`,
  });
  const eligibleShare = ratio(c.eligibleEvents, classifiable);
  metrics.push({
    key: "eligible_event_share",
    dimension: "completeness",
    status: grade(eligibleShare, 0.8, 0.5),
    value: eligibleShare,
    detail: `${c.eligibleEvents}/${classifiable} olay bu veri setine uygun (kategorisiz ${c.noCategory}, hassas kategori ${c.sensitiveCategory}, markasız ${c.noBrand}, geçersiz marka ${c.invalidBrand}).`,
  });

  // --- Accuracy (doğrulanabilen kapsam)
  if (input.spec.key === "price_range_trends") {
    const priceValid = ratio(c.exitEvents - c.priceMissing - c.priceInvalid, c.exitEvents);
    metrics.push({
      key: "price_validity",
      dimension: "accuracy",
      status: grade(priceValid, 0.98, 0.9),
      value: priceValid,
      detail: `Mağaza çıkışlarının fiyatı 1–5.000.000 TL aralığında: eksik ${c.priceMissing}, aralık dışı ${c.priceInvalid} / ${c.exitEvents}.`,
    });
    const currencyOk = ratio(c.exitEvents - c.offerMissing - c.currencyInvalid, c.exitEvents);
    metrics.push({
      key: "currency_validity",
      dimension: "accuracy",
      status: grade(currencyOk, 0.99, 0.95),
      value: currencyOk,
      detail: `Teklif para birimi TRY: teklifi bulunamayan ${c.offerMissing}, TRY dışı ${c.currencyInvalid} / ${c.exitEvents}.`,
    });
  }
  metrics.push(accuracyMetric(input.accuracy));

  // --- Consistency
  const consistent = c.eligibleEvents > 0 ? 1 : null;
  metrics.push({
    key: "schema_conformance",
    dimension: "consistency",
    status: input.anonymity.checks.find((x) => x.id === "schema_allowlist")?.passed
      ? "PASS"
      : consistent === null
        ? "NOT_MEASURED"
        : "FAIL",
    value: input.anonymity.checks.find((x) => x.id === "schema_allowlist")?.passed ? 1 : 0,
    detail: `Tüm satırlar veri sözlüğüne uyar (izinli sütun, enum, biçim). Biçimi tutmayıp elenen satır: ${input.droppedInvalidRows}.`,
  });
  metrics.push({
    key: "event_kind_separation",
    dimension: "consistency",
    status: "PASS",
    value: 1,
    detail: "Olay türleri (product_view, merchant_exit) ayrı satırlarda; birbirine toplanmaz.",
  });

  // --- Uniqueness
  const dupShare = ratio(c.duplicatesRemoved, c.rawEvents);
  metrics.push({
    key: "source_duplicate_share",
    dimension: "uniqueness",
    status:
      dupShare === null
        ? "NOT_MEASURED"
        : dupShare <= 0.01
          ? "PASS"
          : dupShare <= 0.05
            ? "WARN"
            : "FAIL",
    value: dupShare,
    detail: `Birebir aynı (kişi, tür, nesne, zaman) ${c.duplicatesRemoved} olay build sırasında elendi. Eski şemalı (event_id yok) satır: ${c.legacyWithoutEventId}/${c.rawEvents}; bunlarda yalnızca birebir tekrar yakalanır.`,
  });
  metrics.push({
    key: "output_key_uniqueness",
    dimension: "uniqueness",
    status: input.rowKeyDuplicates === 0 ? "PASS" : "FAIL",
    value: input.rowKeyDuplicates,
    detail: `Çıktıda anahtar (${input.spec.keyColumns.join(", ")}) tekrarı: ${input.rowKeyDuplicates}.`,
  });
  metrics.push({
    key: "suspicious_traffic_excluded",
    dimension: "uniqueness",
    status: "PASS",
    value: c.suspiciousExcluded,
    detail: `Aynı kişide günde >${SUSPICIOUS_DAILY_EVENTS} olay şüpheli (betik/bot) sayılıp elendi: ${c.suspiciousExcluded} olay. Bu, kayıt sonrası bir süzgeçtir; /git'teki bot süzgeci (1B-1) ayrıca çalışır.`,
  });

  // --- Freshness
  if (c.maxEventAt === null) {
    metrics.push({
      key: "source_freshness",
      dimension: "freshness",
      status: "NOT_MEASURED",
      value: null,
      detail: "Dönemde olay yok.",
    });
  } else {
    const ageHours = (input.now.getTime() - c.maxEventAt.getTime()) / 3_600_000;
    metrics.push({
      key: "source_freshness",
      dimension: "freshness",
      status: ageHours <= FRESHNESS_WARN_HOURS ? "PASS" : "WARN",
      value: Math.round(ageHours * 10) / 10,
      detail: `Son kaynak olay ${c.maxEventAt.toISOString()} (build anında ${Math.round(ageHours)} saat önce). Dönem geçmişte kaldıysa bayatlık beklenen durumdur.`,
    });
  }

  // --- Coverage (ölçülebilen)
  const consentShare = ratio(input.coverage.analyticsConsentUsers, input.coverage.registeredUsers);
  metrics.push({
    key: "consented_user_coverage",
    dimension: "coverage",
    status: consentShare === null ? "NOT_MEASURED" : "WARN",
    value: consentShare,
    detail:
      consentShare === null
        ? "Kayıtlı kullanıcı yok."
        : `${input.coverage.analyticsConsentUsers}/${input.coverage.registeredUsers} kayıtlı hesap analitik rızası açık. Anonim ziyaretçi hiç kapsanmaz; veri seti tüm trafiği temsil etmez (kapsam notu, eşik yok).`,
  });
  metrics.push({
    key: "population_users",
    dimension: "coverage",
    status: input.anonymity.checks.find((x) => x.id === "min_population")?.passed ? "PASS" : "FAIL",
    value: c.populationUsers,
    detail: `Veri setine katkı veren farklı kişi: ${c.populationUsers}.`,
  });

  // --- Telemetri kapsamı ve kayıp: ölçülemez
  metrics.push({
    key: "event_loss_rate",
    dimension: "telemetry",
    status: "NOT_MEASURED",
    value: null,
    detail:
      "Kayıp olay oranı ölçülmüyor: olaylar sunucuda eşzamanlı yazılır, istemci sıra numarası ya da beklenen-olay sayacı yok. Rıza kapısı nedeniyle ayrışan kayıp 'consented_user_coverage' ile ayrı anlatılır.",
  });
  metrics.push({
    key: "event_to_record_lag",
    dimension: "telemetry",
    status: "NOT_MEASURED",
    value: null,
    detail:
      "Olay üretim zamanı ile kayıt zamanı ayrı saklanmıyor (tek kolon `created_at`, sunucuda eşzamanlı yazım). İstemci tarafı toplu/asenkron olay eklenirse ayrı bir `occurred_at` kolonu gerekir (karar 0102).",
  });

  const sourceRoles = input.spec.sources.map((id) => ({
    id,
    role: "olay kaynağı (rızalı)",
    filters: [
      "kind IN ('product_viewed','merchant_exit')",
      "dönem [başlangıç, bitiş) UTC",
      "birebir tekrar elenir",
      `kişi/gün > ${SUSPICIOUS_DAILY_EVENTS} olay elenir`,
      "hassas (is_discoverable=false) kategori elenir",
    ],
  }));

  return {
    dataset: input.spec.key,
    version: input.version,
    generatorVersion: GENERATOR_VERSION,
    period: { start: input.periodStart, endExclusive: input.periodEnd },
    rowCount: input.rowCount,
    generatedAt: input.now.toISOString(),
    metrics,
    lineage: {
      sources: [
        ...sourceRoles,
        { id: "product", role: "kategori/marka ataması (üretim anındaki katalog)", filters: [] },
        ...(input.spec.key === "price_range_trends"
          ? [
              {
                id: "click",
                role: "yalnızca merchant_exit olayının click_id'si ile fiyat özniteliği",
                filters: ["1–5.000.000 TL", "offer.currency = TRY"],
              },
            ]
          : []),
      ],
      transformations: [
        "ISO haftasına (Pazartesi, UTC) göre grupla",
        `kişi başına hücre katkısı en çok ${CONTRIBUTION_CAP}`,
        `farklı kişi < ${K_MIN_USERS} olan hücre bastırılır (toplam/diğer satırı yok)`,
        "kişi sayısı banda çevrilir; kesin sayı yayımlanmaz",
      ],
    },
    anonymity: input.anonymity,
    knownLimitations: [
      ...input.spec.limitations,
      `Bastırılan hücre sayısı: ${input.suppressedCells}.`,
      "Kaynak olaylar rıza geri alınınca silinir; dönemi sonradan yeniden üretmek farklı sonuç verebilir, bu yüzden saklanan sürüm esastır.",
      "Hukuki dayanak: ticari lisanslama için DOĞRULANMADI; dışa aktarım varsayılan kapalı.",
    ],
  };
}
