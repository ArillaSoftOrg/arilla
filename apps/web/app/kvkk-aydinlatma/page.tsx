import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { LEGAL_EFFECTIVE_LABEL, LegalIdentityBlock } from "../legal-identity-block.tsx";

export const metadata: Metadata = {
  title: "KVKK Aydınlatma Metni – Arilla",
  description:
    "6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında Arilla kullanıcılarına yönelik aydınlatma metni.",
  alternates: { canonical: "/kvkk-aydinlatma" },
};

/**
 * Karar 0038: docs/arilla_legal_pack/02 temel alinarak repo denetimiyle
 * somutlastirildi. Veri kategorileri /gizlilik ile ayni denetime dayanir;
 * biri degisirse digeri de guncellenir. Hukukcu onayi bekleyen metin.
 */
export default function KvkkAydinlatmaPage() {
  return (
    <LegalPageLayout title="KVKK Aydınlatma Metni" lastUpdatedLabel={LEGAL_EFFECTIVE_LABEL}>
      <section>
        <p>
          Bu metin, 6698 sayılı Kişisel Verilerin Korunması Kanunu (&quot;KVKK&quot;) kapsamında,
          Arilla hizmetlerini kullanan kişilerin kişisel verilerinin işlenmesi hakkında
          bilgilendirilmesi amacıyla hazırlanmıştır.
        </p>
      </section>

      <section>
        <h2>1. Veri sorumlusu</h2>
        <LegalIdentityBlock contact="privacy" />
      </section>

      <section>
        <h2>2. İşlenen kişisel veri kategorileri</h2>
        <ul>
          <li>
            <strong>Kimlik ve iletişim:</strong> e-posta adresi, ad, profil fotoğrafı bağlantısı,
            Google veya Apple hesap kimliği; telefonla giriş sunulduğunda telefon numarası.
          </li>
          <li>
            <strong>İşlem güvenliği:</strong> IP adresi, tarayıcı bilgisi, oturum kayıtları, giriş
            bağlantısı ve doğrulama kodlarının özet değerleri, giriş denemesi sayaçları.
          </li>
          <li>
            <strong>Müşteri işlem:</strong> kaydedilen ürünler, fiyat/stok alarmları, ürün
            bağlantısıyla yapılan aramalar, mağazaya yönlendirme (tıklama) kayıtları, anonim oturum
            kimliği.
          </li>
          <li>
            <strong>Görsel:</strong> fotoğrafla aramada yüklenen görsel. Görsel saklanmaz; yalnızca
            sayısal temsili ve özet değeri tutulur.
          </li>
          <li>
            <strong>Pazarlama ve rıza tercihleri:</strong> hesap rıza tercihleri, çerez tercihi.
          </li>
          <li>
            <strong>Talep/şikâyet:</strong> destek yazışmaları.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. İşleme amaçları</h2>
        <ul>
          <li>Arama, karşılaştırma ve mağazaya yönlendirme hizmetinin sunulması,</li>
          <li>hesap açılması, kimlik doğrulama, oturum ve hesap güvenliğinin sağlanması,</li>
          <li>kaydedilen ürünlerin ve alarm bildirimlerinin yönetilmesi,</li>
          <li>
            kullanım limitlerinin işletilmesi, kötüye kullanım ve güvenlik risklerinin önlenmesi,
          </li>
          <li>teknik sorunların giderilmesi ve hizmet kalitesinin artırılması,</li>
          <li>
            mağaza yönlendirmelerinin kaydı; affiliate programları etkinleştirildiğinde komisyon
            ilişkilendirmesi ve mutabakatı,
          </li>
          <li>destek taleplerinin yönetilmesi,</li>
          <li>hukuki yükümlülüklerin yerine getirilmesi.</li>
        </ul>
      </section>

      <section>
        <h2>4. Toplama yöntemi ve hukuki sebep</h2>
        <p>
          Kişisel veriler; web sitesi, giriş formları, Google ve Apple kimlik doğrulama hizmetleri,
          arama ve tıklama işlemleri, çerezler, sunucu ve güvenlik kayıtları ile e-posta yoluyla,
          otomatik veya kısmen otomatik yöntemlerle toplanır.
        </p>
        <p>
          Veriler, KVKK&apos;nın 5. maddesinde öngörülen şu hukuki sebeplere dayanılarak işlenir:
        </p>
        <ul>
          <li>sözleşmenin kurulması veya ifası için gerekli olması,</li>
          <li>veri sorumlusunun hukuki yükümlülüğünü yerine getirmesi,</li>
          <li>bir hakkın tesisi, kullanılması veya korunması,</li>
          <li>temel hak ve özgürlüklere zarar vermemek kaydıyla meşru menfaat,</li>
          <li>
            gerekli hallerde açık rıza (gezinme geçmişi, pazarlama e-postası, zorunlu olmayan
            çerezler).
          </li>
        </ul>
        <p>Açık rıza gerektiren çerez ve teknolojiler, rıza verilmeden etkinleştirilmez.</p>
      </section>

      <section>
        <h2>5. Aktarım</h2>
        <p>Kişisel veriler, amaçla sınırlı ve ölçülü olmak kaydıyla şu alıcılara aktarılabilir:</p>
        <ul>
          <li>
            barındırma (Vercel), veritabanı (Supabase), önbellek/kuyruk, e-posta ve SMS gönderim
            hizmet sağlayıcıları,
          </li>
          <li>
            fotoğrafla arama için görsel embedding hizmeti sağlayıcısı Jina AI GmbH (Almanya),
          </li>
          <li>Google ile veya Apple ile giriş seçildiğinde ilgili kimlik doğrulama sağlayıcısı,</li>
          <li>mağazaya yönlendirme kapsamında ilgili mağaza veya affiliate ağı,</li>
          <li>kanunen yetkili kamu kurum ve kuruluşları.</li>
        </ul>
        <p>
          Bu sağlayıcıların bir kısmı yurt dışında bulunduğundan veriler yurt dışına aktarılabilir;
          aktarım KVKK&apos;nın 9. maddesinde öngörülen mekanizmalara dayanılarak yapılır.
        </p>
      </section>

      <section>
        <h2>6. KVKK&apos;nın 11. maddesi kapsamındaki haklarınız</h2>
        <ul>
          <li>kişisel verilerinizin işlenip işlenmediğini öğrenme,</li>
          <li>işlenmişse buna ilişkin bilgi talep etme,</li>
          <li>işlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme,</li>
          <li>yurt içinde veya yurt dışında aktarıldığı üçüncü kişileri bilme,</li>
          <li>eksik veya yanlış işlenmişse düzeltilmesini isteme,</li>
          <li>kanuni şartlar çerçevesinde silinmesini veya yok edilmesini isteme,</li>
          <li>
            düzeltme, silme veya yok etme işlemlerinin verilerin aktarıldığı üçüncü kişilere
            bildirilmesini isteme,
          </li>
          <li>
            münhasıran otomatik sistemlerle analiz edilmesi suretiyle aleyhinize bir sonucun ortaya
            çıkmasına itiraz etme,
          </li>
          <li>
            kanuna aykırı işleme nedeniyle zarara uğramanız hâlinde zararın giderilmesini talep
            etme.
          </li>
        </ul>
      </section>

      <section>
        <h2>7. Başvuru</h2>
        <p>
          Giriş yaptıysanız verilerinizi Hesap sayfanızdan indirebilir, rıza tercihlerinizi
          değiştirebilir ve hesabınızı silebilirsiniz. Diğer talepleriniz için veri sorumlusuna
          aşağıdaki adresten veya mevzuata uygun diğer yöntemlerle başvurabilirsiniz. Başvurunuzda
          kimliğinizi doğrulamak için yalnızca talebin güvenli biçimde sonuçlandırılmasına yetecek
          bilgiler istenir.
        </p>
        <LegalIdentityBlock contact="privacy" entity={false} />
      </section>

      <section>
        <h2>8. Aydınlatma ve açık rızanın ayrılığı</h2>
        <p>
          Bu metin yalnızca bilgilendirme amaçlıdır. Açık rıza gerektiren işlemler için rızanız
          ayrıca ve özgür iradenizle alınır. Bu metnin okunması veya siteye girilmesi, tek başına
          açık rıza verildiği anlamına gelmez.
        </p>
      </section>
    </LegalPageLayout>
  );
}
