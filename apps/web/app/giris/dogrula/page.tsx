import { safeRedirectPath } from "@arilla/core";
import { Button } from "@arilla/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import styles from "../page.module.css";
import { confirmLoginAction } from "./actions.ts";

export const metadata: Metadata = {
  title: "Girişi tamamla",
  robots: { index: false, follow: false },
  // Adres satırındaki token hiçbir istekte Referer ile dışarı gitmesin.
  referrer: "no-referrer",
};

/** docs/copy.md `auth.confirm_*`. */
const COPY = {
  title: "Girişi tamamla",
  body: "Giriş yapmak için aşağıdaki düğmeye bas. Bağlantı yalnızca bir kez kullanılabilir.",
  submit: "Giriş yap", // action.login
} as const;

/**
 * docs/routes.md `/giris/dogrula?token=...`. GET hiçbir şeyi değiştirmez:
 * yalnızca onay formunu gösterir. E-posta tarayıcıları ve bağlantı
 * önizlemeleri adresi açsa da token tüketilmez; giriş, formun POST'u ile
 * (`confirmLoginAction`) tamamlanır. Token'ın geçerliliği burada
 * sorgulanmaz: GET yan etkisiz ve veritabanına dokunmaz.
 */
export default async function DogrulaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  if (!token) {
    redirect("/giris");
  }

  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label="Arilla ana sayfa">
        Arilla
      </a>
      <section className={styles.panel} aria-labelledby="dogrula-baslik">
        <h1 id="dogrula-baslik" className={styles.title}>
          {COPY.title}
        </h1>
        <p className={styles.sentBody}>{COPY.body}</p>
        <form action={confirmLoginAction} className={styles.form}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="next" value={safeRedirectPath(next)} />
          <Button type="submit" variant="primary" size="lg" fullWidth>
            {COPY.submit}
          </Button>
        </form>
      </section>
    </div>
  );
}
