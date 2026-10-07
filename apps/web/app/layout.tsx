import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { readAppUrl } from "@arilla/core";
import { ConsentProvider } from "./cookie-consent-client.tsx";
import { readConsent } from "./lib/consent.ts";
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
  },
};

export const viewport: Viewport = {
  // Iki tema da ilk gunden tanimli; belirtecler packages/ui/src/tokens.css'te.
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Karar 0038: tercih sunucuda okunur; banner ilk HTML'de gelir, yanip sonmez.
  const consent = await readConsent();

  return (
    <html lang="tr">
      <body>
        <ConsentProvider consent={consent}>{children}</ConsentProvider>
      </body>
    </html>
  );
}
