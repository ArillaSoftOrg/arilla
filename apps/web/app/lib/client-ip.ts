/** `x-forwarded-for`'dan ilk (gerçek istemci) IP'yi çıkarır. Birden çok yerde kullanılır (giriş, rıza kaydı). */
export function clientIp(forwardedFor: string | null): string | null {
  return forwardedFor?.split(",")[0]?.trim() || null;
}
