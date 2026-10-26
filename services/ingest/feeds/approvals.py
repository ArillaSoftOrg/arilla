"""Karantinadaki besleme dususu icin ACIK onay (karar 0152).

`feeds.sync` kayit sayisi son tam surumlerin medyaninin `min_ratio_vs_median`inin altindaki
dosyayi yazmadan reddeder (`too_few_records`). Katalog gercekten kuculebilir; bu durumda
bir insan sunu yapar:

    python -m feeds quarantine --feed 7
    python -m feeds approve-drop --feed 7 --snapshot 12 --by ad --reason "..." --confirm

Ilkeler:

- **Otomatik kabul yok.** Ayni icerigin tekrar gelmesi, sure gecmesi ya da kayit sayisinin
  artmasi onay yerine GECMEZ.
- **Dar kapsam.** Onay tek bir dosya icerigine (sha256), tek beslemeye baglidir; baska bir
  icerik (kaynak yeniden guncellenmisse) yeniden karantinaya alinir.
- **Tek kullanimlik, sureli.** Onay yalnizca bir surumu kabul ettirir (`feed_drop_accepted`
  satiri). Ayni surumun yarim kalip kaldigi yerden surdurulmesi serbesttir. Varsayilan gecerlilik
  7 gundur.
- **Denetlenebilir.** Onay ve kabul `job_run` satirlaridir (ekleme; `feed_drop_approval`,
  `feed_drop_accepted`): kim (`by`), neden (`reason`), hangi surum/sha256/kayit/medyan, ne zaman.
  Kisitli saklama: `job_run` 180 gun tutulur (migration 0041).
- **Diger kapilar atlanmaz.** Onay yalniz kayit sayisi kapisini gecirir. Butunluk taramasi
  (kesik/bos dosya), hata orani kapisi, `no_deactivate`, deaktivasyon tavani ve 48 saat bekleme
  aynen calisir.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg

APPROVAL_JOB = "feed_drop_approval"
ACCEPTED_JOB = "feed_drop_accepted"
#: Onay bu kadar gun gecerlidir; sonra yeniden onay gerekir.
DEFAULT_TTL_DAYS = 7
MIN_REASON_CHARS = 15
MAX_TEXT_CHARS = 120


class ApprovalError(Exception):
    """Onay verilemedi; mesaj kullaniciya gosterilir (sir/adres icermez)."""


@dataclass(frozen=True)
class Quarantined:
    snapshot_id: int
    feed_id: int
    sha256: str
    records: int
    median: float | None
    completed_at: datetime
    approval_id: int | None


def _detail(**values: Any) -> str:
    return json.dumps(values, ensure_ascii=False)


def approve(
    conn: psycopg.Connection,
    feed_id: int,
    snapshot_id: int,
    *,
    by: str,
    reason: str,
    ttl_days: int = DEFAULT_TTL_DAYS,
) -> int:
    """Karantinadaki bir surumun ICERIGINI onaylar; `feed_drop_approval` satiri kimligini doner."""
    by = (by or "").strip()
    reason = (reason or "").strip()
    if not 2 <= len(by) <= 60:
        raise ApprovalError("--by: 2-60 karakter (onaylayan kisi)")
    if not MIN_REASON_CHARS <= len(reason) <= MAX_TEXT_CHARS:
        raise ApprovalError(f"--reason: {MIN_REASON_CHARS}-{MAX_TEXT_CHARS} karakter (gerekce)")
    if not 1 <= ttl_days <= 30:
        raise ApprovalError("--ttl-days: 1-30")
    with conn.cursor() as cur:
        cur.execute(
            """SELECT feed_source_id, status, reject_reason, sha256, record_count
                 FROM source_snapshot WHERE id = %s""",
            (snapshot_id,),
        )
        row = cur.fetchone()
        if row is None or int(row[0]) != feed_id:
            raise ApprovalError("surum bu beslemeye ait degil ya da yok")
        _fid, status, reject_reason, sha, records = row
        if status != "rejected" or reject_reason != "too_few_records":
            raise ApprovalError(
                f"yalniz 'too_few_records' ile reddedilmis surum onaylanir (durum: {status}, "
                f"neden: {reject_reason or '-'}); kesik/bos dosya onaylanamaz"
            )
        if not sha or records is None:
            raise ApprovalError("surumun ozeti/kayit sayisi yok")
        cur.execute(
            """SELECT max(id) FROM source_snapshot
                WHERE feed_source_id = %s AND status = 'complete'""",
            (feed_id,),
        )
        latest = cur.fetchone()
        if latest and latest[0] is not None and int(latest[0]) > snapshot_id:
            raise ApprovalError("daha yeni bir tam surum var; bu karantina eskimis")
        if find_valid(conn, feed_id, str(sha), ttl_days=ttl_days) is not None:
            raise ApprovalError("bu icerik icin gecerli bir onay zaten var")
        cur.execute(
            """INSERT INTO job_run (job, trigger, status, finished_at, detail)
               VALUES (%s, 'manual', 'success', now(), %s::jsonb) RETURNING id""",
            (
                APPROVAL_JOB,
                _detail(
                    feed_id=feed_id,
                    snapshot_id=snapshot_id,
                    sha256=str(sha),
                    records=int(records),
                    ttl_days=ttl_days,
                    approved_by=by,
                    reason=reason,
                ),
            ),
        )
        approval_id = int(cur.fetchone()[0])  # type: ignore[index]
    conn.commit()
    return approval_id


def find_valid(
    conn: psycopg.Connection,
    feed_id: int,
    sha256: str,
    *,
    snapshot_id: int | None = None,
    ttl_days: int = DEFAULT_TTL_DAYS,
) -> int | None:
    """Bu beslemenin bu icerigi icin gecerli, KULLANILMAMIS (ya da bu surumde kullanilmis) onay.

    Gecerlilik suresi onayin KENDI `ttl_days` degeridir (`ttl_days` argumani yalniz eksikse).

    `snapshot_id`: yarim kalan surumun kaldigi yerden surdurulmesi icin; onay o surumde zaten
    kullanildiysa gecerli sayilir.
    """
    with conn.cursor() as cur:
        cur.execute(
            """SELECT a.id FROM job_run a
                WHERE a.job = %s AND a.status = 'success'
                  AND a.detail ->> 'feed_id' = %s AND a.detail ->> 'sha256' = %s
                  AND a.started_at > now() - make_interval(
                        days => coalesce((a.detail ->> 'ttl_days')::int, %s))
                  AND NOT EXISTS (
                        SELECT 1 FROM job_run u
                         WHERE u.job = %s AND u.detail ->> 'approval_id' = a.id::text
                           AND u.detail ->> 'snapshot_id' IS DISTINCT FROM %s)
                ORDER BY a.id DESC LIMIT 1""",
            (
                APPROVAL_JOB,
                str(feed_id),
                sha256,
                ttl_days,
                ACCEPTED_JOB,
                str(snapshot_id) if snapshot_id is not None else None,
            ),
        )
        row = cur.fetchone()
    conn.commit()
    return int(row[0]) if row else None


def record_accepted(
    conn: psycopg.Connection,
    approval_id: int,
    *,
    feed_id: int,
    snapshot_id: int,
    sha256: str,
    records: int,
    median: float,
) -> None:
    """Onayin bu surumde kullanildigini denetim izine yazar (tek kullanim)."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO job_run (job, trigger, status, finished_at, detail)
               SELECT %s, 'manual', 'success', now(), %s::jsonb
                WHERE NOT EXISTS (
                      SELECT 1 FROM job_run u WHERE u.job = %s
                         AND u.detail ->> 'approval_id' = %s
                         AND u.detail ->> 'snapshot_id' = %s)""",
            (
                ACCEPTED_JOB,
                _detail(
                    approval_id=approval_id,
                    feed_id=feed_id,
                    snapshot_id=snapshot_id,
                    sha256=sha256,
                    records=records,
                    median=round(median),
                ),
                ACCEPTED_JOB,
                str(approval_id),
                str(snapshot_id),
            ),
        )
    conn.commit()


def quarantined(conn: psycopg.Connection, feed_id: int | None = None) -> list[Quarantined]:
    """Son tam surumden SONRA `too_few_records` ile reddedilen surumler (salt okunur)."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT s.id, s.feed_source_id, s.sha256, coalesce(s.record_count, 0), s.completed_at,
                      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.record_count)
                         FROM (SELECT record_count FROM source_snapshot
                                WHERE feed_source_id = s.feed_source_id AND status = 'complete'
                                  AND record_count IS NOT NULL
                                ORDER BY completed_at DESC LIMIT 3) c)
                 FROM source_snapshot s
                WHERE s.status = 'rejected' AND s.reject_reason = 'too_few_records'
                  AND (%s::bigint IS NULL OR s.feed_source_id = %s)
                  AND s.id > coalesce((SELECT max(x.id) FROM source_snapshot x
                                        WHERE x.feed_source_id = s.feed_source_id
                                          AND x.status = 'complete'), 0)
                ORDER BY s.id DESC LIMIT 50""",
            (feed_id, feed_id),
        )
        rows = cur.fetchall()
    out = []
    for sid, fid, sha, records, at, median in rows:
        approval = find_valid(conn, int(fid), str(sha)) if sha else None
        out.append(
            Quarantined(int(sid), int(fid), str(sha or ""), int(records), median, at, approval)
        )
    conn.rollback()
    return out
