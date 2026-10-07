import { isChatDiscoveryEnabled, loadConversation } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound } from "next/navigation";
import { requireProductUser } from "../../lib/dal.ts";
import { ChatInteractive } from "../chat-client.tsx";
import { ChatThread } from "../chat-thread.tsx";

/**
 * Sayfadaki sunucu eylemlerinin (`runTurnAction`: model çağrısı, en çok 3 deneme
 * x 15 sn + bekleme) zaman aşımı. Bkz. docs/decisions/0059 istemci ayarları.
 */
export const maxDuration = 60;

/**
 * `/sohbet/[conversationId]`: kullanıcının kendi sohbeti. Sahiplik sorguda
 * (`user_id`) denetlenir; başkasının ya da olmayan sohbet 404'tür (varlığı
 * sızdırılmaz). Özellik kapalıysa yine 404.
 */
export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ sirala?: string }>;
}) {
  const user = await requireProductUser();
  if (!isChatDiscoveryEnabled()) notFound();

  const { conversationId } = await params;
  const view = await loadConversation(getDatabase(), { userId: user.id, conversationId });
  if (!view) notFound();

  const last = view.messages.at(-1);
  // Yalnızca son mesaj açık soruysa etkileşimli kart gösterilir.
  const question =
    last?.role === "assistant" && last.kind === "clarify" ? view.pendingQuestion : null;
  const lastUser = [...view.messages].reverse().find((m) => m.role === "user" && m.kind === "text");

  return (
    <ChatInteractive
      conversationId={view.id}
      awaitingReply={view.awaitingReply}
      question={question}
      lastUserText={lastUser?.content ?? view.title}
      lastSeq={last?.seq ?? 0}
    >
      <ChatThread
        messages={view.messages}
        conversationId={view.id}
        sortParam={(await searchParams).sirala}
      />
    </ChatInteractive>
  );
}
