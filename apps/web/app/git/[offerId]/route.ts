import { randomUUID } from "node:crypto";
import { OfferNotFoundError, recordActivity, recordClick } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { readConsent } from "../../lib/consent.ts";
import { requireProductAccess } from "../../lib/dal.ts";

/**
 * docs/architecture.md SS6: click kaydi -> affiliate durumu -> deeplink ->
 * yonlendirme, tek istekte. Rota adi dokumandaki `/git/:clickId` degil
 * `[offerId]`: `recordClick()` clickId'yi GIRDI degil CIKTI olarak uretiyor,
 * tiklama kaydi henuz yokken bir clickId ile bu route'a girilemez (bkz.
 * docs/decisions ve C3 planlamasi).
 *
 * `session_id` cerezi bu istekte yoksa olusturulur - decision 0002'nin
 * ongordugu tam anonim oturum sistemi degil, yalnizca `recordClick()`'in
 * zorunlu alanini karsilamak icin minimal bir cozum.
 *
 * 0049 §5: `click` her cikista yazilir (CLAUDE.md kural 8) ve girisli
 * kullanicida `user_id` yalnizca attribution amaciyla tasir. Davranissal
 * analitik kopyasi (`merchant_exit`) AYRI bir olaydir ve yalnizca analitik
 * rizasiyla yazilir. Analitik hatasi yonlendirmeyi asla bozmaz.
 */
export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  // Ürün kapalıyken mağazaya çıkış (ve click kaydı) yok.
  const user = await requireProductAccess();
  const { offerId } = await params;
  const offerIdNum = Number(offerId);
  if (!Number.isInteger(offerIdNum)) {
    notFound();
  }

  const store = await cookies();
  const existingSessionId = store.get("session_id")?.value;
  const sessionId = existingSessionId ?? randomUUID();
  if (!existingSessionId) {
    store.set("session_id", sessionId, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }

  const url = new URL(request.url);
  // Serbest metin degil: core yalnizca izinli yuzeyleri yazar.
  const surface = url.searchParams.get("surface");

  const db = getDatabase();
  let redirectUrl: string;
  let clickId: string;
  try {
    ({ redirectUrl, clickId } = await recordClick(db, {
      offerId: offerIdNum,
      sessionId,
      channel: "web",
      surface,
      userId: user?.id ?? null,
    }));
  } catch (error) {
    if (error instanceof OfferNotFoundError) {
      notFound();
    }
    throw error;
  }

  if (user) {
    try {
      await recordActivity(db, {
        userId: user.id,
        cookieConsent: await readConsent(),
        event: { kind: "merchant_exit", offerId: offerIdNum, clickId },
      });
    } catch (error) {
      console.error("[git] activity failed", error instanceof Error ? error.name : "unknown");
    }
  }

  redirect(redirectUrl);
}
