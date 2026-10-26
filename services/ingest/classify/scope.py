"""Dinamik kategori kapsami yonetimi (karar 0154): hangi Trendyol dallarina yazilabilir.

`classifier_scope` BOS acilir; satir yoksa dal siniflandiriciya kapalidir. Etkinlestirme elle,
gerekceyle ve denetim izli yapilir (`job_run`: kim, neden, hangi dal, hangi mod). Kapsam yalnizca
`external_category_map` ile Trendyol'dan OLUSTURULMUS dugumler icin verilir: mevcut 158 dugumun
V5 kurallari bu mekanizmayla degismez.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

import psycopg

SCOPE_JOB = "classify_scope"
MIN_REASON = 15
MAX_REASON = 200


class ScopeError(Exception):
    """Kapsam degistirilemedi; mesaj kullaniciya gosterilir (sir/adres icermez)."""


@dataclass(frozen=True)
class ScopeRow:
    path: str
    name: str
    mode: str
    decided_by: str
    note: str | None
    updated_at: datetime
    #: Kapsamin altindaki toplam kategori sayisi (kendisi dahil).
    nodes: int


def list_scopes(conn: psycopg.Connection) -> list[ScopeRow]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT c.path, c.name, s.mode, s.decided_by, s.note, s.updated_at,
                      (SELECT count(*) FROM category d
                        WHERE d.path = c.path OR d.path LIKE c.path || '/%')
                 FROM classifier_scope s JOIN category c ON c.id = s.scope_category_id
                ORDER BY c.path"""
        )
        rows = [ScopeRow(*r) for r in cur.fetchall()]
    conn.rollback()
    return rows


def trendyol_scopes(conn: psycopg.Connection) -> list[str]:
    """Trendyol'dan OLUSTURULMUS en ust dugumler (atasi mevcut/eslenmis olanlar): her biri tum
    alt dalini kapsar. `compare` simulasyonu ve secenek listesi icin; yazma yetkisi VERMEZ."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT c.path FROM external_category_map m JOIN category c ON c.id = m.category_id
                WHERE m.source = 'trendyol' AND m.note = 'created'
                  AND (c.parent_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM external_category_map pm
                         WHERE pm.source = 'trendyol' AND pm.note = 'created'
                           AND pm.category_id = c.parent_id))
                ORDER BY c.path"""
        )
        paths = [str(r[0]) for r in cur.fetchall()]
    conn.rollback()
    return paths


def set_scope(conn: psycopg.Connection, path: str, mode: str, *, by: str, reason: str) -> ScopeRow:
    """Bir dalin kapsamini acar (`apply`) ya da kapatir (`off`); `job_run`a denetim izi yazar."""
    by = (by or "").strip()
    reason = (reason or "").strip()
    if mode not in ("apply", "off"):
        raise ScopeError("--mode: apply | off")
    if not 2 <= len(by) <= 60:
        raise ScopeError("--by: 2-60 karakter (kararı veren kisi)")
    if not MIN_REASON <= len(reason) <= MAX_REASON:
        raise ScopeError(f"--reason: {MIN_REASON}-{MAX_REASON} karakter (gerekce)")
    with conn.cursor() as cur:
        cur.execute(
            """SELECT c.id, c.name FROM category c
                 JOIN external_category_map m ON m.category_id = c.id
                WHERE c.path = %s AND m.source = 'trendyol' AND m.note = 'created'""",
            (path,),
        )
        found = cur.fetchone()
        if found is None:
            raise ScopeError(
                "kategori yok ya da Trendyol'dan OLUSTURULMUS bir dugum degil "
                "(mevcut 158 dugum bu mekanizmayla acilmaz)"
            )
        category_id, name = int(found[0]), str(found[1])
        cur.execute(
            """INSERT INTO classifier_scope (scope_category_id, mode, decided_by, note)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (scope_category_id) DO UPDATE
                  SET mode = EXCLUDED.mode, decided_by = EXCLUDED.decided_by,
                      note = EXCLUDED.note, updated_at = now()""",
            (category_id, mode, by, reason),
        )
        cur.execute(
            """INSERT INTO job_run (job, trigger, status, finished_at, detail)
               VALUES (%s, 'manual', 'success', now(), %s::jsonb)""",
            (
                SCOPE_JOB,
                json.dumps({"path": path, "mode": mode, "by": by, "reason": reason}),
            ),
        )
    conn.commit()
    rows = [r for r in list_scopes(conn) if r.path == path]
    return rows[0] if rows else ScopeRow(path, name, mode, by, reason, datetime.now(), 0)
