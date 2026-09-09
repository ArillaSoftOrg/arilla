"use client";

import { ThemeToggle } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { setTheme } from "./theme-actions.ts";

/**
 * Gecici: /hesap yapilana kadar (E3) tema tercihini test edebilmek icin
 * layout'a eklendi. `ThemeToggle` framework-bagimsiz oldugu icin cerez
 * yazma islemini burada, apps/web tarafinda saglariz.
 */
export function ThemeToggleClient({ current }: { current: "light" | "dark" | null }) {
  const router = useRouter();

  async function handleToggle(next: "light" | "dark") {
    await setTheme(next);
    router.refresh();
  }

  return <ThemeToggle current={current} onToggle={handleToggle} />;
}
