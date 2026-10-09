import type { Metadata } from "next";
import { SITE_BRAND } from "../site-config.ts";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: `Hakkında – ${SITE_BRAND}`,
  description: `${SITE_BRAND}, aynı ve benzer ürünleri mağazalar arasında bulup karşılaştırmanı sağlayan yapay zekâ destekli bir keşif platformudur.`,
  alternates: { canonical: "/hakkinda" },
};

const PARAGRAPHS: readonly string[] = [
  "Hepimiz bu durumu yaşamışızdır, değil mi? İnternette gezinirken çok beğendiğiniz bir ürüne rastlıyorsunuz: harika tasarımlı bir koltuk, kusursuz bir ceket, aradığınız tam o telefon kılıfı. Hemen hayran kalıyorsunuz. Sepete eklemeyi düşünmeye başlıyorsunuz... ama sonra fiyatı görüyorsunuz.",
  "Eskiden yapabileceğiniz pek bir şey yoktu. Aynı ürünü başka mağazada aramak saatler alırdı ve çoğu zaman yarı yolda vazgeçerdiniz. Ama artık başka bir yol var.",
  `Dilerseniz fiyatı olduğu gibi kabul edip bütçenizin sınırlarını sessizce kabullenebilirsiniz. Ya da ${SITE_BRAND}'i kullanarak gerçekten karşılayabileceğiniz aynı veya benzer ürünleri bulabilirsiniz. Bir fotoğraf yükleyin ya da ne aradığınızı kendi cümlelerinizle yazın (ürün linkiyle arama da yakında geliyor); ${SITE_BRAND} aynı ürünü farklı mağazalarda yan yana koysun, benzer alternatifleri sizin için sıralasın. Karar vermek çok daha kolay.`,
  `${SITE_BRAND}, herkesin bilmesi gereken bir yöntem. Fiyatlar mağazadan mağazaya değişir; önemli olan doğru karşılaştırmayı doğru anda yapabilmek. Neden hâlâ herkesin bildiği bir alışkanlık olmadığını bilmiyoruz, ama sizi burada görmek bizi mutlu ediyor.`,
  `Herkes güzel şeylere ulaşmayı hak ediyor. ${SITE_BRAND}'i bunu mümkün kılmak için kurduk.`,
];

export default function HakkindaPage() {
  return (
    <article className={styles.page}>
      <h1 className={styles.title}>Fiyat farkından bahsedelim.</h1>
      {PARAGRAPHS.map((text) => (
        <p key={text.slice(0, 24)} className={styles.paragraph}>
          {text}
        </p>
      ))}
    </article>
  );
}
