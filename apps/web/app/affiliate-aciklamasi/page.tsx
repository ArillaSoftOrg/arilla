import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { LEGAL_EFFECTIVE_LABEL, LegalIdentityBlock } from "../legal-identity-block.tsx";

export const metadata: Metadata = {
  title: "Affiliate Açıklaması – Arilla",
  description:
    "Arilla'nın mağazalarla affiliate ilişkisi, komisyonun sıralamaya etkisi ve yönlendirme bağlantıları hakkında açıklama.",
  alternates: { canonical: "/affiliate-aciklamasi" },
};

/**
 * Karar 0038: docs/arilla_legal_pack/05. Denetim (26 Eylul 2026): hicbir
 * affiliate agi canli degil - build-deeplink.ts yalnizca `affiliate_status =
 * 'active'` ve sablon varken parametre ekliyor, bugun gercek bir magazada
 * bu durum yok. Metin bu yuzden "etkinlestirildiginde" baglaminda. Belirli
 * bir ag adi (Admitad vb.) canliya alinmadan yazilmaz. Siralama kodu
 * komisyonu kullanmiyor (CLAUDE.md).
 */
export default function AffiliateAciklamasiPage() {
  return (
    <LegalPageLayout title="Affiliate Açıklaması" lastUpdatedLabel={LEGAL_EFFECTIVE_LABEL}>
      <section>
        <p>
          Arilla, ürün keşfi ve karşılaştırma hizmetini finanse etmek için mağazalar ve affiliate
          ağlarıyla ticari ilişki kurabilir. Bu sayfa bu ilişkinin size etkisini açıklar.
        </p>
      </section>

      <section>
        <h2>Nasıl çalışır</h2>
        <p>
          Arilla&apos;daki bazı mağaza bağlantıları affiliate bağlantısı olabilir. Böyle bir
          bağlantıya tıklayıp mağazada uygun bir alışveriş yaptığınızda Arilla, mağazadan veya
          affiliate ağından komisyon alabilir. Bu komisyon size ek bir ücret olarak yansımaz ve
          mağazanın size gösterdiği fiyatı değiştirmez.
        </p>
        <p>
          Bugün itibarıyla etkin bir affiliate programımız bulunmuyor; mağaza bağlantıları sizi
          doğrudan ürün sayfasına götürür. Bir program etkinleştirildiğinde bu sayfa
          güncellenecektir.
        </p>
      </section>

      <section>
        <h2>Sıralama ve öneriler</h2>
        <p>
          Mağaza fiyatları kargo dahil toplam fiyata göre sıralanır; komisyon oranı sıralamada
          belirleyici değildir. Affiliate ilişkisi bulunması, bir ürünün kalitesinin veya
          ihtiyaçlarınıza uygunluğunun garantisi değildir.
        </p>
        <p>
          Sponsorlu veya ücretli bir yerleşim sunulursa her zaman &quot;Sponsorlu&quot; olarak
          etiketlenir ve organik sonuçlardan ayrı gösterilir. Şu anda sponsorlu yerleşim yoktur.
        </p>
      </section>

      <section>
        <h2>Fiyat ve satış koşulları</h2>
        <p>
          Arilla mağazanın satış sözleşmesinin tarafı değildir. Nihai fiyat, stok, kargo, iade,
          garanti ve ödeme koşulları ilgili mağazanın sitesinde geçerlidir.
        </p>
      </section>

      <section>
        <h2>Yönlendirme ve takip verileri</h2>
        <p>
          Bir mağaza bağlantısına tıkladığınızda Arilla önce kendi sunucusunda bir tıklama kaydı
          oluşturur (hangi teklif, hangi sayfa, anonim oturum kimliği, tıklama anındaki fiyat),
          sonra sizi mağazaya yönlendirir. Bu kayıtta IP adresi ve tarayıcı bilgisi tutulmaz.
        </p>
        <p>
          Affiliate programları etkinleştirildiğinde mağaza bağlantısına yönlendirmenin
          Arilla&apos;dan geldiğini gösteren teknik parametreler eklenebilir. Arilla kendi sitesinde
          affiliate izleme çerezi kullanmaz; cihazınızda çalışan bir ölçüm teknolojisi eklenirse
          yalnızca izninizle çalışır ve <a href="/cerez">Çerez Politikası</a>&apos;nda açıklanır.
          Yönlendirildiğiniz mağaza veya affiliate ağı kendi çerezlerini kendi politikasına göre
          kullanabilir.
        </p>
      </section>

      <section>
        <h2>İletişim</h2>
        <LegalIdentityBlock contact="support" entity={false} />
      </section>
    </LegalPageLayout>
  );
}
