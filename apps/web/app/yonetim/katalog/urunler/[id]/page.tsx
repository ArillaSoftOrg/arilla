import { getProductDetail } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/dal.ts";
import styles from "../../../admin.module.css";
import { KeyValues, PageHeader, Section, StatusText } from "../../../admin-ui.tsx";
import { formatDateOrDash, formatKurus, positiveInt, reviewReasonLabel } from "../../../format.ts";

function attributeText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Ürün ayrıntısı (Faz 4): teklifler, varyant kimlikleri, eşleştirme adayları. Salt okunur. */
export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requireCapability("catalog.read");
  const { id } = await params;
  const productId = positiveInt(id);
  if (!productId) notFound();
  const detail = await getProductDetail(getDatabase(), actor, productId);
  if (!detail) notFound();
  const { product } = detail;

  return (
    <div className={styles.page}>
      <PageHeader title={product.title}>
        <p className={styles.muted}>
          <Link href="/yonetim/katalog/urunler">Ürünler</Link>
          {` / #${product.id} · `}
          <Link href={`/urun/${product.slug}`}>Ürün sayfası</Link>
        </p>
      </PageHeader>

      <div className={styles.twoColumns}>
        <Section id="kimlik" title="Kimlik">
          <KeyValues
            items={[
              ["Slug", product.slug],
              ["Marka", product.brandName ?? "—"],
              ["Kategori", product.categoryPath ?? "—"],
              [
                "Keşfedilebilir kategori",
                product.categoryDiscoverable === null
                  ? "—"
                  : product.categoryDiscoverable
                    ? "Evet"
                    : "Hayır",
              ],
              ["GTIN", product.gtin ?? "—"],
              ["MPN", product.mpn ?? "—"],
              ["Model anahtarı", product.modelKey ?? "—"],
              ["Renk", product.color ?? "—"],
              ["Oluşturuldu", formatDateOrDash(product.createdAt)],
            ]}
          />
        </Section>
        <Section id="fiyat" title="Fiyat">
          <KeyValues
            items={[
              ["En düşük", formatKurus(product.minPrice)],
              ["En yüksek", formatKurus(product.maxPrice)],
              ["Teklif / stokta", `${product.offerCount} / ${product.inStockCount}`],
              ["Fiyat güncellendi", formatDateOrDash(product.priceUpdatedAt)],
              ["30 gün en düşük", formatKurus(detail.priceStats?.min30d ?? null)],
              ["90 gün medyan", formatKurus(detail.priceStats?.median90d ?? null)],
              [
                "Yüzdelik",
                detail.priceStats?.currentPercentile === null ||
                detail.priceStats?.currentPercentile === undefined
                  ? "—"
                  : String(detail.priceStats.currentPercentile),
              ],
              ["Şişirilmiş liste fiyatı", detail.priceStats?.listPriceInflated ? "Evet" : "Hayır"],
              [
                "Benzerlik kenarları",
                Object.entries(detail.similarity)
                  .map(([kind, n]) => `${kind} ${n}`)
                  .join(" · ") || "—",
              ],
            ]}
          />
        </Section>
      </div>

      <Section id="ozellikler" title="Öznitelikler">
        <KeyValues
          items={
            Object.keys(product.attributes).length === 0
              ? [["—", "—"]]
              : Object.entries(product.attributes).map(([key, value]) => [
                  key,
                  attributeText(value),
                ])
          }
        />
      </Section>

      <Section id="teklifler" title="Teklifler">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Mağaza</th>
                <th scope="col">Teklif</th>
                <th scope="col" className={styles.num}>
                  Fiyat
                </th>
                <th scope="col">Durum</th>
                <th scope="col">Son görülme</th>
              </tr>
            </thead>
            <tbody>
              {detail.offers.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/yonetim/magazalar/${o.merchantSlug}`}>{o.merchantName}</Link>
                    {o.merchantActive ? null : <span className={styles.statusWarn}> (kapalı)</span>}
                  </td>
                  <td>
                    {o.title}
                    <br />
                    <span className={styles.mono}>{`${o.externalId} · ${o.url ?? "—"}`}</span>
                  </td>
                  <td className={styles.num}>
                    {formatKurus(o.price)}
                    {o.listPrice && o.listPrice !== o.price ? (
                      <>
                        <br />
                        <span className={styles.meta}>{`liste ${formatKurus(o.listPrice)}`}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {o.isActive ? (o.inStock ? "stokta" : "stokta yok") : "pasif"}
                    <br />
                    <span className={styles.meta}>{o.discoverySource}</span>
                  </td>
                  <td>{formatDateOrDash(o.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {detail.offersTruncated ? (
          <p className={styles.muted}>İlk 100 teklif gösteriliyor.</p>
        ) : null}
      </Section>

      <Section id="varyantlar" title="Varyantlar ve barkodlar">
        {detail.variants.length === 0 ? (
          <p className={styles.muted}>Varyant kaydı yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Teklif</th>
                  <th scope="col">Boyut</th>
                  <th scope="col">SKU</th>
                  <th scope="col">GTIN (kaynak)</th>
                  <th scope="col">Stok</th>
                  <th scope="col" className={styles.num}>
                    Fiyat farkı
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.variants.map((v) => (
                  <tr key={v.id}>
                    <td className={styles.num}>{v.offerId}</td>
                    <td>{v.sizeLabel ?? "—"}</td>
                    <td className={styles.mono}>{v.sku ?? "—"}</td>
                    <td className={styles.mono}>
                      {v.gtin ? `${v.gtin} (${v.gtinSource ?? "?"})` : "—"}
                    </td>
                    <td>{v.inStock ? "var" : "yok"}</td>
                    <td className={styles.num}>{formatKurus(v.priceOverride)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.variantsTruncated ? (
          <p className={styles.muted}>İlk 300 varyant gösteriliyor.</p>
        ) : null}
      </Section>

      <Section id="adaylar" title="Eşleştirme adayları">
        {detail.candidates.length === 0 ? (
          <p className={styles.muted}>Aday yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Aday</th>
                  <th scope="col">Teklif</th>
                  <th scope="col" className={styles.num}>
                    Skor
                  </th>
                  <th scope="col">Durum</th>
                </tr>
              </thead>
              <tbody>
                {detail.candidates.map((c) => (
                  <tr key={c.id}>
                    <td className={styles.num}>{c.id}</td>
                    <td className={styles.num}>{c.offerId}</td>
                    <td className={styles.num}>{`${c.score.toFixed(2)} · ${c.method}`}</td>
                    <td>
                      <StatusText status={c.status} />
                      {c.status === "rejected" ? ` · ${reviewReasonLabel(c.reviewReason)}` : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {detail.slugHistory.length > 0 ? (
        <Section id="sluglar" title="Eski adresler (301)">
          <ul className={styles.list}>
            {detail.slugHistory.map((s) => (
              <li key={s.slug} className={styles.mono}>
                {`/urun/${s.slug} · ${formatDateOrDash(s.createdAt)}`}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
