import { mediaUrlOr } from "@arilla/core/media-url";
import blogImages from "./blog-images.json" with { type: "json" };
import blogSources from "./blog-sources.json" with { type: "json" };

/**
 * /blog statik liste verisi. CMS/arka uc yok; makale detay sayfasi yok -
 * kartlar hicbir yere gitmez. Gorseller R2'den (docs/decisions/0062):
 * `blog-images.json` manifesti obje anahtarini verir, URL
 * `R2_PUBLIC_BASE_URL` ile uretilir; tanimli degilse `public/blog/`
 * altindaki yerel yer tutucu kullanilir. Manifest, `blog-sources.json`
 * kaynak listesinden `pnpm --filter @arilla/core media:import-blog` ile
 * uretilir. Yazar ve sureler gosterim amacli notr degerlerdir.
 */
export interface BlogPost {
  slug: BlogImageId;
  /** Kaynak yazinin slug'i (`blog-sources.json`); govde iceri aktarimi icin. */
  sourceSlug: string;
  title: string;
  excerpt: string;
  image: string;
  readMinutes: number;
}

type BlogImageId = keyof typeof blogImages;

const PLACEHOLDER_IMAGE = "/blog/placeholder.svg";

function sourceSlugOf(id: BlogImageId): string {
  const source = blogSources.find((entry) => entry.id === id);
  if (!source) throw new Error(`blog-sources.json icinde kayit yok: ${id}`);
  return source.sourceSlug;
}

/** Yazi kaydi: gorsel manifestten, kaynak slug kaynak listesinden gelir. */
function post(slug: BlogImageId, title: string, excerpt: string, readMinutes: number): BlogPost {
  return {
    slug,
    sourceSlug: sourceSlugOf(slug),
    title,
    excerpt,
    image: mediaUrlOr(blogImages[slug].key, PLACEHOLDER_IMAGE),
    readMinutes,
  };
}

export const BLOG_AUTHOR = {
  name: "ManiCepte Editör Ekibi",
  role: "İçerik ve Küratörlük",
  initial: "M",
} as const;

export const BLOG_HERO = {
  slug: "rh-cloud-kanepe-muadilleri",
  title: "2026 Yılının En İyi 10 RH Cloud Kanepe Muadili",
  excerpt:
    "Bu kanepenin yumuşak, derin oturuşu çok sevildi; fiyatı ise herkesin bütçesine uymuyor. Rehberde benzer modelleri fiyat, dolgu, kumaş, iskelet, derinlik, modülerlik, kılıf ve garanti başlıklarında yan yana koyuyoruz. Böylece hangi alternatifin gerçekten yaklaştığını, hangisinin yalnızca benzer göründüğünü ve fiyat farkının neye değdiğini tek bakışta görebilir, kararınızı güvenle verebilirsiniz.",
  publishedLabel: "16 Eylül 2026 tarihinde yayınlandı.",
  image: mediaUrlOr(blogImages.hero.key, "/blog/hero.svg"),
  readMinutes: 8,
} as const;

export const BLOG_POSTS: readonly BlogPost[] = [
  post(
    "acik-ev-sezonu",
    "Açık Ev Sezonu: Masa Düzeninden Konuk Odasına Kadar Ev Sahipliği İçin Gerekli Unsurlar",
    "Misafir ağırlayacağınız sonbahar günleri için elinizin altında olması gerekenleri oda oda topladık: masa örtülerinden servis parçalarına...",
    4,
  ),
  post(
    "serena-lily-bar-tabureleri",
    "Serena & Lily Bar Tabureleri: Riviera Tarzının Sırları",
    "Sahil mutfaklarının vazgeçilmezi hasır bar taburesinin benzerlerini, fiyat farklarıyla birlikte yan yana inceliyoruz....",
    7,
  ),
  post(
    "orijinal-teddy-kanepe",
    "Orijinal TEDDY™ Kanepe: İnternetin En Sevilen Kanepesi Kendi Kendini Nasıl Kandırdı?",
    "Çok taklit edilen bir ürün sonunda kendi kopyalarıyla karışır. Bu kanepenin orijinalini ve benzerlerini nasıl ayırt edeceğinizi anlatıyoruz...",
    9,
  ),
  post(
    "sonbahar-moda-sezonu",
    "2026 Sonbahar Moda Sezonu Taklit Ürünler Raporu",
    "Sonbahar defilelerinden öne çıkan sekiz trendi ve her birinin uygun fiyatlı karşılıklarını sizin için sıraladık...",
    15,
  ),
  post(
    "isci-bayrami-mobilya-indirimleri",
    "2026 İşçi Bayramı Mobilya İndirimleri: Gerçekten Alınmaya Değer Olanlar (ve Kaçınılması Gerekenler)",
    "Kampanya dönemlerinde hangi mobilya indirimlerinin gerçekten fark yarattığını, hangilerinin göz boyadığını ayırıyoruz...",
    9,
  ),
  post(
    "mackenzie-childs-taklitleri",
    "MacKenzie-Childs Taklitleri: Daha Uygun Fiyata Şık Ekose Görünümünü Elde Edin",
    "Kareli seramik ve emaye parçaların ilgi çeken görünümünü, çok daha uygun fiyatlı alternatiflerle nasıl yakalayabileceğinizi anlatıyoruz...",
    6,
  ),
  post(
    "louis-vuitton-taklit-cantalari",
    "2026'nın En İyi Louis Vuitton Taklit Çantaları: Çok Daha Uygun Fiyata 8 Benzeri Model",
    "Monogramlı çantaların silüetini hatırlatan sekiz modeli, orijinalleriyle fiyat ve malzeme açısından karşılaştırıyoruz...",
    8,
  ),
  post(
    "rhode-glazing-milk-rakipleri",
    "Rhode'un Glazing Milk ürününe rakip olabilecek sütlü tonik muadilleri",
    "Cildi hazırlayan ve nemlendiren süt dokulu tonikler artık çok popüler. Benzer içerikteki alternatifleri bir araya getirdik....",
    7,
  ),
  post(
    "baccarat-rouge-540-muadilleri",
    "2026 Yılının En İyi Baccarat Rouge 540 Muadilleri",
    "Çok az parfüm bu kadar tanınan bir kokuya ulaşır. Benzer notalar taşıyan alternatifleri fiyatlarıyla birlikte sıraladık...",
    7,
  ),
  post(
    "evinizin-tamamini-doseme",
    "Evinizin Tamamını Gerçekten Sevdiğiniz Parçalarla (Benzer Ürünler Kullanarak) Nasıl Döşersiniz?",
    "Sevdiğiniz parçaların hepsini almak zorunda değilsiniz. ManiCepte ile benzer ürünleri bulup evinizi adım adım kurmanın yolunu anlatıyoruz...",
    8,
  ),
  post(
    "yukseltilmis-boho-rehberi",
    "Yükseltilmiş Boho Rehberi: Anthropologie Estetiğini Parça Parça Kurmak",
    "Doğal dokular, sıcak tonlar ve el işi detaylarla dolu bir evi, benzer ürünlerle adım adım kurmanın yolunu gösteriyoruz...",
    8,
  ),
  post(
    "aritzia-tarzi-rehberi",
    "Havalı Aritzia Görünümü: Her Güne Lüks Katan Tarz Rehberi",
    "Minimalist ama sıkıcı olmayan, şık ama gösterişsiz Aritzia estetiğini parça parça kurmanın yollarını anlatıyoruz...",
    10,
  ),
  post(
    "usm-haller-moduler-alternatifler",
    "Herkes Neden USM Haller'a Hayran (ve Aynı Büyüyü Yakalayan 12 Modüler Parça)",
    "Tasarım editörlerinin evlerindeki İsviçre raf sistemini bu kadar sevilen yapan şeyi ve benzer modüler seçenekleri inceliyoruz...",
    6,
  ),
  post(
    "babalar-gunu-son-dakika-hediyeleri",
    "Son Dakikaya mı Kaldınız? Pazara Kadar Elinize Ulaşan Babalar Günü Hediyeleri",
    "Babalar Günü'ne çok az kaldıysa panik yok; zamanında ulaşan şık ve düşünceli hediye fikirlerini topladık...",
    8,
  ),
  post(
    "2026-en-cok-taklit-edilen-mobilyalar",
    "2026'nın En Çok Taklit Edilen 8 Mobilya Parçası",
    "Bazı parçalar o kadar ikonik ve pahalı ki internet tam fiyat ödemeyi reddediyor; her yıl onlarca benzeri çıkan sekiz tasarımı inceledik...",
    5,
  ),
  post(
    "togo-kanepe-tarzi",
    "2026'da Togo Kanepe Görünümünü Yüzde 90 Daha Az Ödeyerek Yakalamak",
    "Kabarık, kıvrımlı ve yere yakın o kanepeyi herkes tanıyor; fiyatına katlanmadan benzer görünümü nasıl kuracağınızı anlatıyoruz...",
    8,
  ),
  post(
    "uygun-fiyatli-mobilya-nereden",
    "Uygun Fiyatlı Mobilyayı Nereden Bulabilirsiniz? Evinizi Daha Az Harcayarak Döşemenin Akıllı Yolları",
    "Ev döşemek bütçeyi hızla eritebilir; fiyat performans odaklı akıllı seçenekleri ve yöntemleri sıraladık...",
    11,
  ),
  post(
    "eames-sandalye-muadilleri",
    "Almaya Değer Tüm Eames Sandalye Muadillerini İnceledik: Bir Yıl Sonra Hangisi Ayakta Kalıyor?",
    "Dünyanın en çok kopyalanan iki sandalyesinin benzerlerini dayanıklılık ve fiyat açısından karşılaştırdık...",
    11,
  ),
  post(
    "bogg-bag-muadilleri",
    "Bogg Bag Standardı: Plaj Günü İçin Güvenebileceğiniz 8 Muadil",
    "Günün çantası Bogg Bag'in 90 doları aşan fiyatına katlanmadan plaja gidebilmeniz için benzer sekiz modeli araştırdık...",
    7,
  ),
  post(
    "dyson-airwrap-muadilleri",
    "2026'nın Gerçekten İş Gören En İyi Dyson Airwrap Muadilleri",
    "Kurutan, kıvıran ve hacim veren, saçı yakmayan bir cihazı 650 dolarlık fiyat etiketi olmadan nasıl bulursunuz...",
    12,
  ),
  post(
    "lululemon-tayt-muadilleri",
    "2026'da Paranızı Hak Eden En İyi Lululemon Tayt Muadilleri",
    "Align taytların hafif kumaşını ve kusursuz oturuşunu yakalayan uygun fiyatlı alternatifleri karşılaştırdık...",
    14,
  ),
  post(
    "mobilyayi-pahali-gosteren-9-detay",
    "Mobilyayı Pahalı Gösteren 9 Detay (Aslında Öyle Olmasa Bile)",
    "Tasarımcı etiketine ödeme yapmadan mobilyanıza daha lüks bir görünüm kazandıracak dokuz ayrıntıyı anlatıyoruz...",
    7,
  ),
  post(
    "bilincli-harcama-luks-stil",
    "Gerçek Hayat Bütçesiyle Lüks Stil: Bilinçli Harcama Nasıl Yapılır?",
    "Aşırıya kaçmadan güzel bir ev ve gardırop kurmak, daha az harcayıp daha akıllı seçim yapmak için bir rehber...",
    13,
  ),
  post(
    "alaia-file-babet-muadilleri",
    "100 Doların Altındaki En İyi Alaïa File Babet Muadilleri",
    "Aynı zarif ve havadar görünümü sunan uygun fiyatlı file babetleri ve Mary Jane'leri bir araya getirdik...",
    9,
  ),
  post(
    "2026-ev-ve-moda-trendleri",
    "2026'ya Yön Veren 7 Ev ve Moda Trendi (Tasarımcı Görünümlerini Daha Uygun Fiyata Yakalayın)",
    "Heykelsi mobilyadan sessiz lüks stile, öne çıkan trendleri ve bunları daha az harcayarak nasıl kuracağınızı anlatıyoruz...",
    9,
  ),
  post(
    "orijinal-mi-benzer-mi",
    "Orijinal mi, Benzer Ürün mü: Daha Fazla Ödemek Ne Zaman Gerçekten Mantıklı?",
    "Kanepe, sehpa, koltuk ve modada orijinal ile alternatifin gerçek maliyetini, kullanım başına maliyetle birlikte karşılaştırıyoruz...",
    11,
  ),
  post(
    "chatgpt-ile-akilli-alisveris",
    "ChatGPT'de ManiCepte ile Daha Akıllı Alışveriş Nasıl Yapılır?",
    "Uygun fiyatlı alternatifleri bulmak, ürünleri karşılaştırmak ve güvenle karar vermek için adım adım rehber...",
    6,
  ),
  post(
    "emin-alisverisci-cercevesi",
    "Emin Alışverişçi Çerçevesi: Her Seferinde Akıllıca Alışveriş Yapmanın Yolu",
    "Pişmanlıktan kaçınmak, ne zaman biriktirip ne zaman harcayacağınıza karar vermek için tekrarlanabilir bir yöntem...",
    10,
  ),
  post(
    "muadil-urun-nedir",
    "Muadil Ürün Nedir? Muadilleri Anlamak ve Yüksek Kaliteli Alternatifleri Bulmak İçin Eksiksiz Rehber",
    "Tasarımdan ilham alan alternatiflerin modern alışveriş kültürünün neden önemli bir parçası olduğunu açıklıyoruz...",
    7,
  ),
  post(
    "yeni-uygulama-neler-sunuyor",
    "ManiCepte Sizin İçin Neler Yapabilir (ve İnsanların Alışveriş Şeklini Neden Değiştiriyor)",
    "Alışveriş giderek karmaşıklaşırken insanların neden daha akıllı bir yol aradığını ve ManiCepte'nin buna nasıl yardımcı olduğunu anlatıyoruz...",
    6,
  ),
  post(
    "akilli-alisverisci-mobilya-rehberi",
    "Akıllı Alışverişçi Rehberi: ManiCepte İnsanların Mobilya Alışını Nasıl Değiştiriyor",
    "Aynı görünen ürünler için fazla ödemekten yorulduysanız yalnız değilsiniz; sektörün fiyatlandırma mantığına bakıyoruz...",
    10,
  ),
  post(
    "uygun-fiyatli-luksun-sanati",
    "Uygun Fiyatlı Lüksün Sanatı: ManiCepte Evden Gardıroba Akıllı Estetik Yaşamı Nasıl Yeniden Tanımlıyor?",
    "Tasarım severleri üst segment görünümlere daha uygun fiyatla ulaştıran yaklaşımı ev ve gardırop için anlatıyoruz...",
    7,
  ),
  post(
    "2025-ev-trendleri",
    "2025'te Gerçekten Karşılayabileceğiniz Ev Trendleri",
    "Tasarımcı görünümleri, gündelik bütçeler: 2025'te iç mekanlar daha yumuşak, sıcak ve kişisel...",
    6,
  ),
  post(
    "sonbahar-seckisi",
    "Rahat Görünümler, Lüks Hisler ve Daha Akıllı Harcama: ManiCepte'nin Sonbahar Seçkisi",
    "Mevsim geçişinde eve ve gardıroba küçük bir tazelenme katmanın akıllı yolları...",
    6,
  ),
  post(
    "ilk-evimi-doseme-hikayesi",
    "İlk Evimi (ve Dolabımı) Batmadan Nasıl Döşedim?",
    "İlk eve taşınmak bütçeyi sarsmak zorunda değil; yüksek fiyatlı parçalara alternatif bulmanın yollarını anlatıyoruz...",
    8,
  ),
  post(
    "2025in-en-rahat-kanepeleri",
    "2025'in En Rahat Kanepeleri: Uzmanların Onayladığı 14 Seçim",
    "Derin oturuş, stil ve dayanıklılık için mobilya uzmanlarının seçtiği 14 kanepeyi derledik...",
    5,
  ),
  post(
    "mobilyada-tasarruf-13-yol",
    "Mobilyada Tasarruf Etmenin 13 Akıllı Yolu (ve ManiCepte Nasıl Yardımcı Olur)",
    "Fiyatlar yükselirken ve bütçeler daralırken evi yenilemeyi ertelemeden mobilya almanın yolları...",
    6,
  ),
  post(
    "butceli-yilbasi-alisverisi",
    "Bütçeye Uygun Yılbaşı Alışverişi: 2025 İçin Sekiz Denenmiş İpucu",
    "Enflasyon ve belirsizlik döneminde yılbaşı harcamalarını kontrol altında tutmanın sekiz pratik yolu...",
    8,
  ),
  post(
    "kemiksiz-kanepe-muadilleri",
    "En İyi Kemiksiz Kanepe Muadilleri (Gerçekten Beklentiyi Karşılayanlar)",
    "Cloud Couch'ın ardından gündeme gelen kemiksiz, bulut gibi kanepelerin benzerlerini karşılaştırıyoruz...",
    6,
  ),
  post(
    "serena-lily-sahil-tarzi",
    "Serena & Lily Tarzı: Daha Uygun Fiyata Sahil Şıklığı",
    "Serena & Lily'nin sahil esintili stilini ve benzer görünümü sunan uygun fiyatlı alternatifleri inceliyoruz...",
    9,
  ),
  post(
    "boucle-koltuk-rehberi",
    "2025 Bouclé Koltuk Rehberi: Gündemdeki Benzerler ve Şık Dekorasyon Püf Noktaları",
    "Sessiz lüksün simgesi bouclé koltukların yükselişini, benzer modelleri ve yerleştirme önerilerini anlatıyoruz...",
    4,
  ),
];
