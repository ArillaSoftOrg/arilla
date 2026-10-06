import { mediaUrlOr } from "@arilla/core/media-url";
import blogImages from "./blog-images.json" with { type: "json" };

/**
 * /blog statik liste verisi. CMS/arka uc yok; makale detay sayfasi yok -
 * kartlar hicbir yere gitmez. Gorseller R2'den (docs/decisions/0061):
 * `blog-images.json` manifesti obje anahtarini verir, URL
 * `R2_PUBLIC_BASE_URL` ile uretilir; tanimli degilse `public/blog/`
 * altindaki yerel yer tutucu kullanilir. Manifest
 * `pnpm --filter @arilla/core media:import-blog` ile uretilir. Yazar ve
 * sureler gosterim amacli notr degerlerdir.
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
    "Bu kanepenin yumuşak, derin oturuşu çok sevildi; fiyatı ise herkesin bütçesine uymuyor. Rehberde benzer modelleri fiyat, dolgu, kumaş, iskelet, derinlik, modülerlik, kılıf ve garanti başlıklarında yan yana koyuyoruz. Böylece hangi alternatifin gerçekten yaklaştığını, hangisinin yalnızca benzer göründüğünü ve fiyat farkının neye değdiğini tek bakışta görebilir, kararınızı güvenle verebilirsiniz.",
  publishedLabel: "16 Eylül 2026 tarihinde yayınlandı.",
  image: mediaUrlOr(blogImages.hero.key, "/blog/hero.svg"),
  readMinutes: 8,
} as const;

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: "acik-ev-sezonu",
    title: "Açık Ev Sezonu: Masa Düzeninden Konuk Odasına Kadar Ev Sahipliği İçin Gerekli Unsurlar",
    excerpt:
      "Misafir ağırlayacağınız sonbahar günleri için elinizin altında olması gerekenleri oda oda topladık: masa örtülerinden servis parçalarına...",
    image: mediaUrlOr(blogImages["acik-ev-sezonu"].key, "/blog/acik-ev.svg"),
    readMinutes: 4,
  },
  {
    slug: "serena-lily-bar-tabureleri",
    title: "Serena & Lily Bar Tabureleri: Riviera Tarzının Sırları",
    excerpt:
      "Sahil mutfaklarının vazgeçilmezi hasır bar taburesinin benzerlerini, fiyat farklarıyla birlikte yan yana inceliyoruz....",
    image: "/blog/bar-taburesi.svg",
    readMinutes: 7,
  },
  {
    slug: "orijinal-teddy-kanepe",
    title: "Orijinal TEDDY™ Kanepe: İnternetin En Sevilen Kanepesi Kendi Kendini Nasıl Kandırdı?",
    excerpt:
      "Çok taklit edilen bir ürün sonunda kendi kopyalarıyla karışır. Bu kanepenin orijinalini ve benzerlerini nasıl ayırt edeceğinizi anlatıyoruz...",
    image: "/blog/teddy-kanepe.svg",
    readMinutes: 9,
  },
  {
    slug: "sonbahar-moda-sezonu",
    title: "2026 Sonbahar Moda Sezonu Taklit Ürünler Raporu",
    excerpt:
      "Sonbahar defilelerinden öne çıkan sekiz trendi ve her birinin uygun fiyatlı karşılıklarını sizin için sıraladık...",
    image: "/blog/sonbahar-moda.svg",
    readMinutes: 15,
  },
  {
    slug: "isci-bayrami-mobilya-indirimleri",
    title:
      "2026 İşçi Bayramı Mobilya İndirimleri: Gerçekten Alınmaya Değer Olanlar (ve Kaçınılması Gerekenler)",
    excerpt:
      "Kampanya dönemlerinde hangi mobilya indirimlerinin gerçekten fark yarattığını, hangilerinin göz boyadığını ayırıyoruz...",
    image: "/blog/isci-bayrami.svg",
    readMinutes: 9,
  },
  {
    slug: "mackenzie-childs-taklitleri",
    title: "MacKenzie-Childs Taklitleri: Daha Uygun Fiyata Şık Ekose Görünümünü Elde Edin",
    excerpt:
      "Kareli seramik ve emaye parçaların ilgi çeken görünümünü, çok daha uygun fiyatlı alternatiflerle nasıl yakalayabileceğinizi anlatıyoruz...",
    image: "/blog/mackenzie.svg",
    readMinutes: 6,
  },
  {
    slug: "louis-vuitton-taklit-cantalari",
    title: "2026'nın En İyi Louis Vuitton Taklit Çantaları: Çok Daha Uygun Fiyata 8 Benzeri Model",
    excerpt:
      "Monogramlı çantaların silüetini hatırlatan sekiz modeli, orijinalleriyle fiyat ve malzeme açısından karşılaştırıyoruz...",
    image: "/blog/louis-vuitton.svg",
    readMinutes: 8,
  },
  {
    slug: "rhode-glazing-milk-rakipleri",
    title: "Rhode'un Glazing Milk ürününe rakip olabilecek sütlü tonik muadilleri",
    excerpt:
      "Cildi hazırlayan ve nemlendiren süt dokulu tonikler artık çok popüler. Benzer içerikteki alternatifleri bir araya getirdik....",
    image: "/blog/glazing-milk.svg",
    readMinutes: 7,
  },
  {
    slug: "baccarat-rouge-540-muadilleri",
    title: "2026 Yılının En İyi Baccarat Rouge 540 Muadilleri",
    excerpt:
      "Çok az parfüm bu kadar tanınan bir kokuya ulaşır. Benzer notalar taşıyan alternatifleri fiyatlarıyla birlikte sıraladık...",
    image: "/blog/baccarat.svg",
    readMinutes: 7,
  },
  {
    slug: "evinizin-tamamini-doseme",
    title:
      "Evinizin Tamamını Gerçekten Sevdiğiniz Parçalarla (Benzer Ürünler Kullanarak) Nasıl Döşersiniz?",
    excerpt:
      "Sevdiğiniz parçaların hepsini almak zorunda değilsiniz. ManiCepte ile benzer ürünleri bulup evinizi adım adım kurmanın yolunu anlatıyoruz...",
    image: "/blog/evin-tamami.svg",
    readMinutes: 8,
  },
  {
    slug: "yukseltilmis-boho-rehberi",
    title: "Yükseltilmiş Boho Rehberi: Anthropologie Estetiğini Parça Parça Kurmak",
    excerpt:
      "Doğal dokular, sıcak tonlar ve el işi detaylarla dolu bir evi, benzer ürünlerle adım adım kurmanın yolunu gösteriyoruz...",
    image: "/blog/boho.svg",
    readMinutes: 8,
  },
];
