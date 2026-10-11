import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { readAppUrl } from "@arilla/core";
import { parseMeasurementId } from "@arilla/core/ga4-measurement";
import { ConsentGate, ConsentProvider } from "./cookie-consent-client.tsx";
import { Ga4Client } from "./ga4-client.tsx";
import { readConsent } from "./lib/consent.ts";
import { readThemePreference } from "./lib/theme-cookie.ts";
import { SITE_BRAND } from "./site-config.ts";

/**
 * D6: `generateMetadata`'daki göreli `alternates.canonical` bu köke göre
 * çözülür. `APP_URL` yoksa metadataBase atlanır - diğer modüllerdeki gibi
 * burada da fırlatmak, kök layout her istekte yüklendiği için tüm siteyi
 * düşürürdü; canonical linkin eksik kalması tek sayfalık bir SEO kusuru.
 */
const appUrl = readAppUrl();

/** docs/copy.md `home.tagline` - sahte slogan/sayi yok. */
const SITE_DESCRIPTION = "Bir ürün bul, aynısını veya benzerini farklı mağazalarda karşılaştır.";

/**
 * Faz 7: kok Open Graph varsayilanlari. Kendi `openGraph` alanini tanimlamayan
 * sayfalar bunu miras alir. OG gorseli bilerek yok - next/og'un gomulu fontu
 * Turkce glifleri kapsamiyor ve eksik glifi Google Fonts'tan cekiyor (karar
 * 0009 ihlali); repo fontu woff2, next/og desteklemiyor.
 */
export const metadata: Metadata = {
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
  title: SITE_BRAND,
  description: SITE_DESCRIPTION,
  openGraph: {
    siteName: SITE_BRAND,
    locale: "tr_TR",
    type: "website",
    title: SITE_BRAND,
    description: SITE_DESCRIPTION,
  },
  // Affiliate ağı site doğrulamaları; tüm sayfalarda <head> içinde render olur.
  other: {
    "Takeads-verification": "b2908a43-37a8-49ce-b4ac-6c1475c45716",
    "mitgo-verification": "b207158b-022a-4c3c-bba5-65c7f99986e3",
    "impact-site-verification": "3110aa24-cc68-4fe8-a8d5-008958aa486b",
  },
};

export const viewport: Viewport = {
  // Iki tema da ilk gunden tanimli; belirtecler packages/ui/src/tokens.css'te.
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Karar 0038: tercih sunucuda okunur; banner ilk HTML'de gelir, yanip sonmez.
  const consent = await readConsent();
  // Karar 0087: kimlik çalışma anında sunucudan; geçersiz/yoksa GA4 hiç yok.
  const ga4Id = parseMeasurementId(process.env.GA4_MEASUREMENT_ID);
  // Karar 0092: elle secilen tema ilk HTML'de; yoksa cihaz tercihi (titreme yok).
  const theme = await readThemePreference();

  return (
    <html lang="tr" data-theme={theme ?? undefined}>
      <body>
        <ConsentProvider consent={consent}>
          {children}
          {ga4Id ? (
            <ConsentGate category="analytics">
              <Ga4Client measurementId={ga4Id} />
            </ConsentGate>
          ) : null}
        </ConsentProvider>
      </body>
    </html>
  );
}
