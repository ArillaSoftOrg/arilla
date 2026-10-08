import type { Capability } from "@arilla/core";

export interface AdminNavItem {
  href: string;
  label: string;
  /** Menüde gösterme koşulu. Yetki DEĞİLDİR: her sayfa kendi yeteneğini ayrıca ister. */
  capability: Capability;
  /** Operatör için tek cümle: bu sayfa neyi cevaplar (bağlantı ipucu, konum yolu notu). */
  description: string;
}

export interface AdminNavGroup {
  label: string;
  items: readonly AdminNavItem[];
}

/**
 * docs/routes.md §Yönetim, karar 0055 ve 0083: gruplar operatörün alanına
 * göre (katalog, arama ve AI, kullanıcılar, içerik, işletim, güvenlik).
 * Adresler, etiketler ve yetenekler değişmez; yalnızca gruplama. Yeni modül
 * kendi alanının grubuna eklenir (trendler → İçerik, affiliate → yeni "Gelir").
 */
export const ADMIN_NAV: readonly AdminNavGroup[] = [
  {
    label: "Genel bakış",
    items: [
      {
        href: "/yonetim",
        label: "Genel bakış",
        capability: "admin.access",
        description: "Şimdi dikkat isteyenler ve temel sayılar.",
      },
    ],
  },
  {
    label: "Katalog",
    items: [
      {
        href: "/yonetim/magazalar",
        label: "Mağazalar",
        capability: "merchant.read",
        description: "Mağaza listesi, feed ayarı ve açma/kapama.",
      },
      {
        href: "/yonetim/ingest",
        label: "Veri toplama",
        capability: "ingest.read",
        description: "Mağaza başına toplama koşuları ve hataları.",
      },
      {
        href: "/yonetim/katalog/urunler",
        label: "Ürünler",
        capability: "catalog.read",
        description: "Kanonik ürünler ve teklifleri.",
      },
      {
        href: "/yonetim/katalog/teklifler",
        label: "Teklifler",
        capability: "catalog.read",
        description: "Mağaza teklifleri; eşleşmemişler dahil.",
      },
      {
        href: "/yonetim/katalog/kalite",
        label: "Katalog kalitesi",
        capability: "catalog.read",
        description: "Eksik ya da çelişkili katalog verisi bulguları.",
      },
      {
        href: "/yonetim/eslestirme",
        label: "Eşleştirme kuyruğu",
        capability: "matching.review",
        description: "İnsan onayı bekleyen eşleştirme adayları.",
      },
      {
        href: "/yonetim/eslestirme/gecmis",
        label: "Eşleştirme geçmişi",
        capability: "matching.review",
        description: "Onaylanan ve reddedilen eşleştirmeler.",
      },
    ],
  },
  {
    label: "Arama ve AI",
    items: [
      {
        href: "/yonetim/ai",
        label: "AI operasyonları",
        capability: "ai.read",
        description: "Model çağrısı, token, tahmini maliyet, kota ve sağlayıcı tavanı.",
      },
      {
        href: "/yonetim/arama/tani",
        label: "Arama tanısı",
        capability: "diagnostics.read",
        description: "Bir sorgunun nasıl çözüldüğü ve sonuçsuz aramalar.",
      },
      {
        href: "/yonetim/sozluk",
        label: "Sözlük",
        capability: "dictionary.write",
        description: "Renk, kategori, marka ve eş anlamlı karşılıkları.",
      },
      {
        href: "/yonetim/arama/gorsel",
        label: "Görsel arama",
        capability: "diagnostics.read",
        description: "Fotoğrafla arama yüklemeleri ve sonuçları.",
      },
      {
        href: "/yonetim/arama/link",
        label: "Link araması",
        capability: "diagnostics.read",
        description: "Link çözümleme istekleri ve hataları.",
      },
      {
        href: "/yonetim/ai-geri-bildirim",
        label: "AI geri bildirimleri",
        capability: "feedback.chat.read",
        description: "Sohbet yanıtlarına verilen oylar, nedenler ve yorumlar.",
      },
    ],
  },
  {
    label: "Kullanıcılar ve iletişim",
    items: [
      {
        href: "/yonetim/kullanicilar",
        label: "Kullanıcılar",
        capability: "users.read",
        description: "Hesap arama ve ayrıntısı.",
      },
      {
        href: "/yonetim/yolculuk",
        label: "Kullanıcı yolculuğu",
        capability: "analytics.read",
        description: "Kayıt, rıza oranı, arama ve rızalı huni örneklemi (toplamlar).",
      },
      {
        href: "/yonetim/erken-erisim",
        label: "Erken erişim sayacı",
        capability: "early_access.manage",
        description: "Sitede gösterilen erken erişim sayısı ve platform dışı başvurular.",
      },
      {
        href: "/yonetim/mesajlar",
        label: "Gelen kutusu",
        capability: "messages.read",
        description: "İletişim formu ve geri bildirim mesajları.",
      },
      {
        href: "/yonetim/formlar",
        label: "Formlar ve anketler",
        capability: "forms.manage",
        description: "Kullanıcı anketleri ve yanıtları.",
      },
      {
        href: "/yonetim/kampanyalar",
        label: "E-posta kampanyaları",
        capability: "marketing.manage",
        description: "Pazarlama e-postası taslakları ve gönderimleri.",
      },
    ],
  },
  {
    label: "Gelir",
    items: [
      {
        href: "/yonetim/affiliate",
        label: "Affiliate",
        capability: "affiliate.read",
        description: "Mağaza çıkışları, affiliate kapsamı; dönüşüm entegrasyon bekliyor.",
      },
    ],
  },
  {
    label: "İçerik",
    items: [
      {
        href: "/yonetim/seo",
        label: "SEO tanısı",
        capability: "catalog.read",
        description: "Sitemap uygunluğu ve indekslenebilirlik.",
      },
    ],
  },
  {
    label: "İşletim",
    items: [
      {
        href: "/yonetim/islemler",
        label: "Sistem sağlığı",
        capability: "operations.read",
        description: "Partition, iş, boru hattı, KVKK ve maliyet denetimleri.",
      },
      {
        href: "/yonetim/islemler/isler",
        label: "İş koşuları",
        capability: "operations.read",
        description: "Python işleri ve zamanlanmış uçların koşu geçmişi.",
      },
    ],
  },
  {
    label: "Güvenlik",
    items: [
      {
        href: "/yonetim/denetim",
        label: "Denetim kaydı",
        capability: "audit.read",
        description: "Yönetim eylemlerinin kaydı.",
      },
    ],
  },
];

/**
 * Menü öğesi bu adresi kapsıyor mu. Genel bakış yalnızca tam eşleşmede;
 * diğerleri kendi alt sayfalarında da (`/yonetim/kullanicilar/<id>` →
 * Kullanıcılar). Önek eğik çizgiyle sınırlı: `/yonetim/katalog/urunlerx`
 * Ürünler sayılmaz.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/yonetim") return pathname === "/yonetim";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Etkin öğe: adresi kapsayanlardan EN ÖZEL olanı (en uzun `href`). Böylece
 * `/yonetim/eslestirme/gecmis` yalnızca "Eşleştirme geçmişi"ni,
 * `/yonetim/islemler/isler` yalnızca "İş koşuları"nı işaretler; üst öğe aynı
 * anda etkin görünmez.
 */
export function activeNavHref(hrefs: readonly string[], pathname: string): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (isNavItemActive(href, pathname) && (best === null || href.length > best.length)) {
      best = href;
    }
  }
  return best;
}
