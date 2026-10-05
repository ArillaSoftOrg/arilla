/**
 * `/anket/<slug>` metinleri (docs/copy.md "Anket"). Hitap "sen" (onboarding
 * metniyle tutarlı; ürünün genel sesi). Form başlıkları ve sorular yönetimden
 * gelir, burada yalnızca sabit arayüz metinleri vardır.
 */
export const SURVEY_COPY = {
  metaFallbackTitle: "Anket", // survey.meta_title
  submit: "Gönder", // survey.submit
  // Adım adım (sihirbaz) gösterim: aynı anda tek soru
  back: "Geri", // survey.back
  next: "İleri", // survey.next
  finish: "Tamamla", // survey.finish
  progressLabel: "Anket ilerlemesi", // survey.progress_label
  stepOf: (current: number, total: number) => `Soru ${current} / ${total}`, // survey.step_of
  submitting: "Gönderiliyor…", // survey.submitting
  skip: "Şimdilik geç", // survey.skip
  optional: "(isteğe bağlı)", // survey.optional
  successTitle: "Teşekkürler, yanıtın alındı.", // survey.success_title
  successBody: "Cevapların ürünü senin ihtiyaçlarına göre geliştirmemize yardımcı olacak.", // survey.success_body
  backHome: "Ana sayfaya dön", // survey.back_home
  backEarlyAccess: "Erken erişim sayfasına dön", // survey.back_early_access
  authNotice: "Giriş yaptığın için yanıtın hesabınla ilişkilendirilecek.", // survey.auth_notice
  anonymousNotice: "Bu formda kimliğin istenmez; yanıtın hesabınla ilişkilendirilmez.", // survey.anonymous_notice
  privacyNote: "Kişisel verilerinin nasıl işlendiğini", // survey.privacy_note
  privacyLink: "Gizlilik Politikası'nda", // survey.privacy_link
  privacyNoteEnd: "bulabilirsin.", // survey.privacy_note_end
  // Erken erişim sayfasındaki onboarding daveti
  onboardingPrompt: "Seni biraz daha tanıyalım: birkaç kısa soru.", // survey.onboarding_prompt
  onboardingCta: "Şimdi doldur", // survey.onboarding_cta
  // Durum ekranları
  closedTitle: "Bu form artık yanıt almıyor.", // survey.closed_title
  closedBody: "İlgin için teşekkürler.", // survey.closed_body
  notStartedTitle: "Bu form henüz açılmadı.", // survey.not_started_title
  notStartedBody: "Biraz sonra tekrar dene.", // survey.not_started_body
  loginTitle: "Bu formu yanıtlamak için giriş yap.", // survey.login_title
  loginBody: "Yanıtın hesabınla ilişkilendirilecek.", // survey.login_body
  loginCta: "Giriş yap", // survey.login_cta
  earlyAccessTitle: "Bu form erken erişim üyelerine özel.", // survey.early_access_title
  earlyAccessBody: "Erken erişim listesindeki hesaplar yanıtlayabilir.", // survey.early_access_body
  earlyAccessCta: "Erken erişim sayfası", // survey.early_access_cta
  respondedTitle: "Bu formu zaten yanıtladın.", // survey.responded_title
  respondedBody: "Her hesap bu formu bir kez yanıtlayabilir. Teşekkürler!", // survey.responded_body
  // Alan hataları
  errorRequired: "Bu soru zorunlu.", // survey.error_required
  errorInvalid: "Geçerli bir seçim yap.", // survey.error_invalid
  errorTooLong: "Yanıt çok uzun.", // survey.error_too_long
  // Form düzeyi hatalar
  fixErrors: "Lütfen işaretli soruları düzelt.", // survey.error_fix
  malformed: "Form gönderilemedi. Sayfayı yenileyip tekrar dene.", // survey.error_malformed
  tooLarge: "Gönderdiğin metin çok uzun. Lütfen kısaltıp tekrar dene.", // survey.error_too_large
  rateLimited: "Kısa sürede çok fazla gönderim yaptın. Birkaç dakika sonra tekrar dene.", // survey.error_rate_limited
  unavailable: "Yanıtını şu an kaydedemedik. Biraz sonra tekrar dene.", // survey.error_unavailable
  network: "Bağlantı kurulamadı. İnternet bağlantını kontrol edip tekrar dene.", // survey.error_network
  // Onboarding'in son adımı (karar 0059): haftalık özet, varsayılan KAPALI
  newsletterTitle: "Gelişmelerden haberdar ol.", // survey.newsletter_title
  newsletterBody:
    "Haftalık ManiCepte fırsatlarını, önemli ürün güncellemelerini ve yeni özellik haberlerini e-postanla alabilirsin. İstediğin zaman abonelikten çıkabilirsin.", // survey.newsletter_body
  newsletterEmailLabel: "E-posta", // survey.newsletter_email
  newsletterNoEmail: "Hesabında e-posta adresi yok; haftalık özet gönderilemez.", // survey.newsletter_no_email
  newsletterToggle: "Haftalık fırsat özetini bana e-posta ile gönder.", // survey.newsletter_toggle
  sessionExpired:
    "Oturumun sona ermiş. Yanıtın hesabınla ilişkilendirilmesi için tekrar giriş yap.", // survey.error_session_expired
} as const;
