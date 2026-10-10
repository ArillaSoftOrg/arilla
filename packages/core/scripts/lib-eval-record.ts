/**
 * `--record` ortak yardimcilari. Yalniz yerel veritabani; uzak adres reddedilir
 * ve hicbir sey yazilmaz. Parola/adres yazdirilmaz.
 */
import { execFileSync } from "node:child_process";

export function wantsRecord(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--record");
}

export function requireLocalDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    console.error("--record yalnizca yerel DATABASE_URL ile calisir; hicbir sey yazilmadi.");
    process.exit(2);
  }
  return url;
}

export function gitShortRef(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export function printRecordOutcome(o: {
  runId: number;
  reused: boolean;
  baselineStatus: string;
  regressed: boolean | null;
  changes: { metric: string; baseline: number; current: number; regressed: boolean }[];
}): void {
  console.log(
    `kayit: kosu #${o.runId} ${o.reused ? "(ayni kosu zaten kayitliydi)" : "(yeni)"} | karsilastirma: ${o.baselineStatus}`,
  );
  if (o.baselineStatus === "dataset_changed") {
    console.log("veri seti degisti: onceki kosularla regresyon karsilastirmasi yapilmadi.");
  }
  for (const c of o.changes) {
    console.log(
      `${c.regressed ? "REGRESYON" : "ok       "} ${c.metric.padEnd(20)} ${c.baseline.toFixed(3)} -> ${c.current.toFixed(3)}`,
    );
  }
}
