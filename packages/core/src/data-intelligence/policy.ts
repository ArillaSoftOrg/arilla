/**
 * Data Intelligence politikası (docs/decisions/0103). Tüm eşikler ve hukuki kapılar
 * tek yerde. Çağıran kod eşiği gevşetemez; gevşetmek için bu dosya ve karar
 * dosyası birlikte değişir.
 *
 * İki bağımsız kapı, ikisi de VARSAYILAN KAPALI (hukuki dayanak doğrulanmadı):
 * - `DATA_INTELLIGENCE_BUILD_ENABLED=true`: rızalı olaylardan veri seti ÜRETİMİ.
 * - `DATA_INTELLIGENCE_EXPORT_ENABLED=true` VE kaynak başına
 *   `DATA_INTELLIGENCE_CLEARED_SOURCES=user_activity_event,...`: dışa aktarım.
 *   Kaynak listesi hukuki onayın kaydıdır; boş liste = hiçbir kaynak onaylı değil.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Hücredeki en az FARKLI kişi sayısı. 0085'teki yönetim eşiği (5) ticari çıktı için yetmez. */
export const K_MIN_USERS = 10;
/** Dönemde veri setine katkı veren en az farklı kişi; altında hiçbir çıktı anonim sayılmaz. */
export const MIN_POPULATION_USERS = 100;
/** Bir kişinin tek hücreye katkısı bu sayıyla sınırlanır (aykırı kullanıcı etkisi). */
export const CONTRIBUTION_CAP = 10;
/** Aynı kişi için bir günde bu sayıdan fazla olay şüpheli (betik/bot) sayılır, elenir. */
export const SUSPICIOUS_DAILY_EVENTS = 300;
export const MAX_PERIOD_DAYS = 93;
export const MAX_ROWS = 20_000;
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
export const MAX_EXPORTS_PER_HOUR = 10;
/** Birleştirilebilir (paylaşılan boyutlu) iki veri setinde hücre eşiği çarpanı. */
export const LINKABLE_K_MULTIPLIER = 2;
/** Geçerli fiyat aralığı (kuruş): 1 TL – 5.000.000 TL. */
export const PRICE_MIN_KURUS = 100;
export const PRICE_MAX_KURUS = 500_000_000;
/** Doğruluk için en az etiketli örnek; altında metrik NOT_MEASURED. */
export const ACCURACY_MIN_LABELS = 30;
export const ACCURACY_TARGET = 0.95;
/** Kaynak tazeliği: bu süreden eski son olay = bayat. */
export const FRESHNESS_WARN_HOURS = 72;

export const GENERATOR_VERSION = "di-1.0.0";

/** Fiyat bandı sınırları (kuruş, alt sınır dahil). */
export const PRICE_BANDS = [
  { key: "0-250", min: 0, max: 25_000 },
  { key: "250-500", min: 25_000, max: 50_000 },
  { key: "500-1000", min: 50_000, max: 100_000 },
  { key: "1000-2500", min: 100_000, max: 250_000 },
  { key: "2500-5000", min: 250_000, max: 500_000 },
  { key: "5000-10000", min: 500_000, max: 1_000_000 },
  { key: "10000+", min: 1_000_000, max: Number.MAX_SAFE_INTEGER },
] as const;

export type DataSourceId = "user_activity_event";

export interface DataIntelligencePolicy {
  buildEnabled: boolean;
  exportEnabled: boolean;
  /** Ticari kullanım için hukuken onaylanmış kaynaklar. */
  clearedSources: ReadonlySet<string>;
}

/** Her şey kapalı: testlerin ve belirsiz ortamların güvenli varsayılanı. */
export const CLOSED_POLICY: DataIntelligencePolicy = Object.freeze({
  buildEnabled: false,
  exportEnabled: false,
  clearedSources: new Set<string>(),
});

export function policyFromEnv(env: Env = process.env): DataIntelligencePolicy {
  const flag = (name: string) => env[name]?.trim() === "true";
  const cleared = (env.DATA_INTELLIGENCE_CLEARED_SOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9_]{1,59}$/.test(s));
  return {
    buildEnabled: flag("DATA_INTELLIGENCE_BUILD_ENABLED"),
    // Dışa aktarım, üretim kapalıyken de kapalı: kapalı üretim = veri yok.
    exportEnabled:
      flag("DATA_INTELLIGENCE_BUILD_ENABLED") && flag("DATA_INTELLIGENCE_EXPORT_ENABLED"),
    clearedSources: new Set(cleared),
  };
}

/** Kaynakların hepsi onaylı mı; değilse onaysız olanların listesi. */
export function uncleared(policy: DataIntelligencePolicy, sources: readonly string[]): string[] {
  return sources.filter((s) => !policy.clearedSources.has(s));
}
