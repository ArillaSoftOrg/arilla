import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Faz 8: public site kabugu (header + footer), bkz. public-site-shell.tsx. */
export const metadata: Metadata = {
  title: "Arama",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell>{children}</SubpageShell>;
}
