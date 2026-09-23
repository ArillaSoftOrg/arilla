/**
 * "Alarm tetikleme işi" (docs/backlog.md E2). Python tarafı `offer.current_
 * price` / `offer.in_stock` alanlarını zaten güncel tutuyor (services/ingest);
 * bu iş yalnızca okuyor, mimari sınırı bozmuyor (CLAUDE.md - tek kanal
 * PostgreSQL). Üç tür için üç ayrı toplu sorgu (N+1 yok), sonra yalnızca
 * gerçekten tetiklenen (genelde küçük) alt küme için tek tek e-posta.
 *
 * `any_drop` kasıtlı olarak işlenmiyor - hiçbir arayüz eylemi onu üretmiyor
 * (bkz. `alerts.ts`), bu yüzden trigger semantiği tanımsız.
 *
 * Tetiklenme (`triggered_at` + `is_active=false`) ve bildirim (`notified_at`)
 * ayrı adımlar: e-posta gönderimi başarısız olursa alarm yine de bir daha
 * denenmez (tekrar kuyruğu bu görevin kapsamı dışında) ama `notified_at`
 * NULL kalarak başarısız gönderimi görünür bırakır.
 */

import { alert, appUser, type Database, offer, offerVariant, product } from "@arilla/db";
import { and, eq, exists, sql } from "drizzle-orm";
import { requireAppUrl } from "../config/app-url.ts";
import { sendAlertEmail } from "./send-alert-email.ts";
import type { AlertKind } from "./types.ts";

export interface TriggerAlertsResult {
  triggeredCount: number;
  notifiedCount: number;
}

interface QualifyingAlertRow {
  alertId: number;
  email: string;
  kind: AlertKind;
  sizeNorm: string | null;
  productTitle: string;
  productSlug: string;
}

function baseQuery(db: Database) {
  return db
    .select({
      alertId: alert.id,
      email: appUser.email,
      kind: alert.kind,
      sizeNorm: alert.sizeNorm,
      productTitle: product.title,
      productSlug: product.slug,
    })
    .from(alert)
    .innerJoin(appUser, eq(appUser.id, alert.userId))
    .innerJoin(product, eq(product.id, alert.productId));
}

async function qualifyingPriceDropAlerts(db: Database): Promise<QualifyingAlertRow[]> {
  return baseQuery(db).where(
    and(
      eq(alert.kind, "price_drop"),
      eq(alert.isActive, true),
      exists(
        db
          .select({ one: sql`1` })
          .from(offer)
          .where(
            and(
              eq(offer.productId, alert.productId),
              eq(offer.isActive, true),
              eq(offer.inStock, true),
              sql`${offer.currentPrice} <= ${alert.targetPrice}`,
            ),
          ),
      ),
    ),
  );
}

async function qualifyingRestockAlerts(db: Database): Promise<QualifyingAlertRow[]> {
  return baseQuery(db).where(
    and(
      eq(alert.kind, "restock"),
      eq(alert.isActive, true),
      exists(
        db
          .select({ one: sql`1` })
          .from(offer)
          .where(
            and(
              eq(offer.productId, alert.productId),
              eq(offer.isActive, true),
              eq(offer.inStock, true),
            ),
          ),
      ),
    ),
  );
}

async function qualifyingSizeRestockAlerts(db: Database): Promise<QualifyingAlertRow[]> {
  return baseQuery(db).where(
    and(
      eq(alert.kind, "size_restock"),
      eq(alert.isActive, true),
      exists(
        db
          .select({ one: sql`1` })
          .from(offerVariant)
          .innerJoin(offer, eq(offer.id, offerVariant.offerId))
          .where(
            and(
              eq(offer.productId, alert.productId),
              eq(offer.isActive, true),
              eq(offerVariant.inStock, true),
              sql`${offerVariant.sizeNorm} = ${alert.sizeNorm}`,
            ),
          ),
      ),
    ),
  );
}

function appUrl(): string {
  return requireAppUrl();
}

export async function triggerAlerts(db: Database): Promise<TriggerAlertsResult> {
  const candidates = [
    ...(await qualifyingPriceDropAlerts(db)),
    ...(await qualifyingRestockAlerts(db)),
    ...(await qualifyingSizeRestockAlerts(db)),
  ];

  let triggeredCount = 0;
  let notifiedCount = 0;

  for (const row of candidates) {
    const claimed = await db
      .update(alert)
      .set({ isActive: false, triggeredAt: new Date() })
      .where(and(eq(alert.id, row.alertId), eq(alert.isActive, true)))
      .returning({ id: alert.id });
    if (!claimed[0]) continue;
    triggeredCount++;

    try {
      await sendAlertEmail({
        email: row.email,
        kind: row.kind,
        productTitle: row.productTitle,
        productUrl: `${appUrl()}/urun/${row.productSlug}`,
        sizeNorm: row.sizeNorm,
      });
      await db.update(alert).set({ notifiedAt: new Date() }).where(eq(alert.id, row.alertId));
      notifiedCount++;
    } catch {
      // triggered ama e-posta gitmedi; notified_at NULL kalir.
    }
  }

  return { triggeredCount, notifiedCount };
}
