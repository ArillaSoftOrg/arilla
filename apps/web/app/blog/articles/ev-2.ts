import type { Article } from "./types.ts";

/** Ozgun taslak metinler (karar 0071). Editor ekibi tek tek gozden gecirecek. */
export const EV_2: Readonly<Record<string, Article>> = {
  "yukseltilmis-boho-rehberi": {
    lead: "Doğal doku, sıcak ton ve el işi detaylarla boho evi parça parça kurmanın yolu.",
    blocks: [
      {
        type: "p",
        text: "Boho tarz, rastgele toplanmış görünen ama aslında dengeli bir düzene dayanır. Yükseltilmiş versiyonu daha az parça, daha çok doku demektir.",
      },
      { type: "h2", text: "Temel öğeler" },
      {
        type: "ul",
        items: [
          "Doğal malzemeler: rattan, keten, pamuk ve ahşap",
          "Toprak tonları: krem, terakota, hardal, zeytin yeşili",
          "El işi detaylar: makrome, kilim, seramik",
          "Bitkiler: yeşil, tarzı canlı tutar",
        ],
      },
      { type: "h2", text: "Parça parça kurulum" },
      {
        type: "p",
        text: "Önce zemini ve ana mobilyayı nötr tutun. Sonra kilim, yastık ve aydınlatma ile katman ekleyin. Her yeni parça mevcut renk paletine uymalı.",
      },
    ],
  },
  "aritzia-tarzi-rehberi": {
    lead: "Minimalist ama sıkıcı olmayan, gündelik lüks havasında bir gardırobu temel parçalarla kurmanın yolu.",
    blocks: [
      {
        type: "p",
        text: "Bu tarzın özü: temiz kesimler, sakin renkler ve iyi oturan parçalar. Çok sayıda parçadan çok, birbirine uyan birkaç parça fark yaratır.",
      },
      { type: "h2", text: "Gardırobun omurgası" },
      {
        type: "ul",
        items: [
          "Düz kesim pantolon ve geniş paça seçenekleri",
          "Kaliteli, kalın dokulu tişört ve triko",
          "Yapılandırılmış blazer ya da uzun palto",
          "Nötr ayakkabı: sade bot ya da babet",
        ],
      },
      { type: "h2", text: "Kumaş ve kesim" },
      {
        type: "p",
        text: "Fiyat farkı çoğu zaman kumaşın ağırlığında ve dikişin temizliğinde görünür. Kumaş etiketine bakın: yün, pamuk ve viskon oranı bilgi verir.",
      },
    ],
  },
  "usm-haller-moduler-alternatifler": {
    lead: "Modüler raf ve depolama sistemlerini seçerken bakılacak ölçütler: bağlantı, malzeme ve genişleyebilirlik.",
    blocks: [
      {
        type: "p",
        text: "Modüler raf sistemleri, ihtiyaca göre büyüyebildiği için sevilir. Benzer bir sistem seçerken parçaların birbiriyle uyumlu kalacağından emin olmak gerekir.",
      },
      { type: "h2", text: "Neye bakmalı?" },
      {
        type: "ul",
        items: [
          "Bağlantı sistemi: vidasız ya da kolay söküp takılan birleşimler",
          "Malzeme: çelik, kaplamalı metal ve ahşap seçenekleri",
          "Taşıma kapasitesi: raf başına dayanım",
          "Parça sürekliliği: aynı seriden ek parça bulunabilir mi?",
        ],
      },
      {
        type: "p",
        text: "Ölçüleri önceden planlayın. Raf derinliği ve yüksekliği, kullanacağınız eşyaya göre belirlenmeli.",
      },
    ],
  },
  "babalar-gunu-son-dakika-hediyeleri": {
    lead: "Son dakikaya kalındığında zamanında ulaşan, düşünceli hediye fikirleri ve teslimat süresi kontrolü.",
    blocks: [
      {
        type: "p",
        text: "Babalar Günü'ne az kaldıysa panik yapmayın. Hızlı teslim edilen ve işe yarayan hediyeler var.",
      },
      { type: "h2", text: "Hızlı teslimat için ipuçları" },
      {
        type: "ul",
        items: [
          "Mağazanın tahmini teslim tarihini ödeme öncesinde kontrol edin",
          "Aynı gün ya da ertesi gün teslim seçeneklerine bakın",
          "Dijital hediye ya da deneyim seçenekleri kargo gerektirmez",
        ],
      },
      { type: "h2", text: "Fikirler" },
      {
        type: "ul",
        items: [
          "Günlük kullandığı bir eşyanın daha iyi versiyonu",
          "Hobisine uygun küçük bir parça",
          "Birlikte yapılacak bir etkinlik",
        ],
      },
    ],
  },
  "2026-en-cok-taklit-edilen-mobilyalar": {
    lead: "Çok ilgi gören ve benzerleri sıkça aranan mobilya tasarımlarını tanımanın ve alternatif seçmenin yolları.",
    blocks: [
      {
        type: "p",
        text: "Bazı tasarımlar o kadar çok sevilir ki benzer ürünler piyasaya hızla yayılır. Hangisinin gerçekten iyi bir alternatif olduğunu anlamak için ölçütlere bakın.",
      },
      { type: "h2", text: "İyi alternatif nasıl ayırt edilir?" },
      {
        type: "ul",
        items: [
          "Form benzerliği: oranlar ve silüet",
          "Malzeme kalitesi: ahşap, metal ve kumaşın cinsi",
          "Satıcı güvenilirliği ve iade koşulları",
          "Kendi markasıyla satılması",
        ],
      },
      {
        type: "p",
        text: "Sekiz parçayı tek tek incelemek yerine kendi evinize uyanı seçin: ölçü ve kullanım ihtiyacı önce gelir.",
      },
    ],
  },
  "togo-kanepe-tarzi": {
    lead: "Alçak, kabarık ve kıvrımlı kanepe görünümünü daha az harcayarak kurmak için ölçütler ve ipuçları.",
    blocks: [
      {
        type: "p",
        text: "Yere yakın, yumuşak hatlı bir kanepe salona rahat bir hava verir. Bu görünümü başka modellerle de yakalayabilirsiniz.",
      },
      { type: "h2", text: "Görünümü oluşturan özellikler" },
      {
        type: "ul",
        items: [
          "Alçak oturum ve geniş gövde",
          "Kıvrımlı dikiş ve yumuşak köşeler",
          "Tek parça gibi görünen, bölünmeyen yapı",
        ],
      },
      { type: "h2", text: "Seçerken dikkat" },
      {
        type: "p",
        text: "Alçak kanepeye kalkmak her yaşta kolay olmayabilir. Oturum yüksekliğini ve sırt desteğini deneyerek ya da ölçüleri karşılaştırarak seçin. Dolgu türü şekli korumayı belirler.",
      },
    ],
  },
  "uygun-fiyatli-mobilya-nereden": {
    lead: "Ev döşerken bütçeyi korumak için nereye bakılacağı, nelere dikkat edileceği ve hangi yöntemlerin işe yaradığı.",
    blocks: [
      {
        type: "p",
        text: "Ev döşemek pahalı olabilir, ama doğru sırayla ve doğru yerlerden ilerlemek maliyeti düşürür.",
      },
      { type: "h2", text: "Nereye bakmalı?" },
      {
        type: "ul",
        items: [
          "Kampanya dönemlerinde büyük mağaza zincirleri",
          "İkinci el ve yenilenmiş mobilya pazarları",
          "Yerel atölyeler ve üretici satışları",
          "Fiyat karşılaştırma araçları",
        ],
      },
      { type: "h2", text: "Pratik yöntemler" },
      {
        type: "ul",
        items: [
          "Önce en çok kullanacağınız parçalara bütçe ayırın",
          "Ölçüsüz alışveriş yapmayın",
          "Toplam fiyata teslimat ve montajı ekleyin",
        ],
      },
    ],
  },
  "eames-sandalye-muadilleri": {
    lead: "Çok kopyalanan klasik sandalyelerin benzerlerini dayanıklılık ve malzeme açısından karşılaştırma rehberi.",
    blocks: [
      {
        type: "p",
        text: "Klasik tasarım sandalyelerin benzerleri piyasada çok. Aralarındaki fark çoğunlukla bir yıl kullanımdan sonra ortaya çıkar.",
      },
      { type: "h2", text: "Dayanıklılık ölçütleri" },
      {
        type: "ul",
        items: [
          "Kabuk malzemesi: kalınlığı ve çatlamaya karşı direnci",
          "Ayaklar: ahşap ya da metal bağlantıların sağlamlığı",
          "Sallanma ve gıcırtı: ilk günden test edilmeli",
          "Renk solması: güneş ve temizlik ürünleri sonrası",
        ],
      },
      {
        type: "p",
        text: "Ortak kullanım alanında (yemek odası) sağlam bağlantılı modelleri, dekoratif köşede ise daha uygun fiyatlıları tercih edebilirsiniz.",
      },
    ],
  },
  "bogg-bag-muadilleri": {
    lead: "Plaj ve havuz çantası olarak kullanılan kauçuk tote çantaların benzerlerini seçerken bakılacak noktalar.",
    blocks: [
      {
        type: "p",
        text: "Su geçirmez, yıkanabilir ve ayakta duran bir plaj çantası ihtiyaç hâline geldi. Benzer çantalar da çok. Seçerken günlük kullanıma uyan özellikleri ayırın.",
      },
      { type: "h2", text: "Neye bakmalı?" },
      {
        type: "ul",
        items: [
          "Malzeme: esnek ama sağlam kauçuk ya da EVA köpük",
          "Taşıma kapasitesi: iç hacim ve sap dayanımı",
          "Kapama: fermuar, kopça ya da açık ağız",
          "Drenaj: suyun tahliye edilebildiği delikler",
        ],
      },
      {
        type: "p",
        text: "Güneşte uzun süre kalacaksa renk solması ve kokuya dayanıklılığı kontrol edin.",
      },
    ],
  },
  "dyson-airwrap-muadilleri": {
    lead: "Çok amaçlı saç şekillendirme cihazlarını karşılaştırırken ısı, aksesuar ve güvenlik ölçütleri.",
    blocks: [
      {
        type: "p",
        text: "Hem kurutan hem şekillendiren cihazlar saç bakımını kolaylaştırıyor. Fiyat farkı büyük olduğundan alternatifleri dikkatle değerlendirmek gerekir.",
      },
      { type: "h2", text: "Karşılaştırma ölçütleri" },
      {
        type: "ul",
        items: [
          "Isı kontrolü: sabit ya da ayarlanabilir sıcaklık",
          "Aksesuarlar: kıvırma, düzleştirme ve hacim başlıkları",
          "Güç ve gürültü düzeyi",
          "Garanti ve servis ağı",
        ],
      },
      {
        type: "callout",
        title: "Güvenlik",
        text: "Elektrikli cihazlarda CE işareti ve yetkili satıcıyı kontrol edin.",
      },
    ],
  },
  "lululemon-tayt-muadilleri": {
    lead: "Yumuşak, esnek ve yerinde duran spor taytların benzerlerini kumaş ve dikiş açısından seçmenin yolları.",
    blocks: [
      {
        type: "p",
        text: "İyi bir tayt hafif, esnek ve belde sabit durur. Farklı markalar benzer hissi sunabilir.",
      },
      { type: "h2", text: "Kumaş ve kesim" },
      {
        type: "ul",
        items: [
          "Kumaş karışımı: naylon ve elastan oranı esnekliği belirler",
          "Şeffaflık testi: eğilince kumaşın içini göstermemesi",
          "Bel yapısı: kaymayan, kıvrılmayan geniş bel",
          "Dikiş türü: sürtünmeyi azaltan düz dikiş",
        ],
      },
      {
        type: "p",
        text: "Birkaç yıkama sonrası boncuklanma ve şekil kaybı tayt kalitesini gösterir; yorumlara bu açıdan bakın.",
      },
    ],
  },
  "mobilyayi-pahali-gosteren-9-detay": {
    lead: "Mobilyanın daha lüks görünmesini sağlayan dokuz ayrıntı: ölçü, malzeme, ayak, kenar ve aydınlatma.",
    blocks: [
      {
        type: "p",
        text: "Pahalı görünüm çoğu zaman etiket fiyatından değil, ayrıntılardan gelir.",
      },
      { type: "h2", text: "Dokuz ayrıntı" },
      {
        type: "ul",
        items: [
          "Oran: parçanın odanın ölçüsüne uygun olması",
          "Malzeme tutarlılığı: aynı ahşap ya da metal tonu",
          "Kenar işçiliği: düzgün ve yuvarlatılmış köşeler",
          "Ayak detayı: kaliteli ayaklar parçayı yükseltir",
          "Kumaş dokusu: düz ve dolgun",
          "Donanım: kulp ve menteşe",
          "Boya ve cila: pürüzsüz yüzey",
          "Aydınlatma: sıcak ve yumuşak ışık",
          "Düzen: az ama bilinçli parça",
        ],
      },
    ],
  },
  "bilincli-harcama-luks-stil": {
    lead: "Bütçeyi aşmadan şık bir ev ve gardırop kurmak için bilinçli harcama alışkanlıkları.",
    blocks: [
      {
        type: "p",
        text: "Lüks his, çok harcamaktan çok doğru seçmekten gelir. Bilinçli harcama; neye ihtiyacınız olduğunu, neyi sevdiğinizi ve neye değer vereceğinizi bilmektir.",
      },
      { type: "h2", text: "Beş alışkanlık" },
      {
        type: "ul",
        items: [
          "Almadan önce bekleyin: beğendiğiniz ürünü birkaç gün sonra yeniden değerlendirin",
          "Kullanım başına maliyeti hesaplayın",
          "Fiyatları karşılaştırın ve fiyat geçmişine bakın",
          "Az sayıda ama uyumlu parça seçin",
          "Alışveriş listesi tutun",
        ],
      },
      {
        type: "callout",
        title: "Kural",
        text: "Bir ürünü en az otuz kez kullanacağınızı düşünüyorsanız yatırım yapmaya değer.",
      },
    ],
  },
  "alaia-file-babet-muadilleri": {
    lead: "File ve delikli babet ayakkabıların benzerlerini rahatlık, malzeme ve fiyat açısından seçmenin yolları.",
    blocks: [
      {
        type: "p",
        text: "File babetler ayakkabıya hafif ve zarif bir görünüm katıyor. Benzer modellerde dikkat edilecek en önemli konu rahatlıktır.",
      },
      { type: "h2", text: "Neye bakmalı?" },
      {
        type: "ul",
        items: [
          "Taban: esnek ama destekleyici bir taban",
          "İç astar: sürtünmeyi azaltan yumuşak malzeme",
          "File yapısı: ayağı kesmeyen, esneyen örgü",
          "Beden ve kalıp: dar kalıplar genelde yarım numara büyük istenir",
        ],
      },
      {
        type: "p",
        text: "İlk kullanımda kısa mesafeyle başlayın; yeni ayakkabı sürtünme yapabilir.",
      },
    ],
  },
};
