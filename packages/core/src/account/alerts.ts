/**
 * `/alarmlar` ve ürün sayfasındaki "Fiyat alarmı kur" (docs/pages.md,
 * docs/schema.sql `alert`). Üç tür kullanıcı tarafından oluşturulabilir:
 * `price_drop` (hedef fiyat zorunlu), `restock`, `size_restock` (beden
 * zorunlu). `any_drop` şemada var ama hiçbir arayüz eylemi onu üretmiyor
 * (docs/copy.md'de karşılığı yok) - bu görevin kapsamı dışında.
 *
 * `alert_uniq (user_id, product_id, kind, size_norm)` kısıtı `size_norm`
 * NULL olan satırlarda çalışmaz - Postgres UNIQUE'te NULL kendisiyle bile
 * eşleşmez, yani iki `price_drop` satırı bu kısıtı hiç görmez. Bu yüzden
 * çakışma DB kısıtına değil, burada açık bir öncesi-var-mı kontrolüne
 * dayanıyor.
 */

import { alert, type Database, product } from "@arilla/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AlertView, CreateAlertInput } from "./types.ts";

export class InvalidAlertInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAlertInputError";
  }
}

export interface CreateAlertResult {
  alertId: number;
  /** false: ayni (user, product, kind[, size]) icin zaten aktif bir alarm vardi. */
  created: boolean;
}

export async function createAlert(
  db: Database,
  input: CreateAlertInput,
): Promise<CreateAlertResult> {
  if (input.kind === "price_drop" && !(input.targetPrice && input.targetPrice > 0)) {
    throw new InvalidAlertInputError("price_drop icin gecerli bir targetPrice zorunlu");
  }
  if (input.kind === "size_restock" && !input.sizeNorm) {
    throw new InvalidAlertInputError("size_restock icin sizeNorm zorunlu");
  }

  const sizeNorm = input.kind === "size_restock" ? (input.sizeNorm ?? null) : null;
  const targetPrice = input.kind === "price_drop" ? (input.targetPrice ?? null) : null;

  const existing = await db
    .select({ id: alert.id })
    .from(alert)
    .where(
      and(
        eq(alert.userId, input.userId),
        eq(alert.productId, input.productId),
        eq(alert.kind, input.kind),
        eq(alert.isActive, true),
        sizeNorm === null ? isNull(alert.sizeNorm) : eq(alert.sizeNorm, sizeNorm),
      ),
    )
    .limit(1);
  const existingRow = existing[0];
  if (existingRow) {
    return { alertId: existingRow.id, created: false };
  }

  const inserted = await db
    .insert(alert)
    .values({
      userId: input.userId,
      productId: input.productId,
      kind: input.kind,
      targetPrice,
      sizeNorm,
    })
    .returning({ id: alert.id });

  const row = inserted[0];
  if (!row) {
    throw new Error("alert insert bos sonuc dondurdu");
  }
  return { alertId: row.id, created: true };
}

export interface DeleteAlertInput {
  userId: number;
  alertId: number;
}

export interface DeleteAlertResult {
  found: boolean;
}

export async function deleteAlert(
  db: Database,
  input: DeleteAlertInput,
): Promise<DeleteAlertResult> {
  const deleted = await db
    .delete(alert)
    .where(and(eq(alert.id, input.alertId), eq(alert.userId, input.userId)))
    .returning({ id: alert.id });
  return { found: deleted.length > 0 };
}

export async function listAlerts(db: Database, userId: number): Promise<AlertView[]> {
  const rows = await db
    .select({
      alertId: alert.id,
      productId: product.id,
      slug: product.slug,
      title: product.title,
      primaryImageUrl: product.primaryImageUrl,
      minPrice: product.minPrice,
      offerCount: product.offerCount,
      kind: alert.kind,
      targetPrice: alert.targetPrice,
      sizeNorm: alert.sizeNorm,
      isActive: alert.isActive,
      triggeredAt: alert.triggeredAt,
      createdAt: alert.createdAt,
    })
    .from(alert)
    .innerJoin(product, eq(product.id, alert.productId))
    .where(eq(alert.userId, userId))
    .orderBy(desc(alert.createdAt));

  return rows;
}
