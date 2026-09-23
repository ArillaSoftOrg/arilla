import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { HOME_COPY } from "../home-copy.ts";
import { PUBLIC_CONTACT_EMAIL } from "../site-config.ts";

export const metadata: Metadata = {
  title: "İletişim – Arilla",
  description: "Arilla ile ilgili soru, geri bildirim ve destek talepleri için iletişim.",
  alternates: { canonical: "/iletisim" },
};

/**
 * Faz 8.1: tek kanal e-posta (site-config.ts). Telefon, adres, sirket unvani,
 * calisma saati, sosyal medya YOK - dogrulanmis bilgi degil, uydurulmadi.
 */
export default function IletisimPage() {
  return (
    <LegalPageLayout title={HOME_COPY.contactTitle}>
      <section>
        <p>{HOME_COPY.contactDescription}</p>
      </section>

      <section>
        <h2>{HOME_COPY.contactEmailLabel}</h2>
        <p>
          <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
        </p>
      </section>
    </LegalPageLayout>
  );
}
