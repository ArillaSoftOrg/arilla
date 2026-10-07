import type { Metadata } from "next";
import type { ReactNode } from "react";

/** `/giris`: pazarlama navigasyonundan ayrilmis, odakli auth ekrani. */
export const metadata: Metadata = {
  title: "Giriş",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
