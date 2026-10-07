/**
 * `/yonetim/erken-erisim`: erken erisim sayacinin platform disi kismi
 * (karar 0065). Bu sayi herkese gorunen ilerleme cubuguna girer; bu yuzden
 * yalnizca yonetici (`early_access.manage`), gerekce zorunlu ve her degisiklik
 * ayni islemde denetim kaydina yazilir.
 *
 * Sayi gercek kisileri temsil etmelidir (siteden kayit olamayip e-postayla
 * basvuranlar gibi); gerekce alani bu kaynagi kayda gecirir.
 */
import { type Database, earlyAccessCounter } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import {
  computeEarlyAccessProgress,
  type EarlyAccessProgress,
  readEarlyAccessCounts,
} from "../access/early-access-progress.ts";
import { recordAdminEvent } from "./audit.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const OFF_PLATFORM_MAX = 1_000_000;
export const COUNTER_REASON_MIN = 5;
export const COUNTER_REASON_MAX = 200;

export class EarlyAccessCounterValidationError extends Error {}

export interface EarlyAccessCounterAdminView extends EarlyAccessProgress {
  offPlatformCount: number;
  onPlatformCount: number;
  updatedAt: Date | null;
}

export async function getEarlyAccessCounterAdmin(
  db: Database,
  actor: AdminActor,
): Promise<EarlyAccessCounterAdminView> {
  assertCapability(actor, "early_access.manage");
  const counts = await readEarlyAccessCounts(db);
  const [row] = await db
    .select({ updatedAt: earlyAccessCounter.updatedAt })
    .from(earlyAccessCounter)
    .where(eq(earlyAccessCounter.id, 1))
    .limit(1);
  return {
    ...counts,
    ...computeEarlyAccessProgress(counts.offPlatformCount, counts.onPlatformCount),
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Saf dogrulama: tam sayi, 0..OFF_PLATFORM_MAX; gerekce kirpilir, 5-200 karakter. */
export function parseCounterUpdate(
  rawCount: unknown,
  rawReason: unknown,
): { count: number; reason: string } {
  const text = typeof rawCount === "number" ? String(rawCount) : rawCount;
  if (typeof text !== "string" || !/^\d{1,7}$/.test(text.trim())) {
    throw new EarlyAccessCounterValidationError(
      "Sayı 0 ile 1.000.000 arasında bir tam sayı olmalı.",
    );
  }
  const count = Number(text.trim());
  if (count > OFF_PLATFORM_MAX) {
    throw new EarlyAccessCounterValidationError(
      "Sayı 0 ile 1.000.000 arasında bir tam sayı olmalı.",
    );
  }
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length < COUNTER_REASON_MIN || reason.length > COUNTER_REASON_MAX) {
    throw new EarlyAccessCounterValidationError(
      `Gerekçe ${COUNTER_REASON_MIN}-${COUNTER_REASON_MAX} karakter olmalı (ör. kaynak ve tarih).`,
    );
  }
  return { count, reason };
}

export async function setOffPlatformCount(
  db: Database,
  actor: AdminActor,
  rawCount: unknown,
  rawReason: unknown,
): Promise<{ before: number; after: number }> {
  assertCapability(actor, "early_access.manage");
  const { count, reason } = parseCounterUpdate(rawCount, rawReason);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ value: earlyAccessCounter.offPlatformCount })
      .from(earlyAccessCounter)
      .where(eq(earlyAccessCounter.id, 1))
      .for("update");
    if (!current) throw new Error("early_access_counter satiri yok (migration 0050 uygulanmamis).");
    await tx
      .update(earlyAccessCounter)
      .set({ offPlatformCount: count, updatedBy: actor.userId, updatedAt: sql`now()` })
      .where(eq(earlyAccessCounter.id, 1));
    await recordAdminEvent(tx, {
      actor,
      action: "early_access.counter_set",
      targetType: "early_access_counter",
      targetId: 1,
      before: { offPlatformCount: current.value },
      after: { offPlatformCount: count },
      reason,
    });
    return { before: current.value, after: count };
  });
}
