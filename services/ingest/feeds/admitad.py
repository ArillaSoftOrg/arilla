"""Admitad yayinci API'si ile besleme kesfi (karar 0112).

Gercek API'de dogrulanan (14 Ekim 2026, manicepte.com reklam alani):

- `POST https://api.admitad.com/token/`: `Authorization: Basic base64(id:secret)`,
  `grant_type=client_credentials`, `client_id`, `scope` (bosluklu liste).
  Yanit: `access_token`, `expires_in` (604800 sn), `scope`.
- `GET /websites/v2/`: reklam alanlari (dizi); `id`, `status`.
- `GET /advcampaigns/website/{w_id}/?connection_status=active&limit&offset`:
  `{"_meta": {"count", "limit", "offset"}, "results": [...]}`. Program: `id`,
  `name`, `currency`, `feeds_info: [{name, xml_link, csv_link,
  admitad_last_update, advertiser_last_update}]`.
- Besleme adresi `export.admitad.com/webmaster/websites/{w_id}/products/
  export_adv_products/?user=..&code=..&feed_id=..&format=xml|csv`. `code`
  kimlik bilgisidir: saklanmaz, loglanmaz.

Kimlik bilgisi ortamdan: `ADMITAD_CLIENT_ID`, `ADMITAD_CLIENT_SECRET`.
Token yalnizca bellekte. Gecici hatalar (429/5xx/ag) ustel geri cekilmeyle
en fazla `MAX_ATTEMPTS` kez denenir.
"""

from __future__ import annotations

import base64
import logging
import random
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

import httpx

from db.connection import env
from feeds.network import DiscoveredFeed, NetworkUnavailable, redact_url, register

logger = logging.getLogger(__name__)

API = "https://api.admitad.com"
SCOPE = "advcampaigns_for_website websites"
PAGE = 100
MAX_PAGES = 50
MAX_ATTEMPTS = 4
#: Besleme adresinin gosterimde tutulan parametreleri (sir degil).
KEEP_PARAMS = frozenset({"feed_id", "format"})


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace(" ", "T"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _https(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(("https", *parts[1:])) if parts.scheme == "http" else url


class AdmitadNetwork:
    name = "admitad"

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        *,
        client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        programs: frozenset[str] | None = None,
        scope: str = SCOPE,
    ) -> None:
        self._id = client_id or env("ADMITAD_CLIENT_ID")
        self._secret = client_secret or env("ADMITAD_CLIENT_SECRET")
        if not self._id or not self._secret:
            raise NetworkUnavailable("ADMITAD_CLIENT_ID / ADMITAD_CLIENT_SECRET tanimli degil")
        self._http = client or httpx.Client(timeout=30.0)
        self._sleep = sleep
        self._scope = scope
        self._token: str | None = None
        self._token_expires = 0.0
        # Istege bagli program filtresi (ADMITAD_PROGRAMS="6115,123").
        raw = env("ADMITAD_PROGRAMS")
        self._programs = programs or (
            frozenset(p.strip() for p in raw.split(",") if p.strip()) if raw else None
        )

    # -- HTTP ------------------------------------------------------------------
    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        delay = 1.0
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self._http.request(method, API + path, **kwargs)
            except httpx.TransportError as error:
                if attempt == MAX_ATTEMPTS:
                    raise NetworkUnavailable(
                        f"admitad erisilemedi: {type(error).__name__}"
                    ) from None
            else:
                if response.status_code < 500 and response.status_code != 429:
                    return response
                if attempt == MAX_ATTEMPTS:
                    raise NetworkUnavailable(f"admitad {path} -> {response.status_code}")
                retry_after = response.headers.get("retry-after", "")
                if retry_after.isdigit():
                    delay = max(delay, min(float(retry_after), 60.0))
            self._sleep(delay + random.uniform(0, delay / 2))
            delay = min(delay * 2, 30.0)
        raise AssertionError("ulasilmaz")

    def _auth(self) -> dict[str, str]:
        if self._token is None or time.monotonic() >= self._token_expires:
            basic = base64.b64encode(f"{self._id}:{self._secret}".encode()).decode()
            response = self._request(
                "POST",
                "/token/",
                headers={"Authorization": f"Basic {basic}"},
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._id,
                    "scope": self._scope,
                },
            )
            if response.status_code != 200:
                raise NetworkUnavailable(f"admitad token -> {response.status_code}")
            body = response.json()
            self._token = str(body["access_token"])
            # Suresinden once yenile (en fazla 1 gun guvenilir).
            ttl = min(int(body.get("expires_in") or 3600), 86_400)
            self._token_expires = time.monotonic() + max(ttl - 300, 60)
        return {"Authorization": f"Bearer {self._token}"}

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        response = self._request("GET", path, params=params, headers=self._auth())
        if response.status_code == 401:
            # Token gecersizlesmis olabilir: bir kez yenile.
            self._token = None
            response = self._request("GET", path, params=params, headers=self._auth())
        if response.status_code != 200:
            raise NetworkUnavailable(f"admitad {path} -> {response.status_code}")
        return response.json()

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """Kimlik dogrulamali GET (diger Admitad uclari, or. affiliate/admitad_actions.py)."""
        return self._get(path, params)

    # -- Kesif -----------------------------------------------------------------
    def websites(self) -> list[int]:
        body = self._get("/websites/v2/", {"limit": PAGE})
        items = body.get("results", []) if isinstance(body, dict) else body
        return [int(w["id"]) for w in items if w.get("status") == "active"]

    def _programs_for(self, website_id: int) -> Iterator[dict[str, Any]]:
        offset = 0
        for _ in range(MAX_PAGES):
            body = self._get(
                f"/advcampaigns/website/{website_id}/",
                {"limit": PAGE, "offset": offset, "connection_status": "active"},
            )
            results = body.get("results", [])
            yield from results
            count = int((body.get("_meta") or {}).get("count") or 0)
            offset += PAGE
            if not results or offset >= count:
                return

    def _feeds(self) -> Iterator[tuple[int, dict[str, Any], dict[str, Any]]]:
        for website_id in self.websites():
            for program in self._programs_for(website_id):
                if self._programs and str(program.get("id")) not in self._programs:
                    continue
                for feed in program.get("feeds_info") or []:
                    yield website_id, program, feed

    def discover(self) -> list[DiscoveredFeed]:
        found: dict[str, DiscoveredFeed] = {}
        for _website_id, program, feed in self._feeds():
            link = feed.get("xml_link") or feed.get("csv_link")
            if not link:
                continue
            query = dict(parse_qsl(urlsplit(link).query))
            feed_id = query.get("feed_id")
            if not feed_id:
                logger.warning(
                    "admitad: feed_id'siz besleme atlandi (program %s)", program.get("id")
                )
                continue
            is_xml = bool(feed.get("xml_link"))
            external_id = f"{program['id']}:{feed_id}"
            found[external_id] = DiscoveredFeed(
                network=self.name,
                external_id=external_id,
                program_external_id=str(program["id"]),
                program_name=str(program.get("name") or "")[:300] or None,
                name=str(feed.get("name") or "")[:300] or None,
                format="xml" if is_xml else "csv",
                compression=None,
                source_url_redacted=redact_url(_https(link), KEEP_PARAMS),
                currency=(program.get("currency") or None),
                market=None,
                source_updated_at=_parse_time(feed.get("admitad_last_update")),
                default_config={"parser": "yml"} if is_xml else {"delimiter": ";"},
            )
        return list(found.values())

    def download_url(self, external_id: str) -> str:
        program_id, _, feed_id = external_id.partition(":")
        for _website_id, program, feed in self._feeds():
            if str(program.get("id")) != program_id:
                continue
            link = feed.get("xml_link") or feed.get("csv_link") or ""
            if dict(parse_qsl(urlsplit(link).query)).get("feed_id") == feed_id:
                return _https(link)
        raise NetworkUnavailable(f"admitad: {external_id} artik listede yok")


register("admitad", AdmitadNetwork)
