"""TCMB gunluk kur (karar 0113). Resmi, herkese acik kaynak:
`https://www.tcmb.gov.tr/kurlar/today.xml` (robots.txt yalnizca arama sonuclarini
yasaklar). Hafta sonu/tatilde yeni bulten yayimlanmaz; son bulten tarihi saklanir.

Kur `effective_date` (bulten tarihi) ve `fetched_at` ile yazilir. Ayni bulten
ikinci kez yazilmaz (UNIQUE). Kur uydurulmaz: deger yoksa ya da gecersizse atlanir.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree

import httpx
import psycopg

TCMB_URL = "https://www.tcmb.gov.tr/kurlar/today.xml"
KINDS = {"ForexSelling": "forex_selling", "ForexBuying": "forex_buying"}


@dataclass(frozen=True)
class Rate:
    base: str
    rate: Decimal
    kind: str
    effective_date: date
    bulletin: str | None


class FxUnavailable(Exception):
    pass


def parse_tcmb(xml: bytes) -> list[Rate]:
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as error:
        raise FxUnavailable("tcmb_parse") from error
    raw_date = root.get("Tarih") or ""
    try:
        effective = datetime.strptime(raw_date, "%d.%m.%Y").date()
    except ValueError as error:
        raise FxUnavailable("tcmb_date") from error
    bulletin = (root.get("Bulten_No") or "")[:40] or None
    rates: list[Rate] = []
    for currency in root.iter("Currency"):
        code = (currency.get("CurrencyCode") or "").strip().upper()
        if len(code) != 3 or not code.isalpha() or code == "XDR":
            continue
        try:
            unit = Decimal((currency.findtext("Unit") or "1").strip())
        except InvalidOperation:
            continue
        if unit <= 0:
            continue
        for tag, kind in KINDS.items():
            text = (currency.findtext(tag) or "").strip()
            if not text:
                continue
            try:
                value = Decimal(text)
            except InvalidOperation:
                continue
            if value <= 0:
                continue
            rates.append(
                Rate(
                    code, (value / unit).quantize(Decimal("0.00000001")), kind, effective, bulletin
                )
            )
    if not rates:
        raise FxUnavailable("tcmb_empty")
    return rates


def fetch_tcmb(client: httpx.Client | None = None) -> list[Rate]:
    http = client or httpx.Client(timeout=20.0)
    try:
        response = http.get(TCMB_URL)
    except httpx.HTTPError as error:
        raise FxUnavailable("tcmb_network") from error
    finally:
        if client is None:
            http.close()
    if response.status_code != 200:
        raise FxUnavailable(f"tcmb_http_{response.status_code}")
    return parse_tcmb(response.content)


def store(conn: psycopg.Connection, rates: list[Rate]) -> int:
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
               VALUES ('tcmb', %s, 'TRY', %s, %s, %s, %s)
               ON CONFLICT (source, base, quote, rate_kind, effective_date) DO NOTHING""",
            [(r.base, r.rate, r.kind, r.effective_date, r.bulletin) for r in rates],
        )
        cur.execute(
            "SELECT count(*) FROM fx_rate WHERE source = 'tcmb' AND effective_date = %s",
            (rates[0].effective_date,),
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0
