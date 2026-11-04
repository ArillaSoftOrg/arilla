import type { Metadata } from "next";
import { SITE_BRAND } from "../site-config.ts";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: `Hakkında – ${SITE_BRAND}`,
  description: `${SITE_BRAND}, aynı ve benzer ürünleri mağazalar arasında bulup karşılaştırmanı sağlayan yapay zekâ destekli bir keşif platformudur.`,
  alternates: { canonical: "/hakkinda" },
};

const PARAGRAPHS: readonly string[] = [
  `${SITE_BRAND}, aradığın ürünü bulmana ve farklı mağazalardaki seçenekleri karşılaştırmana yardımcı olan yapay zekâ destekli bir ürün keşif platformudur.`,
  "Amacımız, mağazaları tek tek gezme ihtiyacını azaltmak ve karar vermeni kolaylaştırmak. Aradığını yazarak, fotoğraf veya ürün bağlantısı paylaşarak başlayabilirsin.",
  `${SITE_BRAND} ürün satmaz; seçenekleri keşfetmeni sağlar. Alışveriş, seçtiğin mağazanın sitesinde devam eder.`,
];

export default function HakkindaPage() {
  return (
    <article className={styles.page}>
      <h1 className={styles.title}>{SITE_BRAND} hakkında</h1>
      {PARAGRAPHS.map((text) => (
        <p key={text.slice(0, 24)} className={styles.paragraph}>
          {text}
        </p>
      ))}
    </article>
  );
}
