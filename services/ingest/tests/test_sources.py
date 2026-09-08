"""Uc tasima bicimi. Hicbir test aga cikmaz."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import httpx
import pytest

from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.sources.network_dump import NetworkDumpConnector
from collect.sources.rest_api import AuthError, RestApiConnector
from collect.sources.xml_feed import XmlFeedConnector

# --- XML feed ---------------------------------------------------------------


def test_xml_feed_yields_every_item(feed_v1: Path, xml_feed_config: dict) -> None:
    records = list(XmlFeedConnector(source=feed_v1, config=xml_feed_config).fetch())
    assert len(records) == 100
    assert records[0].fields["g:id"] == "SKU-0001"
    # Hem on ekli hem sade ad taninmali.
    assert records[0].fields["id"] == "SKU-0001"


def test_xml_feed_collects_variant_groups(feed_v1: Path, xml_feed_config: dict) -> None:
    record = next(iter(XmlFeedConnector(source=feed_v1, config=xml_feed_config).fetch()))
    variants = record.groups["g:sizes"]
    assert len(variants) == 3
    assert {"g:size", "g:stock"} <= set(variants[0])


def test_xml_feed_normalizes_to_offer(feed_v1: Path, xml_feed_config: dict) -> None:
    mapping = FieldMapping.from_config(xml_feed_config)
    record = next(iter(XmlFeedConnector(source=feed_v1, config=xml_feed_config).fetch()))
    offer = normalize(record, mapping)
    assert offer.external_id == "SKU-0001"
    assert offer.current_price == 207400  # kurus
    assert offer.currency == "TRY"
    assert len(offer.variants) == 3
    assert offer.variants[0].size_norm is not None


# --- REST API ---------------------------------------------------------------


def _paged_client(pages: list[list[dict]]) -> httpx.Client:
    """Sayfa numarasiyla calisan sahte API."""

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params.get("page", 1))
        items = pages[page - 1] if page - 1 < len(pages) else []
        return httpx.Response(200, json={"data": {"products": items}})

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_rest_api_walks_pages() -> None:
    pages = [
        [{"sku": f"A{i}", "name": f"urun {i}"} for i in range(10)],
        [{"sku": f"B{i}", "name": f"urun {i}"} for i in range(10)],
        [{"sku": "C0", "name": "son"}],
    ]
    config = {
        "transport": {
            "record_path": "data.products",
            "pagination": {
                "kind": "page_number",
                "param": "page",
                "size_param": "limit",
                "size": 10,
            },
        }
    }
    connector = RestApiConnector(
        base_url="https://api.example/products", config=config, client=_paged_client(pages)
    )
    records = list(connector.fetch())
    assert len(records) == 21
    assert records[-1].fields["sku"] == "C0"


def test_rest_api_follows_cursor() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        cursor = request.url.params.get("cursor")
        if cursor is None:
            return httpx.Response(200, json={"items": [{"sku": "A"}], "next": "c2"})
        if cursor == "c2":
            return httpx.Response(200, json={"items": [{"sku": "B"}], "next": None})
        return httpx.Response(200, json={"items": []})

    config = {
        "transport": {
            "record_path": "items",
            "pagination": {"kind": "cursor", "param": "cursor", "next_path": "next"},
        }
    }
    connector = RestApiConnector(
        base_url="https://api.example/p",
        config=config,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert [r.fields["sku"] for r in connector.fetch()] == ["A", "B"]


def test_rest_api_nested_lists_become_groups() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"items": [{"sku": "A", "sizes": [{"label": "38", "stock": "1"}]}]},
        )

    config = {"transport": {"record_path": "items", "pagination": {"kind": "cursor"}}}
    connector = RestApiConnector(
        base_url="https://api.example/p",
        config=config,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    record = next(iter(connector.fetch()))
    assert record.groups["sizes"][0]["label"] == "38"


def test_rest_api_refuses_missing_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """Anahtar deger olarak config'te DURMAZ; ortam degiskeni bossa kosu baslamaz."""
    monkeypatch.delenv("MERCHANT_TEST_TOKEN", raising=False)
    config = {
        "transport": {
            "record_path": "items",
            "auth": {"kind": "bearer_env", "env": "MERCHANT_TEST_TOKEN"},
            "pagination": {"kind": "cursor"},
        }
    }
    connector = RestApiConnector(base_url="https://api.example/p", config=config)
    with pytest.raises(AuthError, match="MERCHANT_TEST_TOKEN"):
        list(connector.fetch())


def test_rest_api_sends_bearer_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MERCHANT_TEST_TOKEN", "s3cret")
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("Authorization", ""))
        return httpx.Response(200, json={"items": []})

    config = {
        "transport": {
            "record_path": "items",
            "auth": {"kind": "bearer_env", "env": "MERCHANT_TEST_TOKEN"},
            "pagination": {"kind": "cursor"},
        }
    }
    list(
        RestApiConnector(
            base_url="https://api.example/p",
            config=config,
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        ).fetch()
    )
    assert seen == ["Bearer s3cret"]


# --- Ag dokumu --------------------------------------------------------------


def test_network_dump_maps_generic_columns(network_dump: Path, network_dump_config: dict) -> None:
    """Kolon adlari tamamen jenerik; eslemenin config'ten geldigini kanitlar."""
    mapping = FieldMapping.from_config(network_dump_config)
    records = list(NetworkDumpConnector(source=network_dump, config=network_dump_config).fetch())
    assert len(records) == 25

    offer = normalize(records[0], mapping)
    assert offer.external_id == "NET-0001"
    assert offer.current_price == 103750  # "1037,50" -> kurus
    assert offer.in_stock is True


def test_network_dump_reads_gzip(
    tmp_path: Path, network_dump: Path, network_dump_config: dict
) -> None:
    packed = tmp_path / "dump.csv.gz"
    packed.write_bytes(gzip.compress(network_dump.read_bytes()))
    config = json.loads(json.dumps(network_dump_config))
    config["transport"]["gzip"] = True
    records = list(NetworkDumpConnector(source=packed, config=config).fetch())
    assert len(records) == 25
