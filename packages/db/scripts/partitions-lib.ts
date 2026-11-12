/**
 * `price_point` aylik partition ufku (saf; veritabani yok). `partitions.ts --check` kullanir.
 *
 * Uretim (`partitions.ts`) icinde bulunulan ay + MONTHS_AHEAD ayi acar. Kontrol iki seviyelidir:
 * - KRITIK (cikis 1): bu ayin ya da GELECEK ayin partition'i yok. Bir ay icinde satirlar
 *   `price_point_default`'a dusecek; o ayin partition'i dolu default varken acilamaz (ops.md runbook).
 * - UYARI (cikis 0): politika ufkunun (MONTHS_AHEAD) gerisinde ama en az bir aylik pay var.
 * Boylece uretim zamanlayicisi calismasa bile kontrol, veri default'a dusmeden en az bir ay once
 * KRITIK olur; eski kontrol yalniz default dolduktan SONRA alarm veriyordu.
 */

export const MONTHS_AHEAD = 3;

export type HorizonLevel = "ok" | "warn" | "crit";

export interface HorizonResult {
  level: HorizonLevel;
  /** Eksik aylar, YYYY-MM. */
  missing: string[];
  message: string;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * `pg_get_expr(relpartbound, oid)` ciktisindan alt sinir ayi: `FOR VALUES FROM ('2026-11-01 ...') TO (...)`.
 * DEFAULT ya da tanınmayan sinir icin null.
 */
export function partitionMonth(bound: string): string | null {
  const m = /FROM \('(\d{4})-(\d{2})-01[ T]/.exec(bound);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** `now`'in ayi dahil, ardisik `count` ay (YYYY-MM). Aralik -> Ocak devri Date.UTC ile dogru. */
export function monthsFrom(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))));
  }
  return out;
}

/** Mevcut partition aylarina (YYYY-MM) gore ufuk seviyesi. */
export function horizonStatus(
  present: Iterable<string>,
  now: Date,
  monthsAhead: number = MONTHS_AHEAD,
): HorizonResult {
  const have = new Set(present);
  const required = monthsFrom(now, monthsAhead + 1);
  const missing = required.filter((month) => !have.has(month));
  const critical = required.slice(0, 2).filter((month) => !have.has(month));
  if (critical.length > 0) {
    return {
      level: "crit",
      missing,
      message:
        `KRITIK: price_point partition eksik: ${critical.join(", ")}. Satirlar ` +
        "price_point_default'a dusecek; aylik uretim calismiyor. Runbook: docs/ops.md.",
    };
  }
  if (missing.length > 0) {
    return {
      level: "warn",
      missing,
      message:
        `UYARI: price_point ufku politikanin gerisinde (bu ay + ${monthsAhead}); eksik: ` +
        `${missing.join(", ")}. Aylik uretim (arilla-partitions) calismiyor olabilir.`,
    };
  }
  return { level: "ok", missing, message: `partition ufku tamam (${required.join(", ")}).` };
}
