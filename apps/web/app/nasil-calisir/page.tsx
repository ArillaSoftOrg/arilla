import { canAccessProduct, EARLY_ACCESS_PATH, EARLY_ACCESS_SIGNUP_PATH } from "@arilla/core";
import type { Metadata } from "next";
import Link from "next/link";
import { verifySession } from "../lib/dal.ts";
import { SITE_BRAND } from "../site-config.ts";
import { HowItWorksDemo } from "./demo-client.tsx";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: `Nasıl çalışır? – ${SITE_BRAND}`,
  description: `${SITE_BRAND}'de sohbetin nasıl ilerlediğini etkileşimli bir örnekle keşfet. Ürün kaydetmeyi, fiyat alarmını, benzerleri ve karşılaştırmayı dene.`,
  alternates: { canonical: "/nasil-calisir" },
};

export default async function HowItWorksPage() {
  const user = await verifySession();
  const productAccess = canAccessProduct(user);
  const action = productAccess
    ? { href: "/#anasayfa-baslik", label: "Kendi aramana başla" }
    : user
      ? { href: EARLY_ACCESS_PATH, label: "Erişim durumunu gör" }
      : { href: EARLY_ACCESS_SIGNUP_PATH, label: "Erken erişime katıl" };

  return (
    <article className={styles.page}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>{SITE_BRAND} nasıl çalışır?</p>
        <h1 className={styles.title}>
          Aradığını anlat.
          <br />
          Birlikte bakalım.
        </h1>
        <p className={styles.lead}>
          Sohbetin nasıl ilerlediğini izle. Sonra beğendiğin ürünle neler yapabileceğini burada
          dene.
        </p>
      </header>
      <HowItWorksDemo />
      <div className={styles.outro}>
        <p className={styles.outroText}>
          {productAccess
            ? "Şimdi kendi aradığın üründen başlayabilirsin."
            : `${SITE_BRAND}'yi kullanmak için erişim durumuna göz at.`}
        </p>
        <Link href={action.href} className={styles.action}>
          {action.label} <span aria-hidden="true">→</span>
        </Link>
        <Link href="/sss" className={styles.helpLink}>
          Aklına takılan bir soru mu var?
        </Link>
      </div>
    </article>
  );
}
