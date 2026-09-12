export type Theme = "light" | "dark";

/** `layout.tsx` (html'e uygulamak için) ve `/hesap` (Tema bölümü) ortak kullanır. */
export function readThemeCookie(value: string | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}
