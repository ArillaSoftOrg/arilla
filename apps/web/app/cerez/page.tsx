import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Çerezler – Arilla",
  description: "Arilla'nın kullandığı çerezler ve amaçları.",
  alternates: { canonical: "/cerez" },
};

/**
 * docs/pages.md "/cerez": kod duzeyinde dogrulanmis TAM cerez envanteri -
 * apps/web/app/lib/session-cookie.ts, apps/web/proxy.ts, apps/web/app/lib/
 * theme.ts. Analitik/pazarlama cerezi YOK (grep ile dogrulandi), bu yuzden
 * consent bandi kurulmadi - docs/kvkk.md: "Zorunlu cerezler rıza gerektirmez."
 */
export default function CerezPage() {
  return (
    <LegalPageLayout title="Çerezler" lastUpdatedLabel="Son güncelleme: 17 Eylül 2026">
      <section>
        <p>
          Arilla şu anda yalnızca ürünün çalışması için zorunlu çerezler kullanır. Bunlar için ayrı
          bir onayına ihtiyaç yoktur.
        </p>
      </section>

      <section>
        <h2>Kullandığımız çerezler</h2>
        <ul>
          <li>
            <strong>session</strong> — giriş yaptığında oturumunu tutar. Tarayıcı tarafından
            okunamaz (httpOnly), en fazla 90 gün geçerlidir.
          </li>
          <li>
            <strong>session_id</strong> — giriş yapmasan bile aramanı ve bir mağazaya yönlendiğinde
            tıklama kaydını ilişkilendirmek için kullanılan anonim bir kimlik. En fazla 1 yıl
            geçerlidir.
          </li>
          <li>
            <strong>theme</strong> — açık/koyu tema tercihini hatırlar. Kalıcıdır, sen değiştirene
            kadar kalır.
          </li>
        </ul>
      </section>

      <section>
        <h2>Analitik ve pazarlama çerezleri</h2>
        <p>
          Şu anda analitik veya pazarlama amaçlı bir çerez kullanmıyoruz. İleride eklenirse, rıza
          gerektiren çerezler için ayrı bir onay bandı sunulacak ve bu sayfa güncellenecektir.
        </p>
      </section>
    </LegalPageLayout>
  );
}
