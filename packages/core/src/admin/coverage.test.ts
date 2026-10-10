/**
 * Kapsam kaydı ile depodaki gerçek listelerin karşılaştırması (karar 0082).
 * Yeni bir tablo, model işlemi, cron ucu, iş adı ya da yetenek
 * `coverage.ts`'te sınıflandırılmadan eklenirse burada kırılır.
 *
 * Kaynaklar yalnızca okunur: `docs/schema.sql`, migration dosyaları, kaynak
 * kod (TS + Python), `apps/web/app/api/cron` ve `apps/web/vercel.json`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEMINI_MODEL } from "../llm/model.ts";
import { findLlmPriceRule } from "../llm/pricing.ts";
import { AUDIT_TARGET_TYPES } from "./audit.ts";
import {
  ADMIN_SUBSYSTEMS,
  AI_OPERATIONS,
  AUDIT_TARGET_SUBSYSTEM,
  CAPABILITY_COVERAGE,
  CRON_ROUTES,
  coveredTables,
} from "./coverage.ts";
import { KNOWN_JOBS } from "./job-runs.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const SKIP_DIRS = new Set(["node_modules", ".next", ".venv", "dist", "tests", "__pycache__"]);

/** Kaynak dosyalar (testler hariç): yalnızca verilen uzantılar. */
function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(abs, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (
        extensions.some((ext) => name.endsWith(ext)) &&
        !/\.test\.|_test\.py$|^test_/.test(name)
      ) {
        out.push(path);
      }
    }
  };
  walk(join(repoRoot, dir));
  return out;
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] as string);
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

const TS_SOURCES = [
  ...sourceFiles("packages/core/src", [".ts"]),
  ...sourceFiles("apps/web/app", [".ts", ".tsx"]),
];
const PY_SOURCES = sourceFiles("services/ingest", [".py"]);

describe("tablolar", () => {
  const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_0-9]+)/gi;

  it("docs/schema.sql'deki her tablo tam olarak bir alt sistemde", () => {
    const schema = sorted(matchAll(read("docs/schema.sql"), CREATE_TABLE));
    const covered = coveredTables();
    expect(sorted(covered)).toEqual(schema);
    // Bir tablo iki alt sisteme yazılmaz.
    expect(covered.length).toBe(new Set(covered).size);
  });

  it("migration'lardaki her tablo da kayıtta (schema.sql güncellenmemiş olsa bile)", () => {
    const dir = join(repoRoot, "packages/db/migrations");
    const fromMigrations = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .flatMap((name) => matchAll(readFileSync(join(dir, name), "utf8"), CREATE_TABLE))
      .map((name) => name.toLowerCase());
    const covered = new Set(coveredTables());
    expect(sorted(fromMigrations).filter((t) => !covered.has(t))).toEqual([]);
  });
});

describe("alt sistemler", () => {
  it("kimlikler essiz; denetim hedefleri var olan alt sisteme bagli", () => {
    const ids = ADMIN_SUBSYSTEMS.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
    for (const target of AUDIT_TARGET_TYPES) {
      expect(ids).toContain(AUDIT_TARGET_SUBSYSTEM[target]);
    }
  });

  it("gorunur olan bir yonetim sayfasi gosterir; dis ve uygulanamaz olan gerekce yazar", () => {
    for (const subsystem of ADMIN_SUBSYSTEMS) {
      for (const path of subsystem.adminPaths) expect(path).toMatch(/^\/yonetim(\/|$)/);
      if (subsystem.status === "visible") expect(subsystem.adminPaths.length).toBeGreaterThan(0);
      if (subsystem.status === "external" || subsystem.status === "not_applicable") {
        expect(subsystem.note?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("model islemleri (api_usage.operation)", () => {
  it("kodun yazdigi her islem sinifli; kayitta olup yazilmayan islem yok", () => {
    const written = new Set<string>();
    for (const file of TS_SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const name of matchAll(text, /\b[A-Z_]+_OPERATION = "([a-z_]+)"/g)) written.add(name);
      if (text.includes("insert(apiUsage)")) {
        for (const name of matchAll(text, /operation: "([a-z_]+)"/g)) written.add(name);
      }
    }
    for (const file of PY_SOURCES) {
      for (const name of matchAll(readFileSync(file, "utf8"), /operation="([a-z_]+)"/g)) {
        written.add(name);
      }
    }
    expect(sorted(written)).toEqual(sorted(Object.keys(AI_OPERATIONS)));
  });

  it("Gemini islemi yazan dosya maliyeti sabit 0 yazmaz (karar 0082: llmCallCostMicros)", () => {
    const llmConstants = TS_SOURCES.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/\b([A-Z_]+_OPERATION) = "([a-z_]+)"/g)]
        .filter((m) => AI_OPERATIONS[m[2] as string]?.pricing === "llm_rule")
        .map((m) => m[1] as string),
    );
    expect(llmConstants.length).toBeGreaterThan(0);
    const offenders = TS_SOURCES.filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        text.includes("insert(apiUsage)") &&
        llmConstants.some((name) => text.includes(name)) &&
        /costMicros:\s*0\b/.test(text)
      );
    }).map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it("Gemini islemlerinin kullandigi modelin bugun yururlukte fiyat kurali var", () => {
    const llmOps = Object.values(AI_OPERATIONS).filter((op) => op.pricing === "llm_rule");
    expect(llmOps.length).toBeGreaterThan(0);
    expect(findLlmPriceRule(GEMINI_MODEL, new Date())).not.toBeNull();
  });
});

describe("cron ve is kosulari", () => {
  it("her cron ucu kayitta ve yazdigi is KNOWN_JOBS'ta", () => {
    const routes = readdirSync(join(repoRoot, "apps/web/app/api/cron")).filter((name) =>
      statSync(join(repoRoot, "apps/web/app/api/cron", name)).isDirectory(),
    );
    expect(sorted(routes)).toEqual(sorted(Object.keys(CRON_ROUTES)));
    for (const { job } of Object.values(CRON_ROUTES)) expect(KNOWN_JOBS).toHaveProperty(job);
  });

  it("vercel.json'daki zamanlanmis her yol bir cron ucu", () => {
    const config = JSON.parse(read("apps/web/vercel.json")) as { crons?: { path: string }[] };
    for (const cron of config.crons ?? []) {
      const name = cron.path.replace(/^\/api\/cron\//, "");
      expect(CRON_ROUTES).toHaveProperty(name);
    }
  });

  it("kodda job_run'a yazilan her is adi KNOWN_JOBS'ta (etiket ve gecikme esigi)", () => {
    const constants = new Map<string, string>();
    for (const file of TS_SOURCES) {
      for (const m of readFileSync(file, "utf8").matchAll(/\b([A-Z_]+_JOB) = "([a-z_]+)"/g)) {
        constants.set(m[1] as string, m[2] as string);
      }
    }
    const jobs = new Set<string>();
    for (const file of TS_SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/withJobRun\(\s*[a-z]+,\s*(?:"([a-z_]+)"|([A-Z_]+))/g)) {
        const name = m[1] ?? constants.get(m[2] as string);
        expect(name, `${relative(repoRoot, file)}: ${m[2]}`).toBeDefined();
        jobs.add(name as string);
      }
    }
    for (const file of PY_SOURCES) {
      for (const name of matchAll(readFileSync(file, "utf8"), /track\("([a-z_]+)"\)/g)) {
        jobs.add(name);
      }
    }
    expect(jobs.size).toBeGreaterThan(5);
    expect(sorted(jobs).filter((job) => !(job in KNOWN_JOBS))).toEqual([]);
  });
});

describe("yetenekler", () => {
  it("ayrilmamis her yetenek kodda kullaniliyor; ayrilmis olan kullanilmiyor", () => {
    const corpus = TS_SOURCES.filter(
      // Windows'ta yol ayracı `\`; eşleşme `/` ile yapılır.
      (file) => !/admin\/(capabilities|coverage)\.ts$/.test(file.replaceAll("\\", "/")),
    ).map((file) =>
      // Yorumdaki anılma kullanım sayılmaz ("catalog.write ileride").
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1"),
    );
    for (const [capability, info] of Object.entries(CAPABILITY_COVERAGE)) {
      const used = corpus.some((text) => text.includes(`"${capability}"`));
      expect(used, capability).toBe(info.reserved === undefined);
    }
  });
});
