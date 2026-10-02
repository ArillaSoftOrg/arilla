import { earlyAccessOverview } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { PageHeader, Section, Tile } from "../admin-ui.tsx";
import { earlyAccessStatusLabel, formatCount, formatDateTime } from "../format.ts";
import { SearchFormClient } from "./search-form-client.tsx";

/**
 * Kullanıcı arama (Faz 6). Yalnızca yönetici. Ad ve e-postada kısmi arama,
 * hesap kimliğinde tam eşleşme; sonuçlar sınırlı ve sayfalı (core
 * `searchUsers`). Rol düzenleme, hesap silme ve kimliğe bürünme YOK
 * (docs/decisions/0039). Her arama ve görüntüleme denetim kaydına yazılır.
 *
 * P2: altında salt okunur erken erişim özeti - sayılar ve son kayıtlar.
 * İletişim bilgisi yok, yalnızca hesap kimliği (docs/copy.md
 * `admin.early_access.*`).
 */
export default async function UsersPage() {
  const { actor } = await requireCapability("users.read");
  const earlyAccess = await earlyAccessOverview(getDatabase(), actor);

  return (
    <div className={styles.pageNarrow}>
      <PageHeader title="Kullanıcılar">
        <p className={styles.muted}>
          Kullanıcı ara: adın ya da e-postanın bir kısmı (örn. “arda”, “gmail”) veya tam hesap
          kimliği. Arama ve görüntüleme denetim kaydına yazılır; aranan değer yazılmaz.
        </p>
      </PageHeader>
      <SearchFormClient />

      <Section id="erken-erisim" title="Erken erişim">
        <p className={styles.muted}>
          Listeye katılan hesaplar. Ayrıntı için hesap kimliğine tıkla.
        </p>
        <section className={styles.tiles} aria-label="Erken erişim sayıları">
          <Tile label="Toplam" value={formatCount(earlyAccess.total)} />
          <Tile label="Son 7 gün" value={formatCount(earlyAccess.last7Days)} />
          {earlyAccess.byStatus.map((row) => (
            <Tile
              key={row.status}
              label={earlyAccessStatusLabel(row.status)}
              value={formatCount(row.count)}
            />
          ))}
        </section>
        {earlyAccess.recent.length === 0 ? (
          <p className={styles.muted}>Henüz listeye katılan yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Hesap kimliği</th>
                  <th scope="col">Durum</th>
                  <th scope="col">Kayıt tarihi</th>
                </tr>
              </thead>
              <tbody>
                {earlyAccess.recent.map((row) => (
                  <tr key={row.publicId}>
                    <td>
                      <Link href={`/yonetim/kullanicilar/${row.publicId}`} className={styles.mono}>
                        {row.publicId}
                      </Link>
                    </td>
                    <td>{earlyAccessStatusLabel(row.status)}</td>
                    <td>{formatDateTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
