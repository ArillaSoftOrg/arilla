/**
 * Entegrasyon testleri için (karar 0059): yeni hesabın ilk girişi
 * `/hos-geldin?next=<hedef>`'e gider. Hedefi sınayan testler (next güvenliği,
 * ürün kapısı) bu yardımcıyla asıl hedefi okur; karşılama yönlendirmesinin
 * kendisi `onboarding-redirect.integration.test.ts`'te ayrıca sınanır.
 */
export function afterOnboarding(destination: string | null): string {
  if (destination === null) return "(redirect yok)";
  const url = new URL(destination, "http://x");
  return url.pathname === "/hos-geldin" ? (url.searchParams.get("next") ?? "/") : destination;
}
