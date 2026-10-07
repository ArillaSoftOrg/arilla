import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Public site kabugu (header + footer); icerik tam genislik bolumlerle gelir. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <SubpageShell currentPath="/blog" fullBleed>
      {children}
    </SubpageShell>
  );
}
