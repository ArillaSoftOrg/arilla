/**
 * Sohbete fotograf eklemeden once gosterilen bilgilendirme ve acik riza metni
 * (karar 0101; docs/copy.md "Sohbette fotograf izni"). Metin degisince
 * `CHAT_IMAGE_CONSENT_VERSION` (packages/core/src/chat/image-consent.ts) birlikte
 * guncellenir: eski surume verilmis riza gecersiz sayilir ve yeniden sorulur.
 *
 * YALNIZCA kodun gercekte yaptigi seyler yazilir. Hukuk onayi bekleyen beyanlar
 * (aktarim dayanagi, model egitimi, saglayici saklama suresi) burada YOKTUR.
 */
export const CHAT_IMAGE_CONSENT_COPY = {
  title: "Fotoğrafını kullanmamız için iznin gerekiyor",
  intro: "Seçtiğin fotoğraf, sen Gönder'e basana kadar cihazından çıkmaz.",
  points: [
    "Gönderdiğinde fotoğraf sunucumuzda küçültülür; konum gibi üst bilgileri silinir.",
    "Aradığın ürünü anlamak için fotoğraf Google'ın Gemini yapay zekâ hizmetine gönderilir. Bu, verinin yurt dışına aktarılması anlamına gelebilir.",
    "Fotoğraf sohbetinle birlikte saklanır, yalnızca sen görebilirsin. En geç 90 gün sonra ya da hesabını sildiğinde silinir.",
    "Başka kişilerin yer aldığı veya kimlik, kart, adres gibi kişisel bilgi içeren fotoğraf yükleme.",
  ],
  withdraw:
    "İznini istediğin zaman Hesabım > Gizlilik tercihleri sayfasından geri çekebilirsin. Geri çekmen yeni fotoğraf eklemeni durdurur.",
  detailsLabel: "KVKK Aydınlatma Metni",
  detailsHref: "/kvkk-aydinlatma",
  accept: "Fotoğrafımın bu şekilde kullanılmasını kabul ediyorum",
  decline: "Kabul etmiyorum",
  saveError: "İznin kaydedilemedi. Biraz sonra tekrar dener misin?",
  declined: "Fotoğraf eklenmedi. Metinle sohbet etmeye devam edebilirsin.",
  settingsTitle: "Sohbette fotoğraf kullanımı",
  settingsDescription:
    "Sohbete eklediğin fotoğrafın işlenmesine izin verdin. İzni geri çekersen yeni fotoğraf ekleyemezsin; mevcut sohbetlerdeki fotoğraflar sohbetle birlikte silinir.",
  settingsWithdraw: "İznimi geri çek",
  settingsWithdrawn: "İznin geri çekildi. Fotoğraf eklerken yeniden sorulur.",
} as const;
