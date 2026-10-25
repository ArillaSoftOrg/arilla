/**
 * E-posta/şifre token geçerlilik süreleri (dakika). Hem `issueToken` (sunucu
 * tarafı son kullanma) hem e-posta metinleri bunu okur: metindeki süre ile
 * gerçek süre ayrışamaz.
 */
export const VERIFY_EMAIL_TTL_MINUTES = 60;
export const RESET_PASSWORD_TTL_MINUTES = 30;
