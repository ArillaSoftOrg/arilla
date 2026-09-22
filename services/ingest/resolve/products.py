"""Eslesmeyen offer'dan yeni kanonik `product` turetimi.

`architecture.md` bu adimi hic anlatmiyordu: §1 toplama urun yaratmiyor, §3
eslestirme yalnizca aday yaziyor. Yani feed'den gelen katalog hic buyumuyordu.
Kullanici karariyla bosluk kapatildi (bkz. docs/decisions/0017).

Kural: kuyruk esiginin altinda kalan offer icin YENI urun acilir ve offer ona
baglanir. Boylece her aktif offer bir urune aittir ve aramada gorunur.
"""

from __future__ import annotations

import logging

import psycopg

from resolve.normalize import extract_color, strip_accents

logger = logging.getLogger(__name__)

INSERT_PRODUCT = """
INSERT INTO product (slug, title, brand_id, category_id, gtin, mpn, color, primary_image_url)
VALUES (%(slug)s, %(title)s, %(brand_id)s, %(category_id)s, %(gtin)s, %(mpn)s,
        %(color)s, %(image_url)s)
RETURNING id
"""

FIND_BRAND = "SELECT id FROM brand WHERE name_norm = %(name_norm)s"
INSERT_BRAND = """
INSERT INTO brand (slug, name, name_norm) VALUES (%(slug)s, %(name)s, %(name_norm)s)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
RETURNING id
"""

FIND_CATEGORY = "SELECT id FROM category WHERE path = %(path)s"


def slugify(value: str) -> str:
    text = strip_accents(value).lower()
    cleaned = "".join(char if char.isalnum() else "-" for char in text)
    return "-".join(part for part in cleaned.split("-") if part)[:200] or "urun"


def unique_slug(conn: psycopg.Connection, base: str) -> str:
    """`product.slug` UNIQUE; cakisirsa sonuna sayi eklenir.

    Slug degisirse `product_slug_history` uzerinden 301 verilir — ama yeni
    urun icin gecmis yok, yalnizca cakismayi cozuyoruz.
    """
    candidate = base
    suffix = 2
    with conn.cursor() as cur:
        while True:
            cur.execute("SELECT 1 FROM product WHERE slug = %s", (candidate,))
            if cur.fetchone() is None:
                return candidate
            candidate = f"{base}-{suffix}"
            suffix += 1


def resolve_brand(conn: psycopg.Connection, name: str | None) -> int | None:
    """Markayi bulur, yoksa acar. Marka kimliktir; kaybedilmemeli."""
    if not name or not name.strip():
        return None
    name_norm = strip_accents(name).lower().replace(" ", "")
    with conn.cursor() as cur:
        cur.execute(FIND_BRAND, {"name_norm": name_norm})
        row = cur.fetchone()
        if row is not None:
            return int(row[0])
        cur.execute(
            INSERT_BRAND,
            {"slug": slugify(name), "name": name.strip(), "name_norm": name_norm},
        )
        created = cur.fetchone()
    return int(created[0]) if created else None


def resolve_category(conn: psycopg.Connection, path: str | None) -> int | None:
    """Kategori YALNIZCA varsa baglanir, yoktan acilmaz.

    Kategori agaci kurumsal bir karar: `is_discoverable` bayragi kesfet
    akisini yonetiyor, hangi ana kategorilerin MVP kapsaminda oldugu ise
    docs/decisions/0023 ile bilincli belirleniyor. Feed'in ham metninden
    kategori uretmek bu kararlari delerdi.
    """
    if not path or not path.strip():
        return None
    with conn.cursor() as cur:
        cur.execute(FIND_CATEGORY, {"path": path.strip()})
        row = cur.fetchone()
    return int(row[0]) if row else None


def create_from_offer(
    conn: psycopg.Connection,
    *,
    title: str,
    brand: str | None,
    category_path: str | None,
    image_url: str | None,
    gtin: str | None,
    mpn: str | None,
) -> int:
    brand_id = resolve_brand(conn, brand)
    category_id = resolve_category(conn, category_path)
    slug = unique_slug(conn, slugify(f"{brand or ''} {title}".strip()))

    with conn.cursor() as cur:
        cur.execute(
            INSERT_PRODUCT,
            {
                "slug": slug,
                "title": title.strip(),
                "brand_id": brand_id,
                "category_id": category_id,
                "gtin": gtin,
                "mpn": mpn,
                # Renk kanonik kimligin parcasi: siyah ve bej ayri urundur.
                "color": extract_color(title),
                "image_url": image_url,
            },
        )
        row = cur.fetchone()
    assert row is not None
    logger.info("yeni urun acildi: %s (%s)", title.strip(), slug)
    return int(row[0])
