import type { Metadata } from "next";
import { PUBLIC_CONTACT_EMAIL, SITE_BRAND } from "../site-config.ts";
import styles from "./page.module.css";
import { PartnerFormClient } from "./partner-form-client.tsx";

export const metadata: Metadata = {
  title: `Ortaklıklar – ${SITE_BRAND}`,
  description: `${SITE_BRAND} ortaklık programı: ürün akışınızı paylaşın, ürünlerinizi arayan kullanıcılarla buluşun.`,
  alternates: { canonical: "/ortakliklar" },
};

/** Sayilar degil, urunun gercek ozellikleri: lansman oncesi uydurma istatistik yok. */
const STATS: readonly { value: string; label: string }[] = [
  { value: "3 arama yolu", label: "Fotoğraf, doğal dil ve ürün bağlantısı" },
  { value: "Mağazalar arası", label: "Aynı ve benzer ürün karşılaştırması" },
  { value: "Her tıklama kayıtlı", label: "Mağazanıza giden her link" },
  { value: "Açık komisyon", label: "Sıralamada belirleyici değil" },
];

const BENEFITS: readonly { title: string; text: string }[] = [
  {
    title: "Aradığını bilen kullanıcılarla buluşun.",
    text: "Kullanıcılar aradıkları ürünü fotoğraf, bağlantı veya kendi cümleleriyle tarif eder. Ürünlerinizi bu aramalarla buluştururuz.",
  },
  {
    title: "Alışveriş mağazanızda devam eder.",
    text: "Ürünleriniz burada keşfedilir; kullanıcılar mağaza bağlantısı üzerinden sitenize yönlendirilir. Ödeme mağazanızda gerçekleşir.",
  },
];

const STEPS: readonly { no: string; tag: string; title: string; text: string }[] = [
  {
    no: "01",
    tag: "Başvuru",
    title: "Uygunluğu inceliyoruz.",
    text: "Mağazanızı ve ürün akışınızı e-posta ile paylaşın. Ticari şartları ve aklınıza takılan soruları birlikte netleştirelim.",
  },
  {
    no: "02",
    tag: "Ürün akışı",
    title: "Bağlantı kuruyoruz ve verileri alıyoruz.",
    text: "Bizi ortaklık ağınızda onaylayın, ürün akışınıza yönlendirin; eşleştirme ve izleme işlemlerini biz halledelim.",
  },
  {
    no: "03",
    tag: "Yayına geçiş",
    title: "Ürünleriniz yayına giriyor.",
    text: "Entegrasyon tamamlandığında ürünleriniz arama sonuçlarında görünür. Yönlendirilen trafiği ortaklık ağınızın raporlarından takip edebilirsiniz.",
  },
];

const FAQ: readonly { q: string; a: string }[] = [
  {
    q: "Trafik nasıl sınıflandırılıyor ve izleniyor?",
    a: "Mağazanıza giden her bağlantı bir tıklama kaydı üretir ve ortaklık ağınızın izleme parametreleriyle gönderilir.",
  },
  {
    q: `${SITE_BRAND}, ürün verilerimizi nasıl işliyor?`,
    a: "Ürün akışınızı bir kez işler, sonuçları saklar ve arama sırasında yeniden hesaplamaz. Fiyat ve stok bilgisi akışınızdan gelir.",
  },
  {
    q: "Başvuru ve entegrasyon süreci ne kadar sürer?",
    a: "Süre, ürün akışınızın hazır olup olmamasına ve entegrasyon yöntemine bağlıdır. Başvurunuzu inceledikten sonra süreci birlikte netleştiririz.",
  },
  {
    q: "Komisyon oranı sıralamayı belirler mi?",
    a: "Hayır. Eşit koşullarda yalnızca ayrıştırıcı bir unsur olarak komisyon oranını dikkate alırız; sıralamada belirleyici değildir.",
  },
  {
    q: "Hangi konularda bilgilendirme alırız?",
    a: "Katalog durumunuz, yönlendirilen trafik ve program şartlarındaki değişiklikler hakkında bilgilendirilirsiniz.",
  },
  {
    q: "Minimum bir CPA veya işlem hacmi şartı var mı?",
    a: "Programın ticari şartları görüşmede netleşir; başvuru için asgari bir hacim zorunluluğu belirtmiyoruz.",
  },
];

export default function OrtakliklarPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="hero-title">
        <p className={styles.badge}>Ürün keşfi ve fiyat karşılaştırma için ortaklık</p>
        <h1 id="hero-title" className={styles.heroTitle}>
          {SITE_BRAND} ortağı olun
        </h1>
        <p className={styles.heroText}>
          Ürünlerinizi, aradığını bilen kullanıcılarla buluşturun. Kataloğunuzu paylaşın;
          kullanıcılar ürünleri {SITE_BRAND}'de keşfetsin, alışveriş mağazanızda devam etsin.
        </p>
        <a href="#basvuru" className={styles.cta}>
          Başvuru alanını gör <span aria-hidden="true">→</span>
        </a>
        <a href="#nasil-calisir" className={styles.heroLink}>
          Nasıl çalıştığını öğrenin <span aria-hidden="true">↘</span>
        </a>
      </section>

      <section className={styles.statsWrap} aria-label="Öne çıkanlar">
        <dl className={styles.stats}>
          {STATS.map((stat) => (
            <div key={stat.value} className={styles.stat}>
              <dt className={styles.statValue}>{stat.value}</dt>
              <dd className={styles.statLabel}>{stat.label}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="why-title">
        <div className={styles.inner}>
          <p className={styles.eyebrow}>{`Neden ${SITE_BRAND} ile ortaklık kurmalısınız?`}</p>
          <h2 id="why-title" className={styles.h2}>
            Neden bizimle çalışmalısınız?
          </h2>
          {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
          <ul role="list" className={styles.benefits}>
            {BENEFITS.map((benefit, index) => (
              <li key={benefit.title} className={styles.benefit}>
                <span className={styles.benefitIcon} aria-hidden="true">
                  {index === 0 ? "◎" : "⌂"}
                </span>
                <div>
                  <h3 className={styles.h3}>{benefit.title}</h3>
                  <p className={styles.bodyText}>{benefit.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="nasil-calisir" className={styles.steps} aria-labelledby="steps-title">
        <div className={styles.inner}>
          <p className={`${styles.eyebrow} ${styles.eyebrowOnDark}`}>Nasıl çalışır?</p>
          <h2 id="steps-title" className={`${styles.h2} ${styles.onDark}`}>
            Ürünlerinizi yayınlamak için üç adım
          </h2>
          {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
          <ol role="list" className={styles.stepList}>
            {STEPS.map((step) => (
              <li key={step.no} className={styles.step}>
                <p className={styles.stepHead}>
                  <span className={styles.stepNo}>{step.no}</span>
                  <span className={styles.stepTag}>{step.tag}</span>
                </p>
                <h3 className={`${styles.h3} ${styles.onDark}`}>{step.title}</h3>
                <p className={styles.stepText}>{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="faq-title">
        <div className={styles.inner}>
          <h2 id="faq-title" className={styles.h2}>
            Ortakların sorduğu sorular
          </h2>
          <div className={styles.faq}>
            {FAQ.map((item) => (
              <details key={item.q} className={styles.faqItem}>
                <summary className={styles.faqQuestion}>
                  <span>{item.q}</span>
                  <span className={styles.chevron} aria-hidden="true" />
                </summary>
                <p className={styles.faqAnswer}>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section id="basvuru" className={styles.contact} aria-labelledby="contact-title">
        <div className={styles.inner}>
          <p className={styles.eyebrow}>Bize ulaşın</p>
          <h2 id="contact-title" className={styles.h2}>
            Programınız hakkında bize bilgi verin.
          </h2>
          <p className={styles.bodyText}>
            Mağazanız ve ürün akışınız hakkında bize e-posta gönderin. Başvuru formu henüz kullanıma
            açık değil; aşağıda yalnızca önizlemesini inceleyebilirsiniz.
          </p>
          {PUBLIC_CONTACT_EMAIL ? (
            <div className={styles.mailCard}>
              <p className={styles.eyebrow}>Ortaklık için bize yazın.</p>
              <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`} className={styles.mailLink}>
                <span aria-hidden="true">✉</span> {PUBLIC_CONTACT_EMAIL}
              </a>
            </div>
          ) : null}
          <PartnerFormClient />
        </div>
      </section>
    </div>
  );
}
