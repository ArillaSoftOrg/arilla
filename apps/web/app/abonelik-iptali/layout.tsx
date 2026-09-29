import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Girişsiz abonelik iptali (docs/decisions/0046); public site kabuğu. */
export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell currentPath="/abonelik-iptali">{children}</SubpageShell>;
}
