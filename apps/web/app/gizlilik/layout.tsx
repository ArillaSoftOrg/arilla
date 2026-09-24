import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Faz 8: public site kabugu (header + footer), bkz. public-site-shell.tsx. */
export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell currentPath="/gizlilik">{children}</SubpageShell>;
}
