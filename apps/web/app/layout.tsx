import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { readThemeCookie } from "./lib/theme.ts";

/**
 * D6: `generateMetadata`'daki göreli `alternates.canonical` bu köke göre
 * çözülür. `APP_URL` yoksa metadataBase atlanır - diğer modüllerdeki gibi
 * burada da fırlatmak, kök layout her istekte yüklendiği için tüm siteyi
 * düşürürdü; canonical linkin eksik kalması tek sayfalık bir SEO kusuru.
 */
const appUrl = process.env.APP_URL;

export const metadata: Metadata = {
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
  title: "Arilla",
  description: "Ayni ve benzer urunleri farkli magazalarda karsilastirin.",
};

export const viewport: Viewport = {
  // Iki tema da ilk gunden tanimli; belirtecler packages/ui/src/tokens.css'te.
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const theme = readThemeCookie(store.get("theme")?.value);

  return (
    <html lang="tr" data-theme={theme ?? undefined}>
      <body>{children}</body>
    </html>
  );
}
