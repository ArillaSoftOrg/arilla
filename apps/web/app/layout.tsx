import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeToggleClient } from "./theme-toggle-client.tsx";

export const metadata: Metadata = {
  title: "Arilla",
  description: "Ayni ve benzer urunleri farkli magazalarda karsilastirin.",
};

export const viewport: Viewport = {
  // Iki tema da ilk gunden tanimli; belirtecler packages/ui/src/tokens.css'te.
  colorScheme: "light dark",
};

function readThemeCookie(value: string | undefined): "light" | "dark" | null {
  return value === "light" || value === "dark" ? value : null;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const theme = readThemeCookie(store.get("theme")?.value);

  return (
    <html lang="tr" data-theme={theme ?? undefined}>
      <body>
        {children}
        {/* Gecici: /hesap yapilana kadar (E3) buradan test edilir. */}
        <ThemeToggleClient current={theme} />
      </body>
    </html>
  );
}
