"""`ListingSink` -> mevcut katalog yazicisi (`collect.writer.OfferWriter`).

Ikinci bir yazma mekanizmasi DEGILDIR: tum SQL, idempotentlik (`(merchant_id,
external_id)` upsert), `price_point` yalnizca INSERT ve gorsel yazimi `OfferWriter`'da
kalir. Bu modul yalnizca platform sozlesmesini (`CanonicalListing`) yazicinin
bekledigi `NormalizedOffer`'a cevirir ve parti basina islemi kapatir; boylece
`run_source` kontrol noktasini yalnizca kalici yazimdan sonra saklar (karar 0164).

Ceviri kurallari:
- `external_id` = `offer_key(sema, listing_id, seller_id)`; tek saticili kaynakta ilan kimligi.
- Stok bilinmiyorsa (`in_stock is None`) Hepsiburada gelenegi (karar 0130):
  `in_stock = false` + `attributes_raw.stock_state = 'unknown'`. "Stokta yok" diye
  gosterilmez; `product.stock_unknown` metni kullanilir.
- Varyant eksenleri (`options`) `attributes_raw`'a yazilir. Beden satirlari
  (`offer_variant`) sozlesmede yok; bu yol onlari yazmaz.
- Urun BAGLANMAZ (`product_id` yok): eslestirme `resolve`'un isidir.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

import psycopg

from collect.images import SourceImage, select_images
from collect.records import NormalizedOffer
from collect.writer import OfferWriter
from platforms.contract import CanonicalListing, OfferKeyScheme, offer_key
from platforms.flow import BatchResult

STOCK_UNKNOWN = "unknown"


def to_normalized_offer(
    listing: CanonicalListing, *, scheme: OfferKeyScheme = "listing"
) -> NormalizedOffer:
    attributes: dict[str, str] = {str(k): str(v) for k, v in listing.options.items()}
    if listing.in_stock is None:
        attributes["stock_state"] = STOCK_UNKNOWN
    images = select_images(
        SourceImage(url=url, position=index) for index, url in enumerate(listing.image_urls)
    )
    return NormalizedOffer(
        external_id=offer_key(scheme, listing.listing_id, listing.seller_id),
        url=listing.url,
        title_raw=listing.title,
        current_price=listing.price,
        list_price=listing.list_price,
        in_stock=bool(listing.in_stock),
        currency=listing.currency,
        brand_raw=listing.brand,
        category_raw=" > ".join(listing.category_path) or None,
        image_url=listing.image_urls[0] if listing.image_urls else None,
        gtin=listing.gtin,
        attributes_raw=attributes,
        images=tuple(images),
    )


class OfferWriterSink:
    """Tek merchant icin `ListingSink`. Parti basina tek islem (commit)."""

    def __init__(
        self,
        conn: psycopg.Connection,
        merchant_id: int,
        *,
        scheme: OfferKeyScheme = "listing",
        discovery_source: str = "feed",
    ) -> None:
        self.conn = conn
        self.merchant_id = merchant_id
        self.scheme = scheme
        self.discovery_source = discovery_source
        self.created = 0
        self.updated = 0

    def write_batch(self, listings: Sequence[CanonicalListing]) -> BatchResult:
        if not listings:
            return BatchResult(written=0)
        # Parti icinde ayni ilan iki kez gelirse sonuncusu kazanir (yazici tekrar kabul etmez).
        latest: dict[str, NormalizedOffer] = {}
        for listing in listings:
            offer = to_normalized_offer(listing, scheme=self.scheme)
            latest[offer.external_id] = offer
        observed_at: datetime = listings[0].observed_at
        writer = OfferWriter(
            self.conn, self.merchant_id, observed_at, discovery_source=self.discovery_source
        )
        try:
            writer.write_many(list(latest.values()))
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        self.created += writer.counts.offers_created
        self.updated += writer.counts.offers_updated
        return BatchResult(written=len(latest))
