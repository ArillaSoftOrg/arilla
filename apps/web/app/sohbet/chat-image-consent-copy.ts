/**
 * Sohbete fotograf eklerken gosterilen kisa, satir ici bilgilendirme ve acik riza
 * metni (karar 0101, 0105; docs/copy.md "Sohbette fotograf izni"). Metin degisince
 * `CHAT_IMAGE_CONSENT_VERSION` (packages/core/src/chat/image-consent.ts) birlikte
 * guncellenir: eski surume verilmis riza gecersiz sayilir ve yeniden sorulur.
 *
 * YALNIZCA kodun gercekte yaptigi seyler yazilir. Hukuk onayi bekleyen beyanlar
 * (aktarim dayanagi, model egitimi, saglayici saklama suresi) burada YOKTUR.
 */
export const CHAT_IMAGE_CONSENT_COPY = {
  title: "Fotoğrafı eklemek için iznin gerekiyor",
  summary:
    "Gönder'e basana kadar fotoğraf cihazından çıkmaz. Gönderince sunucumuzda küçültülür, konum gibi üst bilgileri silinir ve aradığın ürünü anlamak için Google'ın Gemini yapay zekâ hizmetine gönderilir; bu, verinin yurt dışına aktarılması anlamına gelebilir. Sohbetinle birlikte en geç 90 gün saklanır, yalnızca sen görürsün. Başka kişilerin yer aldığı ya da kimlik, kart, adres gibi bilgi içeren fotoğraf ekleme.",
  withdraw: "İznini istediğin zaman Hesabım > Gizlilik tercihleri sayfasından geri çekebilirsin.",
  privacyLabel: "Gizlilik tercihleri",
  privacyHref: "/hesap/gizlilik",
  detailsLabel: "KVKK Aydınlatma Metni",
  detailsHref: "/kvkk-aydinlatma",
  accept: "İzin ver ve fotoğrafı ekle",
  decline: "Vazgeç",
  previewAlt: "Eklemek istediğin fotoğrafın önizlemesi",
  saveError: "İznin kaydedilemedi. Biraz sonra tekrar dener misin?",
  declined: "Fotoğraf eklenmedi. Metinle sohbet etmeye devam edebilirsin.",
  settingsTitle: "Sohbette fotoğraf kullanımı",
  settingsStatusGranted: "Durum: izin verildi.",
  settingsStatusNone:
    "Durum: izin verilmedi. Sohbete fotoğraf eklemek istediğinde kısa bir bilgilendirmeyle izin istenir.",
  settingsDescription:
    "İzni geri çekersen yeni fotoğraf ekleyemezsin; mevcut sohbetlerdeki fotoğraflar sohbetle birlikte silinir.",
  settingsWithdraw: "İznimi geri çek",
  settingsWithdrawn: "İznin geri çekildi. Fotoğraf eklerken yeniden sorulur.",
} as const;
