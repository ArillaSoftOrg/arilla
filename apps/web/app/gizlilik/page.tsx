import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { LEGAL_EFFECTIVE_LABEL, LegalIdentityBlock } from "../legal-identity-block.tsx";

export const metadata: Metadata = {
  title: "Gizlilik Politikası – Arilla",
  description:
    "Arilla'nın hangi kişisel verileri hangi amaçla işlediği, kimlerle paylaştığı, ne kadar sakladığı ve haklarınız.",
  alternates: { canonical: "/gizlilik" },
};

/**
 * Karar 0038: docs/arilla_legal_pack/01 temel alinarak repo denetimiyle
 * (26 Eylul 2026) somutlastirildi. YALNIZCA kodda dogrulanmis veri akislari
 * ve saglayicilar yazilir; dogrulanmamis ulke, sure veya saglayici adi yok.
 * Kimlik alanlari legal-identity.ts'ten gelir. Hukukcu onayi bekleyen metin.
 *
 * Denetimde duzeltilen eski iddialar: fotograflar 30 gun gecici depoda
 * TUTULMUYOR (ham dosya hic saklanmiyor), yuz uyarisi ve urun disi fotograf
 * reddi henuz uygulanmiyor - metinden cikarildi.
 */
export default function GizlilikPage() {
  return (
    <LegalPageLayout title="Gizlilik Politikası" lastUpdatedLabel={LEGAL_EFFECTIVE_LABEL}>
      <section>
        <h2>1. Kapsam ve veri sorumlusu</h2>
        <p>
          Bu politika, Arilla ürün arama, karşılaştırma ve mağazaya yönlendirme hizmeti için
          geçerlidir. Hangi kişisel verileri işlediğimizi, bunları hangi amaçlarla kullandığımızı,
          kimlerle paylaştığımızı ve haklarınızı açıklar. KVKK kapsamındaki ayrıntılı bilgilendirme
          için <a href="/kvkk-aydinlatma">KVKK Aydınlatma Metni</a>&apos;ne bakabilirsiniz.
        </p>
        <LegalIdentityBlock contact="privacy" />
      </section>

      <section>
        <h2>2. İşlediğimiz bilgiler</h2>

        <h3>2.1. Hesap ve giriş bilgileri</h3>
        <p>Hesap oluşturmak zorunlu değildir. Giriş yaptığınızda seçtiğiniz yönteme göre:</p>
        <ul>
          <li>
            <strong>Google ile giriş:</strong> Google hesabınızın benzersiz kimliği, e-posta
            adresiniz ve doğrulanma durumu, adınız ve profil fotoğrafınızın bağlantısı. Google
            erişim anahtarınızı saklamayız.
          </li>
          <li>
            <strong>Apple ile giriş:</strong> Apple hesabınızın benzersiz kimliği, Apple&apos;ın
            paylaştığı e-posta adresi (gizli yönlendirme adresi dahil) ve ilk girişte paylaşıldıysa
            adınız.
          </li>
          <li>
            <strong>E-posta bağlantısıyla giriş:</strong> e-posta adresiniz. Bağlantı tek
            kullanımlıktır; bağlantının kendisi değil yalnızca özet değeri saklanır.
          </li>
          <li>
            <strong>Telefonla giriş (sunulduğunda):</strong> telefon numaranız. Size gönderilen
            doğrulama kodu yalnızca özet değeri olarak saklanır.
          </li>
        </ul>
        <p>
          Hesabınızda ayrıca kaydettiğiniz ürünler, kurduğunuz fiyat/stok alarmları ve hesap
          ayarlarınızdaki rıza tercihleriniz tutulur. Gezinme geçmişi yalnızca bu seçeneğe açıkça
          izin verirseniz kaydedilir; varsayılan olarak kapalıdır.
        </p>

        <h3>2.2. Arama ve kullanım bilgileri</h3>
        <ul>
          <li>
            <strong>Metin aramaları:</strong> sonuç üretmek için işlenir. Aramanın normalize edilmiş
            hali, sonuçları hızlandırmak amacıyla sizinle ilişkilendirilmeden genel bir önbellekte
            tutulabilir. Kullanıcıya bağlı bir arama geçmişi tutmayız.
          </li>
          <li>
            <strong>Ürün bağlantısıyla arama:</strong> yapıştırdığınız bağlantı, anonim oturum
            kimliğiniz (giriş yaptıysanız hesabınız) ile birlikte kaydedilir ve sunucularımız
            bağlantıdaki sayfayı ürün bilgisi için ziyaret eder.
          </li>
          <li>
            <strong>Fotoğrafla arama:</strong> yüklediğiniz fotoğraf (JPEG, PNG veya WebP, en fazla
            4 MB) bellekte işlenir ve diske veya dosya deposuna kaydedilmez. İşlenen görsel, sayısal
            temsilinin (embedding) üretilmesi için aşağıda belirtilen yapay zekâ sağlayıcısına
            gönderilir. Kalıcı olarak yalnızca bu sayısal temsil ile tekrar işlemeyi önleyen bir
            özet değeri (hash) saklanır; bunlardan fotoğrafın kendisi geri üretilemez. Lütfen
            kişisel veya başka kişileri gösteren fotoğraflar yüklemeyin.
          </li>
          <li>
            <strong>Mağazaya yönlendirme:</strong> bir mağaza bağlantısına tıkladığınızda hangi
            teklife, hangi yüzeyden, hangi anonim oturumdan ve tıklama anındaki fiyatla gidildiği
            kaydedilir. Bu kayıtta IP adresi ve tarayıcı bilgisi tutulmaz.
          </li>
          <li>
            <strong>Kullanım sınırları:</strong> görsel ve bağlantı aramalarındaki günlük limitler
            ile girişten önceki ücretsiz arama sayısı, anonim oturum kimliğiniz veya hesabınız
            üzerinden sayılır.
          </li>
        </ul>

        <h3>2.3. Teknik ve güvenlik bilgileri</h3>
        <ul>
          <li>
            Giriş yaptığınızda oturum kaydına IP adresiniz ve tarayıcı bilginiz eklenir. Giriş
            bağlantısı veya kod talebinde, rıza tercihi kaydında da IP adresi tutulur.
          </li>
          <li>
            Kötüye kullanımı önlemek için giriş denemeleri IP adresinizin ve e-posta adresinizin
            özet değerleri üzerinden kısa süreli sayılır.
          </li>
          <li>
            Barındırma sağlayıcımızın sunucu kayıtları, isteklerin IP adresini ve teknik bilgilerini
            içerebilir.
          </li>
          <li>Hata kayıtlarına e-posta, telefon numarası veya giriş anahtarı yazılmaz.</li>
        </ul>

        <h3>2.4. Destek yazışmaları</h3>
        <p>Bize e-posta ile yazdığınızda mesajınız ve e-posta adresiniz işlenir.</p>
      </section>

      <section>
        <h2>3. Bilgileri hangi amaçlarla kullanıyoruz</h2>
        <ul>
          <li>Arama, ürün karşılaştırma ve mağazaya yönlendirme hizmetini sunmak.</li>
          <li>Hesabınızı açmak, oturumunuzu ve hesap güvenliğini sağlamak.</li>
          <li>Kaydettiğiniz ürünleri göstermek ve alarm e-postalarını göndermek.</li>
          <li>Arama limitlerini ve kötüye kullanım önleme mekanizmalarını işletmek.</li>
          <li>Teknik sorunları tespit etmek ve hizmeti iyileştirmek.</li>
          <li>
            Mağazalara yapılan yönlendirmeleri kayıt altına almak; affiliate programları
            etkinleştirildiğinde komisyon ilişkilendirmesi ve mutabakatı yapmak.
          </li>
          <li>Destek taleplerinize yanıt vermek.</li>
          <li>
            Hukuki yükümlülükleri yerine getirmek ve hakların korunması için gerekli kayıtları
            tutmak.
          </li>
        </ul>
        <p>
          Şu anda analitik, reklam veya pazarlama ölçümü yapan bir araç kullanmıyoruz. Böyle bir
          araç eklenirse yalnızca açık izninizle çalıştırılır.
        </p>
      </section>

      <section>
        <h2>4. Hukuki sebepler</h2>
        <p>Kişisel verileriniz, somut işleme faaliyetine göre şu hukuki sebeplere dayanır:</p>
        <ul>
          <li>
            Hizmetin sunulması, yani bir sözleşmenin kurulması veya ifası için gerekli olması.
          </li>
          <li>Hukuki yükümlülüklerimizin yerine getirilmesi.</li>
          <li>Bir hakkın tesisi, kullanılması veya korunması.</li>
          <li>
            Temel hak ve özgürlüklerinize zarar vermemek kaydıyla meşru menfaatimiz (ör. güvenlik ve
            kötüye kullanımı önleme).
          </li>
          <li>
            Kanunen gerektiği hallerde açık rızanız (ör. gezinme geçmişi, pazarlama e-postası,
            zorunlu olmayan çerezler).
          </li>
        </ul>
      </section>

      <section>
        <h2>5. Bilgilerin paylaşılması</h2>
        <p>Kişisel veriler yalnızca gerekli olduğu ölçüde şu alıcılarla paylaşılır:</p>
        <ul>
          <li>
            <strong>Vercel</strong> — web sitesinin barındırılması.
          </li>
          <li>
            <strong>Supabase</strong> — veritabanı hizmeti.
          </li>
          <li>
            <strong>Önbellek ve kuyruk (Redis) hizmet sağlayıcısı</strong> — oturum ve limit
            sayaçları.
          </li>
          <li>
            <strong>Jina AI GmbH</strong> — fotoğrafla aramada yüklediğiniz görselin sayısal
            temsilinin üretilmesi.
          </li>
          <li>
            <strong>Google ve Apple</strong> — yalnızca bu yöntemlerle giriş yapmayı seçtiğinizde,
            kimlik doğrulama için.
          </li>
          <li>
            <strong>E-posta gönderim hizmeti sağlayıcısı</strong> — giriş bağlantısı ve alarm
            e-postalarının iletilmesi.
          </li>
          <li>
            <strong>SMS hizmet sağlayıcısı</strong> — telefonla giriş sunulduğunda doğrulama kodunun
            iletilmesi.
          </li>
          <li>
            <strong>Mağazalar ve affiliate ağları</strong> — bir mağaza bağlantısına tıkladığınızda
            o mağazanın sitesine yönlendirilirsiniz. Affiliate programları etkinleştirildiğinde
            bağlantıya yönlendirmenin Arilla&apos;dan geldiğini gösteren teknik parametreler
            eklenebilir. Ayrıntılar <a href="/affiliate-aciklamasi">Affiliate Açıklaması</a>
            &apos;nda.
          </li>
          <li>Kanunen yetkili kamu kurum ve kuruluşları.</li>
        </ul>
        <p>Kişisel verilerinizi satmayız.</p>
      </section>

      <section>
        <h2>6. Yurt dışına veri aktarımı</h2>
        <p>
          Yukarıdaki hizmet sağlayıcıların bir kısmının sunucuları Türkiye dışındadır; bu nedenle
          kişisel verileriniz yurt dışına aktarılabilir. Örneğin fotoğrafla aramada görseliniz
          Almanya merkezli Jina AI GmbH&apos;ye gönderilir. Aktarımlar yalnızca 6698 sayılı
          Kanun&apos;da öngörülen aktarım mekanizmalarına dayanılarak yapılır.
        </p>
      </section>

      <section>
        <h2>7. Çerezler</h2>
        <p>
          Yalnızca sitenin çalışması için gerekli, birinci taraf çerezler kullanıyoruz. Zorunlu
          olmayan çerez ve benzeri teknolojiler yalnızca izin verdiğiniz kategoriler için
          çalıştırılır. Tercihlerinizi footer&apos;daki <strong>Çerez Tercihleri</strong>{" "}
          bağlantısından istediğiniz zaman değiştirebilirsiniz. Tam liste için{" "}
          <a href="/cerez">Çerez Politikası</a>&apos;na bakınız.
        </p>
      </section>

      <section>
        <h2>8. Saklama süreleri</h2>
        <p>
          Kişisel veriler, işleme amacı için gerekli süre boyunca veya mevzuatın öngördüğü daha uzun
          süre varsa o süre boyunca saklanır. Bugün uygulanan somut süreler:
        </p>
        <ul>
          <li>Giriş bağlantısı: 15 dakika geçerlidir, tek kullanımlıktır.</li>
          <li>Telefon doğrulama kodu: 10 dakika geçerlidir.</li>
          <li>Oturum: en fazla 90 gün.</li>
          <li>
            Giriş denemesi sayaçları: en fazla 1 saat. Günlük arama limiti sayaçları: 24 saat.
          </li>
          <li>
            Hesap verileri, kayıtlı ürünler ve alarmlar: hesabınızı silene kadar. Hesap silindiğinde
            bu veriler, oturumlarınız, giriş kimlikleriniz ve rıza kayıtlarınız silinir.
          </li>
          <li>
            Tıklama, bağlantı araması, fotoğraf araması ve maliyet kayıtları: hesap silindiğinde
            hesabınızla bağlantısı kaldırılır; komisyon mutabakatı, muhasebe ve hukuki yükümlülükler
            için gerekli süre boyunca anonim oturum kimliğiyle saklanabilir.
          </li>
        </ul>
        <p>Çerezlerin süreleri Çerez Politikası&apos;nda ayrıca listelenir.</p>
      </section>

      <section>
        <h2>9. Veri güvenliği</h2>
        <p>
          Oturum anahtarları, giriş bağlantıları ve doğrulama kodları veritabanında yalnızca özet
          değerleri olarak saklanır. Bağlantılar şifreli iletilir, erişim yetkilerle
          sınırlandırılır. Hiçbir internet tabanlı sistem mutlak güvenlik garantisi veremez.
        </p>
      </section>

      <section>
        <h2>10. Haklarınız</h2>
        <p>
          6698 sayılı Kanun&apos;un 11. maddesi kapsamındaki haklarınız{" "}
          <a href="/kvkk-aydinlatma">KVKK Aydınlatma Metni</a>&apos;nde listelenir. Giriş
          yaptıysanız Hesap sayfanızdan doğrudan:
        </p>
        <ul>
          <li>hakkınızdaki verileri JSON dosyası olarak indirebilir,</li>
          <li>gezinme geçmişinizi silebilir,</li>
          <li>rıza tercihlerinizi değiştirebilir,</li>
          <li>hesabınızı kalıcı olarak silebilirsiniz.</li>
        </ul>
        <p>Diğer talepleriniz için aşağıdaki gizlilik adresine yazabilirsiniz.</p>
      </section>

      <section>
        <h2>11. Çocukların gizliliği</h2>
        <p>Arilla çocuklara yönelik tasarlanmış bir hizmet değildir.</p>
      </section>

      <section>
        <h2>12. Üçüncü taraf siteleri</h2>
        <p>
          Yönlendirildiğiniz mağaza sitelerinin içerikleri ve gizlilik uygulamaları Arilla&apos;nın
          kontrolünde değildir. Lütfen o sitelerin kendi politikalarını inceleyin.
        </p>
      </section>

      <section>
        <h2>13. Değişiklikler</h2>
        <p>
          Bu politika hizmet veya mevzuat değiştikçe güncellenebilir. Güncel sürüm ve yürürlük
          tarihi bu sayfada yayımlanır.
        </p>
      </section>

      <section>
        <h2>14. İletişim</h2>
        <LegalIdentityBlock contact="both" entity={false} />
      </section>
    </LegalPageLayout>
  );
}
