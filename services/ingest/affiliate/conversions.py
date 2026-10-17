"""Ag eylemlerini `conversion` tablosuna yazar (karar 0128).

Idempotent: `(merchant_id, external_order_id)` benzersiz; ayni eylem ikinci kez
gelirse yalnizca durum/tutar degistiyse guncellenir (`reconciled_at`). Kisisel
veri yok: ag yalnizca kendi eylem kimligini, tutari ve bizim `click_id`'mizi
(subid) dondurur.

- Program -> merchant: `feed_source (network, program_external_id)`. Programa
  bagli tek merchant yoksa eylem atlanir (yanlis merchant'a yazilmaz).
- Tutar kurus tamsayi (TRY). TRY disi tutar, eylem tarihinden en fazla
  `FX_MAX_AGE_DAYS` once yayinlanmis TCMB doviz alis kuruyla cevrilir; kur yoksa
  eylem atlanir (tahmin yok).
- `click_id` yalnizca gecerli UUID ise VE ayni merchant'in teklifine ait bir
  `click` satiri varsa baglanir; aksi halde bos kalir (sahte attribution yok).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

import psycopg

from affiliate.admitad_actions import Action

NETWORK = "admitad"
FX_MAX_AGE_DAYS = 7
EXTERNAL_PREFIX = "admitad:"

STATUS_MAP = {
    "pending": "pending",
    "approved": "confirmed",
    "approved_but_stalled": "confirmed",
    "declined": "cancelled",
}

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

PROGRAM_MERCHANTS = """
SELECT program_external_id, min(merchant_id), count(DISTINCT merchant_id)
  FROM feed_source
 WHERE network = %(network)s AND merchant_id IS NOT NULL AND program_external_id IS NOT NULL
 GROUP BY program_external_id
"""

FX_RATE = """
SELECT rate FROM fx_rate
 WHERE source = 'tcmb' AND base = %(base)s AND quote = 'TRY' AND rate_kind = 'forex_buying'
   AND effective_date <= %(on)s AND effective_date >= %(oldest)s
 ORDER BY effective_date DESC
 LIMIT 1
"""

CLICK = """
SELECT c.creator_id FROM click c JOIN offer o ON o.id = c.offer_id
 WHERE c.id = %(click_id)s AND o.merchant_id = %(merchant_id)s
"""

UPSERT = """
INSERT INTO conversion (click_id, merchant_id, creator_id, external_order_id,
                        order_value, commission, status, occurred_at, reconciled_at)
VALUES (%(click_id)s, %(merchant_id)s, %(creator_id)s, %(external_order_id)s,
        %(order_value)s, %(commission)s, %(status)s, %(occurred_at)s, now())
ON CONFLICT (merchant_id, external_order_id) DO UPDATE
   SET status = EXCLUDED.status,
       order_value = EXCLUDED.order_value,
       commission = EXCLUDED.commission,
       click_id = coalesce(conversion.click_id, EXCLUDED.click_id),
       creator_id = coalesce(conversion.creator_id, EXCLUDED.creator_id),
       reconciled_at = now()
 WHERE (conversion.status, conversion.order_value, conversion.commission)
       IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.order_value, EXCLUDED.commission)
RETURNING (xmax = 0) AS inserted
"""


@dataclass
class ConversionCounts:
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    click_linked: int = 0
    skipped: Counter[str] = field(default_factory=Counter)

    def detail(self) -> dict[str, int]:
        out = {
            "fetched": self.fetched,
            "inserted": self.inserted,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "click_linked": self.click_linked,
        }
        out.update({f"skipped_{reason}": n for reason, n in sorted(self.skipped.items())})
        return out


def to_kurus(amount: Decimal, rate: Decimal = Decimal(1)) -> int:
    return int((amount * rate * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def conversion_status(action: Action) -> str | None:
    status = STATUS_MAP.get(action.status)
    if status == "confirmed" and action.paid:
        return "paid"
    return status


def _program_merchants(conn: psycopg.Connection) -> dict[str, int | None]:
    out: dict[str, int | None] = {}
    with conn.cursor() as cur:
        cur.execute(PROGRAM_MERCHANTS, {"network": NETWORK})
        for program_id, merchant_id, distinct in cur.fetchall():
            # Ayni programa birden fazla merchant: hangisi oldugu bilinemez.
            out[str(program_id)] = int(merchant_id) if distinct == 1 else None
    return out


def _rate(conn: psycopg.Connection, action: Action, cache: dict) -> Decimal | None:
    if action.currency == "TRY":
        return Decimal(1)
    on = action.occurred_at.date()
    key = (action.currency, on)
    if key not in cache:
        with conn.cursor() as cur:
            cur.execute(
                FX_RATE,
                {
                    "base": action.currency,
                    "on": on,
                    "oldest": on - timedelta(days=FX_MAX_AGE_DAYS),
                },
            )
            row = cur.fetchone()
        cache[key] = Decimal(row[0]) if row else None
    return cache[key]


def _click(
    conn: psycopg.Connection, subid: str | None, merchant_id: int
) -> tuple[str | None, int | None]:
    if not subid or not _UUID.match(subid.lower()):
        return None, None
    with conn.cursor() as cur:
        cur.execute(CLICK, {"click_id": subid.lower(), "merchant_id": merchant_id})
        row = cur.fetchone()
    if row is None:
        return None, None
    return subid.lower(), (int(row[0]) if row[0] is not None else None)


def store_actions(conn: psycopg.Connection, actions: Iterable[Action | None]) -> ConversionCounts:
    counts = ConversionCounts()
    merchants = _program_merchants(conn)
    rates: dict = {}
    for action in actions:
        counts.fetched += 1
        if action is None:
            counts.skipped["unparsed"] += 1
            continue
        if action.program_id not in merchants:
            counts.skipped["unknown_program"] += 1
            continue
        merchant_id = merchants[action.program_id]
        if merchant_id is None:
            counts.skipped["ambiguous_program"] += 1
            continue
        status = conversion_status(action)
        if status is None:
            counts.skipped["unknown_status"] += 1
            continue
        rate = _rate(conn, action, rates)
        if rate is None:
            counts.skipped["fx_missing"] += 1
            continue
        click_id, creator_id = _click(conn, action.subid, merchant_id)
        with conn.cursor() as cur:
            cur.execute(
                UPSERT,
                {
                    "click_id": click_id,
                    "merchant_id": merchant_id,
                    "creator_id": creator_id,
                    "external_order_id": EXTERNAL_PREFIX + action.action_id,
                    "order_value": to_kurus(action.order_value, rate),
                    "commission": (
                        None if action.commission is None else to_kurus(action.commission, rate)
                    ),
                    "status": status,
                    "occurred_at": action.occurred_at,
                },
            )
            row = cur.fetchone()
        if row is None:
            counts.unchanged += 1
        elif row[0]:
            counts.inserted += 1
            if click_id:
                counts.click_linked += 1
        else:
            counts.updated += 1
    return counts
