import { LoginFormClient } from "./login-form-client.tsx";
import styles from "./page.module.css";

interface GirisSearchParams {
  error?: string;
}

const ERROR_COPY: Record<string, string> = {
  // docs/copy.md `auth.token_expired` / `auth.token_used`
  expired: "Bu bağlantının süresi dolmuş. Yeni bir tane isteyebilirsin.",
  used: "Bu bağlantı zaten kullanılmış.",
  google: "Google ile giriş şu an tamamlanamadı. E-posta bağlantısıyla devam edebilirsin.",
  apple: "Apple ile giriş şu an tamamlanamadı. Başka bir yöntemle devam edebilirsin.",
};

const LOGIN_TITLE = "Tasarruflarını en üst düzeye çıkarmak için giriş yap.";

/** docs/routes.md `/giris`: e-posta bağlantısı isteme. `/giris/dogrula` başarısızlıkları buraya `?error=` ile döner. */
export default async function GirisPage({
  searchParams,
}: {
  searchParams: Promise<GirisSearchParams>;
}) {
  const { error } = await searchParams;
  const errorText = error ? ERROR_COPY[error] : undefined;

  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label="Arilla ana sayfa">
        Arilla
      </a>
      <a className={styles.close} href="/" aria-label="Giriş ekranını kapat">
        ×
      </a>
      <section className={styles.panel} aria-labelledby="giris-baslik">
        <h1 id="giris-baslik" className={styles.title}>
          {LOGIN_TITLE}
        </h1>
        {errorText ? (
          <p role="alert" className={styles.notice}>
            {errorText}
          </p>
        ) : null}
        <LoginFormClient />
        <p className={styles.legal}>
          Devam ederek Arilla'nın <a href="/kosullar">Hizmet Şartlarını</a> kabul etmiş ve{" "}
          <a href="/gizlilik">Gizlilik Politikasını</a> okumuş olursun.
        </p>
      </section>
    </div>
  );
}
