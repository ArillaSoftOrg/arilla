/**
 * Migration guvenlik kurallari (karar 0111). Saf fonksiyonlar; CLI
 * `lint-migrations.ts`, testler `migration-lint.test.ts`.
 *
 * Tum dosyalar:
 * - Ad `NNNN_kisa_ad.sql`; numara tekrar etmez (bosluk serbest).
 * - `price_point` icin UPDATE/DELETE/TRUNCATE yok (CLAUDE.md kural 4).
 * - `CONCURRENTLY` yok: calistirici her dosyayi tek islemde yurutur.
 *
 * BASELINE sonrasi (yeni) dosyalar ek olarak:
 * - Ilk satir `-- kind: schema|data|grant`.
 * - Yikici DDL yok (DROP TABLE/COLUMN, RENAME, ALTER COLUMN ... TYPE,
 *   SET NOT NULL, TRUNCATE). Bilincli istisna: dosyada
 *   `-- allow-destructive: <gerekce>` satiri (kural 14: once kod, sonra kaldirma).
 * - BEGIN/COMMIT/ROLLBACK yok (islem calistiricinindir).
 * - `kind: data` dosyasinda RAISE EXCEPTION yok: uretimdeki belirli satirlari
 *   varsayan veri migration'i bos/farkli veritabaninda dagitimi dusurur;
 *   beklenmeyen durumda atlanir. Istisna: `-- allow-raise: <gerekce>`.
 */

/** Bu numaraya kadar olan dosyalar kurallar yazilmadan once uygulandi. */
export const BASELINE = 64;

export const KINDS = ["schema", "data", "grant"] as const;

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface LintIssue {
  file: string;
  rule: string;
  message: string;
}

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Yorumlari ve tirnak icindeki metni bosaltir; kurallar yalnizca SQL govdesine bakar. */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      out += "''";
      i = j + 1;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

function directive(sql: string, name: string): string | null {
  const match = sql.match(new RegExp(`^--\\s*${name}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || null;
}

const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bRENAME\b/i, "RENAME"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "ALTER COLUMN ... TYPE"],
  [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL"],
  // Yalnizca ifade basinda: "REVOKE ... TRUNCATE ON" bir yetki geri alimidir, yikici degil.
  [/(^|;)\s*TRUNCATE\b/i, "TRUNCATE"],
];

export function lintMigrations(files: MigrationFile[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const seen = new Map<string, string>();

  for (const { name, sql } of files) {
    const match = name.match(NAME);
    if (!match) {
      issues.push({ file: name, rule: "name", message: "ad NNNN_kisa_ad.sql biciminde olmali" });
      continue;
    }
    const number = match[1] as string;
    const previous = seen.get(number);
    if (previous) {
      issues.push({
        file: name,
        rule: "duplicate",
        message: `${number} numarasi ${previous} ile ayni`,
      });
    }
    seen.set(number, name);

    const body = stripSql(sql);
    if (
      /\b(UPDATE\s+(ONLY\s+)?price_point|DELETE\s+FROM\s+(ONLY\s+)?price_point|TRUNCATE\s+(TABLE\s+)?price_point)\b/i.test(
        body,
      )
    ) {
      issues.push({
        file: name,
        rule: "append-only",
        message: "price_point yalnizca INSERT alir (kural 4)",
      });
    }
    if (/\bCONCURRENTLY\b/i.test(body)) {
      issues.push({
        file: name,
        rule: "concurrently",
        message: "CONCURRENTLY islem icinde calismaz; calistirici her dosyayi tek islemde yurutur",
      });
    }

    if (Number(number) <= BASELINE) continue;

    const kind = sql.match(/^--\s*kind:\s*(\S+)\s*$/m)?.[1];
    const firstLine = sql.split("\n", 1)[0]?.trim() ?? "";
    if (
      !kind ||
      !firstLine.startsWith("-- kind:") ||
      !(KINDS as readonly string[]).includes(kind)
    ) {
      issues.push({
        file: name,
        rule: "kind",
        message: `ilk satir "-- kind: ${KINDS.join("|")}" olmali`,
      });
    }
    if (/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(body.replace(/\$\$[\s\S]*?\$\$/g, " "))) {
      issues.push({
        file: name,
        rule: "transaction",
        message: "BEGIN/COMMIT/ROLLBACK yazilmaz; islem calistiricinindir",
      });
    }
    if (!directive(sql, "allow-destructive")) {
      for (const [pattern, label] of DESTRUCTIVE) {
        if (pattern.test(body)) {
          issues.push({
            file: name,
            rule: "destructive",
            message: `${label} geriye uyumsuz olabilir (kural 14); bilincliyse "-- allow-destructive: <gerekce>"`,
          });
        }
      }
    }
    if (kind === "data" && /\bRAISE\s+EXCEPTION\b/i.test(body) && !directive(sql, "allow-raise")) {
      issues.push({
        file: name,
        rule: "data-raise",
        message:
          "veri migration'i RAISE EXCEPTION ile dagitimi dusurmemeli; beklenmeyen durumu atla ve raporla",
      });
    }
  }
  return issues;
}
