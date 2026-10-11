"""`job_run` yazimi (migration 0041, karar 0052/0055).

Boru hatti islerinin (collect, resolve, enrich, similarity, link refresh)
baslangic/bitis/durum kaydi. Yonetim ekrani (`/yonetim/islemler`) "is calisti
mi, ne zaman, nasil bitti" sorusunu bu tablodan tahminsiz cevaplar.

Uc kural:

1. **Ayri, kisa baglanti.** Kayit isin kendi baglantisini/islemini KULLANMAZ:
   isin `rollback()`'i koşu kaydini silmesin, kaydin `commit()`'i isin yarim
   yazimini kalici yapmasin.
2. **Isi asla dusurmez.** Kayit yazilamazsa (veritabani yok, yetki, kisit)
   uyari loglanir ve is devam eder. Isletim sinyali isin kendisinden onemli
   degildir.
3. **Sirsiz ve sinirli.** `error_summary` adresleri (sorgu dizisi, parola
   dahil) kirpar, en fazla 500 karakter. `detail` yalnizca duz sayi/bool/kisa
   metin, en fazla 4 KB. Kisisel veri, ham hata yigini, adres YOK.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import psycopg

from db.connection import database_url

logger = logging.getLogger(__name__)

JOB_NAME = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
TRIGGERS = frozenset({"manual", "cron", "worker"})
FINAL_STATUSES = frozenset({"success", "partial", "failed"})

#: Zamanlayici (orn. GitHub Actions) `JOB_RUN_TRIGGER=cron` verir; yonetim
#: ekrani zamanlanmis kosuyu elle kosudan ayirir ve gecikme uyarisini bununla uretir.
TRIGGER_ENV = "JOB_RUN_TRIGGER"


def default_trigger() -> str:
    """Kosunun tetigi: `JOB_RUN_TRIGGER` gecerliyse o, yoksa ya da gecersizse `manual`."""
    value = os.environ.get(TRIGGER_ENV, "").strip().lower()
    return value if value in TRIGGERS else "manual"

MAX_ERROR_SUMMARY = 500
#: Kisit `pg_column_size(detail) <= 4096`; JSON metni bunun epey altinda tutulur.
MAX_DETAIL_JSON = 3000
MAX_DETAIL_KEYS = 40
MAX_DETAIL_STRING = 120

#: `scheme://...` adresleri: sorgu dizisi, kullanici:parola ve yol kirpilir,
#: yalnizca sema + host kalir.
_URL = re.compile(r"\b([a-z][a-z0-9+.-]{1,15})://([^\s/?#'\"<>]+)[^\s'\"<>]*", re.IGNORECASE)
_EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+")
_KEY_VALUE_SECRET = re.compile(
    r"\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[=:]\s*\S+",
    re.IGNORECASE,
)


def _host_only(match: re.Match[str]) -> str:
    scheme, authority = match.group(1), match.group(2)
    host = authority.rsplit("@", 1)[-1]
    return f"{scheme}://{host}/…"


def redact(text: str | None, limit: int = MAX_ERROR_SUMMARY) -> str | None:
    """Hata metnini kayda uygun hale getirir: adres/e-posta/sir kirpilir, kisaltilir."""
    if not text:
        return None
    cleaned = _URL.sub(_host_only, str(text))
    cleaned = _EMAIL.sub("<e-posta>", cleaned)
    cleaned = _KEY_VALUE_SECRET.sub(lambda m: f"{m.group(1)}=<gizli>", cleaned)
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        return None
    if len(cleaned) > limit:
        cleaned = cleaned[: limit - 1] + "…"
    return cleaned


def bounded_detail(detail: Mapping[str, Any] | None) -> dict[str, Any]:
    """Duz, kucuk `detail`: ic ice yapi ve uzun metin atilir; boyut sinirlanir."""
    out: dict[str, Any] = {}
    for key, value in (detail or {}).items():
        if len(out) >= MAX_DETAIL_KEYS:
            break
        name = str(key)[:40]
        if value is None or isinstance(value, bool | int):
            out[name] = value
        elif isinstance(value, float):
            # JSON NaN/Infinity jsonb'ye girmez.
            if math.isfinite(value):
                out[name] = value
        elif isinstance(value, str):
            safe = redact(value, MAX_DETAIL_STRING)
            if safe is not None:
                out[name] = safe
        # Liste, sozluk, nesne: bilerek yazilmaz (genel log tablosu degil).
    while out and len(json.dumps(out, ensure_ascii=False)) > MAX_DETAIL_JSON:
        out.pop(next(reversed(out)))
    return out


def _execute(sql: str, params: tuple[Any, ...]) -> Any:
    with psycopg.connect(database_url(), connect_timeout=5) as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone() if cur.description else None
        conn.commit()
        return row


def start(job: str, trigger: str = "manual") -> int | None:
    """Kosuyu `running` olarak acar; kimligini doner. Yazilamazsa None (is devam eder)."""
    if not JOB_NAME.match(job) or trigger not in TRIGGERS:
        logger.warning("job_run: gecersiz is adi/tetik %r/%r, kayit yok", job, trigger)
        return None
    try:
        row = _execute(
            "INSERT INTO job_run (job, trigger) VALUES (%s, %s) RETURNING id", (job, trigger)
        )
        return int(row[0]) if row else None
    except Exception as error:  # noqa: BLE001 — kayit isi asla dusurmez
        logger.warning("job_run baslatilamadi (%s): %s", job, redact(str(error), 200))
        return None


def finish(
    run_id: int | None,
    status: str,
    detail: Mapping[str, Any] | None = None,
    error_summary: str | None = None,
) -> None:
    """Kosuyu kapatir. Yalnizca hala `running` olan satir guncellenir; hata yutulur."""
    if run_id is None:
        return
    if status not in FINAL_STATUSES:
        status = "failed"
    try:
        _execute(
            """
            UPDATE job_run
               SET status = %s, finished_at = now(), detail = %s::jsonb, error_summary = %s
             WHERE id = %s AND status = 'running'
            """,
            (
                status,
                json.dumps(bounded_detail(detail), ensure_ascii=False),
                redact(error_summary),
                run_id,
            ),
        )
    except Exception as error:  # noqa: BLE001
        logger.warning("job_run kapatilamadi (%s): %s", run_id, redact(str(error), 200))


@dataclass
class JobRun:
    """`track` blogunun icinde isin doldurdugu sonuc."""

    job: str
    id: int | None
    #: Varsayilan `success`; is `partial`/`failed` diyebilir.
    status: str = "success"
    detail: dict[str, Any] = field(default_factory=dict)
    error_summary: str | None = None


@contextmanager
def track(job: str, trigger: str | None = None) -> Iterator[JobRun]:
    """Is kosusunu kaydeder.

        with job_run.track("resolve") as run:
            counts = resolve_offers(...)
            run.detail.update(considered=counts.considered)
            if counts.errors:
                run.status = "partial"

    Blok istisnayla (KeyboardInterrupt dahil) biterse `failed` + kirpilmis
    hata ozeti yazilir ve istisna aynen yeniden firlatilir.
    """
    run = JobRun(job=job, id=start(job, trigger or default_trigger()))
    try:
        yield run
    except BaseException as error:
        summary = run.error_summary or f"{type(error).__name__}: {error}"
        finish(run.id, "failed", run.detail, summary)
        raise
    finish(run.id, run.status, run.detail, run.error_summary)
