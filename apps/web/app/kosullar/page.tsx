import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { LEGAL_EFFECTIVE_LABEL, LegalIdentityBlock } from "../legal-identity-block.tsx";

export const metadata: Metadata = {
  title: "Kullanım Koşulları – Arilla",
  description:
    "Arilla hizmetinin kapsamı, fiyat ve stok bilgisinin kaynağı, affiliate ilişkisi ve kullanım kuralları.",
  alternates: { canonical: "/kosullar" },
};

/**
 * Karar 0038: docs/arilla_legal_pack/04 temel alindi. Uygulanacak hukuk ve
 * yetkili merci maddesi, isletmeci tuzel kisilik dogrulanip hukukcu onayi
 * alinana kadar bilerek kesinlestirilmedi (uydurulmadi).
 */
export default function KosullarPage() {
  return (
    <LegalPageLayout title="Kullanım Koşulları" lastUpdatedLabel={LEGAL_EFFECTIVE_LABEL}>
      <section>
        <p>Bu koşullar, Arilla hizmetlerinin kullanımını düzenler.</p>
      </section>

      <section>
        <h2>1. Hizmeti işleten</h2>
        <LegalIdentityBlock contact="support" />
      </section>

      <section>
        <h2>2. Hizmetin kapsamı</h2>
        <p>
          Arilla, ürünleri bulmanıza, farklı mağazalardaki fiyatlarını karşılaştırmanıza ve
          seçtiğiniz mağazaya yönlenmenize yardımcı olan bir bilgi ve yönlendirme hizmetidir. Arilla
          ürün satmaz, stok tutmaz ve ödeme almaz; aksi açıkça belirtilmedikçe listelenen ürünlerin
          satıcısı değildir ve mağaza ile aranızdaki satış sözleşmesinin tarafı olmaz.
        </p>
      </section>

      <section>
        <h2>3. Ürün bilgileri ve fiyatlar</h2>
        <p>
          Ürün adı, görsel, fiyat, stok, varyant ve kargo bilgileri mağazalardan, veri
          sağlayıcılarından veya otomatik veri işleme süreçlerinden gelir ve gecikmeli olabilir. Bu
          bilgileri doğru ve güncel tutmak için makul çaba gösteririz; ancak mağazadaki fiyat, stok
          veya ürün özelliği Arilla&apos;daki gösterimden farklı olabilir. Alışveriş kararı vermeden
          önce nihai fiyat, stok, teslimat, iade ve satış koşullarını ilgili mağazanın sitesinde
          doğrulayın.
        </p>
      </section>

      <section>
        <h2>4. Affiliate ilişkileri</h2>
        <p>
          Arilla bazı mağaza yönlendirmelerinden affiliate komisyonu kazanabilir. Bu, mağazanın size
          gösterdiği fiyatı değiştirmez ve size ek bir Arilla ücreti doğurmaz. Affiliate ilişkisi,
          Arilla&apos;nın bir ürünü veya satıcıyı garanti ettiği anlamına gelmez. Ayrıntılar{" "}
          <a href="/affiliate-aciklamasi">Affiliate Açıklaması</a>&apos;nda.
        </p>
      </section>

      <section>
        <h2>5. Hesaplar</h2>
        <p>
          Hesap açmak zorunlu değildir. Google ile, Apple ile, e-postanıza gönderilen tek
          kullanımlık bağlantıyla veya sunulduğunda telefonunuza gönderilen kodla giriş
          yapabilirsiniz; şifre kullanılmaz. Giriş yaptığınız e-posta, Google, Apple hesabınızın
          veya telefonunuzun güvenliği sizin sorumluluğunuzdadır; yetkisiz kullanımdan
          şüphelenirseniz bize bildirin.
        </p>
        <p>
          Güvenlik, kötüye kullanım, aşırı otomasyon, hizmete zarar verme veya bu koşulların ihlali
          halinde hesap erişimini sınırlayabiliriz. Hesabınızı Hesap sayfanızdan istediğiniz zaman
          silebilirsiniz.
        </p>
      </section>

      <section>
        <h2>6. Kabul edilebilir kullanım</h2>
        <p>Hizmeti kullanırken:</p>
        <ul>
          <li>hukuka aykırı amaçlarla kullanmamayı,</li>
          <li>güvenlik ve kullanım limiti mekanizmalarını aşmaya çalışmamayı,</li>
          <li>aşırı otomatik istek, kazıma veya hizmeti bozacak trafik üretmemeyi,</li>
          <li>başka kullanıcıların hesaplarına veya verilerine yetkisiz erişmeye çalışmamayı,</li>
          <li>
            fotoğrafla aramada yalnızca ürün fotoğrafları yüklemeyi ve başkalarının kişisel
            verilerini içeren görseller yüklememeyi,
          </li>
          <li>
            hizmetin korunan kısımlarını hukuken izin verilen sınırların dışında tersine
            mühendislikle elde etmeye çalışmamayı
          </li>
        </ul>
        <p>kabul edersiniz.</p>
      </section>

      <section>
        <h2>7. Fikri mülkiyet</h2>
        <p>
          Arilla&apos;ya ait marka, yazılım, arayüz ve özgün içerikler ilgili mevzuat kapsamında
          korunur. Ürün adları, markalar ve ürün görselleri ilgili hak sahiplerine aittir ve ürün
          tanımlama ve karşılaştırma amacıyla gösterilir.
        </p>
      </section>

      <section>
        <h2>8. Üçüncü taraf hizmetleri</h2>
        <p>
          Yönlendirildiğiniz mağazaların ürünleri, ödeme, teslimat ve iade süreçleri, veri işleme
          faaliyetleri ve kullanım koşulları kendi sorumluluklarındadır.
        </p>
      </section>

      <section>
        <h2>9. Hizmet değişiklikleri</h2>
        <p>
          Güvenlik, bakım, ürün geliştirme veya hukuki gereklilikler nedeniyle hizmetin bazı
          özelliklerini değiştirebilir, askıya alabilir veya sona erdirebiliriz.
        </p>
      </section>

      <section>
        <h2>10. Sorumluluğun sınırları</h2>
        <p>Emredici hukuk hükümleri saklı kalmak kaydıyla Arilla;</p>
        <ul>
          <li>mağazaların stok, fiyat, ürün kalitesi, teslimat veya iade süreçlerinden,</li>
          <li>üçüncü taraf sitelerin kesintilerinden,</li>
          <li>hizmetin yanlış veya hukuka aykırı kullanımından</li>
        </ul>
        <p>
          doğrudan sorumlu değildir. Bu madde, tüketici mevzuatından veya kişisel verilerin
          korunması mevzuatından doğan emredici haklarınızı ortadan kaldırmaz.
        </p>
      </section>

      <section>
        <h2>11. Gizlilik ve çerezler</h2>
        <p>
          Kişisel verilerin işlenmesine ilişkin ayrıntılar{" "}
          <a href="/gizlilik">Gizlilik Politikası</a>,{" "}
          <a href="/kvkk-aydinlatma">KVKK Aydınlatma Metni</a> ve{" "}
          <a href="/cerez">Çerez Politikası</a>&apos;nda açıklanır.
        </p>
      </section>

      <section>
        <h2>12. Değişiklikler</h2>
        <p>
          Koşullar hizmet veya mevzuat değiştikçe güncellenebilir. Güncel sürüm ve yürürlük tarihi
          bu sayfada yayımlanır.
        </p>
      </section>

      <section>
        <h2>13. Uygulanacak hukuk ve uyuşmazlıklar</h2>
        <p>
          Uygulanacak hukuk ve yetkili merci, hizmeti işleten tüzel kişiliğin tescili ve hukuki
          incelemesi tamamlandığında bu sayfada yayımlanacaktır. Tüketici mevzuatından doğan
          emredici haklarınız her durumda saklıdır.
        </p>
      </section>

      <section>
        <h2>14. İletişim</h2>
        <LegalIdentityBlock contact="support" entity={false} />
      </section>
    </LegalPageLayout>
  );
}
