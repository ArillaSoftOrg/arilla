import { isMerchantSourceType, listMerchants, MERCHANT_SOURCE_TYPES } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { PageHeader, Pager, StatusText } from "../admin-ui.tsx";
import { formatCount, formatDateOrDash, hrefWith, positiveInt } from "../format.ts";

interface MagazalarSearchParams {
  durum?: string;
  kaynak?: string;
  q?: string;
  sayfa?: string;
}

/** docs/routes.md §Yönetim: mağaza listesi (Faz 2). Salt okunur; aç/kapat ayrıntıda. */
export default async function MerchantsPage({
  searchParams,
}: {
  searchParams: Promise<MagazalarSearchParams>;
}) {
  const { actor } = await requireCapability("merchant.read");
  const params = await searchParams;
  const active = params.durum === "aktif" ? true : params.durum === "pasif" ? false : undefined;
  const sourceType = isMerchantSourceType(params.kaynak) ? params.kaynak : undefined;
  const search = params.q?.trim().slice(0, 80) || undefined;
  const page = positiveInt(params.sayfa) ?? 1;

  const result = await listMerchants(getDatabase(), actor, { active, sourceType, search, page });
  const base = { durum: params.durum, kaynak: sourceType, q: search };

  return (
    <div className={styles.page}>
      <PageHeader title="Mağazalar">
        <p className={styles.muted}>
          Feed ayarları, komisyon ve para birimi kanıtı burada düzenlenmez; kaynakta ve komut
          satırında kalır.
        </p>
      </PageHeader>

      <form action="/yonetim/magazalar" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={params.durum ?? ""}>
            <option value="">Tümü</option>
            <option value="aktif">Aktif</option>
            <option value="pasif">Pasif</option>
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Kaynak</span>
          <select name="kaynak" defaultValue={sourceType ?? ""}>
            <option value="">Tümü</option>
            {MERCHANT_SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Ad, kısa ad ya da alan adı</span>
          <input type="search" name="q" defaultValue={search ?? ""} maxLength={80} />
        </label>
        <button type="submit">Filtrele</button>
        {params.durum || sourceType || search ? (
          <Link href="/yonetim/magazalar">Temizle</Link>
        ) : null}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState title="Mağaza yok." description="Bu filtreye uyan mağaza bulunamadı." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Mağaza</th>
                <th scope="col">Kaynak</th>
                <th scope="col">Durum</th>
                <th scope="col">Para birimi</th>
                <th scope="col" className={styles.num}>
                  Teklif (aktif / toplam)
                </th>
                <th scope="col" className={styles.num}>
                  Eşleşmemiş
                </th>
                <th scope="col">Son koşu</th>
                <th scope="col">Son başarılı</th>
                <th scope="col" className={styles.num}>
                  Ardışık hata
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/yonetim/magazalar/${row.slug}`}>{row.name}</Link>
                    <br />
                    <span className={styles.meta}>{row.domain}</span>
                  </td>
                  <td>{row.sourceType}</td>
                  <td>
                    {row.isActive ? "Aktif" : <span className={styles.statusWarn}>Pasif</span>}
                  </td>
                  <td>
                    {row.currency ?? "—"}
                    {row.sourceType === "shopify" ? (
                      <>
                        <br />
                        <span className={row.currencyVerified ? styles.meta : styles.statusWarn}>
                          {row.currencyVerified ? "doğrulandı" : "doğrulanmadı"}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className={styles.num}>
                    {`${formatCount(row.offersActive)} / ${formatCount(row.offersTotal)}`}
                  </td>
                  <td className={styles.num}>{formatCount(row.offersUnmatched)}</td>
                  <td>
                    {row.lastRun ? (
                      <>
                        <StatusText status={row.lastRun.status} />
                        <br />
                        <span className={styles.meta}>
                          {formatDateOrDash(row.lastRun.startedAt)}
                        </span>
                      </>
                    ) : (
                      "Hiç çalışmadı"
                    )}
                  </td>
                  <td>{formatDateOrDash(row.lastSuccessAt)}</td>
                  <td className={styles.num}>
                    {row.failuresSinceSuccess > 0 ? (
                      <span className={styles.statusBad}>{row.failuresSinceSuccess}</span>
                    ) : (
                      0
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        prev={
          result.page > 1
            ? hrefWith("/yonetim/magazalar", { ...base, sayfa: result.page - 1 })
            : null
        }
        next={
          result.hasNext
            ? hrefWith("/yonetim/magazalar", { ...base, sayfa: result.page + 1 })
            : null
        }
        label={result.page > 1 || result.hasNext ? `Sayfa ${result.page}` : undefined}
      />
    </div>
  );
}
