import type { Capability } from "@arilla/core";

export interface AdminNavItem {
  href: string;
  label: string;
  /** Menüde gösterme koşulu. Yetki DEĞİLDİR: her sayfa kendi yeteneğini ayrıca ister. */
  capability: Capability;
}

export interface AdminNavGroup {
  label: string;
  items: readonly AdminNavItem[];
}

/** docs/routes.md §Yönetim. Yeni modül buraya ve kendi sayfasına eklenir. */
export const ADMIN_NAV: readonly AdminNavGroup[] = [
  {
    label: "Genel",
    items: [{ href: "/yonetim", label: "Genel bakış", capability: "admin.access" }],
  },
  {
    label: "Katalog",
    items: [
      { href: "/yonetim/eslestirme", label: "Eşleştirme kuyruğu", capability: "matching.review" },
      { href: "/yonetim/katalog/urunler", label: "Ürünler", capability: "catalog.read" },
      { href: "/yonetim/katalog/teklifler", label: "Teklifler", capability: "catalog.read" },
      { href: "/yonetim/sozluk", label: "Sözlük", capability: "dictionary.write" },
    ],
  },
  {
    label: "Veri",
    items: [
      { href: "/yonetim/magazalar", label: "Mağazalar", capability: "merchant.read" },
      { href: "/yonetim/ingest", label: "Veri toplama", capability: "ingest.read" },
    ],
  },
  {
    label: "Arama",
    items: [
      { href: "/yonetim/arama/tani", label: "Arama tanısı", capability: "diagnostics.read" },
      { href: "/yonetim/arama/link", label: "Link araması", capability: "diagnostics.read" },
      { href: "/yonetim/arama/gorsel", label: "Görsel arama", capability: "diagnostics.read" },
      { href: "/yonetim/seo", label: "SEO tanısı", capability: "catalog.read" },
    ],
  },
  {
    label: "Yönetim",
    items: [
      { href: "/yonetim/islemler", label: "İşletim", capability: "operations.read" },
      { href: "/yonetim/kullanicilar", label: "Kullanıcılar", capability: "users.read" },
      { href: "/yonetim/denetim", label: "Denetim kaydı", capability: "audit.read" },
    ],
  },
];
