"""Gunluk besleme senkronizasyonunun WAL maliyeti (karar 0185, Asama B). YEREL, izole veritabani.

    DATABASE_URL_OWNER=postgresql://arilla:...@127.0.0.1:55510/arilla \\
    DATABASE_URL=postgresql://arilla_app:...@127.0.0.1:55510/arilla \\
    python scripts/bench_feed_wal.py [--offers 100000] [--change 0.6] [--json out.json]

Gercek `FeedSync` yolu (uretimdeki MERGE, uyelik, price_point, search_outbox) sentetik AliExpress
benzeri beslemeyle uc kez kosar:
  1. ilk yukleme (tum teklifler yeni)
  2. gunluk degisim: `--change` oraninda fiyat degisir, %1 yeni, %1 kaybolan
  3. degisimsiz tekrar: kaynak ayni (yalniz uyelik "goruldu" yazimi ve okumalar)
Her kosudan once CHECKPOINT alinir (uretimdeki gibi: kosunun ilk dokunusu tam sayfa = FPI).
Olculenler: WAL bayti (`pg_wal_lsn_diff`), FPI ve kayit (`pg_stat_wal`), `offer` ve
`feed_source_offer` guncelleme/HOT, `price_point` ekleme, sure.

Yalniz 127.0.0.1/localhost veritabaninda calisir; kendi satirlarini (alan adi/ag 'bench0185')
olusturur ve sonunda siler. Uretime BAGLANMAZ.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg  # noqa: E402

from db.connection import database_url  # noqa: E402
from feeds.sync import FeedSync, SyncSettings  # noqa: E402
from tests.feed_fixtures import AE_PROFILE, offer, write, yml  # noqa: E402

DOMAIN = "bench0185.test.invalid"
NETWORK = "bench0185"
T0 = datetime(2026, 11, 1, 6, 30, tzinfo=UTC)


def local_only(url: str) -> None:
    host = urlparse(url).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(f"yalniz yerel veritabani: {host}")


def cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("SELECT id FROM merchant WHERE domain = %s", (DOMAIN,))
    row = cur.fetchone()
    feeds = f"SELECT id FROM feed_source WHERE network = '{NETWORK}'"
    if row:
        offers = "SELECT id FROM offer WHERE merchant_id = %(m)s"
        for table, col in (
            ("search_outbox", "entity_id"),
            ("price_point", "offer_id"),
            ("offer_image", "offer_id"),
            ("feed_source_offer", "offer_id"),
            ("price_verification_request", "offer_id"),
        ):
            extra = " AND entity = 'offer'" if table == "search_outbox" else ""
            cur.execute(f"DELETE FROM {table} WHERE {col} IN ({offers}){extra}", {"m": row[0]})
    cur.execute(f"DELETE FROM ingest_error WHERE feed_source_id IN ({feeds})")
    cur.execute(
        f"DELETE FROM ingest_chunk WHERE snapshot_id IN "
        f"(SELECT id FROM source_snapshot WHERE feed_source_id IN ({feeds}))"
    )
    cur.execute(f"DELETE FROM ingest_run WHERE feed_source_id IN ({feeds})")
    if row:
        cur.execute("DELETE FROM offer WHERE merchant_id = %s", (row[0],))
        cur.execute("DELETE FROM seller WHERE merchant_id = %s", (row[0],))
    cur.execute(f"DELETE FROM source_snapshot WHERE feed_source_id IN ({feeds})")
    cur.execute(f"DELETE FROM feed_source WHERE network = '{NETWORK}'")
    cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))


COUNTERS = """
SELECT (SELECT wal_fpi FROM pg_stat_wal), (SELECT wal_records FROM pg_stat_wal),
       (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'offer'),
       (SELECT n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'offer'),
       (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'feed_source_offer'),
       (SELECT n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'feed_source_offer'),
       (SELECT coalesce(sum(n_tup_ins), 0)::bigint FROM pg_stat_user_tables
         WHERE relname LIKE 'price_point%%'),
       pg_current_wal_lsn()
"""


def counters(cur: psycopg.Cursor) -> tuple:
    # Diger baglantinin istatistikleri bosta en gec ~1 sn'de yazilir.
    time.sleep(2.0)
    cur.execute("SELECT pg_stat_clear_snapshot()")
    cur.execute(COUNTERS)
    return cur.fetchone()


def feed_offers(n: int, *, run: int, change: float, new: float, gone: float) -> list[dict]:
    base = 1005000000000000
    keep = [i for i in range(n) if run < 2 or (i / n) >= gone]  # ilk %gone kaybolur
    extra = [n + i for i in range(int(n * new))] if run >= 2 else []
    out = []
    for i in keep + extra:
        changed = run == 2 and (i % 1000) < change * 1000
        price = f"{10 + (i % 500) / 10 + (1.17 if changed else 0):.2f}"
        out.append(offer(str(base + i), price=price))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offers", type=int, default=100_000)
    ap.add_argument("--change", type=float, default=0.6)
    ap.add_argument("--new", type=float, default=0.01)
    ap.add_argument("--gone", type=float, default=0.01)
    ap.add_argument("--chunk", type=int, default=5000)
    ap.add_argument("--label", default="")
    ap.add_argument("--json")
    args = ap.parse_args(argv)
    owner_url, app_url = database_url("DATABASE_URL_OWNER"), database_url("DATABASE_URL")
    local_only(owner_url)
    local_only(app_url)

    owner = psycopg.connect(owner_url, autocommit=True)
    app = psycopg.connect(app_url)
    results = []
    try:
        with owner.cursor() as cur:
            cleanup(cur)
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type, is_active)
                   VALUES ('bench0185', 'AliExpress (bench)', %s,
                           'affiliate_network', FALSE)
                   RETURNING id""",
                (DOMAIN,),
            )
            merchant_id = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO feed_source
                       (network, external_id, merchant_id, status, format, currency, config)
                   VALUES (%s, '6115:1', %s, 'active', 'xml', 'USD', %s::jsonb)
                   RETURNING id""",
                (NETWORK, merchant_id, json.dumps(AE_PROFILE)),
            )
            feed_id = cur.fetchone()[0]
        with tempfile.TemporaryDirectory() as tmp:
            for run, name in ((1, "ilk_yukleme"), (2, "gunluk_degisim"), (3, "degisimsiz")):
                # 3. kosu, 2. kosunun AYNISI (ayni fiyatlar): yalniz "goruldu" maliyeti kalir.
                offers = feed_offers(
                    args.offers,
                    run=min(run, 2),
                    change=args.change if run >= 2 else 0.0,
                    new=args.new,
                    gone=args.gone,
                )
                # Uretimde kaynak dosya her gun degisir: baslik tarihi kosuya ozgu (ayni bayt =
                # "duplicate" atlanirdi); teklif icerigi 3. kosuda 2.'nin aynisidir.
                data = yml(offers).replace(b"2026-10-14 08:28", f"2026-11-0{run} 06:00".encode())
                path = write(Path(tmp) / f"run{run}.xml", data)
                with owner.cursor() as cur:
                    cur.execute("CHECKPOINT")
                    c0 = counters(cur)
                started = time.monotonic()
                report = FeedSync(
                    app,
                    feed_id,
                    source_path=path,
                    observed_at=T0 + timedelta(hours=12 * run),
                    settings=SyncSettings(chunk_size=args.chunk, pause_ms=0),
                    sleep=lambda _s: None,
                ).run(force=True)
                seconds = time.monotonic() - started
                with owner.cursor() as cur:
                    c1 = counters(cur)
                    cur.execute("SELECT pg_wal_lsn_diff(%s, %s)", (c1[7], c0[7]))
                    wal = int(cur.fetchone()[0])
                offer_upd, offer_hot = c1[2] - c0[2], c1[3] - c0[3]
                fso_upd, fso_hot = c1[4] - c0[4], c1[5] - c0[5]
                results.append(
                    {
                        "run": name,
                        "records": len(offers),
                        "status": report.status,
                        "seconds": round(seconds, 1),
                        "wal_bytes": wal,
                        "wal_mb": round(wal / 1e6, 1),
                        "wal_fpi": c1[0] - c0[0],
                        "wal_records": c1[1] - c0[1],
                        "offer_upd": offer_upd,
                        "offer_hot": offer_hot,
                        "offer_hot_pct": round(100 * offer_hot / offer_upd, 1)
                        if offer_upd
                        else None,
                        "membership_upd": fso_upd,
                        "membership_hot": fso_hot,
                        "price_points": c1[6] - c0[6],
                        "wal_bytes_per_record": round(wal / max(len(offers), 1)),
                    }
                )
                print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    finally:
        app.rollback()
        app.close()
        with owner.cursor() as cur:
            cleanup(cur)
        owner.close()
    out = {
        "label": args.label or None,
        "offers": args.offers,
        "change": args.change,
        "runs": results,
    }
    if args.json:
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
