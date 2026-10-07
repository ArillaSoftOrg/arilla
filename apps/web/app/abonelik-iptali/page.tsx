import { isUnsubscribeTokenShape } from "@arilla/core";
import { Button, LegalPageLayout } from "@arilla/ui";
import type { Metadata } from "next";
import { unsubscribeAction } from "./actions.ts";

export const metadata: Metadata = {
  // docs/copy.md `unsubscribe.title`
  title: "E-posta aboneliği",
  robots: { index: false, follow: false },
  // Token'lı adres başka siteye Referer ile sızmasın.
  referrer: "no-referrer",
};

/**
 * Pazarlama e-postasındaki "buradan kapatabilirsin" bağlantısı
 * (docs/decisions/0048). GET hiçbir şey DEĞİŞTİRMEZ: bağlantı tarayıcıları
 * ve ön izleyiciler kullanıcıyı listeden çıkaramasın; iptal düğmeyle (POST)
 * yapılır. Posta istemcilerinin tek tık iptali ayrıca
 * `/api/email/unsubscribe`'a POST eder. Giriş gerekmez.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = params.durum;
  const token = typeof params.t === "string" ? params.t : undefined;

  if (status === "tamam") {
    return (
      <LegalPageLayout title="Abonelikten çıktın">
        <section>
          <p>
            Artık kampanya ve fırsat e-postası almayacaksın. Giriş bağlantısı ve kurduğun fiyat
            alarmları gibi hesap iletileri gelmeye devam eder.
          </p>
        </section>
      </LegalPageLayout>
    );
  }

  if (status === "gecersiz" || !isUnsubscribeTokenShape(token)) {
    return (
      <LegalPageLayout title="Bağlantı geçersiz">
        <section>
          <p>
            Bu bağlantı geçersiz ya da artık kullanılamıyor. Test iletilerindeki bağlantı da
            çalışmaz.
          </p>
        </section>
      </LegalPageLayout>
    );
  }

  return (
    <LegalPageLayout title="E-posta aboneliği">
      <section>
        <p>Kampanya ve fırsat e-postalarını artık almak istemiyorsan aşağıdaki düğmeye bas.</p>
        <form action={unsubscribeAction}>
          <input type="hidden" name="t" value={token} />
          <Button type="submit" variant="primary">
            Abonelikten çık
          </Button>
        </form>
      </section>
    </LegalPageLayout>
  );
}
