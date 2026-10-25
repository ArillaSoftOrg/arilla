/**
 * E-posta/sifre akisinin hata siniflari. `apps/web` her birini ayri bir
 * kullanici mesajina cevirir; hicbiri hesabin var olup olmadigini belli etmez
 * (`InvalidCredentialsError` yanlis sifre ile var olmayan hesabi ayirmaz).
 */
import type { PasswordPolicyViolation } from "./password-policy.ts";

export class InvalidEmailError extends Error {
  constructor() {
    super("gecersiz e-posta adresi");
    this.name = "InvalidEmailError";
  }
}

/** Apple "E-postamı Gizle" adresiyle sifreli kayit yapilmaz (karar 0150). */
export class PrivateRelayEmailError extends Error {
  constructor() {
    super("Apple gizli e-posta adresiyle e-posta/sifre kaydi yapilamaz");
    this.name = "PrivateRelayEmailError";
  }
}

export class PasswordPolicyError extends Error {
  readonly violation: PasswordPolicyViolation;

  constructor(violation: PasswordPolicyViolation) {
    super(`sifre politikasi: ${violation}`);
    this.name = "PasswordPolicyError";
    this.violation = violation;
  }
}

/** Yanlis sifre, var olmayan hesap, sifresiz hesap ve personel hesabi ayni hata. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("e-posta ya da sifre hatali");
    this.name = "InvalidCredentialsError";
  }
}

/** Dogrulama tamamlanirken adres baska bir yolla (orn. Google) hesaba donusmus. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("bu e-posta adresiyle bir hesap zaten var");
    this.name = "EmailAlreadyRegisteredError";
  }
}
