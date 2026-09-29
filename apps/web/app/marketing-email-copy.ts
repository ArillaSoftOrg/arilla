/**
 * docs/copy.md "Pazarlama e-postası" - anahtarlar yorumda. Rıza cümlesinin
 * kendisi burada DEĞİL: sürümlü olarak `MARKETING_EMAIL_CONSENT_TEXT`
 * (packages/core/src/marketing/consent-text.ts) içinde durur.
 */
export const MARKETING_EMAIL_COPY = {
  preferenceTitle: "Pazarlama e-postaları", // marketing_email.preference_title
  transactionalNote: "Giriş ve hesap güvenliği e-postaları bu tercihten etkilenmez.", // marketing_email.transactional_note
  noEmail: "Hesabına bağlı bir e-posta adresi olmadığı için bu tercih kullanılamıyor.", // marketing_email.no_email
  saveFailed: "Tercihin kaydedilemedi. Biraz sonra yeniden dene.", // marketing_email.save_failed
  optInOptional: "İsteğe bağlı. İşaretlemesen de erken erişim listesinde kalırsın.", // marketing_email.opt_in_optional
  optInSubmit: "Tercihimi kaydet", // marketing_email.opt_in_submit
  optedInNote:
    "Pazarlama e-postalarına izin verdin. Hesap sayfandan istediğin zaman kapatabilirsin.", // marketing_email.opted_in_note
  unsubscribeTitle: "E-posta listesinden ayrıl", // marketing_email.unsubscribe_title
  unsubscribeBody:
    "Onayladığında sana pazarlama e-postası gönderilmez. Giriş ve hesap güvenliği e-postaları gelmeye devam eder.", // marketing_email.unsubscribe_body
  unsubscribeSubmit: "Listeden ayrıl", // marketing_email.unsubscribe_submit
  unsubscribeDoneTitle: "Listeden ayrıldın.", // marketing_email.unsubscribe_done_title
  unsubscribeDoneBody:
    "Artık pazarlama e-postası almayacaksın. Fikrini değiştirirsen hesap sayfandan yeniden izin verebilirsin.", // marketing_email.unsubscribe_done_body
  unsubscribeInvalidTitle: "Bu bağlantı geçerli değil.", // marketing_email.unsubscribe_invalid_title
  unsubscribeInvalidBody:
    "Bağlantı eksik kopyalanmış olabilir. E-postadaki bağlantıyı yeniden aç ya da hesap sayfandan tercihini değiştir.", // marketing_email.unsubscribe_invalid_body
  backHome: "Ana sayfaya dön", // early_access.back_home
} as const;
