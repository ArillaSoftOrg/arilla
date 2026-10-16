"""Veritabani yazimi. Tum SQL burada.

Uc kural bu dosyanin varlik sebebi:

1. **Idempotentlik.** `(merchant_id, external_id)` uzerinde upsert. Ayni feed
   iki kez islendiginde yeni `offer` satiri olusmaz.
2. **`price_point` sadece INSERT.** Fiyat degismemis olsa bile satir yazilir —
   surekliligin kendisi veridir. UPDATE denenmez; `arilla_app` rolunun zaten
   yetkisi yok.
3. **`variant_stock_event` yalnizca DEGISIMDE.** Yazmadan once mevcut durum
   okunur. Her kosuda yazilirsa tablo siser.

Toplu yazim (Faz 3): `write_many` bir partiyi teklif sayisindan bagimsiz sabit
sayida ifadeyle yazar (`unnest`); `write` tek teklifli partidir. Kurallar ve
sonuc teklif teklif yazimla aynidir; islem sinirlari CAGIRANINDIR (kosu tek
islemdir, bkz. `collect/pipeline.py`).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

import psycopg

from collect.image_writer import write_offer_images
from collect.primary_image_sync import sync_primary_images
from collect.records import NormalizedOffer
from db import product_aggregates
from enrich import text as text_builder

#: Gorseli degisen offer'in gorsel vektoru silinir; `enrich` onu yeniden
#: bekleyen sayar ve yeni gorselle uretir. Silinmezse vektor eski gorselde
#: kalirdi: offer embedding'i olan hic secilmiyor (0029).
DELETE_STALE_IMAGE_EMBEDDING = """
DELETE FROM embedding
 WHERE target_type = 'offer' AND target_id = %(offer_id)s AND kind = 'image'
"""

# --- Toplu (parti) ifadeleri -------------------------------------------------------

#: `UPSERT_OFFER`in parti hali. `previous` upsert'ten ONCEKI anlik goruntuyu okur
#: (veri degistiren ifade kendi yazdigini gormez); RETURNING her satirin onceki
#: degerlerini dis anahtarla bulur. Sirali ekleme: es zamanli yazicilarla kilit
#: sirasi tutarli. Tekrarli external_id cagiranda elenir (pipeline).
UPSERT_OFFERS = """
WITH incoming AS (
    SELECT * FROM unnest(
        %(external_id)s::text[], %(url)s::text[], %(title_raw)s::text[],
        %(brand_raw)s::text[], %(category_raw)s::text[], %(image_url)s::text[],
        %(attributes_raw)s::jsonb[], %(current_price)s::bigint[], %(list_price)s::bigint[],
        %(currency)s::text[], %(in_stock)s::boolean[], %(shipping_days)s::smallint[],
        %(shipping_cost)s::bigint[], %(free_shipping_threshold)s::bigint[]
    ) AS t(external_id, url, title_raw, brand_raw, category_raw, image_url, attributes_raw,
           current_price, list_price, currency, in_stock, shipping_days, shipping_cost,
           free_shipping_threshold)
), previous AS (
    SELECT o.external_id, o.image_url, o.title_raw, o.brand_raw, o.category_raw
      FROM offer o
     WHERE o.merchant_id = %(merchant_id)s AND o.external_id = ANY(%(external_id)s::text[])
)
INSERT INTO offer (
    merchant_id, external_id, url, title_raw, brand_raw, category_raw,
    image_url, attributes_raw, current_price, list_price, currency, in_stock,
    shipping_days, shipping_cost, free_shipping_threshold, discovery_source,
    first_seen_at, last_seen_at, is_active
)
SELECT %(merchant_id)s, external_id, url, title_raw, brand_raw, category_raw,
       image_url, attributes_raw, current_price, list_price, currency, in_stock,
       shipping_days, shipping_cost, free_shipping_threshold, %(discovery_source)s,
       %(observed_at)s, %(observed_at)s, TRUE
  FROM incoming
 ORDER BY external_id
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
    -- Gorsel degistiyse eski hash (ve vektor, bkz. write_many()) bayattir (0029).
    image_hash              = CASE WHEN offer.image_url IS DISTINCT FROM EXCLUDED.image_url
                                   THEN NULL ELSE offer.image_hash END
-- product_id KASITLI OLARAK DOKUNULMAZ: eslestirme B4'un isi. Toplama
-- katmani bir offer'i urune baglamaz, bagli olani da koparmaz.
RETURNING id, external_id, (xmax = 0) AS inserted,
          (SELECT p.image_url FROM previous p WHERE p.external_id = offer.external_id)
              IS DISTINCT FROM offer.image_url AS image_changed,
          product_id,
          (SELECT p.title_raw FROM previous p WHERE p.external_id = offer.external_id),
          (SELECT p.brand_raw FROM previous p WHERE p.external_id = offer.external_id),
          (SELECT p.category_raw FROM previous p WHERE p.external_id = offer.external_id)
"""

#: Gorseli degisen offer'in `image`, kanonik metni (baslik/marka/kategori) degisenin
#: `text` vektoru silinir; `enrich` yeniden uretir. Silinmezse vektor eski gorselde/
#: metinde kalirdi (embedding'i olan offer hic secilmiyor, 0029).
DELETE_STALE_EMBEDDINGS = """
DELETE FROM embedding
 WHERE target_type = 'offer' AND kind = %(kind)s AND target_id = ANY(%(offer_ids)s::bigint[])
"""

# Fiyat degismese bile yazilir. Ayni kosu yeniden denenirse (offer_id,
# observed_at) cakisir; DO NOTHING tekrar denemeyi guvenli kilar.
INSERT_PRICE_POINTS = """
INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
SELECT offer_id, %(observed_at)s, price, list_price, in_stock
  FROM unnest(%(offer_id)s::bigint[], %(price)s::bigint[], %(list_price)s::bigint[],
              %(in_stock)s::boolean[]) AS t(offer_id, price, list_price, in_stock)
 ORDER BY offer_id
ON CONFLICT (offer_id, observed_at) DO NOTHING
"""

EXISTING_VARIANT_STOCK = """
SELECT offer_id, external_id, in_stock FROM offer_variant
 WHERE offer_id = ANY(%(offer_ids)s::bigint[])
"""

UPSERT_VARIANTS = """
INSERT INTO offer_variant (
    offer_id, external_id, size_label, size_norm, in_stock, price_override, sku, last_seen_at
)
SELECT offer_id, external_id, size_label, size_norm, in_stock, price_override, sku,
       %(observed_at)s
  FROM unnest(%(offer_id)s::bigint[], %(external_id)s::text[], %(size_label)s::text[],
              %(size_norm)s::text[], %(in_stock)s::boolean[], %(price_override)s::bigint[],
              %(sku)s::text[])
       AS t(offer_id, external_id, size_label, size_norm, in_stock, price_override, sku)
 ORDER BY offer_id, external_id
ON CONFLICT (offer_id, external_id) DO UPDATE SET
    size_label     = EXCLUDED.size_label,
    size_norm      = EXCLUDED.size_norm,
    in_stock       = EXCLUDED.in_stock,
    price_override = EXCLUDED.price_override,
    sku            = EXCLUDED.sku,
    last_seen_at   = EXCLUDED.last_seen_at
RETURNING id, offer_id, external_id
"""

INSERT_STOCK_EVENTS = """
INSERT INTO variant_stock_event (variant_id, in_stock, observed_at)
SELECT variant_id, in_stock, %(observed_at)s
  FROM unnest(%(variant_id)s::bigint[], %(in_stock)s::boolean[]) AS t(variant_id, in_stock)
"""

#: Varyant fiyat olayi (0026, docs/decisions/0037): yalnizca ilk gorulmede ve
#: etkin fiyat degistiginde. `price_point` teklifin en ucuz varyantini tasir;
#: cok boyutlu teklifte boyut bazli gecmis buradan kurulur.
LAST_VARIANT_PRICES = """
SELECT DISTINCT ON (variant_id) variant_id, price FROM variant_price_event
 WHERE variant_id = ANY(%(variant_ids)s::bigint[])
 ORDER BY variant_id, observed_at DESC, id DESC
"""

INSERT_VARIANT_PRICE_EVENTS = """
INSERT INTO variant_price_event (variant_id, price, observed_at)
SELECT variant_id, price, %(observed_at)s
  FROM unnest(%(variant_id)s::bigint[], %(price)s::bigint[]) AS t(variant_id, price)
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
    stale_text_embeddings: int = 0
    images_written: int = 0
    images_removed: int = 0
    primary_images_synced: int = 0


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
        #: Bu kosuda fiyati, stogu ya da aktifligi yazilan teklifin bagli
        #: oldugu urunler: `refresh_aggregates()` yalnizca bunlari yeniler.
        self.touched_product_ids: set[int] = set()

    def write(self, offer: NormalizedOffer) -> int:
        """Tek teklif: tek elemanli parti. Offer kimligini dondurur."""
        return self.write_many([offer])[0]

    def write_many(self, offers: Sequence[NormalizedOffer]) -> list[int]:
        """Bir partiyi teklif sayisindan bagimsiz sabit sayida ifadeyle yazar.

        Offer kimliklerini girdi sirasiyla dondurur. `external_id` parti icinde
        tekil olmalidir (pipeline tekrarlari eler). Islem cagiranindir.
        """
        if not offers:
            return []
        external_ids = [offer.external_id for offer in offers]
        if len(set(external_ids)) != len(external_ids):
            raise ValueError("parti icinde tekrarli external_id")

        # Urunun gorseli kaynak offer'i izler (0073); eski deger okunabilirken, upsert'ten once.
        self.counts.primary_images_synced += sync_primary_images(
            self.conn, self.merchant_id, [(offer.external_id, offer.image_url) for offer in offers]
        )

        rows = self._upsert_offers(offers)
        offer_ids: list[int] = []
        stale_image: list[int] = []
        stale_text: list[int] = []
        for offer in offers:
            offer_id, inserted, image_changed, product_id, previous_text = rows[offer.external_id]
            offer_ids.append(offer_id)
            if product_id is not None:
                self.touched_product_ids.add(product_id)
            if image_changed and not inserted:
                stale_image.append(offer_id)
            # Yalnizca KANONIK metin degistiyse: fiyat, stok ya da gurultu eki (ornegin
            # "Kampanyali") yeniden embedding maliyeti dogurmaz.
            if (
                not inserted
                and previous_text is not None
                and text_builder.build(*previous_text)
                != text_builder.build(offer.title_raw, offer.brand_raw, offer.category_raw)
            ):
                stale_text.append(offer_id)
            self.seen_offer_ids.add(offer_id)
            if inserted:
                self.counts.offers_created += 1
            else:
                self.counts.offers_updated += 1

        self.counts.stale_image_embeddings += self._delete_embeddings("image", stale_image)
        self.counts.stale_text_embeddings += self._delete_embeddings("text", stale_text)
        self._insert_price_points(offer_ids, offers)
        # Galeri gorselleri (0073): tek ifade, metadata. Indirme yok, transaction'i
        # bloke edecek ag cagrisi yok.
        image_counts = write_offer_images(
            self.conn,
            [(offer_id, offer.images) for offer_id, offer in zip(offer_ids, offers, strict=True)],
        )
        self.counts.images_written += image_counts.written
        self.counts.images_removed += image_counts.removed
        self._write_variants(offer_ids, offers)
        return offer_ids

    def _upsert_offers(
        self, offers: Sequence[NormalizedOffer]
    ) -> dict[str, tuple[int, bool, bool, int | None, tuple[str, str | None, str | None] | None]]:
        # `offer` tablosunda gtin/mpn kolonu YOKTUR — barkod kanonik `product`
        # uzerinde durur (docs/schema.sql). Ama eslestirme (B4) ilk adimda
        # gtin'e bakiyor, o yuzden kaynaktan geldiginde kaybedilmemeli:
        # `attributes_raw` icinde saklanir.
        attributes: list[str] = []
        for offer in offers:
            raw = dict(offer.attributes_raw)
            if offer.gtin:
                raw.setdefault("gtin", offer.gtin)
            attributes.append(json.dumps(raw, ensure_ascii=False))

        with self.conn.cursor() as cur:
            cur.execute(
                UPSERT_OFFERS,
                {
                    "merchant_id": self.merchant_id,
                    "external_id": [o.external_id for o in offers],
                    "url": [o.url for o in offers],
                    "title_raw": [o.title_raw for o in offers],
                    "brand_raw": [o.brand_raw for o in offers],
                    "category_raw": [o.category_raw for o in offers],
                    "image_url": [o.image_url for o in offers],
                    "attributes_raw": attributes,
                    "current_price": [o.current_price for o in offers],
                    "list_price": [o.list_price for o in offers],
                    "currency": [o.currency for o in offers],
                    "in_stock": [o.in_stock for o in offers],
                    "shipping_days": [o.shipping_days for o in offers],
                    "shipping_cost": [o.shipping_cost for o in offers],
                    "free_shipping_threshold": [o.free_shipping_threshold for o in offers],
                    "discovery_source": self.discovery_source,
                    "observed_at": self.observed_at,
                },
            )
            fetched = cur.fetchall()
        result = {}
        for row in fetched:
            previous_text = None if row[5] is None else (str(row[5]), row[6], row[7])
            result[str(row[1])] = (
                int(row[0]),
                bool(row[2]),
                bool(row[3]),
                None if row[4] is None else int(row[4]),
                previous_text,
            )
        return result

    def _delete_embeddings(self, kind: str, offer_ids: list[int]) -> int:
        if not offer_ids:
            return 0
        with self.conn.cursor() as cur:
            cur.execute(DELETE_STALE_EMBEDDINGS, {"kind": kind, "offer_ids": offer_ids})
            return cur.rowcount

    def _insert_price_points(self, offer_ids: list[int], offers: Sequence[NormalizedOffer]) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                INSERT_PRICE_POINTS,
                {
                    "observed_at": self.observed_at,
                    "offer_id": offer_ids,
                    "price": [o.current_price for o in offers],
                    "list_price": [o.list_price for o in offers],
                    "in_stock": [o.in_stock for o in offers],
                },
            )
            self.counts.price_points_written += cur.rowcount

    def _write_variants(self, offer_ids: list[int], offers: Sequence[NormalizedOffer]) -> None:
        """Varyantlar, stok olaylari ve fiyat olaylari: parti basina en fazla bes ifade.

        Olay yazmadan ONCE mevcut durum okunur; degismediyse olay yok. Ilk gorulme
        de bir olaydir. Varyantin etkin fiyati: kendi fiyati, yoksa teklif fiyati (0005).
        Varyant kimligi teklif icinde tekildir (normalize._variants).
        """
        items = [
            (offer_id, variant, offer.current_price)
            for offer_id, offer in zip(offer_ids, offers, strict=True)
            for variant in offer.variants
        ]
        if not items:
            return
        with self.conn.cursor() as cur:
            cur.execute(EXISTING_VARIANT_STOCK, {"offer_ids": sorted(set(offer_ids))})
            previous_stock = {(int(r[0]), str(r[1])): bool(r[2]) for r in cur.fetchall()}

            cur.execute(
                UPSERT_VARIANTS,
                {
                    "observed_at": self.observed_at,
                    "offer_id": [offer_id for offer_id, _, _ in items],
                    "external_id": [variant.external_id for _, variant, _ in items],
                    "size_label": [variant.size_label for _, variant, _ in items],
                    "size_norm": [variant.size_norm for _, variant, _ in items],
                    "in_stock": [variant.in_stock for _, variant, _ in items],
                    "price_override": [variant.price_override for _, variant, _ in items],
                    "sku": [variant.sku for _, variant, _ in items],
                },
            )
            variant_ids = {(int(r[1]), str(r[2])): int(r[0]) for r in cur.fetchall()}
            self.counts.variants_written += len(items)

            stock_events: list[tuple[int, bool]] = []
            priced: list[tuple[int, int]] = []
            for offer_id, variant, offer_price in items:
                key = (offer_id, variant.external_id)
                variant_id = variant_ids[key]
                before = previous_stock.get(key)
                if before is None or before != variant.in_stock:
                    stock_events.append((variant_id, variant.in_stock))
                price = (
                    variant.price_override if variant.price_override is not None else offer_price
                )
                if price is not None:
                    priced.append((variant_id, int(price)))

            if stock_events:
                cur.execute(
                    INSERT_STOCK_EVENTS,
                    {
                        "observed_at": self.observed_at,
                        "variant_id": [v for v, _ in stock_events],
                        "in_stock": [s for _, s in stock_events],
                    },
                )
                self.counts.stock_events_written += len(stock_events)

            if priced:
                cur.execute(LAST_VARIANT_PRICES, {"variant_ids": [v for v, _ in priced]})
                last = {int(r[0]): int(r[1]) for r in cur.fetchall()}
                changed = [(v, p) for v, p in priced if last.get(v) != p]
                if changed:
                    cur.execute(
                        INSERT_VARIANT_PRICE_EVENTS,
                        {
                            "observed_at": self.observed_at,
                            "variant_id": [v for v, _ in changed],
                            "price": [p for _, p in changed],
                        },
                    )
                    self.counts.variant_price_events_written += len(changed)

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
                RETURNING product_id
                """,
                (self.merchant_id, list(self.seen_offer_ids)),
            )
            rows = cur.fetchall()
        self.touched_product_ids.update(int(row[0]) for row in rows if row[0] is not None)
        return len(rows)

    def refresh_aggregates(self) -> int:
        """Dokunulan urunlerin fiyat ozetini ayni islemde yeniler.

        Commit'ten ONCE cagrilir: teklif ve ozet birlikte gorunur ya da
        birlikte geri alinir. Bagli urunu olmayan yeni teklif ozeti etkilemez;
        eslestirme onu baglarken yeniler (resolve).
        """
        return product_aggregates.refresh_products(self.conn, self.touched_product_ids)
