import { isOfferState, listOffers, type OfferState } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader, Pager } from "../../admin-ui.tsx";
import { formatDateOrDash, formatKurus, hrefWith, positiveInt } from "../../format.ts";

const STATE_LABELS: Record<OfferState, string> = {
  unmatched: "Eşleşmemiş (aktif)",
  inactive: "Pasif",
  stale: "Bayat (7 gündür görülmedi)",
  all: "Tümü",
};

/** Teklif inceleme (Faz 4): eşleşmemiş, pasif ve bayat teklifler. Salt okunur. */
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string; magaza?: string; q?: string; once?: string }>;
}) {
  const { actor } = await requireCapability("catalog.read");
  const params = await searchParams;
  const state: OfferState = isOfferState(params.durum) ? params.durum : "unmatched";
  const merchantId = positiveInt(params.magaza);
  const query = params.q?.trim().slice(0, 80) || undefined;
  const beforeId = positiveInt(params.once);

  const result = await listOffers(getDatabase(), actor, { state, merchantId, query, beforeId });
  const base = { durum: state, magaza: merchantId, q: query };

  return (
    <div className={styles.page}>
      <PageHeader title="Teklifler">
        <p className={styles.muted}>
          Eşleşmemiş teklifler gece eşleştirmesinde ürüne bağlanır ya da kuyruğa düşer.
        </p>
      </PageHeader>

      <form action="/yonetim/katalog/teklifler" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={state}>
            {(Object.keys(STATE_LABELS) as OfferState[]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Başlık ya da mağaza ürün kimliği</span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ""}
            maxLength={80}
            className={styles.textInput}
          />
        </label>
        {merchantId ? <input type="hidden" name="magaza" value={merchantId} /> : null}
        <button type="submit">Filtrele</button>
        {merchantId || query || state !== "unmatched" ? (
          <Link href="/yonetim/katalog/teklifler">Temizle</Link>
        ) : null}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState title="Teklif yok." description="Bu filtreye uyan teklif bulunamadı." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Teklif</th>
                <th scope="col">Mağaza</th>
                <th scope="col" className={styles.num}>
                  Fiyat
                </th>
                <th scope="col">Ürün</th>
                <th scope="col">Son görülme</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((o) => (
                <tr key={o.id}>
                  <td className={styles.num}>{o.id}</td>
                  <td>
                    {o.title}
                    <br />
                    <span className={styles.meta}>
                      {`${o.brand ?? "markasız"} · ${o.externalId}${o.isActive ? "" : " · pasif"}`}
                    </span>
                  </td>
                  <td>
                    <Link href={`/yonetim/magazalar/${o.merchantSlug}`}>{o.merchantName}</Link>
                  </td>
                  <td className={styles.num}>{formatKurus(o.price)}</td>
                  <td>
                    {o.productId ? (
                      <Link href={`/yonetim/katalog/urunler/${o.productId}`}>
                        {o.productSlug ?? `#${o.productId}`}
                      </Link>
                    ) : o.pendingCandidates > 0 ? (
                      <Link href="/yonetim/eslestirme">{`${o.pendingCandidates} aday kuyrukta`}</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{formatDateOrDash(o.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        first={beforeId ? hrefWith("/yonetim/katalog/teklifler", base) : null}
        next={
          result.nextBeforeId
            ? hrefWith("/yonetim/katalog/teklifler", { ...base, once: result.nextBeforeId })
            : null
        }
        nextLabel="Daha eski teklifler"
      />
    </div>
  );
}
