"""Veritabani yazimi. Tum SQL burada.

Kurallar bu dosyanin varlik sebebi:

1. **Idempotentlik.** `(merchant_id, external_id)` uzerinde upsert. Ayni feed
   iki kez islendiginde yeni `offer` satiri olusmaz.
2. **`price_point` sadece INSERT.** UPDATE denenmez; `arilla_app` rolunun zaten
   yetkisi yok. `dedupe_price_points=True` (toplu kosu) iken fiyat, liste fiyati
   ve stok onceki satirla AYNIYSA yeni satir yazilmaz — gecmis yalnizca
   degisimde buyur (karar 0068). Tazelik `offer.last_seen_at`'te durur.
3. **`variant_stock_event` yalnizca DEGISIMDE.** Yazmadan once mevcut durum
   okunur. Her kosuda yazilirsa tablo siser.
4. **Toplu SQL (0068).** Bir chunk'taki tum teklifler/varyantlar `unnest` ile
   sabit sayida ifadeyle yazilir: uzak veritabaninda her ifade bir round-trip
   oldugundan, teklif/varyant basina 5 ifade yerine chunk basina ~9 ifade.
   Davranis tek tek yazimla aynidir (testlerle sabitlenmis).

`write_batch` BIR islemin icinde calisir; commit/rollback cagirana aittir
(`collect.pipeline` chunk basina commit eder).
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from collect.image_writer import write_offer_images
from collect.records import NormalizedOffer, NormalizedVariant

#: Tek ifadede en fazla bu kadar varyant satiri (bellek ve paket boyutu siniri).
VARIANT_SLICE = 2000

UPSERT_OFFERS = """
WITH incoming AS (
    SELECT * FROM unnest(
        %(external_id)s::text[], %(url)s::text[], %(title_raw)s::text[],
        %(brand_raw)s::text[], %(category_raw)s::text[], %(image_url)s::text[],
        %(attributes_raw)s::jsonb[], %(current_price)s::bigint[], %(list_price)s::bigint[],
        %(currency)s::text[], %(in_stock)s::boolean[], %(shipping_days)s::smallint[],
        %(shipping_cost)s::bigint[], %(free_shipping_threshold)s::bigint[]
    ) AS t(external_id, url, title_raw, brand_raw, category_raw, image_url,
           attributes_raw, current_price, list_price, currency, in_stock,
           shipping_days, shipping_cost, free_shipping_threshold)
), previous AS (
    SELECT o.external_id, o.image_url FROM offer o
      JOIN incoming i ON i.external_id = o.external_id
     WHERE o.merchant_id = %(merchant_id)s
)
INSERT INTO offer (
    merchant_id, external_id, url, title_raw, brand_raw, category_raw,
    image_url, attributes_raw, current_price, list_price, currency, in_stock,
    shipping_days, shipping_cost, free_shipping_threshold, discovery_source,
    first_seen_at, last_seen_at, is_active
)
SELECT %(merchant_id)s, i.external_id, i.url, i.title_raw, i.brand_raw, i.category_raw,
       i.image_url, i.attributes_raw, i.current_price, i.list_price, i.currency, i.in_stock,
       i.shipping_days, i.shipping_cost, i.free_shipping_threshold, %(discovery_source)s,
       %(observed_at)s, %(observed_at)s, TRUE
  FROM incoming i
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
    -- Gorsel degistiyse eski hash (ve vektor, bkz. write_batch) bayattir (0029).
    image_hash              = CASE WHEN offer.image_url IS DISTINCT FROM EXCLUDED.image_url
                                   THEN NULL ELSE offer.image_hash END
-- product_id KASITLI OLARAK DOKUNULMAZ: eslestirme B4'un isi. Toplama
-- katmani bir offer'i urune baglamaz, bagli olani da koparmaz.
RETURNING id, external_id, (xmax = 0) AS inserted,
          (SELECT p.image_url FROM previous p WHERE p.external_id = offer.external_id)
              IS DISTINCT FROM offer.image_url AS image_changed
"""

#: Gorseli degisen offer'in gorsel vektoru silinir; `enrich` onu yeniden
#: bekleyen sayar ve yeni gorselle uretir. Silinmezse vektor eski gorselde
#: kalirdi: offer embedding'i olan hic secilmiyor (0029).
DELETE_STALE_IMAGE_EMBEDDINGS = """
DELETE FROM embedding
 WHERE target_type = 'offer' AND kind = 'image' AND target_id = ANY(%(offer_ids)s)
"""

LAST_PRICE_POINTS = """
SELECT DISTINCT ON (offer_id) offer_id, price, list_price, in_stock
  FROM price_point
 WHERE offer_id = ANY(%(offer_ids)s)
 ORDER BY offer_id, observed_at DESC
"""

# Ayni kosu yeniden denenirse (offer_id, observed_at) cakisir; DO NOTHING
# tekrar denemeyi guvenli kilar.
INSERT_PRICE_POINTS = """
INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
SELECT t.offer_id, %(observed_at)s, t.price, t.list_price, t.in_stock
  FROM unnest(%(offer_id)s::bigint[], %(price)s::bigint[], %(list_price)s::bigint[],
              %(in_stock)s::boolean[]) AS t(offer_id, price, list_price, in_stock)
ON CONFLICT (offer_id, observed_at) DO NOTHING
"""

EXISTING_VARIANTS = """
SELECT offer_id, external_id, in_stock FROM offer_variant WHERE offer_id = ANY(%(offer_ids)s)
"""

UPSERT_VARIANTS = """
INSERT INTO offer_variant (
    offer_id, external_id, size_label, size_norm, in_stock, price_override, sku, last_seen_at
)
SELECT t.offer_id, t.external_id, t.size_label, t.size_norm, t.in_stock,
       t.price_override, t.sku, %(observed_at)s
  FROM unnest(%(offer_id)s::bigint[], %(external_id)s::text[], %(size_label)s::text[],
              %(size_norm)s::text[], %(in_stock)s::boolean[], %(price_override)s::bigint[],
              %(sku)s::text[])
       AS t(offer_id, external_id, size_label, size_norm, in_stock, price_override, sku)
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
SELECT t.variant_id, t.in_stock, %(observed_at)s
  FROM unnest(%(variant_id)s::bigint[], %(in_stock)s::boolean[]) AS t(variant_id, in_stock)
"""

#: Varyant fiyat olayi (0026, docs/decisions/0037): yalnizca ilk gorulmede ve
#: etkin fiyat degistiginde. `price_point` teklifin en ucuz varyantini tasir;
#: cok boyutlu teklifte boyut bazli gecmis buradan kurulur.
LAST_VARIANT_PRICES = """
SELECT DISTINCT ON (variant_id) variant_id, price FROM variant_price_event
 WHERE variant_id = ANY(%(variant_ids)s)
 ORDER BY variant_id, observed_at DESC, id DESC
"""

INSERT_VARIANT_PRICE_EVENTS = """
INSERT INTO variant_price_event (variant_id, price, observed_at)
SELECT t.variant_id, t.price, %(observed_at)s
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
    images_written: int = 0
    images_removed: int = 0

    def add(self, other: WriteCounts) -> None:
        for name in self.__dataclass_fields__:
            setattr(self, name, getattr(self, name) + getattr(other, name))


def _slices[T](items: Sequence[T], size: int) -> Iterator[Sequence[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


class OfferWriter:
    """Tek bir merchant kosusu icin yazma islemleri."""

    def __init__(
        self,
        conn: psycopg.Connection,
        merchant_id: int,
        observed_at: datetime,
        discovery_source: str = "feed",
        dedupe_price_points: bool = False,
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
        #: True: fiyat/liste fiyati/stok onceki `price_point` ile ayniysa satir
        #: yazilmaz (toplu toplama, karar 0068). Kullanici linki yolu her
        #: cozumlemede bir nokta yazmaya devam eder (False).
        self.dedupe_price_points = dedupe_price_points
        self.counts = WriteCounts()

    def write(self, offer: NormalizedOffer) -> int:
        """Tek teklif: `write_batch([offer])`."""
        return self.write_batch([offer])[0]

    def write_batch(self, offers: Sequence[NormalizedOffer]) -> list[int]:
        """Teklifleri ve varyantlarini toplu yazar; offer id'lerini girdi
        sirasiyla doner. Ayni `external_id` tekrarlarsa SONUNCUSU kazanir
        (tek tek yazimin sonucuyla ayni). Commit cagirana aittir."""
        if not offers:
            return []
        latest: dict[str, NormalizedOffer] = {offer.external_id: offer for offer in offers}
        unique = list(latest.values())

        ids = self._upsert_offers(unique)
        self._insert_price_points(unique, ids)
        self._write_variants(unique, ids)
        # Galeri gorselleri (0073): chunk basina TEK ifade, metadata; indirme/ag yok.
        # Chunk islemi icinde calisir, commit/rollback cagirana (pipeline) aittir.
        image_counts = write_offer_images(
            self.conn, [(ids[offer.external_id], offer.images) for offer in unique]
        )
        self.counts.images_written += image_counts.written
        self.counts.images_removed += image_counts.removed
        return [ids[offer.external_id] for offer in offers]

    # -- teklifler ------------------------------------------------------------

    def _upsert_offers(self, offers: Sequence[NormalizedOffer]) -> dict[str, int]:
        def attributes(offer: NormalizedOffer) -> Jsonb:
            # `offer` tablosunda gtin/mpn kolonu YOKTUR — barkod kanonik
            # `product` uzerinde durur (docs/schema.sql). Ama eslestirme (B4)
            # ilk adimda gtin'e bakiyor, o yuzden kaynaktan geldiginde
            # kaybedilmemeli: `attributes_raw` icinde saklanir.
            data = dict(offer.attributes_raw)
            if offer.gtin:
                data.setdefault("gtin", offer.gtin)
            return Jsonb(data, dumps=lambda value: json.dumps(value, ensure_ascii=False))

        params: dict[str, Any] = {
            "merchant_id": self.merchant_id,
            "discovery_source": self.discovery_source,
            "observed_at": self.observed_at,
            "external_id": [o.external_id for o in offers],
            "url": [o.url for o in offers],
            "title_raw": [o.title_raw for o in offers],
            "brand_raw": [o.brand_raw for o in offers],
            "category_raw": [o.category_raw for o in offers],
            "image_url": [o.image_url for o in offers],
            "attributes_raw": [attributes(o) for o in offers],
            "current_price": [o.current_price for o in offers],
            "list_price": [o.list_price for o in offers],
            "currency": [o.currency for o in offers],
            "in_stock": [o.in_stock for o in offers],
            "shipping_days": [o.shipping_days for o in offers],
            "shipping_cost": [o.shipping_cost for o in offers],
            "free_shipping_threshold": [o.free_shipping_threshold for o in offers],
        }
        with self.conn.cursor() as cur:
            cur.execute(UPSERT_OFFERS, params)
            rows = cur.fetchall()

        ids: dict[str, int] = {}
        stale: list[int] = []
        for offer_id, external_id, inserted, image_changed in rows:
            ids[external_id] = int(offer_id)
            if inserted:
                self.counts.offers_created += 1
            else:
                self.counts.offers_updated += 1
                if image_changed:
                    stale.append(int(offer_id))
        if stale:
            with self.conn.cursor() as cur:
                cur.execute(DELETE_STALE_IMAGE_EMBEDDINGS, {"offer_ids": stale})
                self.counts.stale_image_embeddings += cur.rowcount
        return ids

    def _insert_price_points(self, offers: Sequence[NormalizedOffer], ids: dict[str, int]) -> None:
        last: dict[int, tuple[int, int | None, bool]] = {}
        if self.dedupe_price_points:
            with self.conn.cursor() as cur:
                cur.execute(LAST_PRICE_POINTS, {"offer_ids": list(ids.values())})
                last = {int(r[0]): (int(r[1]), r[2], bool(r[3])) for r in cur.fetchall()}

        rows = [
            (ids[o.external_id], o.current_price, o.list_price, o.in_stock)
            for o in offers
            if last.get(ids[o.external_id]) != (o.current_price, o.list_price, o.in_stock)
        ]
        if not rows:
            return
        with self.conn.cursor() as cur:
            cur.execute(
                INSERT_PRICE_POINTS,
                {
                    "observed_at": self.observed_at,
                    "offer_id": [r[0] for r in rows],
                    "price": [r[1] for r in rows],
                    "list_price": [r[2] for r in rows],
                    "in_stock": [r[3] for r in rows],
                },
            )
            self.counts.price_points_written += cur.rowcount

    # -- varyantlar -----------------------------------------------------------

    def _write_variants(self, offers: Sequence[NormalizedOffer], ids: dict[str, int]) -> None:
        # (offer_id, variant external_id) -> (varyant, teklif fiyati); sonuncu kazanir.
        wanted: dict[tuple[int, str], tuple[NormalizedVariant, int | None]] = {}
        for offer in offers:
            for variant in offer.variants:
                wanted[(ids[offer.external_id], variant.external_id)] = (
                    variant,
                    offer.current_price,
                )
        if not wanted:
            return

        offer_ids = sorted({key[0] for key in wanted})
        with self.conn.cursor() as cur:
            cur.execute(EXISTING_VARIANTS, {"offer_ids": offer_ids})
            previous_stock = {(int(r[0]), r[1]): bool(r[2]) for r in cur.fetchall()}

        items = list(wanted.items())
        variant_ids: dict[tuple[int, str], int] = {}
        for part in _slices(items, VARIANT_SLICE):
            with self.conn.cursor() as cur:
                cur.execute(
                    UPSERT_VARIANTS,
                    {
                        "observed_at": self.observed_at,
                        "offer_id": [key[0] for key, _ in part],
                        "external_id": [key[1] for key, _ in part],
                        "size_label": [v.size_label for _, (v, _p) in part],
                        "size_norm": [v.size_norm for _, (v, _p) in part],
                        "in_stock": [v.in_stock for _, (v, _p) in part],
                        "price_override": [v.price_override for _, (v, _p) in part],
                        "sku": [v.sku for _, (v, _p) in part],
                    },
                )
                for variant_id, offer_id, external_id in cur.fetchall():
                    variant_ids[(int(offer_id), external_id)] = int(variant_id)
        self.counts.variants_written += len(items)

        # Ilk gorulme de bir olaydir; sonrasi yalnizca degisimde.
        stock_rows = [
            (variant_ids[key], variant.in_stock)
            for key, (variant, _price) in items
            if previous_stock.get(key) is None or previous_stock[key] != variant.in_stock
        ]
        if stock_rows:
            with self.conn.cursor() as cur:
                cur.execute(
                    INSERT_STOCK_EVENTS,
                    {
                        "observed_at": self.observed_at,
                        "variant_id": [r[0] for r in stock_rows],
                        "in_stock": [r[1] for r in stock_rows],
                    },
                )
            self.counts.stock_events_written += len(stock_rows)

        # Varyantin etkin fiyati: kendi fiyati, yoksa teklif fiyati (0005).
        priced = [
            (
                variant_ids[key],
                variant.price_override if variant.price_override is not None else offer_price,
            )
            for key, (variant, offer_price) in items
        ]
        priced = [(vid, price) for vid, price in priced if price is not None]
        if not priced:
            return
        with self.conn.cursor() as cur:
            cur.execute(LAST_VARIANT_PRICES, {"variant_ids": [vid for vid, _ in priced]})
            last_price = {int(r[0]): int(r[1]) for r in cur.fetchall()}
        changed = [(vid, price) for vid, price in priced if last_price.get(vid) != int(price)]
        if changed:
            with self.conn.cursor() as cur:
                cur.execute(
                    INSERT_VARIANT_PRICE_EVENTS,
                    {
                        "observed_at": self.observed_at,
                        "variant_id": [r[0] for r in changed],
                        "price": [r[1] for r in changed],
                    },
                )
            self.counts.variant_price_events_written += len(changed)

    # -- tam dokum ------------------------------------------------------------

    def deactivate_missing(self) -> int:
        """Bu kosuda gorunmeyen teklifleri pasiflestirir.

        YALNIZCA `feed_config.full_dump = true` olan ve BASARIYLA biten
        kosularda cagrilir. Delta feed veya yarim inmis bir dosya yuzunden
        katalogun sessizce kapatilmasi, kurtarilmasi en pahali hatalardan
        biri olurdu.

        "Gorulen" = `last_seen_at = observed_at`: chunk'li ve devam ettirilmis
        kosuda onceki surecte yazilan teklifler de gorulmus sayilir (bellekteki
        bir id kumesi yeniden baslatmada kaybolurdu).
        """
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE offer SET is_active = FALSE
                 WHERE merchant_id = %s AND is_active AND last_seen_at < %s
                """,
                (self.merchant_id, self.observed_at),
            )
            return cur.rowcount
