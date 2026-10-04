import {
  countProductQuality,
  isProductIssueFilter,
  isProductQualityFilter,
  PRODUCT_QUALITY_FILTERS,
  type ProductIssueFilter,
  type ProductQualityFilter,
  searchProducts,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader, Pager, Tile } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash, formatKurus, hrefWith, positiveInt } from "../../format.ts";

const QUALITY_LABELS: Record<ProductQualityFilter, string> = {
  no_brand: "Markasız",
  no_category: "Kategorisiz",
  no_image: "Görselsiz",
  no_offers: "Teklifsiz",
  no_price: "Fiyatsız",
  // Karar 0051: mağaza fiyatının eskiliği DEĞİL; elle çalışan fiyat özeti işinin yaşı.
  stale_price: "Fiyat özeti 7+ gündür yenilenmedi",
};

/** Katalog kalitesi bağlantılarının filtresi (karar 0053); sayaç panelinde yok. */
const ISSUE_LABELS: Record<ProductIssueFilter, string> = {
  no_active_offer: "Aktif teklifi olmayan ürünler (canlı)",
  duplicate_gtin: "Barkodu başka bir üründe de olan ürünler",
};

/** Katalog inceleme (Faz 4). Salt okunur; genel tablo düzenleyici değildir. */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kalite?: string; sorun?: string; sayfa?: string }>;
}) {
  const { actor } = await requireCapability("catalog.read");
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 80) || undefined;
  const quality = isProductQualityFilter(params.kalite) ? params.kalite : undefined;
  const issue = isProductIssueFilter(params.sorun) ? params.sorun : undefined;
  const page = positiveInt(params.sayfa) ?? 1;

  const db = getDatabase();
  const [result, counts] = await Promise.all([
    searchProducts(db, actor, { query, quality, issue, page }),
    countProductQuality(db, actor),
  ]);
  const base = { q: query, kalite: quality, sorun: issue };

  return (
    <div className={styles.page}>
      <PageHeader title="Ürünler">
        <p className={styles.muted}>
          Arama: sayı → ürün kimliği, 8–14 hane → GTIN (ürün ya da varyant), diğer → başlık.
        </p>
        {issue ? (
          <p className={styles.muted}>
            {`Sorun filtresi: ${ISSUE_LABELS[issue]} · `}
            <Link href={hrefWith("/yonetim/katalog/urunler", { q: query, kalite: quality })}>
              Filtreyi kaldır
            </Link>
            {" · "}
            <Link href="/yonetim/katalog/kalite">Katalog kalitesi</Link>
          </p>
        ) : null}
      </PageHeader>

      <section className={styles.tiles} aria-label="Katalog kalitesi">
        <Tile label="Toplam ürün" value={formatCount(counts.total)} />
        {PRODUCT_QUALITY_FILTERS.map((filter) => (
          <Link
            key={filter}
            href={hrefWith("/yonetim/katalog/urunler", { q: query, kalite: filter })}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <Tile
              label={QUALITY_LABELS[filter]}
              value={formatCount(counts[filter])}
              warning={filter === quality}
            />
          </Link>
        ))}
      </section>

      <form action="/yonetim/katalog/urunler" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Kimlik, GTIN ya da başlık</span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ""}
            maxLength={80}
            className={styles.textInput}
          />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Kalite</span>
          <select name="kalite" defaultValue={quality ?? ""}>
            <option value="">Tümü</option>
            {PRODUCT_QUALITY_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {QUALITY_LABELS[filter]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Ara</button>
        {query || quality ? <Link href="/yonetim/katalog/urunler">Temizle</Link> : null}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState title="Ürün yok." description="Bu aramaya uyan ürün bulunamadı." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Ürün</th>
                <th scope="col">Marka / kategori</th>
                <th scope="col" className={styles.num}>
                  En düşük fiyat
                </th>
                <th scope="col" className={styles.num}>
                  Teklif (stokta)
                </th>
                <th scope="col">Fiyat özeti yenilendi</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id}>
                  <td className={styles.num}>{row.id}</td>
                  <td>
                    <Link href={`/yonetim/katalog/urunler/${row.id}`}>{row.title}</Link>
                    <br />
                    <span className={styles.meta}>{row.gtin ? `GTIN ${row.gtin}` : row.slug}</span>
                  </td>
                  <td>
                    {row.brandName ?? <span className={styles.statusWarn}>markasız</span>}
                    <br />
                    <span className={styles.meta}>{row.categoryPath ?? "kategorisiz"}</span>
                  </td>
                  <td className={styles.num}>{formatKurus(row.minPrice)}</td>
                  <td className={styles.num}>{`${row.offerCount} (${row.inStockCount})`}</td>
                  <td>{formatDateOrDash(row.priceUpdatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        prev={
          result.page > 1
            ? hrefWith("/yonetim/katalog/urunler", { ...base, sayfa: result.page - 1 })
            : null
        }
        next={
          result.hasNext
            ? hrefWith("/yonetim/katalog/urunler", { ...base, sayfa: result.page + 1 })
            : null
        }
        label={result.page > 1 || result.hasNext ? `Sayfa ${result.page}` : undefined}
      />
    </div>
  );
}
