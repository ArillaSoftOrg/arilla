import { isProductOpen, safeRedirectPath } from "@arilla/core";
import { COMING_SOON_COPY } from "../coming-soon-copy.ts";
import { EARLY_ACCESS_COPY } from "../early-access-copy.ts";
import { SITE_BRAND } from "../site-config.ts";
import { LoginFormClient } from "./login-form-client.tsx";
import styles from "./page.module.css";

interface GirisSearchParams {
  error?: string;
  next?: string;
}

const ERROR_COPY: Record<string, string> = {
  // docs/copy.md `auth.token_expired` / `auth.token_used`
  expired: "Bu bağlantının süresi dolmuş. Yeni bir tane isteyebilirsin.",
  used: "Bu bağlantı zaten kullanılmış.",
  google: "Google ile giriş şu an tamamlanamadı. E-posta bağlantısıyla devam edebilirsin.",
  apple: "Apple ile giriş şu an tamamlanamadı. Başka bir yöntemle devam edebilirsin.",
};

const LOGIN_TITLE = "Tasarruflarını en üst düzeye çıkarmak için giriş yap.";

/** "Admin Girişi" bağlantısı (`ADMIN_LOGIN_PATH`) - yalnızca başlık seçimi, yetki değil. */
function isAdminNext(next: string): boolean {
  return next === "/yonetim" || next.startsWith("/yonetim/") || next.startsWith("/yonetim?");
}

/** docs/routes.md `/giris`: e-posta bağlantısı isteme. `/giris/dogrula` başarısızlıkları buraya `?error=` ile döner. */
export default async function GirisPage({
  searchParams,
}: {
  searchParams: Promise<GirisSearchParams>;
}) {
  const { error, next } = await searchParams;
  const errorText = error ? ERROR_COPY[error] : undefined;
  // Giriş sonrası dönüş yolu; güvensizse `/` (open redirect yok).
  const safeNext = safeRedirectPath(next);

  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label={`${SITE_BRAND} ana sayfa`}>
        {SITE_BRAND}
      </a>
      <a className={styles.close} href="/" aria-label="Giriş ekranını kapat">
        ×
      </a>
      <section className={styles.panel} aria-labelledby="giris-baslik">
        <h1 id="giris-baslik" className={styles.title}>
          {/* P2: lansman öncesi aynı form erken erişime katılma yoludur. */}
          {isProductOpen()
            ? LOGIN_TITLE
            : isAdminNext(safeNext)
              ? COMING_SOON_COPY.adminLoginTitle
              : EARLY_ACCESS_COPY.loginTitle}
        </h1>
        {errorText ? (
          <p role="alert" className={styles.notice}>
            {errorText}
          </p>
        ) : null}
        <LoginFormClient next={safeNext} />
        <p className={styles.legal}>
          Devam ederek {SITE_BRAND}'nin <a href="/kosullar">Hizmet Şartlarını</a> kabul etmiş ve{" "}
          <a href="/gizlilik">Gizlilik Politikasını</a> okumuş olursun.
        </p>
      </section>
    </div>
  );
}
