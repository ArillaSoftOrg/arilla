/**
 * GECICI demo urun katalogu - Admitad/feed entegrasyonu gelene kadar ana
 * sayfanin Trendler (`homepage-trends.ts`) ve Kesif (`homepage-discovery.ts`)
 * bolumlerinin TEK ortak veri kaynagi. Ayni urun metadata'si iki dosyaya
 * kopyalanmaz - her iki dosya da buradan id ile referans alir.
 *
 * Urun adlari, markalari ve gorselleri kamuya acik resmi marka urun
 * sayfalarindan alinmistir - kaynak detaylari (sayfa, gorsel, erisim
 * tarihi) icin bkz. ./SOURCES.md. Bu dosya production veri kaynagi
 * DEGILDIR.
 *
 * `aspectRatio` gercek gorsel piksel olcumlerinden alinmistir (width/height)
 * - urun gorseli anlamsizca crop edilmesin diye uydurulmamistir.
 */
export interface DemoProduct {
  id: string;
  title: string;
  brand: string;
  imageUrl: string;
  imageAlt: string;
  /** Gercek gorsel en/boy orani (width/height). */
  aspectRatio: number;
  /** Kesif izgarasi kategori karisimi icin - UI'da zorunlu gosterilmez. */
  category: string;
}

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    id: "nike-air-force-1-07",
    title: "Air Force 1 '07",
    brand: "Nike",
    imageUrl:
      "https://static.nike.com/a/images/t_web_pdp_535_v2/f_auto,u_9ddf04c7-2a9a-4d76-add1-d15af8f0263d,c_scale,fl_relative,w_1.0,h_1.0,fl_layer_apply/8861a585-43b0-491a-9229-14f9d1ebfb35/AIR+FORCE+1+%2707.png",
    imageAlt: "Nike Air Force 1 '07 beyaz spor ayakkabı",
    aspectRatio: 0.8,
    category: "ayakkabı",
  },
  {
    id: "puma-suede-classic-xxi",
    title: "Suede Classic XXI",
    brand: "Puma",
    imageUrl:
      "https://images.puma.com/image/upload/f_auto,q_auto,b_rgb:fafafa,w_600,h_600/global/374915/12/sv01/fnd/PNA/fmt/png/Suede-Classic-XXI-Sneakers",
    imageAlt: "Puma Suede Classic XXI siyah süet spor ayakkabı",
    aspectRatio: 1,
    category: "ayakkabı",
  },
  {
    id: "veja-campo-leather-white-black",
    title: "Campo Leather",
    brand: "Veja",
    imageUrl:
      "https://media.veja-store.com/images/t_sfcc-pdp-desktop-v2/c_limit,w_600/v1781690682/VEJA/PACKSHOTS/CP0501537_1/CP0501537_1.jpg",
    imageAlt: "Veja Campo Leather beyaz-siyah spor ayakkabı",
    aspectRatio: 1,
    category: "ayakkabı",
  },
  {
    id: "veja-esplar-leather-white-black",
    title: "Esplar Leather",
    brand: "Veja",
    imageUrl:
      "https://media.veja-store.com/images/t_sfcc-pdp-desktop-v2/c_limit,w_600/v1779892444/VEJA/PACKSHOTS/EO0200005_1/EO0200005_1.jpg",
    imageAlt: "Veja Esplar Leather kadın spor ayakkabı",
    aspectRatio: 1,
    category: "kadın ayakkabı",
  },
  {
    id: "ikea-markus-chair",
    title: "MARKUS ofis koltuğu",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/markus-office-chair-vissle-dark-gray__0724714_pe734597_s4.jpg",
    imageAlt: "IKEA MARKUS ofis koltuğu, koyu gri",
    aspectRatio: 1,
    category: "çalışma koltuğu",
  },
  {
    id: "ikea-forsa-lamp",
    title: "FORSÅ masa lambası",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/forsa-work-lamp-nickel-plated__0121576_pe278160_s4.jpg",
    imageAlt: "IKEA FORSÅ nikel kaplama masa lambası",
    aspectRatio: 1,
    category: "aydınlatma",
  },
  {
    id: "ikea-ovning-organizer",
    title: "ÖVNING masaüstü düzenleyici",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/oevning-desk-accessories-organizer__1160249_pe888822_s4.jpg",
    imageAlt: "IKEA ÖVNING masaüstü düzenleyici",
    aspectRatio: 1,
    category: "küçük ev ürünü",
  },
  {
    id: "carhartt-wip-detroit-jacket",
    title: "Detroit Ceket",
    brand: "Carhartt WIP",
    imageUrl:
      "https://cdn.shopify.com/s/files/1/2193/5809/files/I033112_00E_02-OF-01.jpg?v=1776965443&width=600&height=900&crop=center",
    imageAlt: "Carhartt WIP Detroit ceket, siyah",
    aspectRatio: 0.67,
    category: "erkek giyim",
  },
  {
    id: "la-apparel-heavy-fleece-crewneck",
    title: "Heavy Fleece Crewneck",
    brand: "Los Angeles Apparel",
    imageUrl:
      "https://losangelesapparel.net/cdn/shop/files/HF07BLACKBEDGEFRONT.jpg?v=1742861425&width=600",
    imageAlt: "Los Angeles Apparel Heavy Fleece Crewneck sweatshirt, siyah",
    aspectRatio: 0.67,
    category: "giyim",
  },
  {
    id: "herschel-little-america-backpack",
    title: "Little America Sırt Çantası",
    brand: "Herschel",
    imageUrl:
      "https://herschel.com/cdn/shop/files/hero-11390-00001-os-desktop-Ums6JEJw.jpg?v=1781646193&width=800",
    imageAlt: "Herschel Little America sırt çantası",
    aspectRatio: 1.6,
    category: "çanta",
  },
  {
    id: "ikea-fejka-plant",
    title: "FEJKA yapay saksı bitkisi",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/fejka-artificial-potted-plant-indoor-outdoor-aralia__1389892_pe965297_s4.jpg",
    imageAlt: "IKEA FEJKA yapay saksı bitkisi, aralia",
    aspectRatio: 1,
    category: "küçük ev ürünü",
  },
  {
    id: "ikea-billy-bookcase",
    title: "BILLY kitaplık",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/billy-bookcase-white__1590291_pe1038930_s4.jpg",
    imageAlt: "IKEA BILLY kitaplık, beyaz",
    aspectRatio: 1,
    category: "ev mobilyası",
  },
  {
    id: "ikea-vallkrassing-cushion-cover",
    title: "VALLKRASSING yastık kılıfı",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/vallkrassing-cushion-cover-off-white__1338072_pe948186_s4.jpg",
    imageAlt: "IKEA VALLKRASSING yastık kılıfı, kırık beyaz",
    aspectRatio: 1,
    category: "küçük ev ürünü",
  },
  {
    id: "ikea-lindbyn-mirror",
    title: "LINDBYN ayna",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/lindbyn-mirror-black__0798815_pe767395_s4.jpg",
    imageAlt: "IKEA LINDBYN yuvarlak ayna, siyah",
    aspectRatio: 1,
    category: "ev aksesuarı",
  },
  {
    id: "ikea-hektar-floor-lamp",
    title: "HEKTAR lambader",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/hektar-floor-lamp-dark-gray__0149974_pe308131_s4.jpg",
    imageAlt: "IKEA HEKTAR lambader, koyu gri",
    aspectRatio: 1,
    category: "aydınlatma",
  },
  {
    id: "ikea-lohals-rug",
    title: "LOHALS halı",
    brand: "IKEA",
    imageUrl:
      "https://www.ikea.com/us/en/images/products/lohals-rug-flatwoven-natural__0280221_pe419173_s4.jpg",
    imageAlt: "IKEA LOHALS düz dokuma jüt halı",
    aspectRatio: 1,
    category: "ev mobilyası",
  },
  {
    id: "nike-club-hoodie",
    title: "Club Pullover Hoodie",
    brand: "Nike",
    imageUrl:
      "https://static.nike.com/a/images/t_web_pdp_535_v2/f_auto,u_9ddf04c7-2a9a-4d76-add1-d15af8f0263d,c_scale,fl_relative,w_1.0,h_1.0,fl_layer_apply/0beb434c-56b3-4607-b266-29d90879fbb5/M+NK+CLUB+BB+PO+HOODIE.png",
    imageAlt: "Nike Club Pullover Hoodie",
    aspectRatio: 0.8,
    category: "giyim",
  },
  {
    id: "nike-featherlight-cap",
    title: "Dri-FIT Featherlight Cap",
    brand: "Nike",
    imageUrl:
      "https://static.nike.com/a/images/t_web_pdp_535_v2/f_auto,u_9ddf04c7-2a9a-4d76-add1-d15af8f0263d,c_scale,fl_relative,w_1.0,h_1.0,fl_layer_apply/1e73c461-d429-4631-bcce-cf9bba2670a1/U+NK+DF+CLUB+CAP+U+AB+FL+P.png",
    imageAlt: "Nike Dri-FIT Featherlight şapka",
    aspectRatio: 0.8,
    category: "aksesuar",
  },
  {
    id: "puma-essentials-tee",
    title: "Essentials Tee",
    brand: "Puma",
    imageUrl:
      "https://images.puma.com/image/upload/f_auto,q_auto,b_rgb:fafafa,w_600,h_600/global/688845/13/mod01/fnd/PNA/fmt/png/PUMA-Essentials-Men's-Tee",
    imageAlt: "Puma Essentials t-shirt",
    aspectRatio: 1,
    category: "giyim",
  },
  {
    id: "herschel-classic-hip-pack",
    title: "Classic Hip Pack",
    brand: "Herschel",
    imageUrl:
      "https://herschel.com/cdn/shop/files/11549-00001-os-01-T0VJ6RYE.jpg?v=1781474667&width=800",
    imageAlt: "Herschel Classic Hip Pack bel çantası",
    aspectRatio: 0.8,
    category: "çanta",
  },
  {
    id: "carhartt-wip-gabe-beanie",
    title: "Gabe Beanie",
    brand: "Carhartt WIP",
    imageUrl:
      "https://cdn.shopify.com/s/files/1/2193/5809/files/I026222_00F_XX-OF-01.jpg?v=1786037460&width=600&height=900&crop=center",
    imageAlt: "Carhartt WIP Gabe Beanie, siyah",
    aspectRatio: 0.67,
    category: "aksesuar",
  },
  {
    id: "la-apparel-1801-tee",
    title: "The 1801 Garment Dye Tee",
    brand: "Los Angeles Apparel",
    imageUrl:
      "https://losangelesapparel.net/cdn/shop/files/1801VINTAGEBLACK1.jpg?v=1779395141&width=600",
    imageAlt: "Los Angeles Apparel The 1801 t-shirt, siyah",
    aspectRatio: 0.67,
    category: "giyim",
  },
];

export function findDemoProduct(id: string): DemoProduct {
  const product = DEMO_PRODUCTS.find((item) => item.id === id);
  if (!product) {
    throw new Error(`Demo urun bulunamadi: ${id}`);
  }
  return product;
}
