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
  adminLoginPath,
  type Capability,
  canAccessProduct,
  deleteSession,
  evaluateAdminSession,
  hasCapability,
  isFreshAuth,
  productAccessRedirect,
  type SessionUser,
  safeAdminNext,
  verifySessionToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { ADMIN_PATH_HEADER } from "./admin-path-header.ts";
import { readSessionCookie } from "./session-cookie.ts";

export const verifySession = cache(async (): Promise<SessionUser | null> => {
  const rawToken = await readSessionCookie();
  if (!rawToken) return null;
  return verifySessionToken(getDatabase(), rawToken);
});

/**
 * İsteğin yönetim yolu: proxy `/yonetim/*` isteklerinde `x-arilla-path`
 * başlığını KENDİSİ yazar (istemciden gelen aynı adlı başlık ezilir).
 * Yeniden giriş sonrası kullanıcı aynı sayfaya döner; değer ayrıca
 * `safeAdminNext` ile süzülür.
 */
async function currentAdminPath(): Promise<string> {
  return safeAdminNext((await headers()).get(ADMIN_PATH_HEADER));
}

/**
 * `/yonetim` yetki kapısı (docs/decisions/0039, 0044). Her yönetim sayfası
 * ve server action'ı kendi yeteneğiyle çağırır; layout'taki çağrı yalnızca
 * kolaylıktır, action'ları korumaz. Rol her istekte veritabanından okunur:
 * rolü düşürülen kişi bir sonraki istekte erişimi kaybeder.
 *
 * - Anonim → `/yonetim/giris` (dönüş yoluyla).
 * - Girişli ama yetkisiz → 404: yönetim alanının varlığı doğrulanmaz.
 * - Yetkili ama yönetim oturumu dolmuş (12 saat) ya da boşta kalmış
 *   (30 dk) → `/yonetim/giris?neden=...`. Normal site oturumu etkilenmez.
 *
 * Dönen `actor` core mutasyonlarına verilir; core aynı yeteneği ikinci kez
 * denetler.
 */
export async function requireCapability(
  capability: Capability,
): Promise<{ user: SessionUser; actor: AdminActor }> {
  const user = await verifySession();
  if (!user) {
    redirect(adminLoginPath(await currentAdminPath()));
  }
  if (!hasCapability(user.role, capability)) {
    notFound();
  }
  const state = evaluateAdminSession({
    createdAt: user.sessionCreatedAt,
    lastUsedAt: user.sessionLastUsedAt,
  });
  if (state !== "ok") {
    // Oturum sunucuda sonlandırılır: `last_used_at` bu istekte zaten
    // güncellendi; silinmezse sayfayı yenilemek boşta kalma kuralını
    // atlatırdı. Yalnızca yönetim yetkili hesaplar buraya gelir.
    const rawToken = await readSessionCookie();
    if (rawToken) await deleteSession(getDatabase(), rawToken);
    redirect(adminLoginPath(await currentAdminPath(), state === "idle" ? "bosta" : "sure"));
  }
  return { user, actor: { userId: user.id, role: user.role } };
}

/**
 * `requireCapability` + taze giriş (son 1 saat, `FRESH_AUTH_MAX_AGE_MS`).
 * Yüksek etkili mutasyonlar içindir (docs/decisions/0044 listesi).
 * `fresh: false` dönerse çağıran işlemi YAPMAZ ve kullanıcıya `reauthHref`
 * ile yeniden giriş bağlantısını gösterir.
 */
export async function requireFreshCapability(capability: Capability): Promise<{
  user: SessionUser;
  actor: AdminActor;
  fresh: boolean;
  reauthHref: string;
}> {
  const { user, actor } = await requireCapability(capability);
  return {
    user,
    actor,
    fresh: isFreshAuth(user.sessionCreatedAt),
    reauthHref: adminLoginPath(await currentAdminPath(), "yeniden"),
  };
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
