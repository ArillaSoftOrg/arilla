import type { ContactCategory } from "@arilla/db";

/** docs/copy.md "İletişim" - anahtarlar yorumda. Hitap "siz" (geri bildirimle aynı). */
export const CONTACT_COPY = {
  title: "İletişim", // contact.title
  description:
    "Sorunuzu, talebinizi veya bildirmek istediğiniz bir hatayı aşağıdaki formla iletebilirsiniz. Gerekirse bıraktığınız e-posta adresinden size dönüş yaparız.", // contact.description
  faqPrompt: "Yanıtını aradığınız soru", // contact.faq_prompt
  faqLink: "Sıkça sorulan sorular", // contact.faq_link
  faqPromptEnd: "sayfasında olabilir.", // contact.faq_prompt_end
  nameLabel: "Adınız", // contact.name_label
  emailLabel: "E-posta", // contact.email_label
  emailHint: "Size dönüş yapmamız gerekirse bu adresi kullanırız.", // contact.email_hint
  categoryLegend: "Konu", // contact.category_label
  subjectLabel: "Başlık", // contact.subject_label
  subjectPlaceholder: "Ürün sayfasında fiyat farklı görünüyor", // contact.subject_placeholder
  messageLabel: "Mesajınız", // contact.message_label
  messageHint: "Ürün adı veya sayfa bağlantısı eklemeniz incelememizi kolaylaştırır.", // contact.message_hint
  authNotice: "Giriş yaptığınız için mesajınız hesabınızla ilişkilendirilecektir.", // contact.auth_notice
  privacyNote: "Bilgilerinizi yalnızca talebinizi yanıtlamak için kullanırız. Ayrıntılar", // contact.privacy_note
  privacyLink: "Gizlilik Politikası", // contact.privacy_link
  privacyAnd: "ve", // contact.privacy_and
  kvkkLink: "KVKK Aydınlatma Metni", // contact.kvkk_link
  privacyNoteEnd: "içinde.", // contact.privacy_note_end
  emailAlternative: "Dilerseniz doğrudan e-posta da gönderebilirsiniz:", // contact.email_alternative
  submit: "Mesajı gönder", // contact.submit
  submitting: "Gönderiliyor…", // contact.submitting
  successTitle: "Mesajınız bize ulaştı.", // contact.success_title
  successBody:
    "Mesajınızı inceleyeceğiz; gerekirse bıraktığınız e-posta adresinden size dönüş yaparız.", // contact.success_body
  successAnother: "Yeni mesaj gönder", // contact.success_another
  backHome: "Ana sayfaya dön", // early_access.back_home
  // Alan hataları
  nameRequired: "Adınızı yazın.", // contact.error_name_required
  nameLength: "Ad 2 ile 100 karakter arasında olmalı.", // contact.error_name_length
  emailRequired: "Yanıt verebilmemiz için e-posta adresinizi yazın.", // contact.error_email_required
  emailInvalid: "Geçerli bir e-posta adresi girin.", // contact.error_email
  categoryRequired: "Bir konu seçin.", // contact.error_category
  subjectRequired: "Bir başlık yazın.", // contact.error_subject_required
  subjectLength: "Başlık 3 ile 120 karakter arasında olmalı.", // contact.error_subject_length
  messageRequired: "Mesajınızı yazın.", // contact.error_message_required
  messageLength: "Mesaj 10 ile 5000 karakter arasında olmalı.", // contact.error_message_length
  // Form düzeyi hatalar
  fixErrors: "Lütfen işaretli alanları düzeltin.", // contact.error_fix_fields
  malformed: "Form gönderilemedi. Sayfayı yenileyip tekrar deneyin.", // contact.error_malformed
  tooLarge: "Mesajınız çok uzun. Lütfen kısaltıp tekrar deneyin.", // contact.error_too_large
  rateLimited: "Kısa sürede çok fazla mesaj gönderdiniz. Birkaç dakika sonra tekrar deneyin.", // contact.error_rate_limited
  unavailable: "Mesajınızı şu an kaydedemedik. Biraz sonra tekrar deneyin ya da e-posta gönderin.", // contact.error_unavailable
  network: "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.", // contact.error_network
  sessionExpired:
    "Oturumunuz sona ermiş. Mesajınızın hesabınızla ilişkilendirilmesi için tekrar giriş yapın.", // contact.error_session_expired
  loginAgain: "Tekrar giriş yap", // contact.login_again
} as const;

/**
 * Kategori etiketleri. `Record` tipi her kategorinin etiketi olduğunu zorlar;
 * istemci seçenekleri buradan üretir (`@arilla/db` değeri istemciye çekilmez).
 */
export const CONTACT_CATEGORY_LABELS: Record<ContactCategory, string> = {
  general: "Genel soru",
  account: "Hesap ve giriş",
  price_error: "Yanlış fiyat veya ürün bilgisi",
  bug: "Teknik sorun",
  partnership: "Mağaza ve iş birliği",
  privacy: "Gizlilik ve KVKK talebi",
  other: "Diğer",
};
