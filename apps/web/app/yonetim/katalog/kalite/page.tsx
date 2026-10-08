import { capabilitiesFor, getCatalogFreshness, getCatalogQualityReport } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import {
  FindingList,
  KeyValues,
  KpiCard,
  PageHeader,
  Panel,
  Section,
  SeverityBadge,
} from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash, formatPercent, imageStatusLabel } from "../../format.ts";

/**
 * Katalog kalitesi (karar 0053). SALT OKUNUR: her denetim zaman aşımlı ve
 * sınırlı (en çok 10 örnek). Düzeltme kontrolü yok; bulgu, sorunu
 * gösteren filtrelenmiş listeye ve örnek varlıklara bağlanır.
 */
export default async function CatalogQualityPage() {
  const { actor } = await requireCapability("catalog.read");
  const allowed = capabilitiesFor(actor.role);
  const [report, fresh] = await Promise.all([
    getCatalogQualityReport(getDatabase(), actor),
    // Karar 0085: tazelik, stok, görsel ve liste fiyatı şişirme (toplam).
    getCatalogFreshness(getDatabase(), actor),
  ]);
  const staleTone = fresh.staleOffers > 0 ? "warning" : "neutral";
  const withSamples = report.findings.filter(
    (f) => f.severity !== "healthy" && f.samples.length > 0,
  );

  return (
    <div className={styles.page}>
      <PageHeader title="Katalog kalitesi">
        <p className={styles.muted}>
          {`Denetim anı ${formatDateOrDash(report.checkedAt)}. Her denetim salt okunur ve zaman aşımlıdır; çalışmayan denetim "Bilinmiyor" olarak görünür, sağlıklı sayılmaz.`}
        </p>
      </PageHeader>

      <Section
        id="tazelik"
        title="Tazelik, stok, görsel ve fiyat"
        description="Aktif teklifler üzerinden tam sayım; tazelik kaynakta son görülme zamanıdır."
      >
        <div className={styles.kpiGrid}>
          <KpiCard
            label="Son 24 saatte görülen teklif"
            value={formatPercent(fresh.seen24h, fresh.activeOffers)}
            note={`${formatCount(fresh.seen24h)} / ${formatCount(fresh.activeOffers)} aktif teklif`}
            basis="count"
          />
          <KpiCard
            label={`${fresh.staleOfferDays} günden eski teklif`}
            value={formatCount(fresh.staleOffers)}
            note={`Son 7 günde görülen: ${formatCount(fresh.seen7d)}`}
            tone={staleTone}
            basis="count"
            href="/yonetim/katalog/teklifler?durum=stale"
          />
          <KpiCard
            label="Stokta olmayan teklif"
            value={formatCount(fresh.outOfStock)}
            note={`Stokta: ${formatCount(fresh.inStock)} · ${formatPercent(fresh.outOfStock, fresh.activeOffers)} stoksuz`}
            basis="count"
          />
          <KpiCard
            label="Görselsiz aktif teklif"
            value={formatCount(fresh.activeOffersWithoutImage)}
            note="Ana görsel ve etkin galeri görseli yok"
            tone={fresh.activeOffersWithoutImage > 0 ? "warning" : "neutral"}
            basis="count"
          />
          <KpiCard
            label="Liste fiyatı şişirilmiş ürün"
            value={formatCount(fresh.inflatedListPrice)}
            note="Fiyat özeti işinin işareti (product_price_stats)"
            basis="count"
          />
          <KpiCard
            label="Kırık görsel"
            value="—"
            note="Görsel canlılığı denetlenmiyor (status='broken' yazılmıyor)"
            basis="unmeasured"
          />
        </div>
        {fresh.images.length > 0 ? (
          <Panel id="galeri" title="Galeri görselleri (offer_image)">
            <KeyValues
              items={fresh.images.map((row) => [
                imageStatusLabel(row.status),
                formatCount(row.count),
              ])}
            />
          </Panel>
        ) : null}
      </Section>

      <Section id="bulgular" title="Bulgular">
        <FindingList
          findings={report.findings.filter((f) => f.severity !== "healthy")}
          allowed={allowed}
          empty="Denetlenen her başlık sağlıklı."
        />
      </Section>

      {withSamples.length > 0 ? (
        <Section id="ornekler" title="Örnekler">
          {withSamples.map((finding) => (
            <div key={finding.key} className={styles.qualityGroup}>
              <div className={styles.findingHead}>
                <SeverityBadge severity={finding.severity} />
                <span className={styles.findingTitle}>{finding.title}</span>
              </div>
              <ul className={styles.samples}>
                {finding.samples.map((sample) => {
                  const href =
                    sample.href && (!sample.capability || allowed.has(sample.capability))
                      ? sample.href
                      : null;
                  return (
                    <li key={`${sample.label}-${sample.href ?? ""}`}>
                      {href ? <Link href={href}>{sample.label}</Link> : sample.label}
                      {sample.detail ? (
                        <span className={styles.meta}>{` · ${sample.detail}`}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {finding.count !== null && finding.count > finding.samples.length ? (
                <p className={styles.meta}>
                  {`${formatCount(finding.samples.length)} örnek / ${formatCount(finding.count)}`}
                </p>
              ) : null}
            </div>
          ))}
        </Section>
      ) : null}

      <Section id="saglikli" title="Sağlıklı denetimler">
        <ul className={styles.list}>
          {report.findings
            .filter((f) => f.severity === "healthy")
            .map((f) => (
              <li key={f.key}>{f.title}</li>
            ))}
        </ul>
      </Section>
    </div>
  );
}
