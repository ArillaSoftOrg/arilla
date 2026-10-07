import type { Article } from "./types.ts";

/** Hero yazi: bulut kanepe alternatifleri rehberi. Ozgun metin; editor incelemesi bekler. */
export const HERO_ARTICLE: Article = {
  lead: "Derin, yumuşak ve dolgun oturuşlu bulut kanepelerin benzerlerini nasıl karşılaştıracağınızı, hangi ölçütlerin fiyat farkını açıkladığını anlatan rehber.",
  blocks: [
    {
      type: "p",
      text: "Bulut kanepe diye anılan model, yumuşak ve derin oturuşuyla bir ev dekorasyonu klasiği oldu. Fiyatı ise çoğu bütçenin üstünde kalıyor. İyi haber şu: aynı hissi veren seçenekler var, ancak hepsi aynı şeyi vaat etmiyor. Bu rehberde benzer kanepeleri hangi ölçütlere bakarak karşılaştıracağınızı anlatıyoruz.",
    },
    { type: "h2", text: "Önce neyi arıyorsunuz?" },
    {
      type: "p",
      text: "Bulut kanepenin çekiciliği tek bir özellikten gelmiyor. Geniş ve alçak oturum, kabarık minderler, yumuşak bir kumaş ve modüler yapı birlikte o havayı kuruyor. Alternatif ararken ilk iş, bunlardan hangisinin sizin için vazgeçilmez olduğunu belirlemek.",
    },
    {
      type: "ul",
      items: [
        "Oturma hissi: derin ve yumuşak mı, yoksa destekli ve toparlayıcı mı tercih ediyorsunuz?",
        "Görünüm: hacimli, yuvarlak hatlı bir siluet mi, yoksa sadece rahatlık mı önemli?",
        "Kullanım: günlük oturma, uzanma ya da misafir ağırlama; her biri farklı sertlik ister.",
      ],
    },
    { type: "h2", text: "Karşılaştırırken bakılacak sekiz başlık" },
    {
      type: "p",
      text: "İki kanepe fotoğrafta aynı görünebilir; farkı detaylar yaratır. Fiyat farkının neye değdiğini anlamak için şu başlıkları yan yana koyun:",
    },
    {
      type: "ul",
      items: [
        "Dolgu: elyaf, sünger ya da tüy-elyaf karışımı oturuş hissini ve zamanla çökmeyi belirler.",
        "Kumaş: dokunuş, leke tutma ve aşınma direnci. Yumuşak kumaşlar çoğu zaman daha hassastır.",
        "İskelet: kurutulmuş masif ahşap ve sağlam birleşimler uzun ömür demektir.",
        "Derinlik: oturum derinliği boyunuza ve nasıl oturduğunuza uymalı.",
        "Modülerlik: parçaları yeniden düzenleyebilmek taşınma ve oda değişiminde işinize yarar.",
        "Kılıf: çıkarılıp yıkanabilen kılıf, bakım maliyetini düşürür.",
        "Garanti: iskelet ve dolgu için verilen süre, üreticinin güvenini gösterir.",
        "Teslimat: kapıdan, asansörden ve merdivenden geçip geçmediğini önceden ölçün.",
      ],
    },
    {
      type: "callout",
      title: "Hızlı kural",
      text: "Fiyat farkı büyükse nedeni iskelet ve dolgudadır. Fotoğrafta görünmeyen bu iki kalem, bir yıl sonra kanepenin nasıl durduğunu belirler.",
    },
    { type: "h2", text: "Fiyat farkı neye değer?" },
    {
      type: "p",
      text: "Daha uygun fiyatlı bir alternatif her zaman daha kötü demek değil; ama her şeyin aynı olması da beklenmemeli. Genellikle fark dolgunun kalitesinde, kumaşın dayanıklılığında ve garantide ortaya çıkar. Sık kullanılan ana oturma grubu için bu kalemlere yatırım yapmak mantıklıdır. Nadiren kullanılan bir köşe için ise daha sade bir seçenek yeterli olabilir.",
    },
    { type: "h2", text: "Karar vermeden önce kontrol listesi" },
    {
      type: "ul",
      items: [
        "Ölçüleri kağıda dökün: koltuğun genişliği ve derinliği odanıza uyuyor mu?",
        "Kumaş numunesi isteyin; ışıkta ve elinizde nasıl hissettirdiğine bakın.",
        "İade ve değişim koşullarını mağazanın sayfasından okuyun.",
        "Aynı modeli birkaç mağazada karşılaştırın; fiyatlar zamanla değişir.",
      ],
    },
    { type: "h2", text: "Sonuç" },
    {
      type: "p",
      text: "Aradığınız his derin ve yumuşak oturuşsa, ölçütleri baştan belirlemek hem bütçenizi hem de pişmanlık riskinizi azaltır. ManiCepte ile benzer kanepeleri fiyat, dolgu ve garanti başlıklarında yan yana görerek karar verebilirsiniz.",
    },
  ],
};
