import type { CappedCount, CatalogFunnel } from "@arilla/core";
import styles from "../../admin.module.css";
import { KpiCard, KpiGroup, Section } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash } from "../../format.ts";

/** Kapida tutulma nedenleri (karar 0121/0129). Bilinmeyen kod oldugu gibi gosterilir. */
const HOLD_TEXT: Record<string, string> = {
  source_offer_missing: "Fiyatlı teklif yok (keşif kaydı, fiyat bekliyor)",
  no_price: "Teklifte fiyat yok",
  source_offer_inactive: "Kaynak teklif pasif",
  stale_source_offer: "Kaynak teklif 7 gündür görülmedi",
  offer_linked_elsewhere: "Teklif başka ürüne bağlı",
  offer_not_linkable: "Teklif bağlanamadı",
  no_image: "Görsel yok",
  bad_image: "Görsel geçersiz",
  title_missing: "Başlık yok",
  source_id_url_mismatch: "Kimlik ile adres uyuşmuyor",
};

/** Aktarimda atlanma nedenleri (catalog_build). */
const SKIP_TEXT: Record<string, string> = {
  ...HOLD_TEXT,
  inactive: "Teklif pasif",
  source_id_invalid: "Kimlik biçimi geçersiz",
  no_title: "Kaynakta ad yok",
  title_too_short: "Ad çok kısa",
  title_too_long: "Ad çok uzun",
  title_not_text: "Ad metin değil",
  title_repetitive: "Ad tekrarlı",
  title_has_url: "Adda adres var",
  title_placeholder: "Ad yer tutucu",
  slug_conflict: "Adres (slug) çakışması",
  discovery_kind_conflict: "Aynı kod -p-/-pm- farklı türde (bağlanmadı)",
};

function countText(c: CappedCount): string {
  return c.capped ? `en az ${formatCount(c.value)}` : formatCount(c.value);
}

function ReasonTable({ title, rows }: { title: string; rows: Record<string, number> }) {
  const entries = Object.entries(rows).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Neden</th>
            <th className="num">Kayıt</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([code, n]) => (
            <tr key={code}>
              <td>{SKIP_TEXT[code] ?? code}</td>
              <td className="num">{formatCount(n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Iki toplayicinin merkezi katalogdaki ilerleyisi (karar 0129). Sayilar
 * `getCatalogFunnel` ile salt okunur; buyuk tablolarda ust sinirli ("en az").
 */
export function CatalogFunnelSection({ funnel }: { funnel: CatalogFunnel }) {
  const f = funnel;
  const unpriced = f.discovery.total.capped
    ? null
    : Math.max(
        0,
        f.discovery.total.value -
          f.discovery.listingPrice -
          f.discovery.pageVerified -
          f.discovery.stale,
      );
  return (
    <Section
      id="katalog"
      title="Kataloğa aktarım"
      description="Toplanan kayıtlar doğrudan yayına çıkmaz: birleştirme (hb-merge) → taslak ürün (catalog_build) → kalite kapısı → açık yayın. Fiyatsız keşif kaydı teklif ya da fiyat üretmez; -p- ve -pm- kodları birbirine bağlanmaz."
    >
      {f.merchantFound ? null : (
        <p className={styles.muted}>
          Hepsiburada mağaza kaydı yok; birleştirme için önce mağaza kaydı açılmalı (python -m feeds
          ensure-merchant).
        </p>
      )}
      <KpiGroup label="Kaynak kayıtları">
        <KpiCard
          label="Arama toplayıcısı kaydı"
          value={countText(f.intake.total)}
          note={`Birleştirilen ${countText(f.intake.merged)} · bekleyen ${formatCount(f.intake.pending)}`}
          tone={f.intake.pending > 0 ? "warning" : "neutral"}
        />
        <KpiCard
          label="Sitemap keşif kaydı"
          value={countText(f.discovery.total)}
          note={`Fiyatı görülen ${formatCount(f.discovery.listingPrice + f.discovery.pageVerified)}${
            unpriced === null ? "" : ` · fiyatsız ${formatCount(unpriced)}`
          }`}
        />
        <KpiCard
          label="Birleştirilmiş kayıt (teklif)"
          value={formatCount(f.offers.total)}
          note={`Aktif ${formatCount(f.offers.active)} · ürüne bağlı ${formatCount(f.offers.linkedToProduct)} · stok bilinmiyor ${formatCount(f.offers.stockUnknown)}`}
        />
      </KpiGroup>
      <KpiGroup label="Ürün aşamaları">
        <KpiCard
          label="Ürüne aktarılan"
          value={formatCount(f.products.total)}
          note={`Taslak ${formatCount(f.products.draft)} · hazır ${formatCount(f.products.ready)} · beklemede ${formatCount(f.products.held)}`}
        />
        <KpiCard
          label="Fiyatı olan ürün"
          value={formatCount(f.pricedProducts)}
          note="Kaynak listesindeki gerçek fiyat; ürün sayfasıyla ayrıca doğrulanmadı."
        />
        <KpiCard
          label="Fiyat bekleyen ürün"
          value={formatCount(f.awaitingPriceProducts)}
          note="Keşiften gelen, fiyatlı teklifi henüz olmayan taslaklar (yayına çıkamaz)."
        />
        <KpiCard label="Yayınlanan ürün" value={formatCount(f.products.published)} />
        <KpiCard
          label="Hatalı / incelemede"
          value={formatCount(f.problems.priceJumpHeld)}
          note="Fiyat sıçraması nedeniyle teklife yazılmayan kayıt (ingest_error)."
          tone={f.problems.priceJumpHeld > 0 ? "warning" : "neutral"}
        />
      </KpiGroup>
      <p className={styles.muted}>
        {`Teklif aktarımı son tamamlanma: ${formatDateOrDash(f.checkpoints.offerBuildCompletedAt)} · keşif aktarımı son tamamlanma: ${formatDateOrDash(f.checkpoints.discoveryBuildCompletedAt)}${
          f.checkpoints.discoveryBuildLastId
            ? ` (son kimlik ${f.checkpoints.discoveryBuildLastId})`
            : ""
        }`}
      </p>
      <ReasonTable title="Kapıda bekleyen ürünler" rows={f.products.heldReasons} />
      <ReasonTable title="Teklif aktarımında atlananlar" rows={f.problems.offerBuildSkipped} />
      <ReasonTable title="Keşif aktarımında atlananlar" rows={f.problems.discoveryBuildSkipped} />
    </Section>
  );
}
