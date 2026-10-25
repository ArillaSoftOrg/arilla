/** Apple "E-postamı gizle" aktarma adresi: iletiler yalnızca kayıtlı gönderen alan adından teslim edilir. */
export function isApplePrivateRelayEmail(email: string): boolean {
  return email.endsWith("@privaterelay.appleid.com");
}
