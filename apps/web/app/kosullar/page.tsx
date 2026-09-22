import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kullanım Koşulları – Arilla",
  description: "Arilla'nın ne yaptığı, fiyat/stok bilgisinin kaynağı ve affiliate ilişkisi.",
  alternates: { canonical: "/kosullar" },
};

/**
 * docs/pages.md "/kosullar": TASLAK sayfa. Sorumluluk sinirlamasi, uygulanacak
 * hukuk, uyusmazlik cozumu gibi hukmler kaynakta YOK - uydurulmadi, sayfa
 * bilerek bu maddeleri icermiyor.
 */
export default function KosullarPage() {
  return (
    <LegalPageLayout title="Kullanım Koşulları" lastUpdatedLabel="Son güncelleme: 17 Eylül 2026">
      <section>
        <p>
          Bu sayfa Arilla&apos;nın nasıl çalıştığını ve kullanıcı sorumluluklarını açıklar.
          Sorumluluk sınırlaması, uygulanacak hukuk ve uyuşmazlık çözümü gibi hükümler şirketin
          resmi kuruluşu ve hukuki onayı sonrasında eklenecektir; bu sayfa nihai bir sözleşme metni
          değildir.
        </p>
      </section>

      <section>
        <h2>Arilla ne yapar</h2>
        <p>
          Arilla bir arama ve karşılaştırma aracıdır — ürün satmaz, stok tutmaz, ödeme almaz. Aynı
          veya benzer ürünleri farklı mağazalarda bulmana yardımcı olur; satın alma işlemini her
          zaman ilgili mağazanın kendi sitesinde tamamlarsın.
        </p>
      </section>

      <section>
        <h2>Fiyat ve stok bilgisi</h2>
        <p>
          Gösterilen fiyat ve stok bilgisi mağaza kaynaklarından gelir ve gecikmeli olabilir.
          Arilla, mağazada göreceğin fiyat veya stok durumunun gösterilenle birebir aynı olacağını
          garanti etmez.
        </p>
      </section>

      <section>
        <h2>Affiliate ilişkisi</h2>
        <p>
          Arilla üzerinden bazı bağlantılara tıklayıp alışveriş yaptığında Arilla komisyon
          kazanabilir. Bu, mağazanın sana gösterdiği fiyatı değiştirmez.
        </p>
      </section>

      <section>
        <h2>Hesabın</h2>
        <p>
          Giriş, e-postana gönderilen tek kullanımlık bir bağlantı ile yapılır; şifre yoktur.
          Bağlantının ve e-posta hesabının güvenliği senin sorumluluğundadır. Hesabınla ilgili veri
          işlemleri ve haklarınla ilgili detaylar <a href="/gizlilik">Gizlilik sayfasında</a>.
        </p>
      </section>

      <section>
        <h2>Marka ve görsel kullanımı</h2>
        <p>
          Ürün görselleri ve marka adları ilgili mağaza veya markaya aittir; karşılaştırma amacıyla
          gösterilir.
        </p>
      </section>
    </LegalPageLayout>
  );
}
