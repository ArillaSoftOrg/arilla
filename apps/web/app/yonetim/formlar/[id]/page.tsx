import { getFormForEdit, readAppUrl } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { Notice, PageHeader, Section, StatusText } from "../../admin-ui.tsx";
import { formatCount, positiveInt, toDateTimeLocalValue } from "../../format.ts";
import { CopyLinkClient } from "../copy-link-client.tsx";
import { FormEditorClient } from "../form-editor-client.tsx";
import { FormStatusClient } from "../form-status-client.tsx";

export default async function EditFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requireCapability("forms.manage");
  const id = positiveInt((await params).id);
  if (!id) notFound();
  const found = await getFormForEdit(getDatabase(), actor, id);
  if (!found) notFound();

  // Paylasim adresi ortamdan gelir (kodda alan adi gomulu degil); APP_URL
  // yoksa yalnizca yol gosterilir.
  const origin = readAppUrl();
  const sharePath = `/anket/${found.slug}`;
  const shareUrl = origin ? new URL(sharePath, origin).toString() : sharePath;

  return (
    <div className={styles.page}>
      <PageHeader title={found.title}>
        <p className={styles.muted}>
          Durum: <StatusText status={found.status} /> · {formatCount(found.responseCount)} yanıt ·{" "}
          <Link href={`/yonetim/formlar/${found.id}/sonuclar`}>Sonuçlar</Link> ·{" "}
          <Link href="/yonetim/formlar">Tüm formlar</Link>
        </p>
      </PageHeader>

      <Section id="yayin" title="Yayın">
        {found.status === "published" ? (
          <>
            <p className={styles.muted}>Paylaşılabilir bağlantı:</p>
            <CopyLinkClient url={shareUrl} />
          </>
        ) : (
          <Notice>
            {found.status === "closed"
              ? "Form kapalı: bağlantı yeni yanıt almaz."
              : "Taslak: yayınlayana kadar bağlantı kimseye görünmez."}
          </Notice>
        )}
        <FormStatusClient id={found.id} status={found.status} />
      </Section>

      <Section id="duzenle" title="Düzenle">
        <FormEditorClient
          mode="edit"
          id={found.id}
          expectedUpdatedAt={found.updatedAt.getTime()}
          questionsLocked={found.responseCount > 0}
          slugLocked={found.publishedAt !== null}
          initial={{
            slug: found.slug,
            title: found.title,
            description: found.description ?? "",
            audience: found.audience,
            kind: found.kind,
            allowSkip: found.allowSkip,
            allowMultipleResponses: found.allowMultipleResponses,
            startsAt: toDateTimeLocalValue(found.startsAt),
            endsAt: toDateTimeLocalValue(found.endsAt),
            questions: found.questions.map((q) => ({
              label: q.label,
              description: q.description ?? "",
              type: q.type,
              required: q.required,
              options: q.options.join("\n"),
            })),
          }}
        />
      </Section>
    </div>
  );
}
