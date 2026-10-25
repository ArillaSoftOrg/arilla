/**
 * Sifre politikasi (NIST SP 800-63B ruhu): uzunluk esastir, karakter-sinifi
 * kurali yok. En az 10, en fazla 128 karakter (ust sinir Argon2 girdisini
 * sinirlar; cok uzun govde ile hizmet reddi onlenir). Sik kullanilan sifreler
 * ve e-posta adresinin kendisi reddedilir. Mesajlar `docs/copy.md`
 * `auth.password_*` anahtarlaridir; burada yalnizca kod dondurulur.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordPolicyViolation = "too_short" | "too_long" | "too_common" | "same_as_email";

/** Kucuk, bilinen en sik kullanilan sifreler (>=10 karakter olanlar); tam liste degildir. */
const COMMON_PASSWORDS = new Set([
  "1234567890",
  "12345678910",
  "123456789012",
  "0123456789",
  "qwertyuiop",
  "qwertyuiop123",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "qazwsxedc123",
  "password12",
  "password123",
  "password1234",
  "passw0rd123",
  "iloveyou123",
  "abc1234567",
  "abcdefghij",
  "asdfghjkl1",
  "asdfghjklş",
  "1234qwer5678",
  "welcome123",
  "admin12345",
  "letmein123",
  "sifre12345",
  "parola12345",
  "galatasaray",
  "fenerbahce",
  "fenerbahce1907",
  "galatasaray1905",
  "besiktas1903",
  "trabzonspor",
  "istanbul1453",
  "manicepte123",
]);

function allSameCharacter(value: string): boolean {
  return new Set(value).size === 1;
}

export function checkPasswordPolicy(
  password: string,
  context: { email?: string | null } = {},
): PasswordPolicyViolation | null {
  const normalized = password.normalize("NFKC");
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) return "too_short";
  if (length > PASSWORD_MAX_LENGTH) return "too_long";
  const lower = normalized.toLocaleLowerCase("tr");
  if (COMMON_PASSWORDS.has(lower) || allSameCharacter(normalized)) return "too_common";
  const email = context.email?.trim().toLowerCase();
  if (email && (lower === email || lower === email.split("@")[0])) return "same_as_email";
  return null;
}
