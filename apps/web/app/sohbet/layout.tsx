import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Konuşmalı keşif (karar 0074): herkese açık içerik değil, dizinlenmez. */
export const metadata: Metadata = {
  title: "Sohbet",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell chrome="chat">{children}</SubpageShell>;
}
