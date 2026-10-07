"""Link worker'inin Redis adresi: uretim benzeri ortamda TLS zorunlu.

"Yerel gelistirme" = `DATABASE_URL` yerel bir hostu gosteriyor (ayni olcut:
`collect/bootstrap.py` `is_local_database`). Yalnizca o durumda:

- `REDIS_URL` yoksa `redis://localhost:6379` kullanilir;
- yerel bir hosta duz `redis://` kabul edilir.

Aksi halde `REDIS_URL` zorunludur ve `rediss://` olmalidir. Sessizce
localhost'a dusmek uretimde kuyrugu hic tuketmeyen bir worker demektir.
Hata metinleri sabittir: adres, kullanici ya da parola asla yazilmaz.
"""

from __future__ import annotations

from urllib.parse import urlparse

LOCAL_REDIS_URL = "redis://localhost:6379"
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class WorkerConfigError(RuntimeError):
    """Worker baslatilmaz; mesaj sabittir ve sir icermez."""


def _host(url: str) -> str | None:
    try:
        return urlparse(url).hostname
    except ValueError:
        return None


def _is_local(url: str | None) -> bool:
    return bool(url) and _host(url or "") in _LOCAL_HOSTS


def worker_redis_url(redis_url: str | None, database_url: str | None) -> str:
    """Kullanilacak Redis adresi; uygun degilse `WorkerConfigError`."""
    local_development = _is_local(database_url)
    url = (redis_url or "").strip()
    if not url:
        if local_development:
            return LOCAL_REDIS_URL
        raise WorkerConfigError("REDIS_URL tanimli degil; worker baslatilmadi.")

    try:
        scheme = urlparse(url).scheme
    except ValueError:
        scheme = ""
    if scheme == "rediss" and _host(url):
        return url
    if scheme == "redis" and local_development and _is_local(url):
        return url
    if scheme not in ("redis", "rediss"):
        raise WorkerConfigError("REDIS_URL redis:// ya da rediss:// ile baslamali.")
    raise WorkerConfigError(
        "REDIS_URL TLS degil: yerel gelistirme disinda rediss:// gerekli; worker baslatilmadi."
    )
