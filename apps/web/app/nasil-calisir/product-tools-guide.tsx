import { Accordion, HeartIcon } from "@arilla/ui";
import styles from "./page.module.css";

/** İşlem adları mevcut sohbet menüsüyle aynıdır. Örnek ürün/fiyat üretilmez. */
export function ProductToolsGuide() {
  return (
    <section className={styles.productTools} aria-labelledby="urunle-devam-et">
      <div className={styles.toolsIntro}>
        <p className={styles.eyebrow}>Bir seçenek ilgini çektiğinde</p>
        <h2 id="urunle-devam-et" className={styles.sectionTitle}>
          Bulduğun ürünle devam et.
        </h2>
        <p className={styles.description}>
          Beğendiğini sakla, benzerlerine bak ya da karar vermeden önce karşılaştır.
        </p>
        <p className={styles.toolLocations}>
          <span>
            <HeartIcon size={20} /> Kalp ile kaydet
          </span>
          <span>
            <span className={styles.moreSymbol} aria-hidden="true">
              ⋯
            </span>{" "}
            Diğerleri üç nokta menüsünde
          </span>
        </p>
      </div>
      <Accordion
        headingLevel={3}
        className={styles.toolsAccordion}
        items={[
          {
            id: "urun-kaydetme",
            heading: "Kaydet, sonra tekrar bak",
            content: (
              <>
                <p>Beğendiğin ürünleri bir arada tut.</p>
                <ol className={styles.actionSteps}>
                  <li>Ürün kartının sağ üstündeki kalbe dokun.</li>
                  <li>
                    Kaydettiğin ürünü daha sonra <strong>Kaydettiklerim</strong> bölümünden aç.
                  </li>
                  <li>Kaydı kaldırmak istersen aynı kalbe tekrar dokun.</li>
                </ol>
              </>
            ),
          },
          {
            id: "fiyat-alarmi",
            heading: "Fiyat alarmı kur",
            content: (
              <>
                <p>Aklındaki fiyat için ürünü takibe al.</p>
                <ol className={styles.actionSteps}>
                  <li>
                    Üç nokta menüsünden <strong>Fiyat alarmı kur</strong> seçeneğini aç.
                  </li>
                  <li>Hedef fiyatını TL olarak yaz ve alarmı kur.</li>
                  <li>Aktif alarmını aynı menüden görüntüleyebilir veya kaldırabilirsin.</li>
                </ol>
                <p className={styles.toolsNote}>
                  Fiyat alarmı, TL fiyatı bulunan ürünlerde kullanılabilir.
                </p>
              </>
            ),
          },
          {
            id: "benzer-urunler",
            heading: "Benzer seçenekleri keşfet",
            content: (
              <>
                <p>İlgini çeken üründen yola çıkarak başka seçeneklere bak.</p>
                <ol className={styles.actionSteps}>
                  <li>
                    Üç nokta menüsünden <strong>Benzerlerini bul</strong> seçeneğini aç.
                  </li>
                  <li>Listelenen alternatifleri sohbetten ayrılmadan incele.</li>
                </ol>
                <p className={styles.toolsNote}>
                  Benzer ürünler aynı ürün olmayabilir. Malzeme, beden ve diğer ayrıntıları kontrol
                  et.
                </p>
              </>
            ),
          },
          {
            id: "urun-karsilastirma",
            heading: "2–3 ürünü karşılaştır",
            content: (
              <>
                <p>Kararsız kaldığın seçenekleri yan yana incele.</p>
                <ol className={styles.actionSteps}>
                  <li>
                    İlgilendiğin ürünlerin üç nokta menüsünden <strong>Karşılaştırmaya ekle</strong>{" "}
                    seçeneğini kullan.
                  </li>
                  <li>
                    İki ya da üç ürün seçince alttaki <strong>Karşılaştır</strong> düğmesine dokun.
                  </li>
                  <li>Fiyat, marka, renk, mağaza, stok ve seçenek bilgilerini aynı panelde gör.</li>
                </ol>
                <p className={styles.toolsNote}>
                  Başlangıç fiyatları farklı beden veya seçeneklere ait olabilir.
                </p>
              </>
            ),
          },
        ]}
      />
    </section>
  );
}
