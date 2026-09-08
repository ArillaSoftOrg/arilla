"""PostgreSQL baglantisi.

`DATABASE_URL` UYGULAMA rolunu gosterir (`arilla_app`). Bu rol superuser
degildir ve append-only tablolarda yalnizca SELECT + INSERT yapabilir. Toplama
isinin ihtiyaci tam olarak budur; yanlislikla yazilan bir `UPDATE price_point`
burada veritabani tarafindan reddedilir.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg

# Depo koku: services/ingest/db/connection.py -> ../../..
REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_dotenv() -> None:
    """Depo kokundeki .env dosyasini okur. Gercek degerler asla depoya girmez."""
    for name in (".env", ".env.local"):
        path = REPO_ROOT / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = value.strip().strip("\"'")


def database_url(variable: str = "DATABASE_URL") -> str:
    _load_dotenv()
    url = os.environ.get(variable)
    if not url:
        raise RuntimeError(f"{variable} tanimli degil. .env.example dosyasina bakin.")
    return url


@contextmanager
def connect(variable: str = "DATABASE_URL") -> Iterator[psycopg.Connection]:
    """Tek islemlik baglanti. Blok hatasiz biterse COMMIT, aksi halde ROLLBACK."""
    with psycopg.connect(database_url(variable)) as conn:
        yield conn
