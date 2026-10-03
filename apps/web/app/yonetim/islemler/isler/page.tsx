import { JOB_RUN_STATUSES, jobLabel, KNOWN_JOBS, listJobRuns } from "@arilla/core";
import { getDatabase, type JobRunStatus } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader, Pager, StatusText } from "../../admin-ui.tsx";
import {
  formatDateTime,
  formatDuration,
  formatJobDetail,
  hrefWith,
  jobTriggerLabel,
  positiveInt,
  statusLabel,
} from "../../format.ts";

const JOB_PARAM = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * İş koşuları geçmişi (`job_run`, karar 0055). Yalnızca yönetici
 * (`operations.read`). Salt okunur: şimdi çalıştır / yeniden dene YOK.
 * `detail` düz sayılardır; hata özeti yazılırken adreslerden arındırılmıştır.
 */
export default async function JobRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ is?: string; durum?: string; once?: string }>;
}) {
  const { actor } = await requireCapability("operations.read");
  const params = await searchParams;
  const job = params.is && JOB_PARAM.test(params.is) ? params.is : undefined;
  const status = (JOB_RUN_STATUSES as readonly string[]).includes(params.durum ?? "")
    ? (params.durum as JobRunStatus)
    : undefined;
  const beforeId = positiveInt(params.once);
  const runs = await listJobRuns(getDatabase(), actor, { job, status, beforeId });
  const base = { is: job, durum: status };

  return (
    <div className={styles.page}>
      <PageHeader title="İş koşuları">
        <p className={styles.muted}>
          Python boru hattı işleri ve zamanlanmış uçların her koşusu. 180 gün saklanır. Mağaza
          başına toplama ayrıntısı <Link href="/yonetim/ingest">Veri toplama</Link> sayfasındadır.
        </p>
      </PageHeader>

      <form action="/yonetim/islemler/isler" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>İş</span>
          <select name="is" defaultValue={job ?? ""}>
            <option value="">Tümü</option>
            {Object.entries(KNOWN_JOBS).map(([name, meta]) => (
              <option key={name} value={name}>
                {meta.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={status ?? ""}>
            <option value="">Tümü</option>
            {JOB_RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrele</button>
        {job || status ? <Link href="/yonetim/islemler/isler">Temizle</Link> : null}
      </form>

      {runs.rows.length === 0 ? (
        <EmptyState title="Koşu yok." description="Bu filtreye uyan iş koşusu kaydı yok." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">İş</th>
                <th scope="col">Başladı</th>
                <th scope="col">Durum</th>
                <th scope="col">Süre</th>
                <th scope="col">Ayrıntı</th>
              </tr>
            </thead>
            <tbody>
              {runs.rows.map((run) => (
                <tr key={run.id}>
                  <td>
                    {jobLabel(run.job)}
                    <span className={styles.meta} style={{ display: "block" }}>
                      {`${run.job} · ${jobTriggerLabel(run.trigger)}`}
                    </span>
                  </td>
                  <td>{formatDateTime(run.startedAt)}</td>
                  <td>
                    <StatusText status={run.status} />
                  </td>
                  <td>{formatDuration(run.durationMs)}</td>
                  <td>
                    <span className={styles.meta}>{formatJobDetail(run.detail)}</span>
                    {run.errorSummary ? (
                      <span className={styles.mono} style={{ display: "block" }}>
                        {run.errorSummary}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        first={beforeId ? hrefWith("/yonetim/islemler/isler", base) : null}
        next={
          runs.nextBeforeId
            ? hrefWith("/yonetim/islemler/isler", { ...base, once: runs.nextBeforeId })
            : null
        }
        nextLabel="Daha eski koşular"
      />
    </div>
  );
}
