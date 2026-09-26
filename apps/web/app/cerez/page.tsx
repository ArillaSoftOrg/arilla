import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { CookiePreferencesPageForm } from "../cookie-consent-client.tsx";
import { LEGAL_EFFECTIVE_LABEL, LegalIdentityBlock } from "../legal-identity-block.tsx";
import { readConsent } from "../lib/consent.ts";

export const metadata: Metadata = {
  title: "Çerez Politikası – Arilla",
  description:
    "Arilla'nın kullandığı çerezler, amaçları, süreleri ve çerez tercihlerinizi nasıl yöneteceğiniz.",
  alternates: { canonical: "/cerez" },
};

interface CookieRow {
  name: string;
  purpose: string;
  duration: string;
}

/**
 * Karar 0038: kod duzeyinde dogrulanmis TAM cerez envanteri (denetim, 26
 * Eylul 2026). Hepsi birinci taraf ve kesinlikle gerekli; analitik, pazarlama,
 * piksel veya affiliate cerezi YOK. Yeni cerez eklenince once bu liste ve
 * `OPTIONAL_COOKIES` (packages/core/src/consent) guncellenir.
 *
 * Kaynaklar: lib/session-cookie.ts, proxy.ts + git/[offerId]/route.ts,
 * theme-actions.ts, giris/google/route.ts, giris/apple/route.ts,
 * giris/telefon/kod-gonder/route.ts, consent-actions.ts.
 */
const NECESSARY_COOKIES: readonly CookieRow[] = [
  {
    name: "session",
    purpose:
      "Giriş yaptığınızda oturumunuzu tutar. Tarayıcıdaki betikler tarafından okunamaz (httpOnly).",
    duration: "En fazla 90 gün",
  },
  {
    name: "session_id",
    purpose:
      "Giriş yapmasanız da atanan anonim kimlik. Girişten önceki ücretsiz arama sayısını ve günlük arama limitlerini saymak ve bir mağazaya yönlendiğinizde tıklama kaydını anonim oturuma bağlamak için kullanılır.",
    duration: "1 yıl",
  },
  {
    name: "theme",
    purpose: "Açık veya koyu tema tercihinizi, siz seçtiğinizde hatırlar.",
    duration: "1 yıl",
  },
  {
    name: "cookie_consent",
    purpose: "Bu sayfadaki çerez tercihinizi ve tercih sürümünü hatırlar.",
    duration: "12 ay",
  },
  {
    name: "google_oauth_state",
    purpose: "Google ile girişte isteğin sahteciliğe karşı doğrulanması.",
    duration: "10 dakika",
  },
  {
    name: "apple_oauth_state, apple_oauth_nonce",
    purpose: "Apple ile girişte isteğin ve kimlik belirtecinin doğrulanması.",
    duration: "10 dakika",
  },
  {
    name: "phone_login",
    purpose: "Telefonla girişte, kod doğrulanana kadar telefon numaranızı taşır.",
    duration: "15 dakika",
  },
];

export default async function CerezPage() {
  const consent = await readConsent();

  return (
    <LegalPageLayout title="Çerez Politikası" lastUpdatedLabel={LEGAL_EFFECTIVE_LABEL}>
      <section>
        <p>
          Bu politika, Arilla&apos;da kullanılan çerezleri ve benzeri teknolojileri açıklar.
          Çerezler, bir siteyi ziyaret ettiğinizde tarayıcınızda saklanan küçük veri dosyalarıdır.
        </p>
      </section>

      <section>
        <h2>1. Kısaca</h2>
        <p>
          Arilla bugün yalnızca sitenin çalışması için kesinlikle gerekli, birinci taraf çerezler
          kullanır. Analitik, reklam, pazarlama, sosyal medya pikseli veya affiliate izleme çerezi
          kullanmıyoruz ve üçüncü taraf betik yüklemiyoruz.
        </p>
      </section>

      <section>
        <h2>2. Çerez kategorileri</h2>
        <h3>Kesinlikle gerekli</h3>
        <p>
          Oturum, güvenlik, giriş, arama limitleri, tema ve çerez tercihinin hatırlanması için
          gereklidir. Kapatılamaz; engellenirse bazı işlevler çalışmaz.
        </p>
        <h3>İşlevsel</h3>
        <p>
          İsteğe bağlı site özelliklerini hatırlar. Şu an bu kategoride kullandığımız bir çerez yok;
          eklenirse yalnızca izninizle çalışır.
        </p>
        <h3>Analitik / performans</h3>
        <p>
          Sitenin kullanımını ve performansını ölçer. Şu an bu kategoride kullandığımız bir çerez
          veya araç yok; eklenirse izin vermeden yüklenmez.
        </p>
        <h3>Reklam / affiliate ölçüm</h3>
        <p>
          Reklam ve affiliate yönlendirmelerini cihazınızda ölçer. Şu an bu kategoride kullandığımız
          bir çerez yok. Bir mağaza bağlantısının adresine yönlendirmenin Arilla&apos;dan geldiğini
          gösteren bir parametre eklenmesi ile cihazınıza çerez bırakılması aynı şey değildir;
          cihazınızda çalışan bir ölçüm teknolojisi eklenirse yalnızca izninizle çalışır.
          Yönlendirildiğiniz mağaza sitesi kendi çerezlerini kendi politikasına göre kullanır.
        </p>
      </section>

      <section>
        <h2>3. Kullandığımız çerezler</h2>
        <p>Tümü birinci taraf ve kesinlikle gerekli kategorisindedir; açık rıza gerektirmez.</p>
        <ul>
          {NECESSARY_COOKIES.map((cookie) => (
            <li key={cookie.name}>
              <strong>{cookie.name}</strong> — {cookie.purpose} Süre: {cookie.duration}.
            </li>
          ))}
        </ul>
      </section>

      <section id="tercihler">
        <h2>4. Çerez tercihleriniz</h2>
        <p>
          Zorunlu olmayan kategoriler siz açmadıkça kapalıdır. Tercihinizi burada veya her sayfanın
          altındaki <strong>Çerez Tercihleri</strong> bağlantısından istediğiniz zaman
          değiştirebilir, verdiğiniz izni geri çekebilirsiniz. İzni geri çekmek vermek kadar
          kolaydır; geri çektiğiniz kategoriler sonraki işlemlerde çalıştırılmaz.
        </p>
        <CookiePreferencesPageForm consent={consent} />
      </section>

      <section>
        <h2>5. Tarayıcı ayarları</h2>
        <p>
          Çerezleri tarayıcı ayarlarınızdan da silebilir veya engelleyebilirsiniz. Kesinlikle
          gerekli çerezleri engellerseniz giriş ve arama gibi işlevler çalışmayabilir.
        </p>
      </section>

      <section>
        <h2>6. Güncellemeler ve iletişim</h2>
        <p>
          Bu politika kullandığımız teknolojiler değiştikçe güncellenir. Yeni bir kategori
          eklendiğinde tercihiniz yeniden sorulur.
        </p>
        <LegalIdentityBlock contact="privacy" entity={false} />
      </section>
    </LegalPageLayout>
  );
}
