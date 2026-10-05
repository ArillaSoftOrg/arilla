from __future__ import annotations

import json
from pathlib import Path

import pytest
from urllib.parse import urlparse

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


@pytest.fixture(scope="session", autouse=True)
def _refuse_non_local_database() -> None:
    """Testler uretim/uzak veritabanina baglanamaz (fail-closed). Host/parola yazdirilmaz."""
    from db.connection import env

    for name in ("DATABASE_URL", "DATABASE_URL_OWNER"):
        url = env(name)
        if not url:
            continue
        try:
            host = (urlparse(url).hostname or "").lower()
        except ValueError:
            host = ""
        if host not in _LOCAL_HOSTS:
            pytest.exit(
                f"{name} yerel makineyi gostermiyor; testler yalnizca yerel veritabaniyla calisir.",
                returncode=2,
            )

FIXTURES = Path(__file__).parent / "fixtures"

#: Ornek feed'in eslemesi. Alan adlari KAYNAGA ait; kod hicbirini varsaymaz.
XML_FEED_CONFIG = {
    "transport": {"record_path": "channel/item"},
    "mapping": {
        "external_id": "g:id",
        "title": "g:title",
        "url": "g:link",
        "price": "g:price",
        "list_price": "g:sale_price",
        "image_url": "g:image_link",
        "brand": "g:brand",
        "category": "g:product_type",
        "availability": "g:availability",
        "shipping_days": "g:shipping_days",
        "variants": {"path": "g:sizes", "size": "g:size", "availability": "g:stock"},
    },
    "value_formats": {"decimal_separator": ".", "thousands_separator": ""},
    # Fixture feed'leri TL; para birimi merchant duzeyinde dogrulanmis (0029).
    "currency": "TRY",
    "currency_verified": True,
}

#: Ag dokumu eslemesi: kolon adlari tamamen farkli, kod degismiyor.
NETWORK_DUMP_CONFIG = {
    "transport": {"delimiter": ";", "encoding": "utf-8"},
    "mapping": {
        "external_id": "urun_kodu",
        "title": "baslik",
        "url": "adres",
        "price": "tutar",
        "availability": "stok_durumu",
    },
    "value_formats": {"decimal_separator": ",", "thousands_separator": "."},
    "currency": "TRY",
    "currency_verified": True,
}


@pytest.fixture
def xml_feed_config() -> dict:
    return json.loads(json.dumps(XML_FEED_CONFIG))


@pytest.fixture
def network_dump_config() -> dict:
    return json.loads(json.dumps(NETWORK_DUMP_CONFIG))


@pytest.fixture
def feed_v1() -> Path:
    return FIXTURES / "xml_feed_100.xml"


@pytest.fixture
def feed_v2() -> Path:
    return FIXTURES / "xml_feed_100_v2.xml"


@pytest.fixture
def network_dump() -> Path:
    return FIXTURES / "network_dump.csv"
