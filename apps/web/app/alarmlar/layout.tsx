import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Public site kabugu (header + menu paneli + footer); oturum kapisi sayfada. */
export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell currentPath="/alarmlar">{children}</SubpageShell>;
}
