import { serializeJsonLd } from "@arilla/core";
import { Accordion } from "@arilla/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { SITE_BRAND } from "../site-config.ts";
import { FaqAnswer } from "./faq-answer.tsx";
import { FAQ_ITEMS, faqPlainText } from "./faq-content.ts";
import { FAQ_PAGE_COPY as COPY } from "./faq-page-copy.ts";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: `${COPY.metaTitle} – ${SITE_BRAND}`,
  description: COPY.metaDescription,
  alternates: { canonical: "/sss" },
};

/** schema.org FAQPage: soru ve yanıtlar sayfadaki metnin aynısı (tek kaynak). */
const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer.map(faqPlainText).join(" "),
    },
  })),
};

/**
 * `/sss` (docs/decisions/0061). Ürün kapısının dışında, giriş modali yok
 * (karar 0002). İçerik `faq-content.ts`'te; bu dosya yalnızca yerleşim.
 */
export default function SssPage() {
  return (
    <article className={styles.page}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: schema.org JSON-LD; icerik depodaki sabit metin, serializeJsonLd </script> kacisini engeller.
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(FAQ_JSON_LD) }}
      />
      <header className={styles.intro}>
        <h1 className={styles.title}>{COPY.title}</h1>
        <p className={styles.description}>{COPY.description}</p>
      </header>

      <Accordion
        items={FAQ_ITEMS.map((item) => ({
          id: item.id,
          heading: item.question,
          content: <FaqAnswer paragraphs={item.answer} />,
        }))}
      />

      <section className={styles.more} aria-labelledby="sss-iletisim">
        <h2 id="sss-iletisim" className={styles.moreTitle}>
          {COPY.moreTitle}
        </h2>
        <p className={styles.moreBody}>{COPY.moreBody}</p>
        <Link className={styles.moreAction} href="/iletisim">
          {COPY.moreAction}
        </Link>
      </section>
    </article>
  );
}
