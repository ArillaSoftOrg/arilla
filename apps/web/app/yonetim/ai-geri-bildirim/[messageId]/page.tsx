import { getChatFeedbackDetail, isChatFeedbackSchemaMissing } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KeyValues, PageHeader } from "../../admin-ui.tsx";
import { formatDateTime, positiveInt } from "../../format.ts";
import { reasonLabel, searchSourceLabel } from "../labels.ts";

/**
 * Tek oy ayrıntısı (karar 0079). Sohbet metni YOK: yalnızca oy, neden, yorum, mesaj
 * referansı, arama kaynağı ve yaklaşık model sürümü. Sohbet bağlamı ayrı bir faz ve
 * ayrı yetkidir. Her görüntüleme denetime yazılır (içerik yazılmaz).
 */
export default async function ChatFeedbackDetailPage({
  params,
}: {
  params: Promise<{ messageId: string }>;
}) {
  const { actor } = await requireCapability("feedback.chat.read");
  const messageId = positiveInt((await params).messageId);
  if (!messageId) notFound();
  let detail: Awaited<ReturnType<typeof getChatFeedbackDetail>>;
  try {
    detail = await getChatFeedbackDetail(getDatabase(), actor, messageId);
  } catch (error) {
    // 0058 uygulanmamis: 500 yerine bulunamadi (liste sayfasi nedenini aciklar).
    if (!isChatFeedbackSchemaMissing(error)) throw error;
    notFound();
  }
  if (!detail) notFound();

  return (
    <div className={styles.pageNarrow}>
      <PageHeader title={`Değerlendirme #${detail.messageId}`}>
        <p className={styles.muted}>
          <Link href="/yonetim/ai-geri-bildirim">← AI geri bildirimleri</Link>
        </p>
      </PageHeader>
      <KeyValues
        items={[
          ["Oy", detail.helpful ? "Olumlu" : "Olumsuz"],
          [
            "Neden",
            detail.reasons.length ? detail.reasons.map(reasonLabel).join(", ") : "Seçilmedi",
          ],
          ["Yorum", detail.comment ?? "Yazılmadı"],
          ["Oy tarihi", formatDateTime(detail.createdAt)],
          ["Son değişiklik", formatDateTime(detail.updatedAt)],
          ["Sohbet", detail.conversationId],
          ["Mesaj sırası", `#${detail.messageSeq}`],
          ["Arama kaynağı", searchSourceLabel(detail.searchSource)],
          ["Yedek nedeni", detail.fallbackReason],
          ["Model (yaklaşık)", detail.modelVersion ?? "Bilinmiyor"],
        ]}
      />
      <p className={styles.muted}>
        Sohbet metni bu ekranda gösterilmez. Sohbet bağlamına erişim kullanıcı onayı, ayrı yetki ve
        hukuki inceleme gerektirir (karar 0079 m.10).
      </p>
    </div>
  );
}
