import {
  bulkSendBlockMessage,
  getCampaign,
  getRecipientPreview,
  type MarketingEmailConfig,
  marketingEmailConfigFromEnv,
  RECIPIENT_REASONS,
  renderCampaignPreview,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import { SITE_BRAND } from "../../../site-config.ts";
import styles from "../../admin.module.css";
import {
  ErrorNotice,
  KeyValues,
  Notice,
  PageHeader,
  Section,
  StatusText,
  Tile,
} from "../../admin-ui.tsx";
import {
  formatCount,
  formatDateOrDash,
  formatDateTime,
  marketingReasonLabel,
} from "../../format.ts";
import { CampaignFormClient } from "../campaign-form-client.tsx";
import { CampaignOpsClient } from "./campaign-ops-client.tsx";
import { SendCampaignClient } from "./send-campaign-client.tsx";
import { TestSendClient } from "./test-send-client.tsx";

/**
 * Bu sayfanın server action'ları (gönderimi başlat, sonraki parti) sınırlı
 * bir parti işler (`MARKETING_EMAIL_TIME_BUDGET_MS`, varsayılan 25 sn).
 * Platform varsayılan süresi daha kısaysa parti yarıda kesilirdi.
 */
export const maxDuration = 60;

/**
 * Kampanya ayrıntısı (docs/decisions/0048). Taslakta: düzenleme, önizleme,
 * uygun alıcı sayısı (yalnızca toplamlar), test gönderimi, gerçek gönderim.
 * Gönderim başladıktan sonra içerik salt okunur; durum sayıları ve maskeli
 * sorun örnekleri görünür. Alıcı listesi gösterilmez.
 */
export default async function CampaignPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { user, actor } = await requireCapability("marketing.manage");
  const db = getDatabase();
  const campaign = await getCampaign(db, actor, (await params).publicId);
  if (!campaign) notFound();

  const isDraft = campaign.status === "draft";
  const preview = isDraft ? await getRecipientPreview(db, actor) : null;

  let config: MarketingEmailConfig | null = null;
  try {
    config = marketingEmailConfigFromEnv();
  } catch {
    config = null;
  }

  let rendered: { html: string } | null = null;
  try {
    rendered = renderCampaignPreview(campaign, SITE_BRAND);
  } catch {
    rendered = null;
  }

  const tested = campaign.testedVersion === campaign.contentVersion;
  let sendDisabledReason: string | null = null;
  if (!config) sendDisabledReason = "E-posta yapılandırması eksik (SMTP / gönderen adresi).";
  else if (!config.bulkSendAllowed && config.bulkSendBlock) {
    sendDisabledReason = bulkSendBlockMessage(config.bulkSendBlock);
  } else if (!tested) {
    sendDisabledReason =
      "Gerçek gönderimden önce bu içerik sürümünün test e-postasını gönder ve incele.";
  } else if (preview && preview.eligible === 0) {
    sendDisabledReason = "Şu anda uygun alıcı yok.";
  }

  return (
    <div className={styles.page}>
      <p>
        <Link href="/yonetim/kampanyalar">← E-posta kampanyaları</Link>
      </p>
      <PageHeader title={campaign.title}>
        <p>
          <StatusText status={campaign.status} />
        </p>
      </PageHeader>

      {campaign.lastErrorCode ? (
        <ErrorNotice>
          {`Son parti işlenemedi: ${marketingReasonLabel(campaign.lastErrorCode)}`}
          {campaign.lastErrorAt ? ` (${formatDateTime(campaign.lastErrorAt)})` : ""}
        </ErrorNotice>
      ) : null}

      <KeyValues
        items={[
          ["Konu", campaign.subject],
          ["Oluşturan", campaign.creatorLabel ?? "—"],
          ["Oluşturma", formatDateTime(campaign.createdAt)],
          ["Son değişiklik", formatDateTime(campaign.updatedAt)],
          ["İçerik sürümü", String(campaign.contentVersion)],
          ["Test gönderimi", tested ? "Bu sürüm test edildi" : "Bu sürüm henüz test edilmedi"],
          ["Gönderim başlangıcı", formatDateOrDash(campaign.sendStartedAt)],
          ["Bitiş", formatDateOrDash(campaign.completedAt)],
          ["İptal", formatDateOrDash(campaign.cancelledAt)],
        ]}
      />

      {!isDraft ? (
        <Section id="teslim" title="Teslim durumu">
          <div className={styles.tiles}>
            <Tile
              label="Alıcı (başlangıçta)"
              value={campaign.recipientCount === null ? "—" : formatCount(campaign.recipientCount)}
            />
            <Tile
              label="Bekliyor"
              value={formatCount(campaign.counts.pending + campaign.counts.sending)}
            />
            <Tile
              label="Sağlayıcıya verildi"
              value={formatCount(campaign.counts.sent)}
              note="Sağlayıcı kabul etti; kutuya ulaştığı ayrıca bilinmiyor."
            />
            <Tile
              label="Başarısız"
              value={formatCount(campaign.counts.failed)}
              warning={campaign.counts.failed > 0}
            />
            <Tile
              label="Atlandı"
              value={formatCount(campaign.counts.skipped)}
              note="Gönderim anında izni/adresi uygun değildi ya da iptal."
            />
          </div>
          <CampaignOpsClient
            publicId={campaign.publicId}
            canProcess={campaign.status === "sending"}
            canCancel={campaign.status === "sending"}
          />
          {campaign.status === "sending" ? (
            <Notice>
              Gönderim arka planda partiler hâlinde sürer (cron). Bu sayfanın açık kalması gerekmez.
            </Notice>
          ) : null}
        </Section>
      ) : null}

      {isDraft ? (
        <Section id="duzenle" title="Taslağı düzenle">
          <CampaignFormClient
            mode="edit"
            publicId={campaign.publicId}
            contentVersion={campaign.contentVersion}
            title={campaign.title}
            subject={campaign.subject}
            body={campaign.body}
          />
        </Section>
      ) : null}

      <Section id="onizleme" title="Önizleme">
        {rendered ? (
          <iframe
            title="E-posta önizlemesi"
            className={styles.previewFrame}
            // Betik, form ve gezinme kapalı: içerik yine de core'da kaçırılmış düz metin.
            sandbox=""
            srcDoc={rendered.html}
          />
        ) : (
          <ErrorNotice>Önizleme oluşturulamadı: APP_URL tanımlı değil.</ErrorNotice>
        )}
      </Section>

      {preview ? (
        <Section id="alicilar" title="Alıcılar (şu an)">
          <div className={styles.tiles}>
            <Tile label="Uygun" value={formatCount(preview.eligible)} />
            <Tile label="Toplam hesap" value={formatCount(preview.total)} />
            <Tile label="Hariç" value={formatCount(preview.total - preview.eligible)} />
          </div>
          <KeyValues
            items={RECIPIENT_REASONS.filter((reason) => reason !== "eligible").map((reason) => [
              marketingReasonLabel(reason),
              formatCount(preview.excluded[reason as Exclude<typeof reason, "eligible">]),
            ])}
          />
          <p className={styles.muted}>
            Sayı bilgi amaçlıdır. Gerçek gönderimde her alıcı, ileti gönderilmeden hemen önce
            yeniden denetlenir.
          </p>
        </Section>
      ) : null}

      {isDraft ? (
        <>
          <Section id="test" title="Test gönderimi">
            <TestSendClient
              publicId={campaign.publicId}
              contentVersion={campaign.contentVersion}
              defaultRecipient={user.email ?? ""}
            />
          </Section>
          <Section id="gonder" title="Gerçek gönderim">
            <SendCampaignClient
              publicId={campaign.publicId}
              contentVersion={campaign.contentVersion}
              subject={campaign.subject}
              eligibleCount={preview?.eligible ?? 0}
              disabledReason={sendDisabledReason}
            />
            <CampaignOpsClient publicId={campaign.publicId} canProcess={false} canCancel={true} />
          </Section>
        </>
      ) : null}

      {!isDraft ? (
        <Section id="sorunlar" title="Son sorunlar">
          {campaign.problems.length === 0 ? (
            <EmptyState title="Sorun yok." description="Başarısız ya da atlanan teslim yok." />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Alıcı</th>
                    <th scope="col">Durum</th>
                    <th scope="col">Neden</th>
                    <th scope="col">Zaman</th>
                  </tr>
                </thead>
                <tbody>
                  {campaign.problems.map((problem) => (
                    <tr key={problem.deliveryId}>
                      <td>
                        {problem.userPublicId ? (
                          <Link href={`/yonetim/kullanicilar/${problem.userPublicId}`}>
                            {problem.recipientLabel ?? "e-postasız hesap"}
                          </Link>
                        ) : (
                          "silinmiş hesap"
                        )}
                      </td>
                      <td>
                        <StatusText status={problem.state} />
                      </td>
                      <td>{marketingReasonLabel(problem.code)}</td>
                      <td>{formatDateTime(problem.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}
    </div>
  );
}
