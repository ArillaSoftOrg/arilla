import { capabilitiesFor, getCatalogQualityReport } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { FindingList, PageHeader, Section, SeverityBadge } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash } from "../../format.ts";

/**
 * Katalog kalitesi (karar 0053). SALT OKUNUR: her denetim zaman aşımlı ve
 * sınırlı (en çok 10 örnek). Düzeltme kontrolü yok; bulgu, sorunu
 * gösteren filtrelenmiş listeye ve örnek varlıklara bağlanır.
 */
export default async function CatalogQualityPage() {
  const { actor } = await requireCapability("catalog.read");
  const allowed = capabilitiesFor(actor.role);
  const report = await getCatalogQualityReport(getDatabase(), actor);
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
