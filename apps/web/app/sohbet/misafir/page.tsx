import { permanentRedirect } from "next/navigation";
import { homeGuestHref } from "../../home-chat-mode.ts";

/**
 * Eski misafir sohbet adresi (karar 0204): ana sayfadaki `/?q=&g=1` yuzeyine tasindi; adimlar (`n`)
 * korunur. Sorgu yoksa ana sayfaya.
 */
export default async function GuestChatRedirect({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; n?: string | string[] }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 500) ?? "";
  if (!query) permanentRedirect("/");
  const steps = Array.isArray(params.n) ? params.n : params.n ? [params.n] : [];
  permanentRedirect(homeGuestHref(query, steps));
}
