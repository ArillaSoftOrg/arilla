import { SITE_BRAND } from "../site-config.ts";

/** docs/copy.md "SSS" - anahtarlar yorumda. Soru ve yanıtlar `faq-content.ts`'te. */
export const FAQ_PAGE_COPY = {
  metaTitle: "Sıkça sorulan sorular", // faq.meta_title
  metaDescription: `${SITE_BRAND} nasıl çalışır, fiyatlar ne kadar güncel, hesap gerekir mi, verileriniz nasıl kullanılır? Sık sorulan soruların yanıtları.`, // faq.meta_description
  title: "Sıkça sorulan sorular", // faq.title
  description: "Merak ettiğiniz bir konunun yanıtı büyük olasılıkla burada.", // faq.description
  moreTitle: "Sorunuzun yanıtını bulamadınız mı?", // faq.more_title
  moreBody: "Bize yazın; mesajınızı inceleyip gerekirse e-posta ile size dönüş yapalım.", // faq.more_body
  moreAction: "İletişime geçin", // faq.more_action
} as const;
