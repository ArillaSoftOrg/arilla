import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Arilla",
  description: "Ayni ve benzer urunleri farkli magazalarda karsilastirin.",
};

export const viewport: Viewport = {
  // Iki tema da ilk gunden tanimli; belirtecler D1'de gelir.
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
