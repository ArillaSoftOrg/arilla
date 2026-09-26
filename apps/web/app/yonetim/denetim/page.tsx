import { listAdminEvents } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { ADMIN_ACTIONS, actionLabel, formatDateTime } from "../format.ts";

interface DenetimSearchParams {
  eylem?: string;
  once?: string;
}

function parseCursor(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,18}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function changeText(value: unknown): string {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 1);
}

/** docs/decisions/0039 madde 5: yalnızca `audit.read` (yönetici). Değiştirilemez kayıt. */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<DenetimSearchParams>;
}) {
  const { actor } = await requireCapability("audit.read");
  const { eylem, once } = await searchParams;
  const action = eylem && ADMIN_ACTIONS.includes(eylem) ? eylem : undefined;
  const beforeId = parseCursor(once);

  const page = await listAdminEvents(getDatabase(), actor, { action, beforeId });

  function href(next: { eylem?: string; once?: number }): string {
    const params = new URLSearchParams();
    if (next.eylem) params.set("eylem", next.eylem);
    if (next.once) params.set("once", String(next.once));
    const qs = params.toString();
    return qs ? `/yonetim/denetim?${qs}` : "/yonetim/denetim";
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Denetim kaydı</h1>
        <p className={styles.muted}>
          Yönetim ekranlarındaki her değişiklik burada, değiştirilemez olarak tutulur. Yeniden
          eskiye.
        </p>
      </header>

      <form action="/yonetim/denetim" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Eylem</span>
          <select name="eylem" defaultValue={action ?? ""}>
            <option value="">Tümü</option>
            {ADMIN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrele</button>
        {action || beforeId ? <Link href="/yonetim/denetim">Temizle</Link> : null}
      </form>

      {page.rows.length === 0 ? (
        <EmptyState title="Kayıt yok." description="Bu filtreye uyan bir değişiklik yapılmamış." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Kişi</th>
                <th scope="col">Eylem</th>
                <th scope="col">Hedef</th>
                <th scope="col">Önce</th>
                <th scope="col">Sonra</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>
                    {row.actorLabel}
                    <br />
                    <span className={styles.meta}>{row.actorRole}</span>
                  </td>
                  <td>{actionLabel(row.action)}</td>
                  <td className={styles.mono}>{`${row.targetType} #${row.targetId}`}</td>
                  <td className={styles.mono}>{changeText(row.before)}</td>
                  <td className={styles.mono}>{changeText(row.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className={styles.pager} aria-label="Sayfalar">
        {beforeId ? <Link href={href({ eylem: action })}>En yeniye dön</Link> : null}
        {page.nextBeforeId ? (
          <Link href={href({ eylem: action, once: page.nextBeforeId })}>Daha eski kayıtlar</Link>
        ) : null}
      </nav>
    </div>
  );
}
