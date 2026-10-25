import { allowedTrendTransitions, getTrendEditor } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KeyValues, Notice, PageHeader, Panel, StatusBadge } from "../../admin-ui.tsx";
import {
  formatDateOrDash,
  positiveInt,
  trendCategoryLabel,
  trendCurationLabel,
  trendStatusLabel,
  trendTypeLabel,
} from "../../format.ts";
import { toCardView } from "../card-view.ts";
import { TrendActionsClient } from "../trend-actions-client.tsx";
import { TrendCurationClient } from "../trend-curation-client.tsx";
import { TrendFormClient } from "../trend-form-client.tsx";
import { TrendProductsClient } from "../trend-products-client.tsx";

/**
 * Koleksiyon ayrıntısı (karar 0149, `trends.manage`): ayrıntılar, tür (elle/otomatik), ürünler
 * ve hazırlık. Durum, öne çıkarma ve sıra mevcut trend işlemleriyle (karar 0086) yapılır.
 */
export default async function TrendDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requireCapability("trends.manage");
  const id = positiveInt((await params).id);
  if (!id) notFound();
  const editor = await getTrendEditor(getDatabase(), actor, id);
  if (!editor) notFound();
  const manual = editor.curation === "manual";
  const editable = manual && editor.status !== "archived";
  const products = editor.products.map(toCardView);
  const advisories = editor.products.filter((p) => p.showable && p.warnings.length > 0).length;

  return (
    <div className={styles.page}>
      <PageHeader
        title={editor.details.title}
        description={`/trendler/${editor.slug} · ${trendCategoryLabel(editor.details.category)} · ${trendTypeLabel(editor.details.trendType)}`}
        actions={
          <span className={styles.row}>
            <Link href="/yonetim/trendler">Trendlere dön</Link>
            <TrendActionsClient
              row={{
                id: editor.id,
                title: editor.details.title,
                status: editor.status,
                featured: editor.featured,
                transitions: allowedTrendTransitions(editor.status),
                belowThreshold: !editor.meetsThreshold,
                isFirst: false,
                isLast: false,
              }}
            />
          </span>
        }
      />

      <Panel id="hazirlik" title="Hazırlık">
        <KeyValues
          items={[
            [
              "Durum",
              <StatusBadge key="s" tone={editor.status === "published" ? "success" : "neutral"}>
                {trendStatusLabel(editor.status)}
              </StatusBadge>,
            ],
            ["Tür", trendCurationLabel(editor.curation)],
            ["Öne çıkan", editor.featured ? "Evet" : "Hayır"],
            [
              "Gösterilebilir ürün",
              `${editor.showableProducts} / ${editor.products.length} (en az ${editor.minProducts})`,
            ],
            [
              "Yayına uygunluk",
              editor.meetsThreshold ? (
                <StatusBadge key="r" tone="success">
                  Eşik sağlanıyor
                </StatusBadge>
              ) : (
                <StatusBadge key="r" tone="warning">
                  {`Eşik altı: ${editor.minProducts - editor.showableProducts} ürün daha gerekli`}
                </StatusBadge>
              ),
            ],
            ["Uyarılı gösterilebilir ürün", String(advisories)],
            [
              "Yayın penceresi",
              `${formatDateOrDash(editor.details.activeFrom)} – ${formatDateOrDash(editor.details.activeUntil)}`,
            ],
          ]}
        />
        {advisories > 0 ? (
          <p className={styles.statusWarn}>
            Bazı ürünlerde fiyat tazeliği ya da teklif uyarısı var. Yayından önce ürün kartlarını
            kontrol et; uyarılar orijinallik iddiası değildir, verinin tazeliğini gösterir.
          </p>
        ) : null}
      </Panel>

      <Panel
        id="urunler"
        title="Ürünler"
        description={
          manual
            ? editor.status === "archived"
              ? "Arşivdeki koleksiyonun ürünleri değişmez; önce taslağa al."
              : "Elle seçilmiş: sırayı ve ürünleri sen belirlersin; otomatik küratör dokunmaz."
            : "Otomatik: ürünleri curate toplu işi seçer. Elle yönetmek için türü değiştir."
        }
        actions={<TrendCurationClient trendId={editor.id} curation={editor.curation} />}
      >
        <TrendProductsClient
          key={products.map((p) => p.id).join(",")}
          trendId={editor.id}
          initial={products}
          editable={editable}
          minProducts={editor.minProducts}
          maxProducts={editor.maxProducts}
          published={editor.status === "published"}
        />
      </Panel>

      <Panel id="ayrintilar" title="Ayrıntılar">
        <TrendFormClient
          key={JSON.stringify(editor.details)}
          mode="edit"
          trendId={editor.id}
          slug={editor.slug}
          initial={{
            ...editor.details,
            activeFrom: editor.details.activeFrom?.toISOString() ?? null,
            activeUntil: editor.details.activeUntil?.toISOString() ?? null,
          }}
        />
      </Panel>

      <Notice title="Kapsam">
        Ürün, teklif, fiyat ve stok verisi bu ekrandan değişmez. Her işlem gerekçesiyle denetim
        kaydına yazılır; arada başka biri değiştirdiyse kayıt reddedilir ve sayfayı yenilemen
        istenir.
      </Notice>
    </div>
  );
}
