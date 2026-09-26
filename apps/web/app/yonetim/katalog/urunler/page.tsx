import {
  countProductQuality,
  isProductQualityFilter,
  PRODUCT_QUALITY_FILTERS,
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
  stale_price: "Fiyatı bayat (7 gün)",
};

/** Katalog inceleme (Faz 4). Salt okunur; genel tablo düzenleyici değildir. */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kalite?: string; sayfa?: string }>;
}) {
  const { actor } = await requireCapability("catalog.read");
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 80) || undefined;
  const quality = isProductQualityFilter(params.kalite) ? params.kalite : undefined;
  const page = positiveInt(params.sayfa) ?? 1;

  const db = getDatabase();
  const [result, counts] = await Promise.all([
    searchProducts(db, actor, { query, quality, page }),
    countProductQuality(db, actor),
  ]);
  const base = { q: query, kalite: quality };

  return (
    <div className={styles.page}>
      <PageHeader title="Ürünler">
        <p className={styles.muted}>
          Arama: sayı → ürün kimliği, 8–14 hane → GTIN (ürün ya da varyant), diğer → başlık.
        </p>
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
                <th scope="col">Fiyat güncel</th>
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
