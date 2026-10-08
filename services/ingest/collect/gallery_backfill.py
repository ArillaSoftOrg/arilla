"""Yalnizca-gorsel galeri backfill'i (karar 0073).

Normal ingest (`OfferWriter.write`) fiyat, stok, `last_seen_at`, varyant ve
`price_point` da yazar; galeri backfill'inde bunlar ISTENMEZ. Bu modul yalnizca:

- `offer_image` satirlari (mevcut `write_offer_images` ile),
- `offer.image_url` (+ `image_hash` sifirlama) ve yalniz degisince,
- `product.primary_image_url` (mevcut `sync_primary_images` kurali),
- gorsel degisince image embedding'in silinmesi (mevcut `DELETE_STALE_IMAGE_EMBEDDING`)

alanlarina dokunur. Fiyat, stok, `price_point`, varyant ve diger offer alanlari
ASLA yazilmaz. Plan once salt-okunur hesaplanir; dry-run hic yazmaz, degisiklik
yoksa apply da hic ifade calistirmaz (idempotent).

    python -m collect.gallery_backfill --merchant SLUG [--handle H] [--limit N] [--apply]
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass, field

import psycopg

from collect.image_writer import write_offer_images
from collect.primary_image_sync import sync_primary_images
from collect.records import NormalizedOffer
from collect.writer import DELETE_STALE_IMAGE_EMBEDDING

logger = logging.getLogger(__name__)


@dataclass
class OfferPlan:
    offer_id: int | None = None
    product_id: int | None = None
    found: bool = False
    stored: int = 0
    shown: int = 0
    existing: int = 0
    inserts: int = 0
    updates: int = 0
    removals: int = 0
    image_url_changes: bool = False
    primary_changes: bool = False
    has_image_embedding: bool = False
    in_sync: bool = True
    errors: list[str] = field(default_factory=list)

    @property
    def needs_write(self) -> bool:
        return bool(
            self.inserts
            or self.updates
            or self.removals
            or self.image_url_changes
            or self.primary_changes
        )


def plan_offer(conn: psycopg.Connection, merchant_id: int, offer: NormalizedOffer) -> OfferPlan:
    """Salt-okunur: bu offer'in galerisi icin ne yazilmasi gerektigini hesaplar."""
    plan = OfferPlan()
    with conn.cursor() as cur:
        cur.execute(
            """SELECT o.id, o.product_id, o.image_url, p.primary_image_url
                 FROM offer o LEFT JOIN product p ON p.id = o.product_id
                WHERE o.merchant_id = %s AND o.external_id = %s""",
            (merchant_id, offer.external_id),
        )
        row = cur.fetchone()
        if row is None:
            return plan  # offer yok: backfill offer olusturmaz
        plan.found = True
        plan.offer_id, plan.product_id, old_image, old_primary = row
        cur.execute(
            """SELECT url_hash, source_url, source_position, display_rank, width, height,
                      is_variant_specific, status
                 FROM offer_image WHERE offer_id = %s""",
            (plan.offer_id,),
        )
        existing = {bytes(r[0]): r for r in cur.fetchall()}
        cur.execute(
            """SELECT 1 FROM embedding
                WHERE target_type = 'offer' AND target_id = %s AND kind = 'image' LIMIT 1""",
            (plan.offer_id,),
        )
        plan.has_image_embedding = cur.fetchone() is not None

    plan.existing = len(existing)
    incoming = {image.url_hash: image for image in offer.images}
    plan.stored = len(incoming)
    plan.shown = sum(1 for image in incoming.values() if image.display_rank is not None)
    for url_hash, image in incoming.items():
        current = existing.get(url_hash)
        if current is None:
            plan.inserts += 1
            continue
        if current[7] == "broken":
            continue
        width = image.width if image.width is not None else current[4]
        height = image.height if image.height is not None else current[5]
        wanted = (
            image.source_url,
            image.source_position,
            image.display_rank,
            width,
            height,
            image.is_variant_specific,
            "active",
        )
        if tuple(current[1:8]) != wanted:
            plan.updates += 1
    plan.removals = sum(1 for h, r in existing.items() if r[7] == "active" and h not in incoming)
    new_image = offer.image_url
    plan.image_url_changes = bool(new_image) and new_image != old_image
    plan.primary_changes = (
        plan.image_url_changes and plan.product_id is not None and old_primary == old_image
    )
    plan.in_sync = not plan.needs_write
    return plan


def apply_offer(
    conn: psycopg.Connection, merchant_id: int, offer: NormalizedOffer, plan: OfferPlan
) -> None:
    """Plana gore yazar. Cagiranin transaction'indadir; commit ona aittir."""
    if not plan.found or not plan.needs_write:
        return
    if plan.image_url_changes:
        sync_primary_images(conn, merchant_id, [(offer.external_id, offer.image_url)])
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE offer SET image_url = %s, image_hash = NULL WHERE id = %s",
                (offer.image_url, plan.offer_id),
            )
            cur.execute(DELETE_STALE_IMAGE_EMBEDDING, {"offer_id": plan.offer_id})
    if plan.inserts or plan.updates or plan.removals:
        write_offer_images(conn, [(plan.offer_id, offer.images)])


@dataclass
class Totals:
    offers_seen: int = 0
    not_found: int = 0
    in_sync: int = 0
    to_write: int = 0
    inserts: int = 0
    updates: int = 0
    removals: int = 0
    image_url_changes: int = 0
    primary_changes: int = 0
    stale_embeddings: int = 0
    single: int = 0
    double: int = 0
    triple_plus: int = 0

    def add(self, plan: OfferPlan) -> None:
        self.offers_seen += 1
        if not plan.found:
            self.not_found += 1
            return
        self.in_sync += plan.in_sync
        self.to_write += plan.needs_write
        self.inserts += plan.inserts
        self.updates += plan.updates
        self.removals += plan.removals
        self.image_url_changes += plan.image_url_changes
        self.primary_changes += plan.primary_changes
        self.stale_embeddings += plan.image_url_changes and plan.has_image_embedding
        if plan.stored <= 1:
            self.single += 1
        elif plan.stored == 2:
            self.double += 1
        else:
            self.triple_plus += 1


def run_merchant(
    conn: psycopg.Connection,
    slug: str,
    *,
    apply: bool,
    handle: str | None = None,
    limit: int | None = None,
) -> Totals:
    """Bir magazanin tum (ya da tek `handle`) urunleri. Offer basina ayri transaction."""
    from collect import connector as connector_registry
    from collect.gate import ingest_refusal
    from collect.mapping import FieldMapping
    from collect.normalize import normalize
    from collect.pipeline import _check_currency, _load_merchant
    from collect.records import RecordRejected

    merchant = _load_merchant(conn, slug)
    refusal = ingest_refusal(merchant)
    if refusal is not None:
        raise RuntimeError(f"{slug}: {refusal.error_text}")
    mapping = FieldMapping.from_config(merchant["feed_config"])
    source = connector_registry.build(
        merchant["source_type"], merchant["feed_url"], merchant["feed_config"]
    )
    totals = Totals()
    for record in source.fetch():
        if handle and f"/products/{handle}" not in record.fields.get("url", ""):
            continue
        try:
            offer = normalize(record, mapping)
            _check_currency(merchant["source_type"], offer)
        except RecordRejected:
            continue
        plan = plan_offer(conn, merchant["id"], offer)
        totals.add(plan)
        if apply and plan.found and plan.needs_write:
            try:
                apply_offer(conn, merchant["id"], offer, plan)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        else:
            conn.rollback()  # yalniz okuma transaction'ini kapatir
        if limit and totals.offers_seen >= limit:
            break
    return totals


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--merchant", required=True)
    parser.add_argument("--handle")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--apply", action="store_true", help="yazar; varsayilan dry-run")
    args = parser.parse_args(argv)
    from db.connection import connect

    with connect() as conn:
        totals = run_merchant(
            conn, args.merchant, apply=args.apply, handle=args.handle, limit=args.limit
        )
    print(("APPLY" if args.apply else "DRY-RUN"), args.merchant, totals)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
