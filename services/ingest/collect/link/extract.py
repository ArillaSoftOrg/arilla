"""Sayfadan urun bilgisi cikarimi — uc katmanli, sirayla.

`docs/architecture.md` Katman 2: "once sayfadaki yapilandirilmis veri
(schema.org JSON-LD) denenir, HTML ayristirma son caredir."

    1. JSON-LD  — schema.org `Product`. Yayinlanmis bir standart; alan adlari
                  tahmin degil, sozlesme.
    2. OpenGraph / microdata — yaygin, yari-yapilandirilmis.
    3. HTML sezgisel — son care. Dusuk guvenle isaretlenir.

Ayristirici stdlib `html.parser`: B1'de `lxml` reddedildi, burada da
`beautifulsoup4` eklenmiyor. Sayfadan yalnizca script ve meta icerigi
cekiliyor, DOM agaci gezilmiyor.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any

logger = logging.getLogger(__name__)

#: Son care katmaninin fiyat sezgisi: "1.234,56 TL", "₺1.234,56", "1234.56 TRY"
PRICE_PATTERN = re.compile(
    r"(?:₺|\bTL\b|\bTRY\b)\s*([0-9][0-9.,\s]*)|([0-9][0-9.,]*)\s*(?:₺|\bTL\b|\bTRY\b)",
    re.IGNORECASE,
)

IN_STOCK_TOKENS = ("instock", "in_stock", "in stock", "limitedavailability", "presale", "1", "true")
#: Once bunlara bakilir: "outofstock" icinde "stock" gectigi icin sira onemli.
OUT_OF_STOCK_TOKENS = (
    "outofstock",
    "out_of_stock",
    "out of stock",
    "soldout",
    "discontinued",
    "backorder",
    "0",
    "false",
)


@dataclass
class ExtractedProduct:
    """Sayfadan okunan ham urun bilgisi. Henuz `NormalizedOffer` degil."""

    title: str | None = None
    price_text: str | None = None
    list_price_text: str | None = None
    currency: str | None = None
    image_url: str | None = None
    brand: str | None = None
    gtin: str | None = None
    mpn: str | None = None
    category: str | None = None
    in_stock: bool | None = None
    #: Hangi katman verdi: 'json_ld' | 'opengraph' | 'heuristic'
    source_layer: str = "heuristic"

    @property
    def low_confidence(self) -> bool:
        """Son care katmani. Cagiran taraf bunu kullaniciya isaretleyebilir."""
        return self.source_layer == "heuristic"

    @property
    def usable(self) -> bool:
        return bool(self.title and self.price_text)


class _PageParser(HTMLParser):
    """Sayfadan JSON-LD bloklarini, meta etiketlerini ve basligi toplar."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.json_ld: list[str] = []
        self.meta: dict[str, str] = {}
        self.microdata: dict[str, str] = {}
        self.title: str | None = None
        self.text_chunks: list[str] = []
        self._in_ld = False
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): (value or "") for name, value in attrs}
        if tag == "script" and values.get("type", "").lower() == "application/ld+json":
            self._in_ld = True
            self.json_ld.append("")
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = values.get("property") or values.get("name") or values.get("itemprop")
            content = values.get("content")
            if key and content:
                self.meta.setdefault(key.lower(), content)
        # itemprop tasiyan elemanlarin content/href degerleri (microdata)
        prop = values.get("itemprop")
        if prop and tag != "meta":
            value = values.get("content") or values.get("href") or values.get("src")
            if value:
                self.microdata.setdefault(prop.lower(), value)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self._in_ld = False
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_ld and self.json_ld:
            self.json_ld[-1] += data
        elif self._in_title:
            self.title = (self.title or "") + data
        else:
            stripped = data.strip()
            if stripped:
                self.text_chunks.append(stripped)


# --- 1. katman: JSON-LD -----------------------------------------------------


def _walk(node: Any) -> list[dict[str, Any]]:
    """JSON-LD govdesindeki tum nesneleri duzlestirir (@graph ve diziler dahil)."""
    found: list[dict[str, Any]] = []
    if isinstance(node, list):
        for item in node:
            found.extend(_walk(item))
    elif isinstance(node, dict):
        found.append(node)
        for key in ("@graph", "mainEntity", "itemListElement"):
            if key in node:
                found.extend(_walk(node[key]))
    return found


def _types(node: dict[str, Any]) -> set[str]:
    raw = node.get("@type") or node.get("type") or []
    values = raw if isinstance(raw, list) else [raw]
    return {str(value).lower() for value in values}


def _first_offer(node: Any) -> dict[str, Any] | None:
    """`offers` tekil, dizi veya AggregateOffer olabilir."""
    if isinstance(node, dict):
        if "lowPrice" in node or "price" in node or "highPrice" in node:
            return node
        if "offers" in node:
            return _first_offer(node["offers"])
        return None
    if isinstance(node, list):
        for item in node:
            found = _first_offer(item)
            if found:
                return found
    return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, dict):
        return _text(value.get("name") or value.get("@value") or value.get("url"))
    if isinstance(value, list) and value:
        return _text(value[0])
    return None


def from_json_ld(blocks: list[str]) -> ExtractedProduct | None:
    for block in blocks:
        try:
            payload = json.loads(block)
        except json.JSONDecodeError:
            logger.debug("JSON-LD blogu ayristirilamadi, sonrakine geciliyor")
            continue

        for node in _walk(payload):
            if "product" not in _types(node):
                continue

            offer = _first_offer(node.get("offers")) or _first_offer(node)
            price = _text(offer.get("price") or offer.get("lowPrice")) if offer else None
            availability = _text(offer.get("availability")) if offer else None

            product = ExtractedProduct(
                title=_text(node.get("name")),
                price_text=price,
                currency=_text(offer.get("priceCurrency")) if offer else None,
                image_url=_text(node.get("image")),
                brand=_text(node.get("brand")),
                gtin=_text(node.get("gtin13") or node.get("gtin") or node.get("gtin12")),
                mpn=_text(node.get("mpn")),
                category=_text(node.get("category")),
                in_stock=_availability(availability),
                source_layer="json_ld",
            )
            if product.usable:
                return product
    return None


def _availability(value: str | None) -> bool | None:
    """schema.org availability -> stokta mi.

    Bilinmeyen bir deger `None` doner: "bilmiyorum" ile "stokta degil" ayri
    seylerdir ve karistirilirsa urun sebepsiz yere stok disi gorunur.
    """
    if not value:
        return None
    lowered = value.lower().rsplit("/", 1)[-1]
    if any(token in lowered for token in OUT_OF_STOCK_TOKENS):
        return False
    if any(token in lowered for token in IN_STOCK_TOKENS):
        return True
    return None


# --- 2. katman: OpenGraph / microdata ---------------------------------------


def from_meta(parser: _PageParser) -> ExtractedProduct | None:
    meta = parser.meta
    micro = parser.microdata

    title = meta.get("og:title") or micro.get("name") or (parser.title or "").strip() or None
    price = meta.get("product:price:amount") or meta.get("og:price:amount") or micro.get("price")
    if not (title and price):
        return None

    availability = meta.get("product:availability") or micro.get("availability")
    product = ExtractedProduct(
        title=title,
        price_text=price,
        currency=meta.get("product:price:currency") or meta.get("og:price:currency"),
        image_url=meta.get("og:image") or micro.get("image"),
        brand=meta.get("product:brand") or micro.get("brand"),
        gtin=micro.get("gtin13") or micro.get("gtin"),
        mpn=micro.get("mpn"),
        in_stock=_availability(availability),
        source_layer="opengraph",
    )
    return product if product.usable else None


# --- 3. katman: son care ----------------------------------------------------


def from_heuristics(parser: _PageParser) -> ExtractedProduct | None:
    """Yapilandirilmis veri yok. Basligi ve ilk fiyat gorunumlu sayiyi al.

    Bu katmanin ciktisi DUSUK GUVENLIDIR ve oyle isaretlenir: eslestirme
    (B4) ve arayuz bu farki gormeli. Yanlis fiyat gostermek, fiyat
    gostermemekten kotudur.
    """
    title = (parser.title or "").strip() or None
    if not title:
        return None

    for chunk in parser.text_chunks:
        match = PRICE_PATTERN.search(chunk)
        if match:
            price = (match.group(1) or match.group(2) or "").strip()
            if price:
                return ExtractedProduct(
                    title=title,
                    price_text=price,
                    currency="TRY",
                    image_url=parser.meta.get("og:image"),
                    source_layer="heuristic",
                )
    return None


def extract(html: str) -> ExtractedProduct | None:
    """Uc katmani sirayla dener, ilk kullanilabilir sonucta durur."""
    parser = _PageParser()
    parser.feed(html)

    for layer in (
        lambda: from_json_ld(parser.json_ld),
        lambda: from_meta(parser),
        lambda: from_heuristics(parser),
    ):
        product = layer()
        if product is not None:
            return product
    return None
