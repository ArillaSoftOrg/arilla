import type { Article } from "./types.ts";

/** Ozgun taslak metinler (karar 0071). Editor ekibi tek tek gozden gecirecek. */
export const EV_1: Readonly<Record<string, Article>> = {
  "acik-ev-sezonu": {
    lead: "Sonbaharda misafir ağırlamak için masa düzeninden konuk odasına kadar elinizin altında olması gereken parçaların oda oda listesi.",
    blocks: [
      {
        type: "p",
        text: "Misafir sezonu başlarken evin her köşesini yeniden almak gerekmez. Birkaç doğru parça, hem sofrayı hem konuk odasını toparlar. Listeyi oda oda ilerleterek hazırladık.",
      },
      { type: "h2", text: "Masa ve sofra" },
      {
        type: "ul",
        items: [
          "Yıkanabilir, ütü gerektirmeyen bir masa örtüsü ve kumaş peçeteler",
          "Sekiz kişiye yetecek, birbiriyle uyumlu servis tabakları",
          "Büyük bir servis tepsisi ve iki ahşap servis tahtası",
          "Su ve içecek için cam sürahi",
        ],
      },
      { type: "h2", text: "Salon" },
      {
        type: "p",
        text: "Oturma alanında yeterli yan masa, bardak altlığı ve misafirlerin üstüne alabileceği hafif bir battaniye düşünün. Işığı yumuşatan bir abajur, tavan lambasından çok daha davetkâr durur.",
      },
      { type: "h2", text: "Konuk odası" },
      {
        type: "ul",
        items: [
          "İki takım temiz nevresim ve ekstra yastık",
          "Yatak yanında küçük bir lamba ve su bardağı",
          "Katlanabilir bir bavul sehpası",
          "Boş bırakılmış birkaç askı ve kapı arkası askılığı",
        ],
      },
      {
        type: "callout",
        title: "Küçük ipucu",
        text: "Her şeyi aynı anda almayın. Önce sofra, sonra konuk odası; ihtiyacınızı ilk misafirden sonra netleştirin.",
      },
    ],
  },
  "serena-lily-bar-tabureleri": {
    lead: "Hasır ve doğal dokulu sahil tarzı bar taburelerinin benzerlerini hangi ölçütlerle karşılaştıracağınızı anlatan rehber.",
    blocks: [
      {
        type: "p",
        text: "Hasır örgülü bar tabureleri, mutfağa sahil evi havası katmanın en kolay yolu. Fiyat farkı ise çoğunlukla malzeme ve işçilikten gelir. Alternatiflere bakarken şunları kontrol edin.",
      },
      { type: "h2", text: "Malzeme ve örgü" },
      {
        type: "p",
        text: "Gerçek rattan, kamış ve sentetik hasır farklı davranır. Gerçek malzeme sıcak bir görünüm verir ama nemden etkilenebilir. Sentetik örgü ise bakım açısından daha rahattır; dış mekânda da kullanılabilir.",
      },
      { type: "h2", text: "Yükseklik ölçüsü" },
      {
        type: "ul",
        items: [
          "Tezgâh yüksekliği için oturum yüksekliği genellikle 60-65 cm aralığında aranır",
          "Bar yüksekliği daha yüksek tabure ister",
          "Tabure ile tezgâh arasında yaklaşık 25-30 cm boşluk bırakın",
        ],
      },
      {
        type: "p",
        text: "Sırt desteği, ayak dayama çubuğunun konumu ve minder olup olmaması günlük rahatlığı belirler. Dar mutfakta sırtsız modeller yer kazandırır.",
      },
    ],
  },
  "orijinal-teddy-kanepe": {
    lead: "Çok kopyalanan bir kanepede orijinali ve benzerleri ayırt etmenin yolları: kumaş, dikiş, iskelet ve garanti.",
    blocks: [
      {
        type: "p",
        text: "Bir tasarım çok sevildiğinde piyasa kısa sürede onun benzeriyle dolar. Sonunda hangisinin orijinal, hangisinin ilham alan bir model olduğunu anlamak zorlaşır. Karar vermeden önce bakılacak noktaları sıraladık.",
      },
      { type: "h2", text: "Orijinali ayırt etmek" },
      {
        type: "ul",
        items: [
          "Resmî satıcı ve etiket: marka kendi mağaza listesini yayınlar",
          "Kumaş dokusu: bukle ya da peluş doku yakından bakınca düzenli olmalı",
          "Dikiş: kıvrımlarda ve minder kenarlarında düzgün, sık dikiş",
          "Garanti belgesi ve seri bilgisi",
        ],
      },
      { type: "h2", text: "Benzer model seçerken" },
      {
        type: "p",
        text: "İlham alan bir model, orijinalin markasını ya da logosunu taklit etmemeli. Bunun yerine form ve doku benzerliği sunan, kendi adıyla satılan ürünler güvenli tercihtir.",
      },
      {
        type: "callout",
        title: "Neden önemli?",
        text: "Marka taklidi hem hukuki risk taşır hem de kalite konusunda güvence vermez. İlham alan ama kendi markasıyla satılan ürün, daha az risklidir.",
      },
    ],
  },
  "sonbahar-moda-sezonu": {
    lead: "Sonbahar sezonunun öne çıkan trendleri ve her birinin daha uygun fiyatlı karşılığını nasıl bulacağınıza dair rehber.",
    blocks: [
      {
        type: "p",
        text: "Defile trendlerinin hepsi gardıroba girmek zorunda değil. Hangilerinin kalıcı olacağını ayırıp bunlar için akıllı alternatifler bulmak bütçeyi korur.",
      },
      { type: "h2", text: "Trendleri ayırmak" },
      {
        type: "ul",
        items: [
          "Kalıcı parçalar: kaliteli ceket, deri görünümlü çanta, düz kesim pantolon",
          "Geçici parçalar: aşırı desenli, yalnızca bu sezona özgü detaylar",
          "Deneme parçaları: küçük aksesuarlar ve eşarplar",
        ],
      },
      { type: "h2", text: "Uygun fiyatlı karşılık nasıl bulunur?" },
      {
        type: "p",
        text: "Önce parçanın hangi özelliği sizi çekiyor, ona karar verin: kesim, renk mi, kumaş mı? Sonra aynı kesimi ve rengi sunan alternatifleri karşılaştırın. Kumaş bileşimi ve astar kalitesi fiyat farkının nedenini gösterir.",
      },
    ],
  },
  "isci-bayrami-mobilya-indirimleri": {
    lead: "Kampanya dönemlerinde mobilya indirimlerinin gerçek mi göz boyayıcı mı olduğunu anlamak için pratik bir kontrol listesi.",
    blocks: [
      {
        type: "p",
        text: "Kampanya dönemlerinde etiketteki yüzde ile gerçek tasarruf aynı şey olmayabilir. İndirimin gerçek olup olmadığını anlamak için fiyat geçmişine bakmak en güvenilir yoldur.",
      },
      { type: "h2", text: "Gerçek indirimi anlamak" },
      {
        type: "ul",
        items: [
          "Aynı ürünün son aylardaki fiyatını kontrol edin",
          "Aynı modeli birkaç mağazada karşılaştırın",
          "Teslimat, montaj ve iade maliyetini toplam fiyata ekleyin",
          "İndirimden hariç tutulan kalemleri okuyun",
        ],
      },
      { type: "h2", text: "Kaçınılması gerekenler" },
      {
        type: "p",
        text: "Acele ettiren geri sayım sayaçları ve 'son birkaç adet' uyarıları karar vermeyi zorlaştırır. Planınızda olmayan bir parçayı sadece indirimde diye almayın.",
      },
      {
        type: "callout",
        title: "Fiyat geçmişi",
        text: "ManiCepte fiyat geçmişini kaydeder; indirimin gerçekten düşüş olup olmadığını bu sayede görebilirsiniz.",
      },
    ],
  },
  "mackenzie-childs-taklitleri": {
    lead: "Kareli seramik ve emaye görünümünü daha uygun fiyatla yakalamak için malzeme, desen ve kullanım ipuçları.",
    blocks: [
      {
        type: "p",
        text: "Siyah-beyaz kareli desen, altın detaylı çaydanlıklar ve emaye parçalar mutfağa karakter katıyor. Bu görünümü başka yollarla da kurabilirsiniz.",
      },
      { type: "h2", text: "Görünümü oluşturan öğeler" },
      {
        type: "ul",
        items: [
          "Kareli (damalı) desen: büyük ve küçük karelerin dengesi",
          "Parlak sır ve kenarlarda altın ya da pirinç detay",
          "Emaye yüzey: dayanıklı ama çarpmaya hassas",
        ],
      },
      { type: "h2", text: "Hangi parçayı seçmeli?" },
      {
        type: "p",
        text: "Günlük kullanılan parçalarda (fincan, tabak) dayanıklılığa bakın. Sadece sergilenecek parçalarda (vazo, çaydanlık) görünüm öne çıkar; burada fiyat avantajı sağlamak daha kolaydır.",
      },
      {
        type: "p",
        text: "Hepsini aynı desenle almak yerine bir iki kareli parçayı düz renklerle dengelemek hem bütçeyi hem görsel dengeyi korur.",
      },
    ],
  },
  "louis-vuitton-taklit-cantalari": {
    lead: "Monogramlı lüks çantaların silüetinden ilham alan, marka ve logo kopyalamayan alternatifleri değerlendirmek için bir çerçeve.",
    blocks: [
      {
        type: "p",
        text: "Monogramlı çantalar ilk bakışta tanınır. Aynı silüeti uygun fiyatla yakalamak mümkün, ancak logo ve marka kopyalayan ürünlerden uzak durmak gerekir.",
      },
      { type: "h2", text: "İlham ile kopya arasındaki çizgi" },
      {
        type: "p",
        text: "Silüet, renk ve genel hava serbesttir; marka adı, logo ve tescilli monogram ise değildir. Kendi markasıyla satılan ve desenini kendi tasarlayan çantalar güvenli tarafta kalır.",
      },
      { type: "h2", text: "Çanta seçerken bakılacaklar" },
      {
        type: "ul",
        items: [
          "Malzeme: gerçek deri, kaplamalı kanvas ya da sentetik",
          "Dikiş ve kenar boyası: kenar işçiliği kaliteyi gösterir",
          "Donanım: fermuar ve metal parçaların ağırlığı ve dayanıklılığı",
          "İç yapı: astar ve cep düzeni",
        ],
      },
      {
        type: "callout",
        title: "Uyarı",
        text: "Marka logosunu taşıyan 'benzer' ürünler sahtedir ve ticari marka haklarını ihlal eder. Böyle ürünleri listelemeyiz.",
      },
    ],
  },
  "rhode-glazing-milk-rakipleri": {
    lead: "Cildi hazırlayan, süt dokulu nemlendirici tonik ve esans ürünlerini içerik açısından karşılaştırmak için rehber.",
    blocks: [
      {
        type: "p",
        text: "Süt dokulu tonik ve esanslar cildi nemlendirip sonraki adımlara hazırlıyor. Benzer ürün ararken etiketteki içerik listesi, marka adından daha çok şey söyler.",
      },
      { type: "h2", text: "İçeriğe bakın" },
      {
        type: "ul",
        items: [
          "Nem tutucular: gliserin, hyaluronik asit gibi bileşenler",
          "Yatıştırıcılar: pantenol, centella gibi içerikler",
          "Kokulu ya da alkollü formüller hassas ciltte tahriş yapabilir",
        ],
      },
      { type: "h2", text: "Ürünü deneme" },
      {
        type: "p",
        text: "Yeni bir ürünü önce kolun iç kısmında deneyin. Cilt tipinizi bilmiyorsanız bir uzmana danışın. Bu yazı tıbbi öneri değildir.",
      },
    ],
  },
  "baccarat-rouge-540-muadilleri": {
    lead: "Çok tanınan bir parfümün benzerlerini koku ailesi, nota yapısı ve kalıcılık açısından nasıl değerlendireceğinizi anlatan rehber.",
    blocks: [
      {
        type: "p",
        text: "Bir parfümün benzerini aramak, kokunun ne anlattığını anlamakla başlar. Etiketteki 'benzer' ibaresine değil, nota piramidine ve gerçek denemeye güvenin.",
      },
      { type: "h2", text: "Koku yapısını anlamak" },
      {
        type: "p",
        text: "Orijinal kokunun çiçeksi, amber ve odunsu karakterleri öne çıkar. Benzer ararken aynı koku ailesinden gelen ürünlere bakın; üst, orta ve alt notaların uyumu yakınlığı gösterir.",
      },
      { type: "h2", text: "Karşılaştırma ölçütleri" },
      {
        type: "ul",
        items: [
          "Nota yakınlığı: üst, orta ve alt notalar",
          "Kalıcılık: ciltte ve kumaşta kaç saat kaldığı",
          "Yayılım: etrafa ne kadar koku bıraktığı",
          "Fiyat ve mililitre başına maliyet",
        ],
      },
      {
        type: "callout",
        title: "Denemeden alma",
        text: "Koku kişiden kişiye değişir. Mümkünse minik boy ya da numune ile başlayın.",
      },
    ],
  },
  "evinizin-tamamini-doseme": {
    lead: "Sevdiğiniz parçaları benzer ürünlerle tamamlayarak evi bütçeyi aşmadan adım adım döşemenin yolu.",
    blocks: [
      {
        type: "p",
        text: "Beğendiğiniz her parçanın orijinalini almak zorunda değilsiniz. Evi, öncelik sırasına göre benzer ürünlerle kurmak hem bütçeyi hem zamanı rahatlatır.",
      },
      { type: "h2", text: "Adım adım plan" },
      {
        type: "ul",
        items: [
          "Önce ölçüleri alın ve odaları öncelik sırasına dizin",
          "Büyük parçalar (kanepe, yatak) için bütçe ayırın",
          "Küçük parçaları (aydınlatma, tekstil) ikinci aşamaya bırakın",
          "Her oda için bir renk paleti belirleyin",
        ],
      },
      { type: "h2", text: "Nerede tasarruf, nerede yatırım?" },
      {
        type: "p",
        text: "Her gün kullanılan ve yıpranan parçalarda kaliteye yatırım yapın. Dekoratif ve mevsimlik parçalarda ise uygun fiyatlı alternatifler iş görür.",
      },
      {
        type: "p",
        text: "ManiCepte'de beğendiğiniz ürünün benzerlerini fiyat ve mağaza bazında karşılaştırarak her adımda en uygun seçeneği bulabilirsiniz.",
      },
    ],
  },
};
