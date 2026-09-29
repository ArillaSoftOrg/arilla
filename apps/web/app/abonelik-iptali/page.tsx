import { isUnsubscribeTokenShape } from "@arilla/core";
import { Button, LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { MARKETING_EMAIL_COPY } from "../marketing-email-copy.ts";
import { unsubscribeAction } from "./actions.ts";

export const metadata: Metadata = {
  title: MARKETING_EMAIL_COPY.unsubscribeTitle,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Pazarlama e-postasındaki "listeden ayrıl" bağlantısı (docs/decisions/0046).
 * GET hiçbir şey DEĞİŞTİRMEZ — bağlantı tarayıcıları ve ön izleyiciler
 * kullanıcıyı listeden çıkaramasın; iptal düğmeyle (POST) yapılır. Posta
 * istemcilerinin tek tık iptali ayrıca `/api/email/unsubscribe`'a POST eder.
 */
export default async function AbonelikIptaliPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = params.durum;
  const token = typeof params.t === "string" ? params.t : undefined;

  if (status === "tamam") {
    return (
      <LegalPageLayout title={MARKETING_EMAIL_COPY.unsubscribeDoneTitle}>
        <section>
          <p>{MARKETING_EMAIL_COPY.unsubscribeDoneBody}</p>
          <p>
            <a href="/">{MARKETING_EMAIL_COPY.backHome}</a>
          </p>
        </section>
      </LegalPageLayout>
    );
  }

  if (status === "gecersiz" || !isUnsubscribeTokenShape(token)) {
    return (
      <LegalPageLayout title={MARKETING_EMAIL_COPY.unsubscribeInvalidTitle}>
        <section>
          <p>{MARKETING_EMAIL_COPY.unsubscribeInvalidBody}</p>
          <p>
            <a href="/hesap">Hesabım</a>
          </p>
        </section>
      </LegalPageLayout>
    );
  }

  return (
    <LegalPageLayout title={MARKETING_EMAIL_COPY.unsubscribeTitle}>
      <section>
        <p>{MARKETING_EMAIL_COPY.unsubscribeBody}</p>
        <form action={unsubscribeAction}>
          <input type="hidden" name="t" value={token} />
          <Button type="submit" variant="accent" shape="pill">
            {MARKETING_EMAIL_COPY.unsubscribeSubmit}
          </Button>
        </form>
      </section>
    </LegalPageLayout>
  );
}
