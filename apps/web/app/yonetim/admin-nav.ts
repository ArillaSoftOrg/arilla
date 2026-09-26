import type { Capability } from "@arilla/core";

export interface AdminNavItem {
  href: string;
  label: string;
  /** Menüde gösterme koşulu. Yetki DEĞİLDİR: her sayfa kendi yeteneğini ayrıca ister. */
  capability: Capability;
}

/** docs/routes.md §Yönetim. Yeni modül buraya ve kendi sayfasına eklenir. */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: "/yonetim", label: "Genel bakış", capability: "admin.access" },
  { href: "/yonetim/eslestirme", label: "Eşleştirme kuyruğu", capability: "matching.review" },
  { href: "/yonetim/sozluk", label: "Sözlük", capability: "dictionary.write" },
  { href: "/yonetim/denetim", label: "Denetim kaydı", capability: "audit.read" },
];
