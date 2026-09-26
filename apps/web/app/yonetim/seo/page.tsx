import { getSeoDiagnostics, type SeoSample } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { ErrorNotice, KeyValues, Notice, PageHeader, Section, Tile } from "../admin-ui.tsx";
import { formatCount, formatDateOrDash, hrefWith } from "../format.ts";

function Samples({ items, quality }: { items: SeoSample[]; quality: string }) {
  if (items.length === 0) return <p className={styles.muted}>Yok.</p>;
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.id}>
          <Link href={`/yonetim/katalog/urunler/${item.id}`}>{item.title}</Link>
        </li>
      ))}
      <li>
        <Link href={hrefWith("/yonetim/katalog/urunler", { kalite: quality })}>Tümünü gör</Link>
      </li>
    </ul>
  );
}

/**
 * İç SEO tanısı (Faz 7). Yalnızca Arilla'nın kendi verisi ve sitemap kuralı;
 * Google Search Console verisi DEĞİLDİR.
 */
export default async function SeoPage() {
  const { actor } = await requireCapability("catalog.read");
  const seo = await getSeoDiagnostics(getDatabase(), actor);
  const p = seo.products;

  return (
    <div className={styles.page}>
      <PageHeader title="SEO tanısı">
        <p className={styles.muted}>
          Arilla'nın kendi katalog ve sitemap verisinden üretilir. Search Console verisi değildir:
          tarama, dizine ekleme, gösterim ya da tıklama sayısı burada yok.
        </p>
      </PageHeader>

      <section className={styles.tiles} aria-label="Ürün sayfası sinyalleri">
        <Tile label="Toplam ürün" value={formatCount(p.total)} />
        <Tile
          label="Görselsiz"
          value={formatCount(p.missingImage)}
          note="Sitemap'e girmez, JSON-LD eksik"
          warning={p.missingImage > 0}
        />
        <Tile label="Markasız" value={formatCount(p.missingBrand)} note="JSON-LD brand yok" />
        <Tile label="Fiyatsız" value={formatCount(p.missingPrice)} note="JSON-LD offers yok" />
        <Tile label="Kategorisiz" value={formatCount(p.missingCategory)} note="Sitemap'e girmez" />
        <Tile
          label="Keşfedilmeyen kategoride"
          value={formatCount(p.nonDiscoverableCategory)}
          note="Bilerek dışarıda"
        />
        <Tile
          label="Tek teklifli"
          value={formatCount(p.singleOffer)}
          note="14 gün fiyat geçmişi bekler"
        />
        <Tile label="Teklifsiz" value={formatCount(p.noOffers)} />
      </section>

      <Section id="sitemap" title="Ürün sitemap'i">
        {seo.sitemap ? (
          <>
            <KeyValues
              items={[
                ["Uygun ürün (noindex almaz)", formatCount(seo.sitemap.eligibleTotal)],
                ["Parça sayısı", formatCount(seo.sitemap.shardCount)],
                ["Parça boyutu (üst sınır)", formatCount(seo.sitemap.shardSize)],
                ["En büyük ürün kimliği", formatCount(seo.sitemap.maxProductId)],
              ]}
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Parça</th>
                    <th scope="col" className={styles.num}>
                      Uygun ürün
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {seo.sitemap.shards.map((shard) => (
                    <tr key={shard.shard}>
                      <td className={styles.mono}>{`/sitemaps/urun/${shard.shard}.xml`}</td>
                      <td className={styles.num}>{formatCount(shard.eligible)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {seo.sitemap.eligibleTotal === 0 ? (
              <Notice>
                Hiçbir ürün sitemap koşulunu sağlamıyor (2+ teklif ya da 14 gün fiyat geçmişi,
                görsel, keşfedilebilir kategori).
              </Notice>
            ) : null}
          </>
        ) : (
          <ErrorNotice>Sitemap uygunluk sayımı zaman aşımına uğradı (10 sn).</ErrorNotice>
        )}
      </Section>

      <div className={styles.twoColumns}>
        <Section id="gorselsiz" title="Görselsiz örnekler">
          <Samples items={seo.samples.missingImage} quality="no_image" />
        </Section>
        <Section id="markasiz" title="Markasız örnekler">
          <Samples items={seo.samples.missingBrand} quality="no_brand" />
        </Section>
        <Section id="fiyatsiz" title="Fiyatsız örnekler">
          <Samples items={seo.samples.missingPrice} quality="no_price" />
        </Section>
      </div>

      <Section id="slug" title="Eski adresler (301 yönlendirme)">
        {seo.slugHistory.conflicts > 0 ? (
          <ErrorNotice>
            {`${seo.slugHistory.conflicts} eski adres başka bir canlı ürünün adresiyle çakışıyor.`}
          </ErrorNotice>
        ) : null}
        <KeyValues
          items={[
            ["Kayıtlı eski adres", formatCount(seo.slugHistory.total)],
            ["Canlı ürünle çakışan", formatCount(seo.slugHistory.conflicts)],
          ]}
        />
        {seo.slugHistory.recent.length > 0 ? (
          <ul className={styles.list}>
            {seo.slugHistory.recent.map((row) => (
              <li key={row.oldSlug} className={styles.mono}>
                {`/urun/${row.oldSlug} → /urun/${row.currentSlug} · ${formatDateOrDash(row.createdAt)}`}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}
