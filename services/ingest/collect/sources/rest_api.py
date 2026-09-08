"""REST API tasimasi.

XML feed'den ayiran uc sey burada: kimlik dogrulama, sayfalama ve oran siniri.
Bir REST kosusu 100 sayfanin 40'inda olebilir — `ingest_run.status = 'partial'`
tam olarak bunun icin var.

Sayfalama bicimleri JENERIKTIR (sayfa numarasi ve cursor). Hicbir saglayicinin
API semasi varsayilmaz; hangi parametrenin ne oldugu `feed_config` icinde
yazar.

HTTP istemcisi disaridan verilebilir: testler aga cikmaz.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from collect.connector import Connector, register
from collect.records import RawRecord


class AuthError(RuntimeError):
    """Kimlik bilgisi eksik. Kosu baslamadan durur."""


def _resolve_auth(auth: dict[str, Any]) -> dict[str, str]:
    """Kimlik basliklarini uretir.

    Token DEGERI `feed_config` icinde DURMAZ — orada yalnizca okunacak ortam
    degiskeninin ADI durur (docs/ops.md: depoya asla anahtar yazilmaz).
    """
    if not auth:
        return {}
    kind = auth.get("kind")
    if kind in {"bearer_env", "header_env"}:
        variable = auth.get("env")
        if not variable:
            raise AuthError("auth.env tanimli degil: hangi ortam degiskeni okunacak?")
        value = os.environ.get(variable)
        if not value:
            raise AuthError(f"{variable} ortam degiskeni bos. Anahtar depoda tutulmaz.")
        if kind == "bearer_env":
            return {"Authorization": f"Bearer {value}"}
        return {str(auth.get("header", "X-Api-Key")): value}
    raise AuthError(f"bilinmeyen auth turu: {kind!r}")


def _dig(payload: Any, path: str | None) -> Any:
    """'data.products' gibi bir yolu JSON govdesinde izler."""
    if not path:
        return payload
    current = payload
    for part in str(path).split("."):
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


@dataclass
class RestApiConnector(Connector):
    base_url: str
    config: dict[str, Any] = field(default_factory=dict)
    client: httpx.Client | None = None
    #: Guvenlik freni: yanlis yapilandirilmis bir cursor sonsuz donebilir.
    max_pages: int = 10_000

    @property
    def _transport(self) -> dict[str, Any]:
        return self.config.get("transport") or {}

    def _client(self) -> httpx.Client:
        return self.client or httpx.Client(timeout=60.0, follow_redirects=True)

    def fetch(self) -> Iterator[RawRecord]:
        transport = self._transport
        headers = _resolve_auth(transport.get("auth") or {})
        pagination = transport.get("pagination") or {}
        kind = pagination.get("kind", "page_number")
        record_path = transport.get("record_path")
        min_interval = 0.0
        rate = (transport.get("rate_limit") or {}).get("requests_per_second")
        if rate:
            min_interval = 1.0 / float(rate)

        client = self._client()
        params: dict[str, Any] = dict(transport.get("params") or {})
        size = pagination.get("size")
        if size and pagination.get("size_param"):
            params[pagination["size_param"]] = size

        page = int(pagination.get("start", 1))
        cursor: str | None = None
        index = 0
        last_request = 0.0

        for _ in range(self.max_pages):
            if kind == "page_number":
                params[pagination.get("param", "page")] = page
            elif kind == "cursor":
                if cursor:
                    params[pagination.get("param", "cursor")] = cursor
            else:
                raise ValueError(f"bilinmeyen sayfalama turu: {kind!r}")

            # Oran siniri: istekler arasinda en az bu kadar bekle.
            if min_interval:
                elapsed = time.monotonic() - last_request
                if elapsed < min_interval:
                    time.sleep(min_interval - elapsed)
            last_request = time.monotonic()

            response = client.get(self.base_url, params=params, headers=headers)
            response.raise_for_status()
            payload = response.json()

            records = _dig(payload, record_path)
            if not records:
                return

            for entry in records:
                index += 1
                fields = {
                    key: str(value)
                    for key, value in entry.items()
                    if value is not None and not isinstance(value, list | dict)
                }
                groups = {
                    key: tuple(
                        {k: str(v) for k, v in item.items() if v is not None}
                        for item in value
                        if isinstance(item, dict)
                    )
                    for key, value in entry.items()
                    if isinstance(value, list)
                }
                yield RawRecord(
                    fields=fields,
                    source_ref=f"sayfa {page}, kayit {index}",
                    groups=groups,
                )

            if kind == "cursor":
                cursor = _dig(payload, pagination.get("next_path", "next_cursor"))
                if not cursor:
                    return
            else:
                page += 1
                # Sayfa boyutundan az kayit geldiyse son sayfadayiz.
                if size and len(records) < int(size):
                    return

        raise RuntimeError(
            f"sayfalama {self.max_pages} sayfada bitmedi — yapilandirma hatasi olabilir"
        )


register("api", lambda url, config: RestApiConnector(base_url=url or "", config=config))
