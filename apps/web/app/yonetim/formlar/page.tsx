import { listForms } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { PageHeader, Pager, StatusText } from "../admin-ui.tsx";
import { formatCount, formatDateTime, positiveInt } from "../format.ts";

const KIND_LABELS = { survey: "Anket", onboarding: "Onboarding" } as const;
const AUDIENCE_LABELS = {
  public: "Herkese açık",
  authenticated: "Giriş yapmış",
  early_access: "Erken erişim",
} as const;

/**
 * Form / anket merkezi (docs/decisions/0058). Yalnızca `forms.manage`
 * (yönetici). Geri bildirimden (`/geri-bildirim`) ayrıdır: burada bizim
 * kullanıcıya sorduğumuz yapılandırılmış sorular yönetilir.
 */
export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ sayfa?: string }>;
}) {
  const { actor } = await requireCapability("forms.manage");
  const page = positiveInt((await searchParams).sayfa) ?? 1;
  const { rows, hasNext } = await listForms(getDatabase(), actor, page);

  return (
    <div className={styles.page}>
      <PageHeader title="Formlar">
        <p className={styles.muted}>
          Yayınlanan formlar <code>/anket/&lt;adres&gt;</code> bağlantısıyla paylaşılır.{" "}
          <Link href="/yonetim/formlar/yeni">Yeni form oluştur</Link>
        </p>
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState title="Henüz form yok." description="İlk formu oluştur." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Başlık</th>
                <th scope="col">Tür</th>
                <th scope="col">Durum</th>
                <th scope="col">Hedef kitle</th>
                <th scope="col" className={styles.num}>
                  Yanıt
                </th>
                <th scope="col">Oluşturma</th>
                <th scope="col">İşlemler</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/yonetim/formlar/${row.id}`}>{row.title}</Link>
                    <br />
                    <span className={styles.meta}>/anket/{row.slug}</span>
                  </td>
                  <td>{KIND_LABELS[row.kind]}</td>
                  <td>
                    <StatusText status={row.status} />
                  </td>
                  <td>{AUDIENCE_LABELS[row.audience]}</td>
                  <td className={styles.num}>{formatCount(row.responseCount)}</td>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>
                    <Link href={`/yonetim/formlar/${row.id}`}>
                      {row.status === "published" ? "Düzenle / Kapat" : "Düzenle / Aç"}
                    </Link>
                    {" · "}
                    <Link href={`/yonetim/formlar/${row.id}/sonuclar`}>Sonuçlar</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        prev={page > 1 ? `/yonetim/formlar?sayfa=${page - 1}` : null}
        next={hasNext ? `/yonetim/formlar?sayfa=${page + 1}` : null}
        label={`Sayfa ${page}`}
      />
    </div>
  );
}
