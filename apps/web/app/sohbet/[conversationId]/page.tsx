import { isUuid } from "@arilla/core";
import { notFound, permanentRedirect } from "next/navigation";
import { homeConversationHref } from "../../home-chat-mode.ts";

/**
 * Eski konuşma adresi (karar 0204): `/sohbet/<uuid>` -> `/?s=<uuid>` (308). Sıralama (`sirala`)
 * ve açık kart (`ac`) parametreleri korunur. Konuşma ana sayfada çizilir; bu rota yalnız
 * eski bağlantıları taşır. UUID olmayan değer 404.
 */
export default async function LegacyConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ sirala?: string; ac?: string }>;
}) {
  const { conversationId } = await params;
  if (!isUuid(conversationId)) notFound();
  const query = await searchParams;
  permanentRedirect(
    homeConversationHref(conversationId, {
      sirala: typeof query.sirala === "string" ? query.sirala : undefined,
      ac: typeof query.ac === "string" ? query.ac : undefined,
    }),
  );
}
