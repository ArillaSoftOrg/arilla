/** Hak modulunun ortak veritabani tipleri ve kucuk yardimcilari. */
import type { Database } from "@arilla/db";
import type { SQL } from "drizzle-orm";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

/** Ham SQL; satirlar tipli dondurulur. `DATE` kolonlari SQL'de `::text`'e cevrilir. */
export async function rows<T>(executor: Executor, query: SQL): Promise<T[]> {
  const result = await executor.execute(query);
  return result.rows as T[];
}

const UNIQUE_VIOLATION = "23505";

/** pg hatasi dogrudan ya da Drizzle sarmalayicisinin `cause`'unda gelir. */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === UNIQUE_VIOLATION) {
      const constraint = (current as { constraint?: unknown }).constraint;
      return typeof constraint === "string" ? constraint : "";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
