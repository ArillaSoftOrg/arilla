"use client";

import { ThemeToggle } from "@arilla/ui";
import { useSyncExternalStore } from "react";
import { HOME_COPY } from "./home-copy.ts";
import { oppositeTheme, parseTheme, type Theme, themeCookieAssignment } from "./lib/theme.ts";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Etkin tema: elle secim (`<html data-theme>`) yoksa cihaz tercihi. */
function readEffectiveTheme(): Theme {
  return (
    parseTheme(document.documentElement.dataset.theme) ??
    (window.matchMedia(DARK_QUERY).matches ? "dark" : "light")
  );
}

/** Secim ya da cihaz tercihi degisince (baska sekme/ornek dahil) yeniden okunur. */
function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    media.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

/**
 * Karar 0092: ust cubuktaki tema dugmesi. Secim `<html data-theme>`a aninda
 * yazilir (sunucuya gidilmez, sayfa yeniden cizilmez) ve cereze kaydedilir;
 * sonraki istekte kok layout ayni temayi ilk HTML'de verir.
 *
 * `initialTheme`: sunucunun bildigi elle secim; yoksa `null` (cihaz tercihi
 * sunucuda bilinmez, `aria-pressed` istemci baglaninca dolar - ikon CSS'ten
 * zaten dogru).
 */
export function ThemeToggleControl({ initialTheme }: { initialTheme: Theme | null }) {
  const theme = useSyncExternalStore<Theme | null>(
    subscribe,
    readEffectiveTheme,
    () => initialTheme,
  );

  function toggle() {
    const next = oppositeTheme(readEffectiveTheme());
    document.documentElement.dataset.theme = next;
    // biome-ignore lint/suspicious/noDocumentCookie: tek degerli tercih cerezi; Cookie Store API her tarayicida yok.
    document.cookie = themeCookieAssignment(next, {
      secure: window.location.protocol === "https:",
    });
  }

  return (
    <ThemeToggle
      label={HOME_COPY.themeToggleLabel}
      pressed={theme === null ? undefined : theme === "dark"}
      onToggle={toggle}
    />
  );
}
