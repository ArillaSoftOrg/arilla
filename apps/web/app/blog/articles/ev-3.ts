import type { Article } from "./types.ts";

/** Ozgun taslak metinler (karar 0071). Editor ekibi tek tek gozden gecirecek. */
export const EV_3: Readonly<Record<string, Article>> = {
  "2026-ev-ve-moda-trendleri": {
    lead: "Ev ve modada öne çıkan yedi eğilim ve bunları bütçeyi zorlamadan evinize ve gardırobunuza taşımanın yolları.",
    blocks: [
      {
        type: "p",
        text: "Trendleri izlemek, hepsini uygulamak anlamına gelmez. Hangisinin size uyduğunu seçin, sonra uygun fiyatlı bir karşılığını arayın.",
      },
      { type: "h2", text: "Yedi eğilim" },
      {
        type: "ul",
        items: [
          "Heykelsi mobilya: yumuşak, organik formlar",
          "Sessiz lüks: logosuz, kaliteli ve sade parçalar",
          "Toprak tonları: sıcak ve doğal renk paleti",
          "Doğal malzeme: ahşap, taş, keten",
          "Vintage ve el yapımı dokunuşlar",
          "Katmanlı aydınlatma",
          "Çok amaçlı mobilya",
        ],
      },
      {
        type: "p",
        text: "Her eğilim için önce bir parça seçin: bir yastık, bir lamba ya da bir ceket. Beğenirseniz devam edin.",
      },
    ],
  },
  "orijinal-mi-benzer-mi": {
    lead: "Orijinal ürün ile benzer alternatif arasındaki gerçek maliyet farkını kullanım başına maliyetle karşılaştırma rehberi.",
    blocks: [
      {
        type: "p",
        text: "Daha pahalı olan her zaman daha iyi değildir; ama daha uygun fiyatlı olan da her zaman daha akıllıca değildir. Karar, ürünün nasıl kullanılacağına bağlıdır.",
      },
      { type: "h2", text: "Orijinal ne zaman mantıklı?" },
      {
        type: "ul",
        items: [
          "Her gün kullanılan ve yıllarca dayanması beklenen parçalar",
          "İkinci el değeri yüksek ürünler",
          "Güvenlik ya da sağlık gerektiren ürünler",
        ],
      },
      { type: "h2", text: "Alternatif ne zaman yeterli?" },
      {
        type: "ul",
        items: [
          "Mevsimlik ve dekoratif parçalar",
          "Denemek istediğiniz tarzlar",
          "Kısa süreli kullanım",
        ],
      },
      {
        type: "callout",
        title: "Kullanım başına maliyet",
        text: "Fiyatı, ürünü kaç kez kullanacağınıza bölün. Sık kullanılan bir ürünün pahalı olması çoğu zaman bu hesapta kendini ödeyebilir.",
      },
    ],
  },
  "chatgpt-ile-akilli-alisveris": {
    lead: "Bir yapay zekâ asistanı ile ürün arama, alternatif bulma ve karşılaştırma adımlarına genel bakış.",
    blocks: [
      {
        type: "p",
        text: "Asistanlarla alışveriş araştırması yaparken sorunuzu net kurmak sonucu belirler.",
      },
      { type: "h2", text: "İyi bir arama nasıl yapılır?" },
      {
        type: "ul",
        items: [
          "Ürünü, bütçeyi ve ölçüyü birlikte yazın",
          "Beğendiğiniz ürünün fotoğrafını ya da bağlantısını verin",
          "Karşılaştırmak istediğiniz özellikleri belirtin",
        ],
      },
      {
        type: "p",
        text: "Sonuçlardaki fiyat ve stok bilgisini mağaza sayfasında doğrulamak her zaman iyi bir alışkanlıktır.",
      },
    ],
  },
  "emin-alisverisci-cercevesi": {
    lead: "Pişmanlığı azaltan, tekrarlanabilir bir alışveriş karar çerçevesi: ihtiyaç, araştırma, karşılaştırma ve bekleme.",
    blocks: [
      {
        type: "p",
        text: "Her alışverişte aynı dört soruyu sormak karar vermeyi hızlandırır ve pişmanlığı azaltır.",
      },
      { type: "h2", text: "Dört soru" },
      {
        type: "ul",
        items: [
          "İhtiyaç: Bunu gerçekten kullanacak mıyım?",
          "Araştırma: Başka seçenekler neler?",
          "Karşılaştırma: Fiyat, kalite ve iade koşulları nasıl?",
          "Bekleme: Üç gün sonra hâlâ istiyor muyum?",
        ],
      },
      { type: "h2", text: "Ne zaman biriktirmeli, ne zaman harcamalı?" },
      {
        type: "p",
        text: "Sık kullanılan ve uzun ömürlü ürünlerde kaliteye harcayın. Hızla eskiyen ya da modası geçen ürünlerde tasarruf edin.",
      },
    ],
  },
  "muadil-urun-nedir": {
    lead: "Muadil, benzer ve ilham alan ürün kavramları arasındaki farklar ve yüksek kaliteli alternatiflerin nasıl bulunacağı.",
    blocks: [
      {
        type: "p",
        text: "Muadil ürün, bir başka ürünle aynı ihtiyacı karşılayan ve benzer işlev ya da görünüm sunan üründür. Taklit ya da sahte ürünle karıştırılmamalıdır.",
      },
      { type: "h2", text: "Üç farklı kavram" },
      {
        type: "ul",
        items: [
          "Muadil ya da alternatif: kendi markasıyla satılan, benzer işlev sunan ürün",
          "İlham alan ürün: genel tarzı paylaşır, tasarımı ve markası kendine aittir",
          "Sahte ürün: markayı ya da logoyu kopyalar; yasa dışıdır",
        ],
      },
      { type: "h2", text: "Kaliteli alternatif nasıl bulunur?" },
      {
        type: "ul",
        items: [
          "Malzeme ve işçilik bilgisini okuyun",
          "Kullanıcı yorumlarına bakın",
          "Mağazanın iade koşullarını kontrol edin",
          "Fiyat geçmişine bakın",
        ],
      },
    ],
  },
  "yeni-uygulama-neler-sunuyor": {
    lead: "ManiCepte'nin ürün arama, alternatif bulma ve fiyat karşılaştırma yaklaşımına kısa bir tanıtım.",
    blocks: [
      {
        type: "p",
        text: "Alışveriş araştırması çoğu zaman onlarca sekme açmak demektir. ManiCepte bunu tek yerde toplar: fotoğraf, bağlantı ya da kendi sözlerinizle arayın, benzer ürünleri farklı mağazalarda karşılaştırın.",
      },
      { type: "h2", text: "Neler yapabilirsiniz?" },
      {
        type: "ul",
        items: [
          "Fotoğraftan ya da ürün bağlantısından benzer ürün aramak",
          "Aynı ürünü farklı mağazalarda karşılaştırmak",
          "Daha uygun fiyatlı alternatifleri görmek",
        ],
      },
    ],
  },
  "akilli-alisverisci-mobilya-rehberi": {
    lead: "Mobilyada fiyatlandırma mantığını anlayarak fazla ödemeden alışveriş yapmanın yolları.",
    blocks: [
      {
        type: "p",
        text: "Benzer görünen iki mobilya arasında büyük fiyat farkı olabilir. Farkın nedenini anlamak, nerede tasarruf edeceğinizi gösterir.",
      },
      { type: "h2", text: "Fiyatı neler belirler?" },
      {
        type: "ul",
        items: [
          "Marka ve tasarımcı payı",
          "Malzeme ve iskelet kalitesi",
          "Satış kanalı: mağaza kirası ve aracılar",
          "Garanti ve servis",
        ],
      },
      {
        type: "p",
        text: "Aynı ürünü ya da benzerini farklı mağazalarda karşılaştırmak çoğu zaman en kolay tasarruf yoludur.",
      },
    ],
  },
  "uygun-fiyatli-luksun-sanati": {
    lead: "Uygun fiyatla şık bir ev ve gardırop kurmanın ilkeleri: seçici olmak, kaliteyi ayırt etmek ve uyumlu parçalar almak.",
    blocks: [
      {
        type: "p",
        text: "Lüks görünüm pahalı olmak zorunda değil. Renk uyumu, doğru ölçü ve kaliteli malzeme çoğu zaman etiketten daha belirleyicidir.",
      },
      { type: "h2", text: "İlkeler" },
      {
        type: "ul",
        items: [
          "Az parça, uyumlu palet",
          "Doku ve malzemeye öncelik verin",
          "Aydınlatmayı ihmal etmeyin",
          "Parçaları birlikte düşünün: ev ve gardırop aynı sakin dili taşısın",
        ],
      },
    ],
  },
};
