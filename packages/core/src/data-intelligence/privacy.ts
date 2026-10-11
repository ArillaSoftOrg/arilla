/**
 * Gizlilik ve anonimleştirme kontrolleri (Faz 4) — SAF fonksiyonlar, veritabanı yok.
 *
 * Bu kontroller yeniden kimlik belirleme riskini AZALTIR ve ölçülebilir kuralları
 * doğrular; hukuki anlamda "anonim" olduğunu GARANTİ ETMEZ. Garanti verilemeyen
 * (herhangi bir kontrolü geçemeyen) çıktı `anonymityOk=false` olur ve dışa
 * aktarıma kapanır. Başarılı kontrol yalnızca teknik ön koşuldur; dışa aktarım
 * ayrıca hukuki kapıya (`policy.ts`) bağlıdır.
 */
import type { ColumnSpec, DatasetSpec, USERS_BANDS } from "./datasets.ts";
import { K_MIN_USERS, LINKABLE_K_MULTIPLIER, MAX_ROWS, MIN_POPULATION_USERS } from "./policy.ts";

export type Row = Record<string, string | number>;

export type UsersBand = (typeof USERS_BANDS)[number];

/** Kişi sayısını banda çevirir; eşiğin altı `null` (bastırılır). */
export function usersBand(users: number, k: number = K_MIN_USERS): UsersBand | null {
  if (!Number.isFinite(users) || users < k) return null;
  if (users < 20) return "10-19";
  if (users < 50) return "20-49";
  if (users < 100) return "50-99";
  return "100+";
}

/**
 * Küçük hücreleri bastırır. `k` üstünde olmayan hücre dışarı verilmez, yerine
 * "diğer" toplamı da konmaz (çıkarma ile geri çıkarılmasın).
 */
export function suppressSmallCells<T extends { users: number }>(
  cells: readonly T[],
  k: number = K_MIN_USERS,
): { kept: T[]; suppressed: number } {
  const kept: T[] = [];
  let suppressed = 0;
  for (const cell of cells) {
    if (cell.users >= k) kept.push(cell);
    else suppressed += 1;
  }
  return { kept, suppressed };
}

/** Sütun adlarında kimlik taşıyan jetonlar (alt çizgiyle ayrılmış). */
const FORBIDDEN_TOKENS = new Set([
  "email",
  "phone",
  "ip",
  "session",
  "token",
  "query",
  "message",
  "image",
  "url",
  "device",
  "fingerprint",
  "pseudonym",
  "cookie",
  "address",
  "uuid",
]);
const FORBIDDEN_PAIRS = ["user_id", "click_id", "event_id", "offer_id", "product_id", "session_id"];

export function forbiddenColumnName(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_PAIRS.some((p) => lower === p || lower.endsWith(`_${p}`))) return true;
  return lower.split("_").some((t) => FORBIDDEN_TOKENS.has(t));
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGITS_RE = /\d{7,}/;
const IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,}/i;
const URL_RE = /https?:\/\/|www\./i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Değerde e-posta, telefon/uzun rakam, IP, URL ya da UUID benzeri kimlik var mı. */
export function looksLikePii(value: string): boolean {
  return (
    EMAIL_RE.test(value) ||
    LONG_DIGITS_RE.test(value) ||
    IP_RE.test(value) ||
    URL_RE.test(value) ||
    UUID_RE.test(value)
  );
}

function validateCell(column: ColumnSpec, value: unknown): string | null {
  switch (column.type) {
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? null
        : "geçersiz tamsayı";
    case "enum":
      return typeof value === "string" && (column.values ?? []).includes(value)
        ? null
        : "izinli değer değil";
    case "date":
    case "text":
      if (typeof value !== "string") return "metin değil";
      if (column.pattern && !column.pattern.test(value)) return "biçim desenine uymuyor";
      if (looksLikePii(value)) return "kimlik benzeri değer";
      return null;
    default:
      return "bilinmeyen sütun türü";
  }
}

/**
 * Satırlar yalnızca izin listesindeki sütunları, tam olarak bir kez, geçerli
 * değerlerle taşımalı. Fazla/eksik sütun, serbest metin, kimlik benzeri değer
 * ihlaldir. En çok 20 ihlal döner.
 */
export function validateRows(spec: DatasetSpec, rows: readonly Row[]): string[] {
  const violations: string[] = [];
  const allowed = new Set(spec.columns.map((c) => c.name));
  for (const column of spec.columns) {
    if (forbiddenColumnName(column.name)) violations.push(`yasaklı sütun adı: ${column.name}`);
  }
  for (const [index, row] of rows.entries()) {
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) violations.push(`satır ${index}: izinsiz sütun ${key}`);
    }
    for (const column of spec.columns) {
      if (!Object.hasOwn(row, column.name)) {
        violations.push(`satır ${index}: eksik sütun ${column.name}`);
        continue;
      }
      const problem = validateCell(column, row[column.name]);
      if (problem) violations.push(`satır ${index}: ${column.name} ${problem}`);
    }
    if (violations.length >= 20) break;
  }
  return violations.slice(0, 20);
}

export interface AnonymityCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AnonymityAssessment {
  ok: boolean;
  checks: AnonymityCheck[];
  k: number;
  minPublishedUsers: number | null;
  populationUsers: number;
  notice: string;
}

export const ANONYMITY_NOTICE =
  "Bu kontroller yeniden kimlik belirleme riskini azaltır; hukuki anlamda anonimlik garantisi DEĞİLDİR. Dışa aktarım ayrıca hukuki onay ister.";

export function assessAnonymity(input: {
  spec: DatasetSpec;
  rows: readonly Row[];
  /** Yayımlanan hücrelerdeki en küçük farklı kişi sayısı (yayım öncesi iç değer). */
  minPublishedUsers: number | null;
  /** Dönemde sınıflanabilen olaylara katkı veren farklı kişi. */
  populationUsers: number;
  k?: number;
}): AnonymityAssessment {
  const k = input.k ?? K_MIN_USERS;
  const violations = validateRows(input.spec, input.rows);
  const checks: AnonymityCheck[] = [
    {
      id: "k_threshold",
      passed: input.minPublishedUsers !== null && input.minPublishedUsers >= k,
      detail:
        input.minPublishedUsers === null
          ? "yayımlanan hücre yok"
          : `en küçük hücre ${input.minPublishedUsers} kişi (eşik ${k})`,
    },
    {
      id: "min_population",
      passed: input.populationUsers >= MIN_POPULATION_USERS,
      detail: `${input.populationUsers} farklı kişi (en az ${MIN_POPULATION_USERS}); küçük popülasyonda tek tek kişi ayırt edilebilir`,
    },
    {
      id: "schema_allowlist",
      passed: violations.length === 0,
      detail: violations.length === 0 ? "yalnızca izinli sütun ve değerler" : violations.join("; "),
    },
    {
      id: "row_cap",
      passed: input.rows.length > 0 && input.rows.length <= MAX_ROWS,
      detail: `${input.rows.length} satır (üst sınır ${MAX_ROWS})`,
    },
  ];
  return {
    ok: checks.every((c) => c.passed),
    checks,
    k,
    minPublishedUsers: input.minPublishedUsers,
    populationUsers: input.populationUsers,
    notice: ANONYMITY_NOTICE,
  };
}

export interface LinkageInput {
  key: string;
  spec: DatasetSpec;
  periodStart: string;
  periodEnd: string;
  minPublishedUsers: number | null;
}

export interface LinkageAssessment {
  ok: boolean;
  /** Birleştirilebilir (ortak niteleyicili, çakışan dönemli) veri seti çiftleri. */
  joinablePairs: { a: string; b: string; shared: string[] }[];
  failing: { a: string; b: string; reason: string }[];
  notice: string;
}

/**
 * Birden fazla veri setinin AYNI pakette verilmesinin yeniden kimlik riski.
 * Hafta + ortak niteleyici (kategori) paylaşan, dönemi çakışan iki setin
 * hücreleri birleştirilince daha ince bir kesit çıkar. Kural (sezgisel, kanıt
 * değil): birleştirilebilir çiftte her iki setin en küçük hücresi
 * `LINKABLE_K_MULTIPLIER × k` kişi olmalı. Tek setli verilişte uygulanmaz.
 */
export function assessLinkageRisk(
  builds: readonly LinkageInput[],
  k: number = K_MIN_USERS,
): LinkageAssessment {
  const joinablePairs: LinkageAssessment["joinablePairs"] = [];
  const failing: LinkageAssessment["failing"] = [];
  for (let i = 0; i < builds.length; i += 1) {
    for (let j = i + 1; j < builds.length; j += 1) {
      const a = builds[i];
      const b = builds[j];
      if (!a || !b) continue;
      const overlap = a.periodStart < b.periodEnd && b.periodStart < a.periodEnd;
      const shared = a.spec.linkColumns.filter((c) => b.spec.linkColumns.includes(c));
      if (!overlap || shared.length === 0) continue;
      joinablePairs.push({ a: a.key, b: b.key, shared });
      const need = k * LINKABLE_K_MULTIPLIER;
      for (const side of [a, b]) {
        if (side.minPublishedUsers === null || side.minPublishedUsers < need) {
          failing.push({
            a: a.key,
            b: b.key,
            reason: `${side.key}: en küçük hücre ${side.minPublishedUsers ?? "yok"} < ${need} (birleştirilebilir çift)`,
          });
        }
      }
    }
  }
  return {
    ok: failing.length === 0,
    joinablePairs,
    failing,
    notice: ANONYMITY_NOTICE,
  };
}
