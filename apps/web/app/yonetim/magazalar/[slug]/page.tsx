import { getMerchantDetail, hasCapability, listIngestRuns } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KeyValues, PageHeader, Pager, Section, StatusText } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash, hrefWith, positiveInt } from "../../format.ts";
import { IngestRunsTable } from "../../ingest-runs-table.tsx";
import { MerchantToggleClient } from "../merchant-toggle-client.tsx";

export default async function MerchantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ once?: string }>;
}) {
  const { user, actor } = await requireCapability("merchant.read");
  const { slug } = await params;
  const { once } = await searchParams;
  const db = getDatabase();

  const merchant = await getMerchantDetail(db, actor, decodeURIComponent(slug));
  if (!merchant) notFound();
  const beforeId = positiveInt(once);
  const runs = hasCapability(user.role, "ingest.read")
    ? await listIngestRuns(db, actor, { merchantId: merchant.id, beforeId, pageSize: 25 })
    : null;
  const path = `/yonetim/magazalar/${merchant.slug}`;

  return (
    <div className={styles.page}>
      <PageHeader title={merchant.name}>
        <p className={styles.muted}>
          <Link href="/yonetim/magazalar">Mağazalar</Link>
          {` / ${merchant.slug}`}
        </p>
      </PageHeader>

      <div className={styles.twoColumns}>
        <Section id="durum" title="Durum">
          <KeyValues
            items={[
              ["Veri toplama", merchant.isActive ? "Açık" : "Kapalı"],
              ["Kaynak", merchant.sourceType],
              ["Alan adı", merchant.domain],
              ["Yenileme", `${formatCount(merchant.refreshMinutes)} dk`],
              [
                "Son koşu",
                merchant.lastRun ? (
                  <>
                    <StatusText status={merchant.lastRun.status} />
                    {` · ${formatDateOrDash(merchant.lastRun.startedAt)}`}
                  </>
                ) : (
                  "Hiç çalışmadı"
                ),
              ],
              ["Son başarılı koşu", formatDateOrDash(merchant.lastSuccessAt)],
              ["Son başarıdan beri hata", formatCount(merchant.failuresSinceSuccess)],
            ]}
          />
          {hasCapability(user.role, "merchant.manage") ? (
            <MerchantToggleClient
              merchantId={merchant.id}
              slug={merchant.slug}
              isActive={merchant.isActive}
            />
          ) : null}
        </Section>

        <Section id="teklifler" title="Teklifler">
          <KeyValues
            items={[
              ["Toplam", formatCount(merchant.offersTotal)],
              ["Aktif", formatCount(merchant.offersActive)],
              [
                "Eşleşmemiş aktif",
                <Link
                  key="unmatched"
                  href={hrefWith("/yonetim/katalog/teklifler", {
                    durum: "unmatched",
                    magaza: merchant.id,
                  })}
                >
                  {formatCount(merchant.offersUnmatched)}
                </Link>,
              ],
            ]}
          />
        </Section>

        <Section id="feed" title="Feed (salt okunur)">
          <KeyValues
            items={[
              ["Feed adresi", merchant.feedUrl ?? "—"],
              ["Para birimi", merchant.feed.currency ?? "—"],
              ["Para birimi doğrulandı", merchant.feed.currencyVerified ? "Evet" : "Hayır"],
              ["Kategori ipucu", merchant.feed.categoryHint ?? "—"],
              ["Bootstrap kaynağı", merchant.feed.bootstrapSource ?? "—"],
              ["Tanımlı ayar anahtarları", merchant.feed.keys.join(", ") || "—"],
            ]}
          />
        </Section>

        <Section id="ticari" title="Ticari">
          <KeyValues
            items={[
              ["Affiliate durumu", merchant.affiliateStatus],
              ["Affiliate ağı", merchant.affiliateNetwork ?? "—"],
              [
                "Komisyon",
                merchant.commissionRateBp === null
                  ? "—"
                  : `%${(merchant.commissionRateBp / 100).toLocaleString("tr-TR")}`,
              ],
              ["Deeplink şablonu", merchant.hasDeeplinkTemplate ? "Tanımlı" : "Yok"],
              ["Güven puanı", String(merchant.trustScore)],
              ["Güncellendi", formatDateOrDash(merchant.updatedAt)],
            ]}
          />
        </Section>
      </div>

      {runs ? (
        <Section id="kosular" title="Koşu geçmişi">
          {runs.rows.length === 0 ? (
            <EmptyState title="Koşu yok." description="Bu mağaza için veri toplama çalışmamış." />
          ) : (
            <IngestRunsTable rows={runs.rows} showMerchant={false} />
          )}
          <Pager
            first={beforeId ? path : null}
            next={runs.nextBeforeId ? hrefWith(path, { once: runs.nextBeforeId }) : null}
            nextLabel="Daha eski koşular"
          />
        </Section>
      ) : null}
    </div>
  );
}
