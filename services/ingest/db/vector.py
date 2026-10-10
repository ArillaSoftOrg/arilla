"""pgvector HNSW arama ayarlari.

`embedding_ann_idx` tek bir kismi HNSW indeksi (`WHERE target_type = 'offer'`)
ve hem `image` hem `text` vektorlerini tasiyor. `kind` / `model_version`
suzgecleri indeks taramasindan SONRA uygulanir; varsayilan `ef_search = 40`
ile `LIMIT n` istenen sayidan az satir dondurebilir. pgvector >= 0.8
`hnsw.iterative_scan` bu durumda taramayi suzgec sonrasi yeterli satir
bulunana kadar surdurur.

Ayarlar ISLEM-YEREL (`set_config(..., true)`): havuzlanmis baglantiya sizmaz.
Eski surumde tanimsiz parametre yalnizca bir yer tutucudur; hata kaldirilirsa
(`savepoint` icinde) sessizce vazgecilir. Bu yardimci SONUCLARI DEGISTIRMEZ,
yalnizca eksik donen sonuclari tamamlar.
"""

from __future__ import annotations

import logging

import psycopg

logger = logging.getLogger(__name__)

#: Suzgec sonrasi yeterli aday icin taranan komsu sayisi (varsayilan 40).
DEFAULT_EF_SEARCH = 100
ITERATIVE_SCAN = "relaxed_order"


def tune_ann_search(conn: psycopg.Connection, *, ef_search: int = DEFAULT_EF_SEARCH) -> bool:
    """Gecerli islem icin HNSW ayarlarini yapar. Basarisizsa False doner (yoksayilir)."""
    # `conn.transaction()` kullanilmaz: baglanti islemde degilse blok bitince COMMIT eder
    # ve islem-yerel ayarlar kaybolur. Elle savepoint, cagiranin islemini surdurur.
    with conn.cursor() as cur:
        cur.execute("SAVEPOINT tune_ann_search")
        try:
            cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(int(ef_search)),))
            cur.execute("SELECT set_config('hnsw.iterative_scan', %s, true)", (ITERATIVE_SCAN,))
            cur.execute("RELEASE SAVEPOINT tune_ann_search")
        except psycopg.Error as error:
            cur.execute("ROLLBACK TO SAVEPOINT tune_ann_search")
            logger.warning("hnsw ayarlari uygulanamadi: %s", type(error).__name__)
            return False
    return True
