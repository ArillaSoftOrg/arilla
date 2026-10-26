"""Akisla indirme: dosya diske SIKISTIRILMIS haliyle yazilir, bellege alinmaz.

Korumalar (KVM 4):

- Bayt tavani DINAMIK: bos alan - `FEED_MIN_FREE_BYTES`. `FEED_MAX_BYTES`
  verilirse ek ust sinirdir. Asilirsa indirme durur, dosya silinir; kismi
  dosya hicbir zaman islenmez (surum olusmaz, offer pasiflesmez).
- `FEED_MIN_FREE_BYTES` (varsayilan 15 GiB): basta ve her 64 MiB'da bos alan
  denetlenir; altina inilirse indirme durur (PostgreSQL/WAL ve yedek diski
  korunur).
- Hazirlik dizini `FEED_STAGING_DIR`; yalnizca bu isin dosyalari, eskileri
  `cleanup_staging` ile silinir.

sha256 COZULMUS icerik uzerinden hesaplanir: sunucu ayni icerigi farkli gzip
baslik zamaniyla gonderse de ozet degismez (tekrar indirme `duplicate` olur).
Indirme adresi kimlik bilgisi tasiyabilir: loglanmaz, hata metnine girmez.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from db.connection import env

GiB = 1 << 30
CHECK_EVERY = 64 << 20


class DownloadError(Exception):
    """Indirme basarisiz; `code` ingest/feed hata koduna yazilir."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail[:200]

    @property
    def retryable(self) -> bool:
        # `truncated`/`corrupt`: kesik akis gecici olabilir (kaynak ya da ara katman dosyayi
        # yarim verdi); yeniden indirmek anlamli. Disk/boyut hatalari kalicidir.
        return self.code in {"http_5xx", "http_429", "network", "timeout", "truncated", "corrupt"}


@dataclass(frozen=True)
class Downloaded:
    path: Path
    sha256: str
    bytes_on_disk: int
    bytes_decoded: int
    #: Ornek kipi: `stop_after_bytes` ile bilerek erken kesildi (dosya eksik).
    partial: bool = False
    #: Izin listeli HTTP tanilama (adres, sorgu, kimlik bilgisi YOK); bkz. `http_diagnostics`.
    diagnostics: dict[str, object] = field(default_factory=dict)


#: Yanit basliklarindan yalnizca bunlar saklanir. Adres, sorgu, `Set-Cookie`, `Authorization`,
#: `Location` gibi kimlik/sir tasiyabilecek hicbir sey kaydedilmez.
DIAGNOSTIC_HEADERS = (
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "content-type",
    "etag",
    "last-modified",
    "date",
    "accept-ranges",
    "age",
    "cf-cache-status",
    "x-cache",
)
_SAFE_VALUE = re.compile(r"[^\w\s.,;:=/+()*\"'-]")
DIAGNOSTICS_SUFFIX = ".http.json"


def _safe_value(value: str) -> str | None:
    """Adres/sir gibi gorunen degeri dusurur; geri kalani kirpar ve temizler."""
    if "://" in value or "token" in value.lower() or "key=" in value.lower():
        return None
    return _SAFE_VALUE.sub("", value)[:120]


def http_diagnostics(response: httpx.Response) -> dict[str, object]:
    """Teshis icin yanit ozeti: durum, izin listeli basliklar, yonlendirme sayisi, host.

    Yalnizca HOST yazilir (yol ve sorgu degil): indirme adresi kimlik bilgisi tasiyabilir.
    """
    out: dict[str, object] = {
        "status": response.status_code,
        "http_version": response.http_version,
        "redirects": len(response.history),
    }
    host = response.url.host
    if host:
        out["host"] = host[:120]
    headers: dict[str, str] = {}
    for name in DIAGNOSTIC_HEADERS:
        value = response.headers.get(name)
        safe = _safe_value(value) if value else None
        if safe:
            headers[name] = safe
    out["headers"] = headers
    return out


def diagnostics_path(target: Path) -> Path:
    return target.with_name(target.name + DIAGNOSTICS_SUFFIX)


def read_diagnostics(target: Path) -> dict[str, object]:
    """Indirmeyle birlikte yazilan tanilama dosyasi; yoksa/bozuksa bos."""
    try:
        data = json.loads(diagnostics_path(target).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _int_env(name: str, default: int) -> int:
    value = env(name)
    return int(value) if value and value.isdigit() else default


def staging_dir() -> Path:
    path = Path(env("FEED_STAGING_DIR") or Path(tempfile.gettempdir()) / "arilla-feeds")
    path.mkdir(parents=True, exist_ok=True)
    return path


def cleanup_staging(directory: Path, *, older_than_seconds: int = 2 * 86_400) -> int:
    """Eski hazirlik dosyalarini siler (kesintide kalanlar)."""
    removed = 0
    cutoff = time.time() - older_than_seconds
    for item in directory.glob("feed-*"):
        try:
            if item.stat().st_mtime < cutoff:
                item.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def _free_bytes(directory: Path) -> int:
    return shutil.disk_usage(directory).free


def download(
    url: str,
    target: Path,
    *,
    client: httpx.Client | None = None,
    max_bytes: int | None = None,
    min_free_bytes: int | None = None,
    stop_after_bytes: int | None = None,
) -> Downloaded:
    """Akisla indirir. `stop_after_bytes`: yalnizca ornek kipi; dosya bilerek eksik kalir."""
    min_free = (
        min_free_bytes if min_free_bytes is not None else _int_env("FEED_MIN_FREE_BYTES", 15 * GiB)
    )
    directory = target.parent
    free_at_start = _free_bytes(directory)
    if free_at_start < min_free:
        raise DownloadError("disk_low", "indirme oncesi bos alan yetersiz")
    # Tavan sabit degil: diskte `min_free` korunarak kullanilabilen alan kadar
    # (4 GiB'i asan beslemeler de eksiksiz iner). FEED_MAX_BYTES verilirse ust sinirdir.
    budget = free_at_start - min_free
    configured = max_bytes if max_bytes is not None else _int_env("FEED_MAX_BYTES", 0)
    max_bytes = min(configured, budget) if configured > 0 else budget

    http = client or httpx.Client(timeout=httpx.Timeout(60.0, read=300.0), follow_redirects=True)
    digest = hashlib.sha256()
    written = 0
    decoded = 0
    next_check = CHECK_EVERY
    partial_sample = False
    partial = target.with_suffix(target.suffix + ".part")
    try:
        with http.stream("GET", url, headers={"Accept-Encoding": "gzip"}) as response:
            if response.status_code == 429:
                raise DownloadError("http_429")
            if response.status_code >= 500:
                raise DownloadError("http_5xx", str(response.status_code))
            if response.status_code != 200:
                raise DownloadError("http_status", str(response.status_code))
            diagnostics = http_diagnostics(response)
            declared = response.headers.get("content-length", "")
            gzipped = response.headers.get("content-encoding", "").lower() == "gzip"
            inflater = zlib.decompressobj(16 + zlib.MAX_WBITS) if gzipped else None
            with partial.open("wb") as out:
                for chunk in response.iter_raw(1 << 20):
                    written += len(chunk)
                    if written > max_bytes:
                        raise DownloadError("too_large", f"> {max_bytes} bayt")
                    out.write(chunk)
                    plain = inflater.decompress(chunk) if inflater else chunk
                    decoded += len(plain)
                    digest.update(plain)
                    if stop_after_bytes is not None and written >= stop_after_bytes:
                        partial_sample = True
                        break
                    if written >= next_check:
                        next_check += CHECK_EVERY
                        if _free_bytes(directory) < min_free:
                            raise DownloadError("disk_low", "indirme sirasinda bos alan azaldi")
                if inflater and not partial_sample:
                    tail = inflater.flush()
                    decoded += len(tail)
                    digest.update(tail)
                    if not inflater.eof:
                        raise DownloadError("truncated", "gzip akisi tamamlanmadi")
                if declared.isdigit() and not partial_sample and written != int(declared):
                    # Sunucu "N bayt" dedi, N'den azini/cogunu verdi: dosya eksik/bozuk.
                    raise DownloadError("truncated", f"content-length {declared} != {written}")
                out.flush()
                os.fsync(out.fileno())
        diagnostics.update(
            bytes_on_disk=written,
            bytes_decoded=decoded,
            gzip_complete=bool(inflater.eof) if inflater is not None else None,
            sample=partial_sample,
        )
        partial.replace(target)
        # Tanilama indirmenin yanina yazilir (ingest_run.checkpoint'e senkronizasyon tasir).
        diagnostics_path(target).write_text(json.dumps(diagnostics), encoding="utf-8")
    except DownloadError:
        partial.unlink(missing_ok=True)
        raise
    except httpx.TimeoutException:
        partial.unlink(missing_ok=True)
        raise DownloadError("timeout") from None
    except httpx.TransportError as error:
        partial.unlink(missing_ok=True)
        raise DownloadError("network", type(error).__name__) from None
    except zlib.error:
        partial.unlink(missing_ok=True)
        raise DownloadError("corrupt", "gzip cozulemedi") from None
    finally:
        if client is None:
            http.close()
    return Downloaded(target, digest.hexdigest(), written, decoded, partial_sample, diagnostics)
