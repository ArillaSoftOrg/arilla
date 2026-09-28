import { authProviderAvailability, maskPhone, safeRedirectPath } from "@arilla/core";
import { Button, Input } from "@arilla/ui";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SITE_BRAND } from "../../site-config.ts";
import styles from "../page.module.css";
import { PHONE_COOKIE } from "./phone-cookie.ts";

export const metadata: Metadata = {
  title: "Telefonla giriş",
  robots: { index: false, follow: false },
};

/** docs/copy.md `auth.phone_*`. */
const COPY = {
  title: "Telefonla giriş yap",
  phoneLabel: "Cep telefonu numaran",
  phoneHint: "Örn. 0532 123 45 67. Numarana tek kullanımlık bir kod göndereceğiz.",
  sendCode: "Kod gönder",
  codeTitle: "Kodu gir",
  codeSentTo: "Kodu şu numaraya gönderdik:",
  codeLabel: "6 haneli kod",
  verify: "Giriş yap",
  resend: "Kodu tekrar gönder",
  changeNumber: "Başka bir numara kullan",
  back: "Diğer giriş seçenekleri",
} as const;

/** docs/copy.md `auth.phone_unavailable`. */
const UNAVAILABLE = "Telefonla giriş şu an kullanılamıyor. Başka bir yöntemle devam edebilirsin.";

const ERROR_COPY: Record<string, string> = {
  numara: "Geçerli bir cep telefonu numarası gir.",
  ulke: "Şu an yalnızca Türkiye (+90) numaralarıyla giriş yapılabiliyor.", // auth.phone_country_unsupported
  sinir: "Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar dene.",
  gonderilemedi: "Kodu şu an gönderemedik. Biraz sonra tekrar dene.",
  kod: "Kod hatalı ya da süresi dolmuş. Tekrar dene ya da yeni bir kod iste.",
  sure: "Oturumun zaman aşımına uğradı. Numaranı yeniden gir.",
  gecersiz: "İstek doğrulanamadı. Sayfayı yenileyip tekrar dene.",
};

/**
 * İki adım: numara -> kod. Formlar Route Handler'lara native POST yapar
 * (JS'siz çalışır). Numara adımlar arasında httpOnly çerezde, URL'de değil.
 */
export default async function TelefonGirisPage({
  searchParams,
}: {
  searchParams: Promise<{ adim?: string; hata?: string; next?: string }>;
}) {
  const { adim, hata, next } = await searchParams;
  // Dönüş yolu kod-gönder adımında kısa ömürlü çereze yazılır (`next-cookie.ts`).
  const safeNext = safeRedirectPath(next);
  const phone = (await cookies()).get(PHONE_COOKIE)?.value;
  // Sağlayıcı yapılandırılmamışsa form gösterilmez: kod gönderilemeyecek bir
  // akışa kullanıcı sokulmaz (`authProviderAvailability`).
  const available = authProviderAvailability().phone;
  const codeStep = available && adim === "kod" && Boolean(phone);
  const errorText = !available ? UNAVAILABLE : hata ? ERROR_COPY[hata] : undefined;

  return (
    <div className={styles.page}>
      <a className={styles.brand} href="/" aria-label={`${SITE_BRAND} ana sayfa`}>
        {SITE_BRAND}
      </a>
      <a className={styles.close} href="/giris" aria-label="Telefonla girişi kapat">
        ×
      </a>
      <section className={styles.panel} aria-labelledby="telefon-baslik">
        <h1 id="telefon-baslik" className={styles.title}>
          {codeStep ? COPY.codeTitle : COPY.title}
        </h1>
        {errorText ? (
          <p role="alert" className={styles.notice}>
            {errorText}
          </p>
        ) : null}

        {codeStep && phone ? (
          <div className={styles.authChoices}>
            <p className={styles.sentBody}>
              {COPY.codeSentTo} {maskPhone(phone)}
            </p>
            <form action="/giris/telefon/dogrula" method="post" className={styles.form}>
              <Input
                label={COPY.codeLabel}
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
              <Button type="submit" variant="primary" size="lg" fullWidth>
                {COPY.verify}
              </Button>
            </form>
            <form action="/giris/telefon/kod-gonder" method="post">
              <input type="hidden" name="phone" value={phone} />
              <Button type="submit" variant="ghost" fullWidth>
                {COPY.resend}
              </Button>
            </form>
            <a className={styles.legal} href="/giris/telefon">
              {COPY.changeNumber}
            </a>
          </div>
        ) : available ? (
          <form action="/giris/telefon/kod-gonder" method="post" className={styles.form}>
            <input type="hidden" name="next" value={safeNext} />
            <Input
              label={COPY.phoneLabel}
              hint={COPY.phoneHint}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              error={hata === "numara" || hata === "ulke" ? ERROR_COPY[hata] : undefined}
            />
            <Button type="submit" variant="primary" size="lg" fullWidth>
              {COPY.sendCode}
            </Button>
          </form>
        ) : null}

        <a className={styles.legal} href="/giris">
          {COPY.back}
        </a>
      </section>
    </div>
  );
}
