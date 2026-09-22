import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gizlilik ve Veri Kullanımı – Arilla",
  description: "Arilla'nın hangi verileri neden işlediği, ne kadar sakladığı ve haklarınız.",
  alternates: { canonical: "/gizlilik" },
};

/**
 * docs/pages.md "/gizlilik": TASLAK sayfa. Yalnizca docs/kvkk.md, schema.sql
 * ve kodda dogrudan dogrulanmis veri akislarini anlatir - veri sorumlusu
 * tuzel kisi bilgisi YOK (sirket henuz kurulmadi, bkz. docs/kvkk.md "Veri
 * sorumlusu"). Hukukcu onayli nihai metin degildir.
 */
export default function GizlilikPage() {
  return (
    <LegalPageLayout
      title="Gizlilik ve Veri Kullanımı"
      lastUpdatedLabel="Son güncelleme: 17 Eylül 2026"
    >
      <section>
        <p>
          Bu sayfa, Arilla&apos;nın hangi verileri hangi amaçla işlediğini ürün ve teknik düzeyde
          açıklar. Şirketin resmi kuruluşu ve hukuki onayı tamamlanana kadar bu sayfa Kişisel
          Verilerin Korunması Kanunu kapsamında nihai, hukukçu onaylı bir aydınlatma metni değildir;
          o adımlar tamamlandığında güncellenecektir.
        </p>
      </section>

      <section>
        <h2>Hangi verileri işliyoruz</h2>
        <ul>
          <li>E-posta adresin — hesabına giriş yapman için.</li>
          <li>
            Oturum bilgisi — giriş yaptığında güvenlik amacıyla IP adresin ve tarayıcı bilgin oturum
            kaydına eklenir.
          </li>
          <li>Kaydettiğin ürünler ve kurduğun fiyat/stok alarmları.</li>
          <li>
            Gezinme geçmişi — açık rızan olduğunda hangi ürünleri görüntülediğin kaydedilebilir; bu
            özellik rıza tercihine bağlıdır ve reddedildiğinde ürün normal şekilde çalışmaya devam
            eder.
          </li>
          <li>Görsel arama için yüklediğin fotoğraflar (aşağıda ayrıca açıklanır).</li>
          <li>
            Bir mağazaya yönlendiğinde oluşan tıklama kaydı — hangi teklife, hangi oturumdan
            gidildiği.
          </li>
        </ul>
      </section>

      <section>
        <h2>Fotoğraf yükleme</h2>
        <ul>
          <li>Yüklediğin fotoğraf en fazla 30 gün geçici depoda tutulur, sonra silinir.</li>
          <li>
            Kalıcı olarak yalnızca fotoğrafın matematiksel temsili (embedding) ve tekrar işlenmesini
            önlemek için bir özet değeri (hash) saklanır — bunlardan fotoğrafın kendisi geri
            üretilemez.
          </li>
          <li>Fotoğrafta insan tespit edilirse bilgilendirilirsin; yüz bölgesi ayrıca işlenmez.</li>
          <li>Ürün içermeyen bir fotoğraf reddedilir ve saklanmaz.</li>
        </ul>
      </section>

      <section>
        <h2>Çerezler</h2>
        <p>
          Yalnızca oturum, güvenlik ve tema tercihi için zorunlu çerezler kullanılır; bunlar için
          ayrı bir onayına ihtiyaç yoktur. Tam liste için <a href="/cerez">Çerezler sayfasına</a>{" "}
          bakabilirsin.
        </p>
      </section>

      <section>
        <h2>Üçüncü taraflar</h2>
        <p>
          Altyapının bir kısmı yurt dışında çalışır: barındırma, veritabanı ve dosya depolama
          sağlayıcıları ile görsel arama için kullanılan embedding sağlayıcısı (Jina AI GmbH, Berlin
          — Avrupa Birliği merkezli). Bu, kişisel verinin yurt dışına aktarımı anlamına gelir;
          gerekli sözleşme ve aydınlatma adımları şirket kuruluşu sürecinin bir parçasıdır.
        </p>
      </section>

      <section>
        <h2>Haklarınız</h2>
        <p>Hesabın üzerinden aşağıdakileri doğrudan kullanabilirsin (Hesap sayfası):</p>
        <ul>
          <li>Hakkındaki verileri JSON olarak indirme.</li>
          <li>Gezinme geçmişini silme.</li>
          <li>
            Hesabını tamamen silme — bu işlem geri alınamaz. Silme sonrası tıklama kayıtların, mali
            mevzuat gereği bir süre saklanabilir ama kimliğinle ilişkilendirilmez (kullanıcı kimliği
            kaydından kaldırılır).
          </li>
          <li>
            Rıza tercihlerini (gezinme geçmişi/kişiselleştirme, pazarlama e-postası, keşfette
            isimsiz görünme) istediğin zaman değiştirme. Bu kutular varsayılan olarak işaretsiz
            gelir.
          </li>
        </ul>
      </section>

      <section>
        <h2>Veri sorumlusu</h2>
        <p>
          Arilla&apos;nın işleteni olan şirket henüz resmi olarak kurulmadı. Şirket kurulduğunda bu
          bölüm veri sorumlusunun tüzel kişi bilgileriyle güncellenecektir.
        </p>
      </section>
    </LegalPageLayout>
  );
}
