import {
  type AdminLoginReason,
  authProviderAvailability,
  hasCapability,
  safeAdminNext,
} from "@arilla/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifySession } from "../../lib/dal.ts";
import { LoginFormClient } from "../login-form-client.tsx";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "Yönetim girişi",
  robots: { index: false, follow: false },
};

/** docs/copy.md `admin.login.*`. */
const COPY = {
  title: "Yönetim girişi",
  intro: "Yönetim paneline yetkili hesabınla giriş yap. Yönetim oturumu en fazla 12 saat sürer.",
  noAccess: "Bu hesabın yönetim yetkisi yok. Yetkili bir hesapla giriş yap.",
  back: "Siteye dön",
} as const;

const REASON_COPY: Record<AdminLoginReason, string> = {
  sure: "Yönetim oturumun 12 saati doldurdu. Güvenlik için yeniden giriş yap.",
  bosta: "30 dakikadır işlem yapılmadığı için yönetim oturumun kapandı. Yeniden giriş yap.",
  yeniden: "Bu işlem için yakın zamanda giriş yapmış olman gerekiyor. Yeniden giriş yap.",
};

function isReason(value: string | undefined): value is AdminLoginReason {
  return value === "sure" || value === "bosta" || value === "yeniden";
}

/**
 * `/yonetim/giris` (proxy bu adresi buraya rewrite eder; yönetim kabuğu ve
 * yetki kapısı dışında). Aynı giriş seçenekleri (Google, Apple); fark
 * yalnızca dönüş yolu: `next` her zaman güvenli bir
 * `/yonetim` yoludur ve sunucuda her adımda yeniden süzülür.
 *
 * Giriş sonrası: yetkili → `next`; normal kullanıcı → kendi akışı
 * (`postAuthRedirect`: ürün kapalıyken `/erken-erisim`). Yönetim alanına
 * yönlendirilmez.
 */
export default async function YonetimGirisPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; neden?: string }>;
}) {
  const { next, neden } = await searchParams;
  const target = safeAdminNext(next);
  const user = await verifySession();
  // Zaten yetkili bir oturumla gelen (gerekçesiz) doğrudan hedefe: formu
  // yeniden göstermenin anlamı yok. Gerekçe varsa (süre doldu, boşta, taze
  // giriş) form kalır - özellikle "yeniden" taze bir giriş ister. Yönetim
  // oturum kuralları hedefte `requireCapability` ile yine uygulanır; süresi
  // dolmuş oturum orada silinip buraya gerekçeyle döner (döngü yok).
  if (user && hasCapability(user.role, "admin.access") && !isReason(neden)) {
    redirect(target);
  }
  const signedInWithoutAccess = user !== null && !hasCapability(user.role, "admin.access");
  const notice = signedInWithoutAccess
    ? COPY.noAccess
    : isReason(neden)
      ? REASON_COPY[neden]
      : null;

  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label="Ana sayfa">
        ManiCepte
      </a>
      <section className={styles.panel} aria-labelledby="yonetim-giris-baslik">
        <h1 id="yonetim-giris-baslik" className={styles.title}>
          {COPY.title}
        </h1>
        <p className={styles.sentBody}>{COPY.intro}</p>
        {notice ? (
          <p role="alert" className={styles.notice}>
            {notice}
          </p>
        ) : null}
        <LoginFormClient next={target} availability={authProviderAvailability()} />
        <a className={styles.legal} href="/">
          {COPY.back}
        </a>
      </section>
    </div>
  );
}
