/**
 * Next.js authentication rehberindeki DAL deseni: `cookies()` erişimi burada
 * kalır, gerçek doğrulama `packages/core`'daki `verifySessionToken`'a delege
 * edilir (CLAUDE.md kural 6 - iş mantığı core'da).
 *
 * `apps/web/proxy.ts` yalnızca iyimser (çerez var mı) kontrol yapar; bu
 * dosyadaki `requireCapability`/`requireUser` her server action ve sayfada TEKRAR çağrılmalı -
 * Next'in kendi rehberi proxy'nin tek başına yeterli olmadığını söylüyor.
 */
import {
  type AdminActor,
  type Capability,
  canAccessProduct,
  hasCapability,
  productAccessRedirect,
  type SessionUser,
  verifySessionToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { readSessionCookie } from "./session-cookie.ts";

export const verifySession = cache(async (): Promise<SessionUser | null> => {
  const rawToken = await readSessionCookie();
  if (!rawToken) return null;
  return verifySessionToken(getDatabase(), rawToken);
});

/**
 * `/yonetim` yetki kapısı (docs/decisions/0039). Her yönetim sayfası ve
 * server action'ı kendi yeteneğiyle çağırır; layout'taki çağrı yalnızca
 * kolaylıktır, action'ları korumaz.
 *
 * Anonim → `/giris`. Girişli ama yetkisiz → 404: yönetim alanının varlığı
 * doğrulanmaz. Dönen `actor` core mutasyonlarına verilir; core aynı
 * yeteneği ikinci kez denetler.
 */
export async function requireCapability(
  capability: Capability,
): Promise<{ user: SessionUser; actor: AdminActor }> {
  const user = await verifySession();
  if (!user) {
    redirect("/giris");
  }
  if (!hasCapability(user.role, capability)) {
    notFound();
  }
  return { user, actor: { userId: user.id, role: user.role } };
}

/** Hassas yönetim işlemi için oturum en fazla bu kadar eski olabilir. */
export const FRESH_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * `requireCapability` + taze oturum. Uzun ömürlü (90 gün) bir oturumla
 * mağaza kapatma gibi işlemler yapılamaz; kullanıcı yeniden giriş yapar.
 * `fresh: false` dönerse çağıran işlemi yapmaz ve bunu kullanıcıya söyler.
 */
export async function requireFreshCapability(
  capability: Capability,
): Promise<{ user: SessionUser; actor: AdminActor; fresh: boolean }> {
  const { user, actor } = await requireCapability(capability);
  const createdAt = user.sessionCreatedAt?.getTime();
  const fresh = createdAt !== undefined && Date.now() - createdAt <= FRESH_SESSION_MAX_AGE_MS;
  return { user, actor, fresh };
}

/** Giriş gerekli ama ürün dışı sayfalar (`/hesap`, `/erken-erisim`) - rol farketmez. */
export async function requireUser(): Promise<SessionUser> {
  const user = await verifySession();
  if (!user) {
    redirect("/giris");
  }
  return user;
}

/**
 * Lansman öncesi ürün kapısı (P2). Kararın tamamı core'da
 * (`canAccessProduct`): `PRODUCT_ACCESS=open` değilse yalnızca moderatör ve
 * yönetici geçer. Her ürün sayfası, server action'ı ve route handler'ı bunu
 * KENDİSİ çağırır; proxy yalnızca anonim ziyaretçiyi erken yönlendirir.
 *
 * Geçemeyen: anonim → `/` (erken erişim landing'i), girişli → `/erken-erisim`.
 * Geçen anonim ziyaretçi (ürün açıkken) için `null` döner.
 */
export async function requireProductAccess(): Promise<SessionUser | null> {
  const user = await verifySession();
  if (!canAccessProduct(user)) {
    redirect(productAccessRedirect(user));
  }
  return user;
}

/** Giriş gerekli ürün sayfaları: `/kaydettiklerim`, `/alarmlar`, `/gecmis`. */
export async function requireProductUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (!canAccessProduct(user)) {
    redirect(productAccessRedirect(user));
  }
  return user;
}
