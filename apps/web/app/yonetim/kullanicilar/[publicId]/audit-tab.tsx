import type { UserAuditView } from "@arilla/core";
import styles from "../../admin.module.css";
import { Pager, Section } from "../../admin-ui.tsx";
import { actionLabel, formatDateTime } from "../../format.ts";

function changeText(value: unknown): string {
  return value === null || value === undefined ? "—" : JSON.stringify(value);
}

/** Denetim sekmesi (`users.read` + `audit.read`): bu hesabı hedef alan yönetim kayıtları. */
export function AuditTab({
  view,
  first,
  next,
}: {
  view: UserAuditView;
  first: string | null;
  next: (beforeId: number | null) => string | null;
}) {
  return (
    <Section id="denetim" title="Bu hesapla ilgili yönetim kayıtları">
      <p className={styles.muted}>
        Kim, ne zaman, hangi işlemi yaptı. Kayıtlarda aranan değer, e-posta ya da telefon yoktur.
      </p>
      {view.events.rows.length === 0 ? (
        <p className={styles.muted}>Kayıt yok.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Kişi</th>
                <th scope="col">Eylem</th>
                <th scope="col">Ayrıntı</th>
              </tr>
            </thead>
            <tbody>
              {view.events.rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>{row.actorLabel}</td>
                  <td>{actionLabel(row.action)}</td>
                  <td className={styles.mono}>{changeText(row.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager first={first} next={next(view.events.nextBeforeId)} nextLabel="Daha eski kayıtlar" />
    </Section>
  );
}
