/**
 * /blog statik liste verisi. CMS/arka uc yok; makale detay sayfasi yok -
 * kartlar hicbir yere gitmez. Gorseller `public/blog/` altindaki yerel
 * yer tutucular; yazar ve sureler gosterim amacli notr degerlerdir.
 */
export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  image: string;
  readMinutes: number;
}

export const BLOG_AUTHOR = {
  name: "ManiCepte Editör Ekibi",
  role: "İçerik ve Küratörlük",
  initial: "M",
} as const;

export const BLOG_HERO = {
  title: "2026 Yılının En İyi 10 RH Cloud Kanepe Muadili",
  excerpt:
    "Restoration Hardware Cloud Kanepe, on yıla yakın bir süredir internetin en sevilen kanepesi oldu. O içine gömülme, pamuk gibi yumuşaklık hissi gerçek, ama fiyatı da öyle. Bu kılavuz doğrudan konuya giriyor. Aşağıdaki her benzer ürün, aynı dokuz özellik üzerinden orijinaliyle karşılaştırılıyor: fiyat, oturma yeri dolgusu, sırt dolgusu, kumaş, iskelet, oturma derinliği, modülerlik, yıkanabilir kılıflar ve garanti, böylece elma ile elmayı karşılaştırabilirsiniz. Hadi başlayalım.",
  publishedLabel: "16 Eylül 2024 tarihinde yayınlandı.",
  image: "/blog/hero.svg",
  readMinutes: 8,
} as const;

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: "acik-ev-sezonu",
    title: "Açık Ev Sezonu: Masa Düzeninden Konuk Odasına Kadar Ev Sahipliği İçin Gerekli Unsurlar",
    excerpt:
      "Bu sonbahar ve tatil sezonunda elinizin altında bulunması gereken temel ev sahipliği malzemeleri, oda oda: masa örtüleri, servis...",
    image: "/blog/acik-ev.svg",
    readMinutes: 4,
  },
  {
    slug: "serena-lily-bar-tabureleri",
    title: "Serena & Lily Bar Tabureleri: Riviera Tarzının Sırları",
    excerpt:
      "Son beş yılda Pinterest'e tek bir sahil mutfağı fotoğrafı kaydettiyseniz, Serena & Lily Riviera taburesinin de içinde olma ihtimali yüksektir....",
    image: "/blog/bar-taburesi.svg",
    readMinutes: 7,
  },
  {
    slug: "orijinal-teddy-kanepe",
    title: "Orijinal TEDDY™ Kanepe: İnternetin En Sevilen Kanepesi Kendi Kendini Nasıl Kandırdı?",
    excerpt:
      "Bir noktada taklit edilmek sorun olmaktan çıkıp iltifat haline gelir. OMHU için bu nokta, internette orijinaline benzemeye çalışan binlerce TEDDY™...",
    image: "/blog/teddy-kanepe.svg",
    readMinutes: 9,
  },
  {
    slug: "sonbahar-moda-sezonu",
    title: "2026 Sonbahar Moda Sezonu Taklit Ürünler Raporu",
    excerpt:
      "Sonbahar defilelerinden sekiz trend, en yüksek fiyattan en düşük fiyata doğru sıralanmış haliyle ve hangilerinin taklit edilmeye değer olduğuna...",
    image: "/blog/sonbahar-moda.svg",
    readMinutes: 15,
  },
  {
    slug: "isci-bayrami-mobilya-indirimleri",
    title:
      "2026 İşçi Bayramı Mobilya İndirimleri: Gerçekten Alınmaya Değer Olanlar (ve Kaçınılması Gerekenler)",
    excerpt:
      'İşçi Bayramı 7 Eylül Pazartesi. Bazı indirimler çoktan başladı, çoğu henüz başlamadı ve bu ay göreceğiniz en büyük "indirimlerden" bazıları...',
    image: "/blog/isci-bayrami.svg",
    readMinutes: 9,
  },
  {
    slug: "mackenzie-childs-taklitleri",
    title: "MacKenzie-Childs Taklitleri: Daha Uygun Fiyata Şık Ekose Görünümünü Elde Edin",
    excerpt:
      'Eğer bir sosyal medya hesabında gezinirken altın yaldızlı kenarlı, siyah beyaz kareli bir çaydanlığa bakıp "Bunu almalıyım" diye düşündüyseniz,...',
    image: "/blog/mackenzie.svg",
    readMinutes: 6,
  },
  {
    slug: "louis-vuitton-taklit-cantalari",
    title: "2026'nın En İyi Louis Vuitton Taklit Çantaları: Çok Daha Uygun Fiyata 8 Benzeri Model",
    excerpt:
      "Louis Vuitton monogramı, bir asırdan fazla süredir statü sembolü olmuştur: bu siluet, kalabalık bir ortamda bile anında tanınabilir. Çoğumuzun bir...",
    image: "/blog/louis-vuitton.svg",
    readMinutes: 8,
  },
  {
    slug: "rhode-glazing-milk-rakipleri",
    title: "Rhode'un Glazing Milk ürününe rakip olabilecek sütlü tonik muadilleri",
    excerpt:
      "Rhode'un Glazing Milk'i, cildi hazırlayan ve nemlendiren, oldukça teknik bir ürün olan bu ürünü, viral bir olmazsa olmaz haline getirdi....",
    image: "/blog/glazing-milk.svg",
    readMinutes: 7,
  },
  {
    slug: "baccarat-rouge-540-muadilleri",
    title: "2026 Yılının En İyi Baccarat Rouge 540 Muadilleri",
    excerpt:
      "Maison Francis Kurkdjian'ın Baccarat Rouge 540'ı kadar kült bir statüye ulaşmış çok az parfüm vardır. Binlerce \"Ne sürüyorsun?\" anına eşlik...",
    image: "/blog/baccarat.svg",
    readMinutes: 7,
  },
  {
    slug: "evinizin-tamamini-doseme",
    title:
      "Evinizin Tamamını Gerçekten Sevdiğiniz Parçalarla (Benzer Ürünler Kullanarak) Nasıl Döşersiniz?",
    excerpt:
      "Paranızın yetmediği mobilyalara aşık olmak bir tür olgunlaşma sürecidir, ancak hikayenin sonu olmak zorunda değil. Bu rehber, ManiCepte ile...",
    image: "/blog/evin-tamami.svg",
    readMinutes: 8,
  },
];
