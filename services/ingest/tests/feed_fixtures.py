"""Sentetik YML beslemeleri: gercek AliExpress/Admitad ornegiyle AYNI yapi
(14 Ekim 2026), uydurma degerler. Gercek takip kodu ya da kimlik bilgisi yok."""

from __future__ import annotations

import gzip
from collections.abc import Iterable, Mapping
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

AE_PROFILE: dict[str, object] = {
    "parser": "yml",
    "url_unwrap": ["ulp", "dl_target_url"],
    "url_hosts": ["aliexpress.com"],
    "affiliate_hosts": ["rzekl.com"],
    "mapping": {"seller": "param.shopId"},
    "keep_params": ["discount", "commissionRate"],
    "required_fields": ["@id", "name", "url", "price", "currencyId"],
}


def tracking_url(product_id: str, f_id: str = "14267") -> str:
    target = quote(f"https://www.aliexpress.com/item/{product_id}.html", safe="")
    ulp = quote(
        f"https://s.click.aliexpress.com/deep_link.htm?aff_short_key=TEST&dl_target_url={target}",
        safe="",
    )
    return f"https://rzekl.com/g/0000test0000/?i=5&f_id={f_id}&ulp={ulp}"


def offer(
    product_id: str,
    *,
    price: str = "22.11",
    oldprice: str | None = "30.00",
    shop: str | None = "1105855203",
    currency: str = "USD",
    category: str = "200000920",
    title: str | None = None,
    pictures: int = 2,
    url: str | None = None,
) -> dict[str, object]:
    return {
        "id": product_id,
        "name": title or f"Test product {product_id}",
        "url": url if url is not None else tracking_url(product_id),
        "price": price,
        "oldprice": oldprice,
        "currencyId": currency,
        "categoryId": category,
        "pictures": [
            f"https://ae-pic-a1.aliexpress-media.com/kf/S{product_id}{i}.png"
            for i in range(pictures)
        ],
        "params": {
            "discount": "26%",
            "commissionRate": "5.38%",
            **({"shopId": shop} if shop else {}),
        },
    }


def yml(offers: Iterable[Mapping[str, object]], *, truncate: bool = False) -> bytes:
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="2026-10-14 08:28"><shop>',
        "<name>Aliexpress</name><url>https://aliexpress.com</url>",
        '<currencies><currency id="USD" rate="1"/></currencies><categories>',
        '<category id="15">Home &amp; Garden</category>',
        '<category id="200000920" parentId="15">Kitchen Storage</category>',
        "</categories><offers>",
    ]
    for o in offers:
        parts.append(f'<offer id="{o["id"]}">')
        parts.append(f"<name>{escape(str(o['name']))}</name>")
        parts.append(f"<url>{escape(str(o['url']))}</url>")
        parts.append(f"<price>{o['price']}</price>")
        if o.get("oldprice"):
            parts.append(f"<oldprice>{o['oldprice']}</oldprice>")
        parts.append(f"<currencyId>{o['currencyId']}</currencyId>")
        parts.append(f"<categoryId>{o['categoryId']}</categoryId>")
        for picture in o["pictures"]:  # type: ignore[union-attr]
            parts.append(f"<picture>{escape(picture)}</picture>")
        for name, value in o["params"].items():  # type: ignore[union-attr]
            parts.append(f'<param name="{name}">{escape(value)}</param>')
        parts.append("</offer>")
    parts.append("</offers></shop></yml_catalog>")
    data = "".join(parts).encode("utf-8")
    return data[: int(len(data) * 0.8)] if truncate else data


def write(path: Path, data: bytes, *, gz: bool = False) -> Path:
    path.write_bytes(gzip.compress(data) if gz else data)
    return path
