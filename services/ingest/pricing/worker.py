"""Fiyat dogrulama kuyrugu (karar 0113).

- `enqueue_stale`: etkin teklifler icin son dogrulamasi eski (ya da hic olmayan)
  olanlara istek ekler. Offer basina tek acik istek (kismi UNIQUE).
- `process`: istekleri `FOR UPDATE SKIP LOCKED` ile alir (eszamanli iscilerde
  ayni istek iki kez islenmez), uygun saglayiciyi secer, sonucu
  `price_verification`'a EKLER. Offer fiyati DEGISMEZ.
- Saglayici yoksa istek `unsupported` (sahte sonuc yok). Gecici hata ->
  geri cekilmeyle yeniden; 3 denemeden sonra `failed`.
- Bir host erisimi reddederse (401/403/429, robots) o kosuda o host icin
  baska istek gonderilmez; istekler bekletilir.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import psycopg

from pricing.providers import OfferContext, PriceVerificationProvider, ProviderStop

MAX_ATTEMPTS = 3

ENQUEUE = """
INSERT INTO price_verification_request (offer_id, reason, priority)
SELECT o.id, 'stale', 0
  FROM offer o JOIN merchant m ON m.id = o.merchant_id
 WHERE o.is_active
   AND (%(merchant)s::text IS NULL OR m.slug = %(merchant)s)
   AND NOT EXISTS (
       SELECT 1 FROM price_verification v
        WHERE v.offer_id = o.id AND v.verified_at > now() - %(older)s::interval)
 ORDER BY o.last_seen_at DESC
 LIMIT %(limit)s
ON CONFLICT (offer_id) WHERE status IN ('pending', 'running') DO NOTHING
"""

CLAIM = """
UPDATE price_verification_request r
   SET status = 'running', attempts = r.attempts + 1, updated_at = now()
 WHERE r.id IN (
       SELECT id FROM price_verification_request
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY priority DESC, next_attempt_at
        LIMIT %(limit)s
        FOR UPDATE SKIP LOCKED)
RETURNING r.id, r.offer_id, r.attempts
"""

CONTEXT = """
SELECT o.id, m.id, m.slug, m.source_type, o.url, o.currency, o.current_price, o.list_price,
       coalesce((m.feed_config->>'currency_verified')::boolean, false), o.seller_id,
       coalesce(array_agg(v.external_id) FILTER (WHERE v.id IS NOT NULL), '{}')
  FROM offer o JOIN merchant m ON m.id = o.merchant_id
  LEFT JOIN offer_variant v ON v.offer_id = o.id
 WHERE o.id = %s
 GROUP BY o.id, m.id
"""

INSERT_RESULT = """
INSERT INTO price_verification (
    offer_id, seller_id, provider, source_kind, source_reliability, result, currency,
    observed_price_minor, list_price_minor, feed_price_minor, in_stock, shipping_minor,
    tax_included, discount_conditions, coupon_conditions, error_code
) VALUES (
    %(offer_id)s, %(seller_id)s, %(provider)s, %(source_kind)s, %(reliability)s, %(result)s,
    %(currency)s, %(observed)s, %(list)s, %(feed)s, %(in_stock)s, %(shipping)s, %(tax)s,
    %(discount)s::jsonb, %(coupon)s::jsonb, %(error_code)s
) RETURNING id
"""


@dataclass
class VerifyReport:
    claimed: int = 0
    verified: int = 0
    match: int = 0
    mismatch: int = 0
    unavailable: int = 0
    errors: int = 0
    unsupported: int = 0
    deferred: int = 0


def enqueue_stale(
    conn: psycopg.Connection, *, merchant: str | None, limit: int, older_than: timedelta
) -> int:
    with conn.cursor() as cur:
        cur.execute(ENQUEUE, {"merchant": merchant, "limit": limit, "older": older_than})
        return cur.rowcount


def _context(conn: psycopg.Connection, offer_id: int) -> OfferContext | None:
    row = conn.execute(CONTEXT, (offer_id,)).fetchone()
    if row is None:
        return None
    return OfferContext(
        offer_id=int(row[0]),
        merchant_id=int(row[1]),
        merchant_slug=str(row[2]),
        source_type=str(row[3]),
        url=str(row[4]),
        currency=str(row[5]),
        feed_price_minor=row[6],
        feed_list_price_minor=row[7],
        currency_verified=bool(row[8]),
        seller_id=row[9],
        variant_external_ids=tuple(str(v) for v in row[10]),
    )


def _json(value: dict[str, Any] | None) -> str | None:
    return None if value is None else json.dumps(value, ensure_ascii=False)


def _set(conn: psycopg.Connection, request_id: int, status: str, **extra: Any) -> None:
    conn.execute(
        """UPDATE price_verification_request
              SET status = %s, last_error = %s, verification_id = %s,
                  next_attempt_at = now() + %s::interval, updated_at = now()
            WHERE id = %s""",
        (
            status,
            extra.get("error"),
            extra.get("verification_id"),
            extra.get("delay", timedelta(0)),
            request_id,
        ),
    )


def process(
    conn: psycopg.Connection, providers: list[PriceVerificationProvider], *, limit: int
) -> VerifyReport:
    report = VerifyReport()
    with conn.cursor() as cur:
        cur.execute(CLAIM, {"limit": limit})
        claimed = cur.fetchall()
    conn.commit()
    report.claimed = len(claimed)
    for request_id, offer_id, attempts in claimed:
        offer = _context(conn, int(offer_id))
        provider = next((p for p in providers if offer and p.supports(offer)), None)
        if offer is None or provider is None:
            _set(conn, request_id, "unsupported", error="no_provider")
            conn.commit()
            report.unsupported += 1
            continue
        try:
            outcome = provider.verify(offer)
        except ProviderStop as stop:
            # Host erisimi reddetti: istek bekletilir, sonuc yazilmaz.
            _set(conn, request_id, "pending", error=stop.code, delay=timedelta(hours=6))
            conn.commit()
            report.deferred += 1
            continue
        if outcome.result == "error" and attempts < MAX_ATTEMPTS:
            _set(
                conn,
                request_id,
                "pending",
                error=outcome.error_code or "error",
                delay=timedelta(minutes=15 * attempts),
            )
            conn.commit()
            report.errors += 1
            continue
        row = conn.execute(
            INSERT_RESULT,
            {
                "offer_id": offer.offer_id,
                "seller_id": offer.seller_id,
                "provider": provider.name,
                "source_kind": provider.source_kind,
                "reliability": provider.reliability,
                "result": outcome.result,
                "currency": outcome.currency,
                "observed": outcome.observed_price_minor,
                "list": outcome.list_price_minor,
                "feed": offer.feed_price_minor,
                "in_stock": outcome.in_stock,
                "shipping": outcome.shipping_minor,
                "tax": outcome.tax_included,
                "discount": _json(outcome.discount_conditions),
                "coupon": _json(outcome.coupon_conditions),
                "error_code": outcome.error_code,
            },
        ).fetchone()
        status = "failed" if outcome.result == "error" else "done"
        _set(
            conn,
            request_id,
            status,
            error=outcome.error_code,
            verification_id=row[0] if row else None,
        )
        conn.commit()
        report.verified += 1
        counter = "errors" if outcome.result == "error" else outcome.result
        setattr(report, counter, getattr(report, counter) + 1)
    return report
