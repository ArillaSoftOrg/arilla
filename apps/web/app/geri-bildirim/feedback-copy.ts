import type { FeedbackCategory, FeedbackPriority } from "@arilla/db";

/**
 * Geri bildirim metinlerindeki urun adi; yayindaki marka (`SITE_BRAND` ile
 * ayni deger, karar 0045 §9). Yerel sabit: bu dosya istemci formuna girer.
 */
const FEEDBACK_BRAND = "ManiCepte";

/** Belirtme durumu ("ManiCepte'yi"); ek markanin son unlusune (e) gore secilir. */
const BRAND_ACCUSATIVE = `${FEEDBACK_BRAND}'yi`;

/** docs/copy.md "Geri bildirim" - anahtarlar yorumda. Hitap "siz" (urun karari, karar 0045). */
export const FEEDBACK_COPY = {
  navLabel: "Geri bildirim", // nav.feedback
  metaTitle: `Geri bildirim – ${FEEDBACK_BRAND}`, // feedback.meta_title
  metaDescription: `${FEEDBACK_BRAND} için öneri, hata bildirimi veya özellik isteğinizi iletin.`, // feedback.meta_description
  title: `${BRAND_ACCUSATIVE} birlikte geliştirelim`, // feedback.title
  description:
    "Eksik gördüğünüz, geliştirilmesini istediğiniz veya sorun yaşadığınız noktaları bize iletebilirsiniz.", // feedback.description
  categoryLegend: "Geri bildirim türü", // feedback.category_label
  titleLabel: "Başlık", // feedback.title_label
  titlePlaceholder: "Arama sonuçlarında filtreleme olmalı", // feedback.title_placeholder
  messageLabel: "Açıklama", // feedback.message_label
  messageHint: "Ne bekliyordunuz, ne oldu veya neyin geliştirilmesini istersiniz?", // feedback.message_hint
  priorityLegend: "Önem seviyesi", // feedback.priority_label
  optional: "(isteğe bağlı)", // feedback.optional
  emailLabel: "E-posta", // feedback.email_label
  emailHint: "Yanıt almak isterseniz e-posta adresinizi bırakabilirsiniz.", // feedback.email_hint
  authNotice:
    "Erken erişim üyesi olarak gönderdiğiniz geri bildirim hesabınızla ilişkilendirilecektir.", // feedback.auth_notice
  privacyNote: "Kişisel verilerinizin nasıl işlendiğini", // feedback.privacy_note
  privacyLink: "Gizlilik Politikası'nda", // feedback.privacy_link
  privacyNoteEnd: "bulabilirsiniz.", // feedback.privacy_note_end
  submit: "Geri bildirim gönder", // feedback.submit
  submitting: "Gönderiliyor…", // feedback.submitting
  successTitle: "Geri bildiriminiz alındı.", // feedback.success_title
  successBody: `${BRAND_ACCUSATIVE} geliştirmemize yardımcı olduğunuz için teşekkür ederiz.`, // feedback.success_body
  successAnother: "Yeni geri bildirim gönder", // feedback.success_another
  backHome: "Ana sayfaya dön", // early_access.back_home
  // Alan hatalari
  categoryRequired: "Bir geri bildirim türü seçin.", // feedback.error_category
  titleRequired: "Bir başlık yazın.", // feedback.error_title_required
  titleLength: "Başlık 3 ile 120 karakter arasında olmalı.", // feedback.error_title_length
  messageRequired: "Bir açıklama yazın.", // feedback.error_message_required
  messageLength: "Açıklama 10 ile 5000 karakter arasında olmalı.", // feedback.error_message_length
  priorityInvalid: "Listeden bir önem seviyesi seçin.", // feedback.error_priority
  emailInvalid: "Geçerli bir e-posta adresi girin ya da alanı boş bırakın.", // feedback.error_email
  // Form duzeyi hatalar
  fixErrors: "Lütfen işaretli alanları düzeltin.", // feedback.error_fix_fields
  malformed: "Form gönderilemedi. Sayfayı yenileyip tekrar deneyin.", // feedback.error_malformed
  tooLarge: "Gönderdiğiniz metin çok uzun. Lütfen kısaltıp tekrar deneyin.", // feedback.error_too_large
  rateLimited:
    "Kısa sürede çok fazla geri bildirim gönderdiniz. Birkaç dakika sonra tekrar deneyin.", // feedback.error_rate_limited
  unavailable: "Geri bildiriminizi şu an kaydedemedik. Biraz sonra tekrar deneyin.", // feedback.error_unavailable
  network: "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.", // feedback.error_network
  sessionExpired:
    "Oturumunuz sona ermiş. Geri bildiriminizin hesabınızla ilişkilendirilmesi için tekrar giriş yapın.", // feedback.error_session_expired
  loginAgain: "Tekrar giriş yap", // feedback.login_again
  // Erken erisim ekrani
  earlyAccessPrompt: `Bir fikriniz mi var? ${BRAND_ACCUSATIVE} birlikte geliştirelim.`, // feedback.early_access_prompt
} as const;

export const FEEDBACK_CATEGORY_LABELS: Readonly<Record<FeedbackCategory, string>> = {
  suggestion: "Öneri",
  bug: "Hata bildirimi",
  feature_request: "Özellik isteği",
  ux: "Tasarım / kullanım deneyimi",
  product_store: "Ürün / mağaza önerisi",
  other: "Diğer",
};

export const FEEDBACK_PRIORITY_LABELS: Readonly<Record<FeedbackPriority, string>> = {
  low: "Düşük",
  medium: "Orta",
  high: "Yüksek",
};
