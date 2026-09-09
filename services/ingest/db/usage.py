"""`api_usage` yazimi.

`CLAUDE.md` 9. kural: **her model cagrisi `api_usage` tablosuna yazilir.**
Olculemeyen maliyet kontrol edilemez; `docs/ops.md` gunluk maliyet raporunu
bu tablodan uretiyor.

`db/` altinda cunku yalnizca zenginlestirme degil, B4 (eslestirme) ve B5
(benzerlik) de model cagiracak. Uc yerde uc kopya olmasin.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import psycopg

INSERT_USAGE = """
INSERT INTO api_usage
    (session_id, user_id, operation, model_version, units, cost_micros, cache_hit)
VALUES
    (%(session_id)s, %(user_id)s, %(operation)s, %(model_version)s, %(units)s,
     %(cost_micros)s, %(cache_hit)s)
"""


def cost_micros_per_1k_tokens() -> int:
    """Bin token basina maliyet, TRY milyonda bir cinsinden.

    **Varsayilan 0.** Saglayici hesabi acilmadigi icin gercek fiyat henuz
    bilinmiyor (bkz. docs/decisions/0015, acik maddeler). `units` token
    sayisini tuttugu icin maliyet fiyat belli olunca geriye donuk
    hesaplanabilir; sifir bir fiyat "maliyet yok" demek degildir.
    """
    raw = os.environ.get("EMBEDDING_COST_MICROS_PER_1K_TOKENS", "0")
    try:
        return int(raw)
    except ValueError:
        return 0


@dataclass(frozen=True)
class ModelCall:
    """Gerceklesmis tek bir model cagrisi."""

    operation: str
    model_version: str
    #: Saglayicinin dondugu token sayisi.
    units: int
    session_id: str | None = None
    user_id: int | None = None
    cache_hit: bool = False


def record(conn: psycopg.Connection, call: ModelCall) -> None:
    cost = round(call.units * cost_micros_per_1k_tokens() / 1000)
    with conn.cursor() as cur:
        cur.execute(
            INSERT_USAGE,
            {
                "session_id": call.session_id,
                "user_id": call.user_id,
                "operation": call.operation,
                "model_version": call.model_version,
                "units": call.units,
                "cost_micros": cost,
                "cache_hit": call.cache_hit,
            },
        )
