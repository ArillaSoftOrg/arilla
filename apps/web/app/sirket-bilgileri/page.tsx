import { LEGAL_IDENTITY, readAppUrl } from "@arilla/core";
import { LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { LEGAL_EFFECTIVE_LABEL, LEGAL_IDENTITY_PENDING } from "../legal-identity-block.tsx";

export const metadata: Metadata = {
  title: "Şirket Bilgileri – Arilla",
  description: "Arilla hizmetini işleten kişiye ilişkin doğrulanmış bilgiler ve iletişim.",
  alternates: { canonical: "/sirket-bilgileri" },
};

/**
 * Karar 0038: docs/arilla_legal_pack/06. YALNIZCA dogrulanmis ve dolu
 * alanlar listelenir (legal-identity.ts). Unvan, adres, MERSIS, vergi, sicil
 * ve telefon dogrulanana kadar satirlari hic render edilmez - yer tutucu
 * veya ornek deger gosterilmez.
 */
export default function SirketBilgileriPage() {
  const identity = LEGAL_IDENTITY;
  const websiteUrl = readAppUrl();
  const rows: { label: string; value: string | null; href?: string }[] = [
    { label: "Marka", value: identity.brandName },
    { label: "Yasal unvan / işletmeci", value: identity.legalEntityName },
    { label: "Açık adres", value: identity.legalAddress },
    { label: "Ülke", value: identity.country },
    { label: "MERSİS No", value: identity.mersisNo },
    { label: "Vergi dairesi / vergi no", value: identity.taxOfficeAndNo },
    { label: "Ticaret sicil no", value: identity.tradeRegistryNo },
    {
      label: "Genel iletişim",
      value: identity.supportEmail,
      ...(identity.supportEmail ? { href: `mailto:${identity.supportEmail}` } : {}),
    },
    {
      label: "Gizlilik / KVKK",
      value: identity.privacyEmail,
      ...(identity.privacyEmail ? { href: `mailto:${identity.privacyEmail}` } : {}),
    },
    { label: "Telefon", value: identity.phone },
    { label: "Web", value: websiteUrl ?? null, ...(websiteUrl ? { href: websiteUrl } : {}) },
  ];
  const visible = rows.filter((row) => row.value);

  return (
    <LegalPageLayout title="Şirket Bilgileri" lastUpdatedLabel={LEGAL_EFFECTIVE_LABEL}>
      <section>
        <p>
          Bu sayfada Arilla hizmetini işleten kişiye ilişkin yalnızca doğrulanmış ve kamuya
          açıklanması uygun bilgiler yer alır.
        </p>
        {identity.legalEntityName ? null : <p>{LEGAL_IDENTITY_PENDING}</p>}
      </section>

      <section>
        <h2>Bilgiler</h2>
        <ul>
          {visible.map((row) => (
            <li key={row.label}>
              <strong>{row.label}:</strong>{" "}
              {row.href ? <a href={row.href}>{row.value}</a> : row.value}
            </li>
          ))}
        </ul>
      </section>
    </LegalPageLayout>
  );
}
