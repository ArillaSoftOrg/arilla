import {
  hasChatImageConsent,
  isChatAnswerEnabled,
  isChatDiscoveryEnabled,
  isChatImageEnabled,
  isChatUxV2Enabled,
  loadConversation,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound } from "next/navigation";
import { ChatInteractive } from "./chat-client.tsx";
import { ChatThread } from "./chat-thread.tsx";

/**
 * Kullanıcının kendi konuşması (karar 0074, 0204): ana sayfada `/?s=<conversationId>` olarak
 * çizilir (eski `/sohbet/[id]` sayfasının gövdesi; iş mantığı çoğaltılmadı). Sahiplik sorguda
 * (`user_id`) denetlenir; başkasının ya da olmayan sohbet 404'tür (varlığı sızdırılmaz).
 * Özellik kapalıysa yine 404. Çağıran, giriş yapmış ve ürüne erişebilen kullanıcıyı verir.
 */
export async function ConversationView({
  userId,
  conversationId,
  sirala,
  ac,
}: {
  userId: number;
  conversationId: string;
  sirala?: string | undefined;
  ac?: string | undefined;
}) {
  if (!isChatDiscoveryEnabled()) notFound();

  const view = await loadConversation(getDatabase(), { userId, conversationId });
  if (!view) notFound();

  const last = view.messages.at(-1);
  // Yalnızca son mesaj açık soruysa etkileşimli kart gösterilir.
  const question =
    last?.role === "assistant" && last.kind === "clarify" ? view.pendingQuestion : null;
  const lastUser = [...view.messages].reverse().find((m) => m.role === "user" && m.kind === "text");

  const imageEnabled = isChatImageEnabled();
  const imageConsent = imageEnabled && (await hasChatImageConsent(getDatabase(), userId));

  return (
    <ChatInteractive
      conversationId={view.id}
      awaitingReply={view.awaitingReply}
      imageEnabled={imageEnabled}
      imageConsent={imageConsent}
      question={question}
      lastUserText={lastUser?.content ?? view.title}
      lastSeq={last?.seq ?? 0}
    >
      <ChatThread
        messages={view.messages}
        conversationId={view.id}
        sortParam={sirala}
        uxV2={isChatUxV2Enabled()}
        answerEnabled={isChatAnswerEnabled(userId)}
        openParam={ac}
      />
    </ChatInteractive>
  );
}
