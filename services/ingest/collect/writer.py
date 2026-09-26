"""Veritabani yazimi. Tum SQL burada.

Uc kural bu dosyanin varlik sebebi:

1. **Idempotentlik.** `(merchant_id, external_id)` uzerinde upsert. Ayni feed
   iki kez islendiginde yeni `offer` satiri olusmaz.
2. **`price_point` sadece INSERT.** Fiyat degismemis olsa bile satir yazilir —
   surekliligin kendisi veridir. UPDATE denenmez; `arilla_app` rolunun zaten
   yetkisi yok.
3. **`variant_stock_event` yalnizca DEGISIMDE.** Yazmadan once mevcut durum
   okunur. Her kosuda yazilirsa tablo siser.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

import psycopg

from collect.records import NormalizedOffer

UPSERT_OFFER = """
WITH previous AS (
    SELECT image_url FROM offer
     WHERE merchant_id = %(merchant_id)s AND external_id = %(external_id)s
)
INSERT INTO offer (
    merchant_id, external_id, url, title_raw, brand_raw, category_raw,
    image_url, attributes_raw, current_price, list_price, currency, in_stock,
    shipping_days, shipping_cost, free_shipping_threshold, discovery_source,
    first_seen_at, last_seen_at, is_active
) VALUES (
    %(merchant_id)s, %(external_id)s, %(url)s, %(title_raw)s, %(brand_raw)s, %(category_raw)s,
    %(image_url)s, %(attributes_raw)s, %(current_price)s, %(list_price)s, %(currency)s,
    %(in_stock)s, %(shipping_days)s, %(shipping_cost)s, %(free_shipping_threshold)s,
    %(discovery_source)s, %(observed_at)s, %(observed_at)s, TRUE
)
ON CONFLICT (merchant_id, external_id) DO UPDATE SET
    url                     = EXCLUDED.url,
    title_raw               = EXCLUDED.title_raw,
    brand_raw               = EXCLUDED.brand_raw,
    category_raw            = EXCLUDED.category_raw,
    image_url               = EXCLUDED.image_url,
    -- Kaynagin tasimadigi zenginlestirme anahtarlari (barkod,
    -- collect/identifiers.py) yeniden toplamada kaybolmaz; kaynak kendi gtin'ini
    -- tasiyorsa o kazanir (0034).
    attributes_raw          = EXCLUDED.attributes_raw
        || CASE WHEN offer.attributes_raw ? 'gtin' AND NOT (EXCLUDED.attributes_raw ? 'gtin')
                THEN jsonb_build_object('gtin', offer.attributes_raw->'gtin',
                                        'gtin_source', offer.attributes_raw->'gtin_source')
                ELSE '{}'::jsonb END
        -- Tazelik isareti de korunur: yeniden toplama barkodu yeniden istetmez (0036).
        || CASE WHEN offer.attributes_raw ? 'identifiers_checked_at'
                THEN jsonb_build_object('identifiers_checked_at',
                                        offer.attributes_raw->'identifiers_checked_at')
                ELSE '{}'::jsonb END,
    current_price           = EXCLUDED.current_price,
    list_price              = EXCLUDED.list_price,
    currency                = EXCLUDED.currency,
    in_stock                = EXCLUDED.in_stock,
    shipping_days           = EXCLUDED.shipping_days,
    shipping_cost           = EXCLUDED.shipping_cost,
    free_shipping_threshold = EXCLUDED.free_shipping_threshold,
    last_seen_at            = EXCLUDED.last_seen_at,
    is_active               = TRUE,
    -- Gorsel degistiyse eski hash (ve vektor, bkz. write()) bayattir (0029).
    image_hash              = CASE WHEN offer.image_url IS DISTINCT FROM EXCLUDED.image_url
                                   THEN NULL ELSE offer.image_hash END
-- product_id KASITLI OLARAK DOKUNULMAZ: eslestirme B4'un isi. Toplama
-- katmani bir offer'i urune baglamaz, bagli olani da koparmaz.
RETURNING id, (xmax = 0) AS inserted,
          (SELECT image_url FROM previous) IS DISTINCT FROM offer.image_url AS image_changed
"""

#: Gorseli degisen offer'in gorsel vektoru silinir; `enrich` onu yeniden
#: bekleyen sayar ve yeni gorselle uretir. Silinmezse vektor eski gorselde
#: kalirdi: offer embedding'i olan hic secilmiyor (0029).
DELETE_STALE_IMAGE_EMBEDDING = """
DELETE FROM embedding
 WHERE target_type = 'offer' AND target_id = %(offer_id)s AND kind = 'image'
"""

# Fiyat degismese bile yazilir. Ayni kosu yeniden denenirse (offer_id,
# observed_at) cakisir; DO NOTHING tekrar denemeyi guvenli kilar.
INSERT_PRICE_POINT = """
INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
VALUES (%(offer_id)s, %(observed_at)s, %(price)s, %(list_price)s, %(in_stock)s)
ON CONFLICT (offer_id, observed_at) DO NOTHING
"""

UPSERT_VARIANT = """
INSERT INTO offer_variant (
    offer_id, external_id, size_label, size_norm, in_stock, price_override, sku, last_seen_at
) VALUES (
    %(offer_id)s, %(external_id)s, %(size_label)s, %(size_norm)s, %(in_stock)s,
    %(price_override)s, %(sku)s, %(observed_at)s
)
ON CONFLICT (offer_id, external_id) DO UPDATE SET
    size_label     = EXCLUDED.size_label,
    size_norm      = EXCLUDED.size_norm,
    in_stock       = EXCLUDED.in_stock,
    price_override = EXCLUDED.price_override,
    sku            = EXCLUDED.sku,
    last_seen_at   = EXCLUDED.last_seen_at
RETURNING id
"""

#: Varyant fiyat olayi (0026, docs/decisions/0037): yalnizca ilk gorulmede ve
#: etkin fiyat degistiginde. `price_point` teklifin en ucuz varyantini tasir;
#: cok boyutlu teklifte boyut bazli gecmis buradan kurulur.
LAST_VARIANT_PRICE = """
SELECT price FROM variant_price_event
 WHERE variant_id = %(variant_id)s ORDER BY observed_at DESC, id DESC LIMIT 1
"""

INSERT_VARIANT_PRICE_EVENT = """
INSERT INTO variant_price_event (variant_id, price, observed_at)
VALUES (%(variant_id)s, %(price)s, %(observed_at)s)
"""

INSERT_STOCK_EVENT = """
INSERT INTO variant_stock_event (variant_id, in_stock, observed_at)
VALUES (%(variant_id)s, %(in_stock)s, %(observed_at)s)
"""


@dataclass
class WriteCounts:
    offers_created: int = 0
    offers_updated: int = 0
    price_points_written: int = 0
    variants_written: int = 0
    stock_events_written: int = 0
    variant_price_events_written: int = 0
    stale_image_embeddings: int = 0


class OfferWriter:
    """Tek bir merchant kosusu icin yazma islemleri."""

    def __init__(
        self,
        conn: psycopg.Connection,
        merchant_id: int,
        observed_at: datetime,
        discovery_source: str = "feed",
    ) -> None:
        self.conn = conn
        self.merchant_id = merchant_id
        #: Kaydin nereden geldigi. YALNIZCA INSERT'te yazilir — upsert'in
        #: DO UPDATE listesinde yok: feed'den gelmis bir teklif, kullanici
        #: linkini yapistirdi diye user_link'e donmemeli, tersi de gecerli.
        self.discovery_source = discovery_source
        #: Kosunun tum satirlari ayni ani tasir; grafik ve karsilastirma
        #: boylece tutarli olur.
        self.observed_at = observed_at
        self.counts = WriteCounts()
        self.seen_offer_ids: set[int] = set()

    def write(self, offer: NormalizedOffer) -> int:
        offer_id, inserted, image_changed = self._upsert_offer(offer)
        if image_changed and not inserted:
            with self.conn.cursor() as cur:
                cur.execute(DELETE_STALE_IMAGE_EMBEDDING, {"offer_id": offer_id})
                self.counts.stale_image_embeddings += cur.rowcount
        self.seen_offer_ids.add(offer_id)
        if inserted:
            self.counts.offers_created += 1
        else:
            self.counts.offers_updated += 1

        self._insert_price_point(offer_id, offer)
        for variant in offer.variants:
            self._write_variant(offer_id, variant, offer.current_price)
        return offer_id

    def _upsert_offer(self, offer: NormalizedOffer) -> tuple[int, bool, bool]:
        # `offer` tablosunda gtin/mpn kolonu YOKTUR — barkod kanonik `product`
        # uzerinde durur (docs/schema.sql). Ama eslestirme (B4) ilk adimda
        # gtin'e bakiyor, o yuzden kaynaktan geldiginde kaybedilmemeli:
        # `attributes_raw` icinde saklanir.
        attributes = dict(offer.attributes_raw)
        if offer.gtin:
            attributes.setdefault("gtin", offer.gtin)

        with self.conn.cursor() as cur:
            cur.execute(
                UPSERT_OFFER,
                {
                    "merchant_id": self.merchant_id,
                    "external_id": offer.external_id,
                    "url": offer.url,
                    "title_raw": offer.title_raw,
                    "brand_raw": offer.brand_raw,
                    "category_raw": offer.category_raw,
                    "image_url": offer.image_url,
                    "attributes_raw": json.dumps(attributes, ensure_ascii=False),
                    "current_price": offer.current_price,
                    "list_price": offer.list_price,
                    "currency": offer.currency,
                    "in_stock": offer.in_stock,
                    "shipping_days": offer.shipping_days,
                    "shipping_cost": offer.shipping_cost,
                    "free_shipping_threshold": offer.free_shipping_threshold,
                    "discovery_source": self.discovery_source,
                    "observed_at": self.observed_at,
                },
            )
            row = cur.fetchone()
        assert row is not None
        return int(row[0]), bool(row[1]), bool(row[2])

    def _insert_price_point(self, offer_id: int, offer: NormalizedOffer) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                INSERT_PRICE_POINT,
                {
                    "offer_id": offer_id,
                    "observed_at": self.observed_at,
                    "price": offer.current_price,
                    "list_price": offer.list_price,
                    "in_stock": offer.in_stock,
                },
            )
            self.counts.price_points_written += cur.rowcount

    def _write_variant(self, offer_id: int, variant, offer_price: int | None = None) -> None:
        with self.conn.cursor() as cur:
            # Olay yazmadan ONCE mevcut durumu oku. Degismediyse olay yok.
            cur.execute(
                "SELECT id, in_stock FROM offer_variant WHERE offer_id = %s AND external_id = %s",
                (offer_id, variant.external_id),
            )
            existing = cur.fetchone()
            previous_stock = existing[1] if existing else None

            cur.execute(
                UPSERT_VARIANT,
                {
                    "offer_id": offer_id,
                    "external_id": variant.external_id,
                    "size_label": variant.size_label,
                    "size_norm": variant.size_norm,
                    "in_stock": variant.in_stock,
                    "price_override": variant.price_override,
                    "sku": variant.sku,
                    "observed_at": self.observed_at,
                },
            )
            row = cur.fetchone()
            assert row is not None
            variant_id = int(row[0])
            self.counts.variants_written += 1

            # Ilk gorulme de bir olaydir; sonrasi yalnizca degisimde.
            if previous_stock is None or previous_stock != variant.in_stock:
                cur.execute(
                    INSERT_STOCK_EVENT,
                    {
                        "variant_id": variant_id,
                        "in_stock": variant.in_stock,
                        "observed_at": self.observed_at,
                    },
                )
                self.counts.stock_events_written += 1

            # Varyantin etkin fiyati: kendi fiyati, yoksa teklif fiyati (0005).
            price = variant.price_override if variant.price_override is not None else offer_price
            if price is not None:
                cur.execute(LAST_VARIANT_PRICE, {"variant_id": variant_id})
                last = cur.fetchone()
                if last is None or int(last[0]) != int(price):
                    cur.execute(
                        INSERT_VARIANT_PRICE_EVENT,
                        {"variant_id": variant_id, "price": price, "observed_at": self.observed_at},
                    )
                    self.counts.variant_price_events_written += 1

    def deactivate_missing(self) -> int:
        """Feed'de gorunmeyen teklifleri pasiflestirir.

        YALNIZCA `feed_config.full_dump = true` olan ve BASARIYLA biten
        kosularda cagrilir. Delta feed veya yarim inmis bir dosya yuzunden
        katalogun sessizce kapatilmasi, kurtarilmasi en pahali hatalardan
        biri olurdu.
        """
        if not self.seen_offer_ids:
            return 0
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE offer SET is_active = FALSE
                 WHERE merchant_id = %s AND is_active AND NOT (id = ANY(%s))
                """,
                (self.merchant_id, list(self.seen_offer_ids)),
            )
            return cur.rowcount
