/**
 * E-posta + şifre ekranlarının metinleri (docs/copy.md `auth.credential_*`,
 * karar 0150). Hiçbir metin hesabın var olup olmadığını belli etmez.
 */
export const CREDENTIAL_COPY = {
  emailContinue: "E-posta ile devam edin", // auth.credential_entry
  unavailable: "şu an kullanılamıyor", // auth.provider_unavailable
  back: "Diğer giriş seçenekleri",

  loginTitle: "E-posta ile giriş yap",
  registerTitle: "Hesap oluştur",
  forgotTitle: "Şifreni sıfırla",
  resetTitle: "Yeni şifreni belirle",
  verifyTitle: "E-posta adresini doğrula",
  verifyBody:
    "Hesabını açmak için aşağıdaki düğmeye bas. Bağlantı yalnızca bir kez kullanılabilir.",
  verifySubmit: "Doğrula ve giriş yap",

  emailLabel: "E-posta adresin",
  nameLabel: "Adın (isteğe bağlı)",
  passwordLabel: "Şifre",
  newPasswordLabel: "Yeni şifre",
  confirmPasswordLabel: "Şifreyi tekrar gir",
  currentPasswordLabel: "Mevcut şifre",
  passwordHint: "En az 10 karakter. Kolay tahmin edilen şifreler kabul edilmez.",

  loginSubmit: "Giriş yap",
  loginPending: "Giriş yapılıyor…",
  registerSubmit: "Hesap oluştur",
  registerPending: "Hesap oluşturuluyor…",
  forgotSubmit: "Sıfırlama bağlantısı gönder",
  forgotPending: "Gönderiliyor…",
  resetSubmit: "Şifreyi kaydet",
  resetPending: "Kaydediliyor…",
  resendSubmit: "Doğrulama e-postasını tekrar gönder",
  resendPending: "Gönderiliyor…",

  forgotLink: "Şifremi unuttum",
  registerLink: "Hesabın yok mu? Hesap oluştur",
  loginLink: "Zaten hesabın var mı? Giriş yap",
  resendHeading: "Doğrulama e-postası gelmedi mi?",

  // Hesap varlığını belli etmeyen ortak yanıtlar.
  invalidCredentials: "E-posta adresi ya da şifre hatalı.", // auth.credential_invalid
  checkEmailTitle: "E-postanı kontrol et", // auth.credential_check_email_title
  checkEmailBody:
    "Bu adrese devam etmen için bir bağlantı gönderdik. Bağlantı 60 dakika geçerli. Birkaç dakika içinde gelmezse gereksiz klasörüne de bak.", // auth.credential_check_email_body
  resentBody:
    "Bu adrese bekleyen bir kayıt varsa doğrulama bağlantısını tekrar gönderdik. Birkaç dakika içinde gelmezse gereksiz klasörüne de bak.",
  forgotSentTitle: "Bağlantıyı gönderdik",
  forgotSentBody:
    "Bu adresle bir hesap varsa şifre belirleme bağlantısını gönderdik. Bağlantı 30 dakika geçerli. Gelmezse gereksiz klasörüne de bak.", // auth.credential_reset_sent

  invalidEmail: "Geçerli bir e-posta adresi gir.",
  rateLimited: "Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar dene.", // auth.credential_rate_limited
  sendFailed: "E-postayı şu an gönderemedik. Biraz sonra tekrar dene.",
  unavailableNotice:
    "E-posta ile giriş şu an kullanılamıyor. Başka bir yöntemle devam edebilirsin.",
  generic: "İşlem şu an tamamlanamadı. Biraz sonra tekrar dene.",
  passwordMismatch: "Şifreler aynı değil.",
  privateRelay:
    "Apple'ın gizli e-posta adresiyle şifre oluşturulamaz. Apple ile devam et ya da gerçek e-posta adresini kullan.",

  tooShort: "Şifre en az 10 karakter olmalı.",
  tooLong: "Şifre en fazla 128 karakter olabilir.",
  tooCommon: "Bu şifre çok yaygın. Daha özgün bir şifre seç.",
  sameAsEmail: "Şifre e-posta adresinden farklı olmalı.",

  tokenExpired: "Bu bağlantının süresi dolmuş. Yeni bir bağlantı isteyebilirsin.",
  tokenUsed: "Bu bağlantı geçersiz ya da daha önce kullanılmış. Yeni bir bağlantı isteyebilirsin.",
  accountExists:
    "Bu e-posta adresiyle zaten bir hesap var. Google ya da Apple ile giriş yapabilir ya da şifreni sıfırlayabilirsin.",
  passwordChanged: "Şifren kaydedildi. Yeni şifrenle giriş yapabilirsin.",
  requestNewLink: "Yeni bağlantı iste",

  accountPasswordTitle: "Şifre",
  changeTitle: "Şifreni değiştir",
  changeSubmit: "Şifreyi değiştir",
  changePending: "Değiştiriliyor…",
  changeDone: "Şifren değişti. Bu cihaz dışındaki oturumların kapatıldı.",
  wrongCurrent: "Mevcut şifre hatalı.",
  setupTitle: "Şifre belirle",
  setupBody:
    "Hesabın şu an Google ya da Apple ile açılıyor. E-posta adresine bir bağlantı gönderelim, şifreni oradan belirle. Mevcut girişlerin çalışmaya devam eder.",
  setupSubmit: "Bağlantıyı gönder",
  setupPending: "Gönderiliyor…",
  setupDone: "Şifre belirleme bağlantısını e-posta adresine gönderdik. Bağlantı 30 dakika geçerli.",
} as const;

export type CredentialErrorCode =
  | "invalid_credentials"
  | "invalid_email"
  | "rate_limited"
  | "send_failed"
  | "unavailable"
  | "password_mismatch"
  | "private_relay"
  | "too_short"
  | "too_long"
  | "too_common"
  | "same_as_email"
  | "token_expired"
  | "token_used"
  | "wrong_current"
  | "generic";

const ERROR_TEXT: Record<CredentialErrorCode, string> = {
  invalid_credentials: CREDENTIAL_COPY.invalidCredentials,
  invalid_email: CREDENTIAL_COPY.invalidEmail,
  rate_limited: CREDENTIAL_COPY.rateLimited,
  send_failed: CREDENTIAL_COPY.sendFailed,
  unavailable: CREDENTIAL_COPY.unavailableNotice,
  password_mismatch: CREDENTIAL_COPY.passwordMismatch,
  private_relay: CREDENTIAL_COPY.privateRelay,
  too_short: CREDENTIAL_COPY.tooShort,
  too_long: CREDENTIAL_COPY.tooLong,
  too_common: CREDENTIAL_COPY.tooCommon,
  same_as_email: CREDENTIAL_COPY.sameAsEmail,
  token_expired: CREDENTIAL_COPY.tokenExpired,
  token_used: CREDENTIAL_COPY.tokenUsed,
  wrong_current: CREDENTIAL_COPY.wrongCurrent,
  generic: CREDENTIAL_COPY.generic,
};

export function credentialErrorText(code: CredentialErrorCode): string {
  return ERROR_TEXT[code];
}

/** Şifre alanının altında gösterilen kodlar (diğerleri form başında uyarı olur). */
export const PASSWORD_FIELD_ERRORS: ReadonlySet<CredentialErrorCode> = new Set([
  "too_short",
  "too_long",
  "too_common",
  "same_as_email",
  "password_mismatch",
]);

/** `?hata=` ile dönen doğrulama bağlantısı sonuçları (`/giris/eposta`). */
export const LOGIN_PAGE_NOTICES: Record<string, string> = {
  suresi_doldu: CREDENTIAL_COPY.tokenExpired,
  gecersiz: CREDENTIAL_COPY.tokenUsed,
  hesap_var: CREDENTIAL_COPY.accountExists,
  sifre_degisti: CREDENTIAL_COPY.passwordChanged,
};
