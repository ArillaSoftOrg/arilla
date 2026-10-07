import { PUBLIC_CONTACT_EMAIL, SITE_BRAND } from "../site-config.ts";

/**
 * `/sss` içeriği - tek kaynak (docs/decisions/0061, docs/copy.md "SSS").
 * Soru ekleme, çıkarma ve düzenleme yalnızca bu dosyada yapılır; sayfa,
 * akordeon ve FAQPage yapılandırılmış verisi buradan okur.
 *
 * Yanıt biçimi: paragraf dizisi. Paragraf içinde yalnızca site içi bağlantı
 * yazılabilir: `[etiket](/yol)`. Yapılandırılmış veride bağlantı düz metne
 * çevrilir (`faqPlainText`). "Satın al", "dupe" ve "ucuz" kullanılmaz
 * (CLAUDE.md, docs/glossary.md).
 *
 * Yanıtlar yalnızca bugün kodda doğrulanmış davranışı anlatır; sayı veren
 * sınırlar (ör. ücretsiz arama sayısı) ortamdan ayarlandığı için yazılmaz.
 */
export interface FaqItem {
  /** Kalıcı kimlik: bağlantı çapası (`/sss#fiyat-guncelligi`) ve DOM kimliği. */
  id: string;
  question: string;
  answer: readonly string[];
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "nedir",
    question: `${SITE_BRAND} nedir?`,
    answer: [
      `${SITE_BRAND}, aynı ve benzer ürünleri farklı mağazalarda bulup karşılaştırmanızı sağlayan bir ürün keşif platformudur. Ne aradığınızı kendi cümlelerinizle yazabilir, bir ürün fotoğrafı yükleyebilir ya da bir ürün bağlantısı yapıştırabilirsiniz.`,
    ],
  },
  {
    id: "alisveris",
    question: `${SITE_BRAND} üzerinden alışveriş yapabilir miyim?`,
    answer: [
      `Hayır. ${SITE_BRAND} ürün satmaz, stok tutmaz ve ödeme almaz. Bir teklife tıkladığınızda ilgili mağazanın sitesine yönlendirilirsiniz; ödeme, teslimat, iade ve garanti o mağazanın koşullarına tabidir.`,
      `Bazı mağaza yönlendirmelerinden komisyon kazanabiliriz. Bu, mağazanın size gösterdiği fiyatı değiştirmez. Ayrıntılar [Affiliate Açıklaması](/affiliate-aciklamasi)'nda.`,
    ],
  },
  {
    id: "fiyat-guncelligi",
    question: "Fiyatlar ne kadar güncel?",
    answer: [
      "Fiyat ve stok bilgileri mağazalardan, iş ortaklığı ağlarından veya otomatik veri işleme süreçlerinden gelir ve gecikmeli olabilir. Biliniyorsa, ürün sayfasında fiyatın son güncellenme zamanı gösterilir.",
      "Mağazadaki güncel fiyat bizim gösterdiğimizden farklı olabilir. Nihai fiyat, stok ve teslimat koşullarını alışverişten önce mağazanın sitesinde doğrulayın.",
    ],
  },
  {
    id: "hesap",
    question: "Hesap açmak zorunlu mu?",
    answer: [
      "Metinle aramaya hesap açmadan başlayabilirsiniz. Birkaç aramadan sonra devam etmek için ücretsiz bir hesapla giriş yapmanız istenir.",
      "Fotoğrafla ve ürün bağlantısıyla arama için giriş gerekir; bu aramalar hesabınıza tanımlanan günlük arama haklarıyla yapılır. Ürün kaydetme ve fiyat alarmı da hesap ister.",
    ],
  },
  {
    id: "arama",
    question: "Arama nasıl çalışıyor?",
    answer: [
      "Yazdığınız ifadeden ürün türünü ve renk, beden, bütçe gibi özellikleri çıkarırız; eksik bir bilgi varsa kısa bir soruyla netleştiririz. Ardından aynı ürünü sunan mağazaları ve benzer alternatifleri listeleriz.",
      "Benzer ürünler aramanızdan önce hesaplanır; sonuçlar bu yüzden hızlı gelir. Sıralamayı mağazanın bize ödediği komisyon belirlemez.",
    ],
  },
  {
    id: "gorselle-arama",
    question: "Görselle arama nasıl çalışıyor?",
    answer: [
      "Bir ürün fotoğrafı yüklediğinizde (JPEG, PNG veya WebP, en fazla 4 MB) görsel, sayısal bir temsile dönüştürülür ve katalogdaki görsellerle karşılaştırılarak benzer ürünler bulunur.",
      "Fotoğrafınızın kendisi saklanmaz; yalnızca bu sayısal temsil ve aynı görselin tekrar işlenmesini önleyen bir özet değer tutulur. Lütfen kişisel veya başka kişileri gösteren fotoğraflar yüklemeyin. Ayrıntılar [Gizlilik Politikası](/gizlilik)'nda.",
    ],
  },
  {
    id: "veriler",
    question: "Verilerim nasıl kullanılıyor?",
    answer: [
      "Verilerinizi yalnızca hizmeti sunmak, hesabınızı ve aramalarınızı güvenle yönetmek ve hizmeti iyileştirmek için işleriz; kişisel verilerinizi satmayız. Zorunlu olmayan çerezler yalnızca izin verdiğiniz kategorilerde çalışır.",
      "Hangi verinin hangi amaçla işlendiğini, saklama sürelerini ve haklarınızı [Gizlilik Politikası](/gizlilik) ve [KVKK Aydınlatma Metni](/kvkk-aydinlatma)'nde bulabilirsiniz.",
    ],
  },
  {
    id: "hata-bildirme",
    question: "Bir hata veya yanlış fiyatı nasıl bildirebilirim?",
    answer: [
      "[İletişim formu](/iletisim)'nda “Yanlış fiyat veya ürün bilgisi” ya da “Teknik sorun” konusunu seçerek bize yazabilirsiniz. Ürünün adını veya sayfa bağlantısını eklemeniz incelememizi kolaylaştırır.",
      "Ürünle ilgili öneri ve fikirlerinizi [Geri bildirim](/geri-bildirim) sayfasından da iletebilirsiniz.",
    ],
  },
  {
    id: "ucretsiz-mi",
    question: `${SITE_BRAND} ücretsiz mi?`,
    answer: [
      `Evet. ${SITE_BRAND}'i kullanmak ücretsizdir; arama, karşılaştırma ve mağazaya yönlendirme için sizden ücret alınmaz. Bazı mağaza yönlendirmelerinden komisyon kazanabiliriz; bu, mağazanın size gösterdiği fiyatı değiştirmez.`,
    ],
  },
  {
    id: "destek",
    question: "Destek ekibine nasıl ulaşabilirim?",
    answer: [
      `[İletişim formu](/iletisim)'nu kullanabilir ya da ${PUBLIC_CONTACT_EMAIL} adresine e-posta gönderebilirsiniz. Mesajınızı inceler, gerekirse bıraktığınız e-posta adresinden size dönüş yaparız.`,
    ],
  },
];

/** `[etiket](/yol)` - yalnızca site içi yol (`/` ile başlar, `//` değil). */
export const FAQ_LINK_PATTERN = /\[([^\]]+)\]\((\/(?!\/)[^)\s]*)\)/g;

/** Yapılandırılmış veri ve arama motoru için düz metin: bağlantı etiketi kalır. */
export function faqPlainText(paragraph: string): string {
  return paragraph.replace(FAQ_LINK_PATTERN, "$1");
}
