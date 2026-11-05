import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell currentPath="/nasil-calisir">{children}</SubpageShell>;
}
