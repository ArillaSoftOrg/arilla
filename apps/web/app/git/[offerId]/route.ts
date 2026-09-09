import { randomUUID } from "node:crypto";
import { OfferNotFoundError, recordClick } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

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
 */
export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
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
  const surface = url.searchParams.get("surface");

  const db = getDatabase();
  let redirectUrl: string;
  try {
    ({ redirectUrl } = await recordClick(db, {
      offerId: offerIdNum,
      sessionId,
      channel: "web",
      surface,
    }));
  } catch (error) {
    if (error instanceof OfferNotFoundError) {
      notFound();
    }
    throw error;
  }

  redirect(redirectUrl);
}
