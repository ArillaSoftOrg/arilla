import { listCampaigns } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { Notice, PageHeader, Pager, Section, StatusText } from "../admin-ui.tsx";
import { formatCount, formatDateOrDash, formatDateTime, positiveInt } from "../format.ts";
import { CampaignFormClient } from "./campaign-form-client.tsx";

/**
 * Pazarlama e-postası kampanyaları (docs/decisions/0048). Yalnızca
 * `marketing.manage` (yönetici). Listeden gönderim yapılmaz: gerçek gönderim
 * yalnızca kampanya sayfasında, test ve onaydan sonra.
 */
export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ sayfa?: string }>;
}) {
  const { actor } = await requireCapability("marketing.manage");
  const page = positiveInt((await searchParams).sayfa) ?? 1;
  const { rows, hasNext } = await listCampaigns(getDatabase(), actor, page);

  return (
    <div className={styles.page}>
      <PageHeader title="E-posta kampanyaları">
        <p className={styles.muted}>
          Yalnızca pazarlama e-postası iznini vermiş, doğrulanmış adresli hesaplara gider. İzin, her
          ileti gönderilmeden hemen önce yeniden denetlenir.
        </p>
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState title="Henüz kampanya yok." description="Aşağıdan ilk taslağı oluştur." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Kampanya</th>
                <th scope="col">Durum</th>
                <th scope="col">Oluşturma</th>
                <th scope="col">Oluşturan</th>
                <th scope="col" className={styles.num}>
                  Alıcı
                </th>
                <th scope="col" className={styles.num}>
                  Sağlayıcıya verildi
                </th>
                <th scope="col" className={styles.num}>
                  Başarısız
                </th>
                <th scope="col" className={styles.num}>
                  Atlandı
                </th>
                <th scope="col">Gönderim / bitiş</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.publicId}>
                  <td>
                    <Link href={`/yonetim/kampanyalar/${row.publicId}`}>{row.title}</Link>
                    <br />
                    <span className={styles.meta}>{row.subject}</span>
                  </td>
                  <td>
                    <StatusText status={row.status} />
                  </td>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>{row.creatorLabel ?? "—"}</td>
                  <td className={styles.num}>
                    {row.recipientCount === null ? "—" : formatCount(row.recipientCount)}
                  </td>
                  <td className={styles.num}>{formatCount(row.counts.sent)}</td>
                  <td className={styles.num}>{formatCount(row.counts.failed)}</td>
                  <td className={styles.num}>{formatCount(row.counts.skipped)}</td>
                  <td>
                    {formatDateOrDash(row.sendStartedAt)}
                    <br />
                    <span className={styles.meta}>{formatDateOrDash(row.completedAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Notice>
        "Sağlayıcıya verildi", e-posta sağlayıcısının iletiyi kabul ettiği anlamına gelir; alıcının
        kutusuna ulaştığını göstermez.
      </Notice>
      <Pager
        prev={page > 1 ? `/yonetim/kampanyalar?sayfa=${page - 1}` : null}
        next={hasNext ? `/yonetim/kampanyalar?sayfa=${page + 1}` : null}
        label={`Sayfa ${page}`}
      />

      <Section id="yeni-kampanya" title="Yeni kampanya">
        <CampaignFormClient mode="create" />
      </Section>
    </div>
  );
}
