"""Admitad yayinci istatistigi: eylemler (siparis/donusum), karar 0128.

`GET /statistics/actions/` (kapsam `statistics`). Belgelenen alanlar kullanilir;
uretim hesabinda gercek yanitla HENUZ DOGRULANMADI (feeds/admitad.py'deki
kesif uclari dogrulandi, bu uc degil). Bu yuzden ayristirma savunmaci: beklenen
alan yoksa ya da bicimi bozuksa eylem atlanir, uydurulmaz.

- Sayfalama: `{"_meta": {"count", "limit", "offset"}, "results": [...]}`.
- Eylem: `action_id`, `advcampaign_id`, `status` (`pending`, `approved`,
  `approved_but_stalled`, `declined`), `cart` (siparis tutari), `payment`
  (komisyon), `currency`, `action_date` ("YYYY-MM-DD HH:MM:SS"), `subid`
  (deeplink'e koydugumuz `click_id`), `paid` (0/1).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from feeds.admitad import AdmitadNetwork

SCOPE = "statistics"
PAGE = 500
MAX_PAGES = 40


@dataclass(frozen=True)
class Action:
    action_id: str
    program_id: str
    status: str
    order_value: Decimal
    commission: Decimal | None
    currency: str
    occurred_at: datetime
    subid: str | None
    paid: bool


def _decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() and parsed >= 0 else None


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace(" ", "T"))
    except ValueError:
        return None
    # Saat dilimi belirtilmemisse UTC sayilir (dogrulanmadi; karar 0128).
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def parse_action(raw: Any) -> Action | None:
    """Tek eylem; zorunlu alan eksik ya da bozuksa `None` (sessizce uydurulmaz)."""
    if not isinstance(raw, dict):
        return None
    action_id = str(raw.get("action_id") or "").strip()
    program_id = str(raw.get("advcampaign_id") or "").strip()
    status = str(raw.get("status") or "").strip().lower()
    currency = str(raw.get("currency") or "").strip().upper()
    order_value = _decimal(raw.get("cart"))
    occurred_at = _time(raw.get("action_date"))
    if not action_id or not program_id or not status or len(currency) != 3:
        return None
    if order_value is None or occurred_at is None:
        return None
    subid = raw.get("subid")
    return Action(
        action_id=action_id[:80],
        program_id=program_id[:100],
        status=status,
        order_value=order_value,
        commission=_decimal(raw.get("payment")),
        currency=currency,
        occurred_at=occurred_at,
        subid=str(subid).strip()[:64] if subid else None,
        paid=str(raw.get("paid") or "0") in ("1", "true", "True"),
    )


class AdmitadActions:
    """Eylem listesi; kimlik dogrulama ve yeniden deneme `AdmitadNetwork`'ten."""

    def __init__(self, network: AdmitadNetwork | None = None) -> None:
        self._network = network or AdmitadNetwork(scope=SCOPE)

    def actions(self, start: date, end: date) -> Iterator[tuple[Action | None, Any]]:
        """`(eylem ya da None, ham)` ciftleri; `None` ayristirilamayan kayittir."""
        offset = 0
        for _ in range(MAX_PAGES):
            body = self._network.get_json(
                "/statistics/actions/",
                {
                    "date_start": start.strftime("%d.%m.%Y"),
                    "date_end": end.strftime("%d.%m.%Y"),
                    "limit": PAGE,
                    "offset": offset,
                },
            )
            results = body.get("results", []) if isinstance(body, dict) else []
            for raw in results:
                yield parse_action(raw), raw
            count = int(((body or {}).get("_meta") or {}).get("count") or 0)
            offset += PAGE
            if not results or offset >= count:
                return
