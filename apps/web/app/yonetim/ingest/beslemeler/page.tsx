import { feedsOverview, listFeedErrors } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KpiCard, KpiGroup, PageHeader, Section } from "../../admin-ui.tsx";
import {
  formatCount,
  formatDateOrDash,
  formatDateTime,
  formatKurus,
  positiveInt,
  statusLabel,
} from "../../format.ts";

/**
 * Besleme kaynaklari ve senkronizasyon (karar 0111-0113). Salt okunur:
 * kesif, baglama, senkronizasyon ve dogrulama CLI/zamanlayicidan calisir.
 * Besleme adresinde kimlik parametresi yoktur; hata ayrintisi kirpilmistir.
 */
export default async function FeedSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ besleme?: string }>;
}) {
  const { actor } = await requireCapability("ingest.read");
  const params = await searchParams;
  const selected = positiveInt(params.besleme);
  const db = getDatabase();
  const overview = await feedsOverview(db, actor);
  const errors = selected ? await listFeedErrors(db, actor, selected) : [];
  const v = overview.verification;
  const quote = overview.usdQuote;

  return (
    <div className={styles.page}>
      <PageHeader title="Beslemeler">
        <p className={styles.muted}>
          Affiliate ağlarından keşfedilen beslemeler, son aktarım ve fiyat doğrulama durumu.
          Etkinleştirme ve senkronizasyon komut satırından yapılır (<code>python -m feeds</code>).
        </p>
      </PageHeader>

      <Section id="dogrulama" title="Fiyat doğrulama ve kur">
        <KpiGroup>
          <KpiCard label="Eşleşen (7 gün)" value={formatCount(v.byResult.match ?? 0)} />
          <KpiCard
            label="Farklı fiyat (7 gün)"
            value={formatCount(v.byResult.mismatch ?? 0)}
            tone={(v.byResult.mismatch ?? 0) > 0 ? "warning" : "neutral"}
          />
          <KpiCard label="Satışta değil" value={formatCount(v.byResult.unavailable ?? 0)} />
          <KpiCard label="Bekleyen istek" value={formatCount(v.pending)} />
          <KpiCard
            label="Doğrulama kaynağı yok"
            value={formatCount(v.unsupported)}
            note="İzinli canlı kaynak yoksa sonuç üretilmez."
          />
          <KpiCard
            label="TCMB USD (döviz satış)"
            value={quote ? `${quote.rate.replace(/0+$/, "").replace(/\.$/, "")} TL` : "—"}
            note={
              quote
                ? `Bülten ${quote.bulletin ?? "—"}, ${quote.effectiveDate}. 10 USD ≈ ${formatKurus(overview.usdExample)}`
                : "Kur yok: yaklaşık TL gösterilmez."
            }
            tone={quote && overview.usdExample !== null ? "neutral" : "warning"}
          />
        </KpiGroup>
        <p className={styles.meta}>
          Son doğrulama: {formatDateOrDash(v.lastVerifiedAt)}. Başarısız istek:{" "}
          {formatCount(v.failed)}.
        </p>
      </Section>

      <Section id="kaynaklar" title="Kaynaklar">
        {overview.feeds.length === 0 ? (
          <EmptyState title="Besleme yok." description="Henüz keşif çalıştırılmadı." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Besleme</th>
                  <th>Durum</th>
                  <th>Mağaza</th>
                  <th>Para birimi</th>
                  <th>Son başarılı</th>
                  <th>Son sürüm</th>
                  <th className={styles.num}>Kayıt</th>
                  <th className={styles.num}>Yeni / değişen</th>
                  <th className={styles.num}>Pasifleşen</th>
                  <th className={styles.num}>Hatalı</th>
                  <th className={styles.num}>Teklif</th>
                </tr>
              </thead>
              <tbody>
                {overview.feeds.map((feed) => (
                  <tr key={feed.id}>
                    <td>
                      <Link href={`/yonetim/ingest/beslemeler?besleme=${feed.id}#hatalar`}>
                        {feed.name ?? feed.externalId}
                      </Link>
                      <div className={styles.meta}>
                        {feed.network}:{feed.externalId}
                        {feed.programName ? ` · ${feed.programName}` : ""}
                      </div>
                    </td>
                    <td>
                      {statusLabel(feed.status)}
                      {feed.schemaChangedAt ? (
                        <div className={styles.meta}>
                          Şema değişti: {formatDateTime(feed.schemaChangedAt)}
                        </div>
                      ) : null}
                      {feed.lastErrorCode ? (
                        <div className={styles.meta}>Son hata: {feed.lastErrorCode}</div>
                      ) : null}
                    </td>
                    <td>
                      {feed.merchantSlug ?? "—"}
                      {feed.merchantSlug && feed.merchantActive === false ? (
                        <div className={styles.meta}>mağaza kapalı</div>
                      ) : null}
                    </td>
                    <td>{feed.currency ?? "—"}</td>
                    <td>{formatDateOrDash(feed.lastSuccessAt)}</td>
                    <td>
                      {feed.snapshot ? statusLabel(feed.snapshot.status) : "—"}
                      {feed.snapshot?.rejectReason ? (
                        <div className={styles.meta}>{feed.snapshot.rejectReason}</div>
                      ) : null}
                    </td>
                    <td className={styles.num}>{feed.run ? formatCount(feed.run.seen) : "—"}</td>
                    <td className={styles.num}>
                      {feed.run
                        ? `${formatCount(feed.run.created)} / ${formatCount(feed.run.changed)}`
                        : "—"}
                    </td>
                    <td className={styles.num}>
                      {feed.run ? formatCount(feed.run.deactivated) : "—"}
                    </td>
                    <td className={styles.num}>{formatCount(feed.openErrors)}</td>
                    <td className={styles.num}>{formatCount(feed.memberOffers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {selected ? (
        <Section id="hatalar" title={`Hata kayıtları (besleme ${selected})`}>
          {errors.length === 0 ? (
            <EmptyState title="Hata kaydı yok." description="Bu beslemede reddedilen kayıt yok." />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Zaman</th>
                    <th>Kod</th>
                    <th>Kayıt</th>
                    <th>Kaynak kimliği</th>
                    <th>Ayrıntı</th>
                    <th>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((error) => (
                    <tr key={error.id}>
                      <td>{formatDateTime(error.createdAt)}</td>
                      <td>{error.errorCode}</td>
                      <td>{error.recordRef ?? "—"}</td>
                      <td>{error.externalId ?? "—"}</td>
                      <td className={styles.meta}>{error.detail ?? "—"}</td>
                      <td>{statusLabel(error.status)}</td>
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
