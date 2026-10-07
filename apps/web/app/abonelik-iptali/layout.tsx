import type { ReactNode } from "react";
import { SubpageShell } from "../public-site-shell.tsx";

/** Public site kabuğu. Ürün kapısının dışında: giriş ve erken erişim gerektirmez. */
export default function Layout({ children }: { children: ReactNode }) {
  return <SubpageShell>{children}</SubpageShell>;
}
