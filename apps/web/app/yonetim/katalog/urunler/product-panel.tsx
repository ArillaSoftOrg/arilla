import type { ProductPanel, ProductPanelOffer } from "@arilla/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "../../admin-ui.tsx";
import { formatDateOrDash, formatKurus, formatMinor } from "../../format.ts";
import {
  brandBasisLabel,
  categoryBasisLabel,
  classificationBadge,
  classificationDetailLabel,
  confidenceTone,
  publicationBadge,
} from "./product-labels.ts";
import { ProductThumb } from "./product-thumb-client.tsx";
import local from "./products.module.css";

/**
 * Sağ panel içeriği (sunucu bileşeni). Salt okunur: kategori ve marka elle
 * düzenlenemez — bugün denetimli bir yazma yolu yok (bkz. karar 0039 ve 0133;
 * elle karar, sınıflandırıcının sonraki sürümde ezmeyeceği biçimde ayrı bir
 * kararla gelmeli). Panel kararın dayanağını olduğu gibi gösterir.
 */
export function ProductPanelView({ panel, titleId }: { panel: ProductPanel; titleId: string }) {
  const pub = publicationBadge(panel.publicationState);
  const c = panel.classification;
  const cls = classificationBadge(c?.state ?? null);

  return (
    <>
      <div className={local.panelHero}>
        <ProductThumb
          src={panel.imageUrl}
          size={96}
          lazy={false}
          className={local.panelImage}
          emptyClassName={local.panelImageEmpty}
        />
        <div>
          <h2 id={titleId} tabIndex={-1} className={local.panelTitle}>
            {panel.title}
          </h2>
          <span className={local.badges}>
            <StatusBadge tone={pub.tone}>{pub.label}</StatusBadge>
            <StatusBadge tone={cls.tone}>{`Sınıflandırma: ${cls.label}`}</StatusBadge>
          </span>
          <span className={local.panelLinks}>
            <Link href={`/yonetim/katalog/urunler/${panel.id}`}>Tüm ayrıntı</Link>
            {panel.publicationState === "published" ? (
              <Link href={`/urun/${panel.slug}`}>Ürün sayfası</Link>
            ) : null}
          </span>
        </div>
      </div>

      <PanelSection title="Kimlik">
        <dl className={local.facts}>
          <Fact label="Ürün kimliği">
            <span className={local.mono}>{`#${panel.id}`}</span>
          </Fact>
          <Fact label="Genel kimlik">
            <span className={local.mono}>{panel.publicId}</span>
          </Fact>
          <Fact label="Slug">
            <span className={local.mono}>{panel.slug}</span>
          </Fact>
          <Fact label="GTIN">{panel.gtin ?? "—"}</Fact>
          {panel.holdReason ? (
            <Fact label="Bekleme nedeni">
              <span className={local.mono}>{panel.holdReason}</span>
            </Fact>
          ) : null}
        </dl>
      </PanelSection>

      <PanelSection title="Kaynak">
        <dl className={local.facts}>
          <Fact label="Kaynak mağaza">
            {panel.sourceMerchant ? (
              <Link href={`/yonetim/magazalar/${panel.sourceMerchant.slug}`}>
                {panel.sourceMerchant.name}
              </Link>
            ) : (
              "— (eşleştirmeyle oluşmuş ürün)"
            )}
          </Fact>
          <Fact label="Kaynak ilan kimliği">
            {panel.sourceExternalId ? (
              <span className={local.mono}>{panel.sourceExternalId}</span>
            ) : (
              "—"
            )}
          </Fact>
          <Fact label="Kaynak teklif">
            {panel.sourceOffer ? <OfferLine offer={panel.sourceOffer} /> : "—"}
          </Fact>
        </dl>
      </PanelSection>

      <PanelSection title="Fiyat">
        <dl className={local.facts}>
          <Fact label="En düşük (TL)">{formatKurus(panel.minPrice)}</Fact>
          <Fact label="Mağaza (TL / stokta)">{`${panel.offerCount} / ${panel.inStockCount}`}</Fact>
          <Fact label="Yurt dışı mağaza">{String(panel.foreignOfferCount)}</Fact>
          <Fact label="Fiyat özeti değişti">{formatDateOrDash(panel.priceUpdatedAt)}</Fact>
        </dl>
        {panel.offers.length > 0 ? (
          <ul className={local.offerList} aria-label="Teklifler">
            {panel.offers.map((offer) => (
              <li key={offer.id} className={local.offerItem}>
                <span>
                  {offer.merchantName}
                  {offer.isSource ? <span className={local.muted}> · kaynak</span> : null}
                  <br />
                  <span className={local.muted}>
                    {offer.isActive ? (offer.inStock ? "stokta" : "stokta yok") : "pasif"}
                    {offer.merchantActive ? "" : " · mağaza kapalı"}
                    {` · ${formatDateOrDash(offer.lastSeenAt)}`}
                  </span>
                </span>
                <span className={local.num}>{formatMinor(offer.price, offer.currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={local.muted}>Teklif yok.</p>
        )}
        {panel.offersTruncated ? (
          <p className={local.muted}>
            İlk 5 teklif. Tamamı{" "}
            <Link href={`/yonetim/katalog/urunler/${panel.id}`}>ayrıntıda</Link>.
          </p>
        ) : null}
        <p className={local.muted}>Fiyatlar kendi para biriminde; TL dışı tutar TL'ye çevrilmez.</p>
      </PanelSection>

      <PanelSection title="Sınıflandırma">
        <dl className={local.facts}>
          <Fact label="Mevcut marka">
            {panel.brand ? panel.brand.name : <Missing>markasız</Missing>}
          </Fact>
          <Fact label="Mevcut kategori">
            {panel.category ? (
              <span className={local.mono}>{panel.category.path}</span>
            ) : (
              <Missing>kategorisiz</Missing>
            )}
          </Fact>
          {c ? (
            <>
              <Fact label="Durum">
                <StatusBadge tone={cls.tone}>{cls.label}</StatusBadge>
              </Fact>
              <Fact label="Güven puanı">
                <StatusBadge tone={confidenceTone(c.confidence)}>
                  {`${c.confidence} / 100 · ${c.confidence >= 80 ? "yazma eşiğinde" : "eşiğin altında"}`}
                </StatusBadge>
              </Fact>
              <Fact label="Kategori dayanağı">{categoryBasisLabel(c.categoryBasis)}</Fact>
              <Fact label="Kural kategorisi">
                {c.categoryPath ? <span className={local.mono}>{c.categoryPath}</span> : "—"}
              </Fact>
              <Fact label="Marka dayanağı">{brandBasisLabel(c.brandBasis)}</Fact>
              <Fact label="Kural markası">{c.brandName ?? "—"}</Fact>
              <Fact label="Uyumluluk markaları">
                {c.compatibleBrands.length > 0 ? c.compatibleBrands.join(", ") : "—"}
              </Fact>
              <Fact label="Sistem yazdı">
                {[c.wroteBrand ? "marka" : null, c.wroteCategory ? "kategori" : null]
                  .filter(Boolean)
                  .join(" + ") || "hayır (mevcut değer korundu ya da yazılmadı)"}
              </Fact>
              <Fact label="Neden">{classificationDetailLabel(c.detail)}</Fact>
              <Fact label="Kural sürümü">{`v${c.ruleVersion}`}</Fact>
              <Fact label="Karar zamanı">{formatDateOrDash(c.classifiedAt)}</Fact>
            </>
          ) : null}
        </dl>
        {c ? null : (
          <p className={local.muted}>Sınıflandırma işi bu ürüne henüz gelmedi (kanıt kaydı yok).</p>
        )}
        <p className={local.readonlyNote}>
          Marka ve kategori burada düzenlenemez: denetimli bir yazma yolu (yetki, denetim kaydı ve
          sınıflandırıcının elle kararı ezmemesi) henüz tanımlı değil.
        </p>
      </PanelSection>

      <PanelSection title="Zaman">
        <dl className={local.facts}>
          <Fact label="Oluşturuldu">{formatDateOrDash(panel.createdAt)}</Fact>
          <Fact label="Son güncellenme">{formatDateOrDash(panel.updatedAt)}</Fact>
          <Fact label="Yayınlandı">{formatDateOrDash(panel.publishedAt)}</Fact>
        </dl>
      </PanelSection>
    </>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={local.panelSection}>
      <h3 className={local.panelSectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <span className={local.missing}>{children}</span>;
}

function OfferLine({ offer }: { offer: ProductPanelOffer }) {
  return (
    <span className={local.cellStack}>
      <span>
        {`${formatMinor(offer.price, offer.currency)} · ${offer.merchantName}`}
        {offer.isActive ? "" : " (pasif)"}
      </span>
      <span className={local.mono}>{`#${offer.id} · ${offer.externalId}`}</span>
      {/* Kural 8: mağazaya giden bağlantı `click` kaydı ister; adres yalnız metin. */}
      {offer.url ? <span className={local.mono}>{offer.url}</span> : null}
    </span>
  );
}
