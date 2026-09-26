import { LEGAL_IDENTITY, type LegalIdentity } from "@arilla/core";

/** docs/copy.md `legal.identity_pending`. */
export const LEGAL_IDENTITY_PENDING =
  "Hizmeti işleten tüzel kişiliğin tescil bilgileri tamamlandığında bu sayfada yayımlanacaktır.";

/** Yasal sayfalarin ortak yururluk etiketi - sabit, gercek tarih (LegalPageLayout). */
export const LEGAL_EFFECTIVE_LABEL = "Yürürlük ve son güncelleme: 26 Eylül 2026";

function MailLink({ email }: { email: string }) {
  return <a href={`mailto:${email}`}>{email}</a>;
}

/**
 * Karar 0038: veri sorumlusu / isletmeci blogu. Alanlar YALNIZCA
 * `legal-identity.ts`'ten gelir; `null` alan render edilmez, yerine tek bir
 * durust not yazilir. Yer tutucu, ornek telefon veya tahmini unvan yok.
 */
export function LegalIdentityBlock({
  contact,
  entity = true,
  identity = LEGAL_IDENTITY,
}: {
  /** Hangi iletisim adresi gosterilsin. */
  contact: "privacy" | "support" | "both";
  /** `false`: yalnizca iletisim satiri (unvan/not ayni sayfada zaten gosterildiyse). */
  entity?: boolean;
  identity?: LegalIdentity;
}) {
  const address = [identity.legalAddress, identity.country].filter(Boolean).join(", ");
  const showPrivacy = (contact === "privacy" || contact === "both") && identity.privacyEmail;
  const showSupport =
    (contact === "support" || contact === "both") &&
    identity.supportEmail &&
    !(contact === "both" && identity.supportEmail === identity.privacyEmail);

  return (
    <>
      {!entity ? null : identity.legalEntityName ? (
        <p>
          <strong>{identity.legalEntityName}</strong>
          {address ? (
            <>
              <br />
              Adres: {address}
            </>
          ) : null}
        </p>
      ) : (
        <p>{LEGAL_IDENTITY_PENDING}</p>
      )}
      {showPrivacy && identity.privacyEmail ? (
        <p>
          {contact === "both" && identity.supportEmail === identity.privacyEmail
            ? "Gizlilik, KVKK ve destek iletişimi: "
            : "Gizlilik ve KVKK iletişimi: "}
          <MailLink email={identity.privacyEmail} />
        </p>
      ) : null}
      {showSupport && identity.supportEmail ? (
        <p>
          Destek: <MailLink email={identity.supportEmail} />
        </p>
      ) : null}
    </>
  );
}
