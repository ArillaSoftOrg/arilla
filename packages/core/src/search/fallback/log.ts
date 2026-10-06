import type { SearchTrace } from "./types.ts";

/**
 * Log satiri. Sorgu metni (`queryNorm`) kisisel veri tasiyabilir: loga
 * GIRMEZ (CLAUDE.md: hata kayitlarina kisisel veri yok). Yalnizca sabit kodlar
 * ve sayilar.
 */
export function formatTraceForLog(trace: SearchTrace): string {
  return [
    "[search]",
    `provider=${trace.provider}`,
    `mode=${trace.mode}`,
    `stage=${trace.stage}`,
    `tried=${trace.stagesTried.length}`,
    `count=${trace.resultCount}`,
    `reason=${trace.fallbackReason ?? "-"}`,
    `ms=${trace.latencyMs}`,
  ].join(" ");
}
