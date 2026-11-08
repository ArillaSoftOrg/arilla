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


#: Is sonucu sozlesmesi (karar 0174): `detail.outcome` -> (`job_run.status`, surec cikis kodu).
#: `status` enum'u DEGISMEZ; sonuc onun ustunde, "teknik olarak bitti" ile "ne uretti"yi
#: ayirir. 75 = EX_TEMPFAIL (sysexits.h): bu kosu bir sey yapmadi, sonraki kosu yapacak.
EXIT_TEMPFAIL = 75
OUTCOMES: Mapping[str, tuple[str, int]] = {
    # Is tanimli akisini sonuna kadar kosturdu. Yeni kayit uretildigini GARANTI ETMEZ
    # (or. tum adaylar insan kuyruguna dustu, kenarlar taban altinda kaldi); similarity'de
    # tek turde embedding bulunmasi diger turun eksiksiz oldugu anlamina gelmez. Uretilen
    # miktar ve tur bazli eksiklik isin kendi `detail` sayaclarindan okunur.
    "completed": ("success", 0),
    # Islenecek uygun girdi yoktu; ariza degildir.
    "no_input": ("success", 0),
    # Baska bir kosu ayni kilidi tutuyordu; bu kosu hicbir seye dokunmadi.
    "skipped_locked": ("partial", EXIT_TEMPFAIL),
    # Kosu bitti ama oge bazli hatalar var.
    "partial": ("partial", 1),
    # Teknik hata.
    "failed": ("failed", 1),
    # Uygun girdi var ama onceki asamanin ciktisi (or. embedding) eksik; cikis 0 yalnizca
    # zincirin son adiminda guvenlidir (karar 0174, systemd analizi).
    "blocked_upstream": ("partial", 0),
}
#: `status`'tan sonuc: sozlesmeye katilan is sonucu acikca vermediyse.
_STATUS_OUTCOME = {"success": "completed", "partial": "partial", "failed": "failed"}
REASON = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
INVALID_OUTCOME_REASON = "invalid_outcome"
EXCEPTION_REASON = "exception"


@dataclass(frozen=True)
class Outcome:
    """Dogrulanmis is sonucu: ad, gerekce, `job_run.status` ve cikis kodu."""

    name: str
    reason: str | None
    status: str
    exit_code: int


def outcome(name: str, reason: str | None = None) -> Outcome:
    """Sonucu dogrular. Gecersiz ad ARIZA sayilir (fail-closed): `failed`/1, alarm susmasin.

    Gecersiz gerekce (bicim disi metin) yazilmaz; sonuc gecerliyse korunur.
    """
    if name not in OUTCOMES:
        logger.warning("job_run: gecersiz sonuc %r, 'failed' yazilir", str(name)[:40])
        status, code = OUTCOMES["failed"]
        return Outcome("failed", INVALID_OUTCOME_REASON, status, code)
    if reason is not None and not (isinstance(reason, str) and REASON.match(reason)):
        logger.warning("job_run: gecersiz sonuc gerekcesi %r, yazilmaz", str(reason)[:40])
        reason = None
    status, code = OUTCOMES[name]
    return Outcome(name, reason, status, code)


def exit_code(name: str) -> int:
    """Sonucun surec cikis kodu; gecersiz ad 1 (fail-closed)."""
    return outcome(name).exit_code


def with_outcome(detail: Mapping[str, Any] | None, result: Outcome) -> dict[str, Any]:
    """`outcome`/`reason` BASA konur: `bounded_detail` sinira gelince sondan atar, sonuc kalir.

    Isin kendi alanlari silinmez; yalnizca ayni adli `outcome`/`reason` ezilir.
    """
    head: dict[str, Any] = {"outcome": result.name}
    if result.reason is not None:
        head["reason"] = result.reason
    rest = {k: v for k, v in (detail or {}).items() if k not in ("outcome", "reason")}
    return {**head, **rest}


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
    #: Karar 0174: `track(..., outcomes=True)` ile acilan kosu `detail.outcome` yazar.
    outcomes: bool = False
    result: Outcome | None = None

    def set_outcome(self, name: str, reason: str | None = None) -> int:
        """Sonucu kaydeder, `status`'u sozlesmeden alir; surec cikis kodunu doner."""
        self.result = outcome(name, reason)
        self.status = self.result.status
        return self.result.exit_code

    def final_outcome(self) -> Outcome:
        """Blok normal bittiginde yazilacak sonuc: acik sonuc, yoksa `status`'tan."""
        if self.result is not None:
            return self.result
        return outcome(_STATUS_OUTCOME.get(self.status, "failed"))


@contextmanager
def track(job: str, trigger: str | None = None, *, outcomes: bool = False) -> Iterator[JobRun]:
    """Is kosusunu kaydeder.

        with job_run.track("resolve", outcomes=True) as run:
            counts = resolve_offers(...)
            run.detail.update(considered=counts.considered)
            code = run.set_outcome("no_input", "no_eligible_offers")

    Blok istisnayla (KeyboardInterrupt dahil) biterse `failed` + kirpilmis
    hata ozeti yazilir ve istisna aynen yeniden firlatilir. `outcomes=True` ise
    `detail.outcome` da yazilir: istisnada daima `failed`/`exception` (onceden
    secilmis sonucu ezer); `outcomes=False` (varsayilan) eski kayit bicimini aynen korur.
    """
    run = JobRun(job=job, id=start(job, trigger or default_trigger()), outcomes=outcomes)
    try:
        yield run
    except BaseException as error:
        summary = run.error_summary or f"{type(error).__name__}: {error}"
        detail: Mapping[str, Any] = run.detail
        if run.outcomes:
            detail = with_outcome(run.detail, outcome("failed", EXCEPTION_REASON))
        finish(run.id, "failed", detail, summary)
        raise
    if run.outcomes:
        result = run.final_outcome()
        finish(run.id, result.status, with_outcome(run.detail, result), run.error_summary)
    else:
        finish(run.id, run.status, run.detail, run.error_summary)
