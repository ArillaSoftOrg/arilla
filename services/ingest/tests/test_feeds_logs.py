"""Besleme adresindeki kimlik bilgisi loglara yazilmaz (karar 0114)."""

from __future__ import annotations

import logging

import httpx
import pytest

from feeds.logs import MaskUrls, configure, mask_urls

SECRET = (
    "https://export.admitad.com/webmaster/websites/1/products/export_adv_products/"
    "?user=u&code=SECRETCODE&feed_id=1"
)


def test_mask_urls_sorgu_dizisini_ve_kullanici_bilgisini_siler() -> None:
    assert mask_urls(f"GET {SECRET} 200") == (
        "GET https://export.admitad.com/webmaster/websites/1/products/"
        "export_adv_products/?<gizli> 200"
    )
    assert "pass" not in mask_urls("x https://user:pass@h.test/a?b=1")
    assert mask_urls("adres yok") == "adres yok"


def test_httpx_istegi_adresi_sizdirmaz(caplog: pytest.LogCaptureFixture) -> None:
    configure()
    caplog.handler.addFilter(MaskUrls())
    with caplog.at_level(logging.INFO):
        client = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(200)))
        client.get(SECRET)
        logging.getLogger("feeds").info("indiriliyor %s", SECRET)
    assert "SECRETCODE" not in caplog.text
    assert "?<gizli>" in caplog.text
