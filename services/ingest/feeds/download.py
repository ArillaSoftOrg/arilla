"""Akisla indirme: dosya diske SIKISTIRILMIS haliyle yazilir, bellege alinmaz.

Korumalar (KVM 4):

- `FEED_MAX_BYTES` (varsayilan 4 GiB): diske yazilan bayt tavani; asilirsa
  indirme durur, dosya silinir.
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
import os
import shutil
import tempfile
import time
import zlib
from dataclasses import dataclass
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
        return self.code in {"http_5xx", "http_429", "network", "timeout"}


@dataclass(frozen=True)
class Downloaded:
    path: Path
    sha256: str
    bytes_on_disk: int
    bytes_decoded: int
    #: Ornek kipi: `stop_after_bytes` ile bilerek erken kesildi (dosya eksik).
    partial: bool = False


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
    max_bytes = max_bytes if max_bytes is not None else _int_env("FEED_MAX_BYTES", 4 * GiB)
    min_free = (
        min_free_bytes if min_free_bytes is not None else _int_env("FEED_MIN_FREE_BYTES", 15 * GiB)
    )
    directory = target.parent
    if _free_bytes(directory) < min_free:
        raise DownloadError("disk_low", "indirme oncesi bos alan yetersiz")

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
                out.flush()
                os.fsync(out.fileno())
        partial.replace(target)
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
    return Downloaded(target, digest.hexdigest(), written, decoded, partial_sample)
