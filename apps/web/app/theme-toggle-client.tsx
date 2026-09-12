"use client";

import { ThemeToggle } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { setTheme } from "./theme-actions.ts";

/**
 * `/hesap` "Tema" bölümü (docs/pages.md). `ThemeToggle` framework-bağımsız
 * olduğu için çerez yazma işlemini burada, apps/web tarafında sağlarız.
 */
export function ThemeToggleClient({ current }: { current: "light" | "dark" | null }) {
  const router = useRouter();

  async function handleToggle(next: "light" | "dark") {
    await setTheme(next);
    router.refresh();
  }

  return <ThemeToggle current={current} onToggle={handleToggle} />;
}
