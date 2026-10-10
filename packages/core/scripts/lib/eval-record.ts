/**
 * `--record` ortak yardimcilari (Faz 1A-4, karar 0098). Yalnizca yerel DB'ye
 * yazar; uzak adreste cikis kodu 2 ile durur. Kayit olmadan hicbir sey yazilmaz.
 */
import { execSync } from "node:child_process";
import { createDatabase } from "@arilla/db";
import {
  assertLocalRecordTarget,
  type RecordInput,
  recordEvaluation,
} from "../../src/eval/record.ts";

export function codeRef(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * Olcumden ONCE cagrilir: `--record` istenmis ve adres yerel degilse hicbir sey
 * calistirilmadan cikis kodu 2.
 */
export function guardRecordFlag(argv: readonly string[] = process.argv): boolean {
  if (!argv.includes("--record")) return false;
  try {
    assertLocalRecordTarget(process.env.DATABASE_URL);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  return true;
}

export async function recordOrExit(input: RecordInput): Promise<void> {
  try {
    assertLocalRecordTarget(process.env.DATABASE_URL);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const db = createDatabase(process.env.DATABASE_URL as string);
  const result = await recordEvaluation(db, {
    ...input,
    snapshot: {
      ...input.snapshot,
      codeRef: /^[0-9a-f]{7,64}$/.test(codeRef()) ? codeRef() : undefined,
    },
  });
  const state = result.duplicate ? "zaten kayitli (yazilmadi)" : "kaydedildi";
  const regress =
    result.regressed === null
      ? result.baselineStatus === "dataset_changed"
        ? "veri seti degisti: regresyon karsilastirmasi yapilmadi"
        : "ilk kosu: karsilastirma yok"
      : result.regressed
        ? `REGRESYON: ${result.regressedMetrics.join(", ")}`
        : "regresyon yok";
  console.log(`kosu #${result.runId} ${state} · veri seti #${result.snapshotId} · ${regress}`);
}
