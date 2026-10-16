"""Kesfedilen beslemeleri `feed_source`'a kaydeder (karar 0111, 0112).

- Yeni besleme: `status='discovered'`, merchant'siz. Etkinlestirme yoneticinin
  isi (`python -m feeds bind`): para birimi, pazar ve lisans dogrulanmadan
  katalog kirlenmez.
- Bilinen besleme: ad, bicim, gosterim adresi, kaynak guncelleme zamani ve
  `last_discovery_at` tazelenir. `config` ve `status` (yonetici karari) EZILMEZ;
  yalnizca config bossa varsayilanlar/profil yazilir.
- Kesifte artik gorunmeyen besleme: `gone`. Offer'lara dokunulmaz.
- `gone` iken yeniden gorunen: `discovered` (yeniden onay ister).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import psycopg

from feeds.network import DiscoveredFeed, FeedNetwork
from feeds.profiles import profile_for

UPSERT = """
INSERT INTO feed_source (
    network, external_id, program_external_id, program_name, name, format, compression,
    source_url_redacted, currency, market, source_updated_at, config
) VALUES (
    %(network)s, %(external_id)s, %(program_external_id)s, %(program_name)s, %(name)s,
    %(format)s, %(compression)s, %(url)s, %(currency)s, %(market)s, %(source_updated_at)s,
    %(config)s::jsonb
)
ON CONFLICT (network, external_id) DO UPDATE SET
    program_external_id = EXCLUDED.program_external_id,
    program_name        = EXCLUDED.program_name,
    name                = EXCLUDED.name,
    format              = EXCLUDED.format,
    compression         = EXCLUDED.compression,
    source_url_redacted = EXCLUDED.source_url_redacted,
    currency            = COALESCE(feed_source.currency, EXCLUDED.currency),
    source_updated_at   = EXCLUDED.source_updated_at,
    config              = CASE WHEN feed_source.config = '{}'::jsonb
                               THEN EXCLUDED.config ELSE feed_source.config END,
    status              = CASE WHEN feed_source.status = 'gone'
                               THEN 'discovered' ELSE feed_source.status END,
    last_discovery_at   = now(),
    updated_at          = now()
RETURNING (xmax = 0) AS inserted, status
"""

MARK_GONE = """
UPDATE feed_source SET status = 'gone', updated_at = now()
 WHERE network = %(network)s AND status <> 'gone'
   AND NOT (external_id = ANY(%(seen)s))
"""


@dataclass
class DiscoveryReport:
    network: str
    seen: int = 0
    new: list[str] = field(default_factory=list)
    gone: int = 0


def record(conn: psycopg.Connection, network: str, feeds: list[DiscoveredFeed]) -> DiscoveryReport:
    report = DiscoveryReport(network)
    with conn.cursor() as cur:
        for feed in feeds:
            config = {**feed.default_config, **profile_for(network, feed.program_external_id)}
            cur.execute(
                UPSERT,
                {
                    "network": feed.network,
                    "external_id": feed.external_id,
                    "program_external_id": feed.program_external_id,
                    "program_name": feed.program_name,
                    "name": feed.name,
                    "format": feed.format,
                    "compression": feed.compression,
                    "url": feed.source_url_redacted,
                    "currency": feed.currency,
                    "market": feed.market,
                    "source_updated_at": feed.source_updated_at,
                    "config": json.dumps(config, ensure_ascii=False),
                },
            )
            row = cur.fetchone()
            report.seen += 1
            if row is not None and row[0]:
                report.new.append(feed.external_id)
        # Bos kesif (ag hatasi gibi) her seyi 'gone' yapmasin.
        if feeds:
            cur.execute(MARK_GONE, {"network": network, "seen": [f.external_id for f in feeds]})
            report.gone = cur.rowcount
    return report


def discover(conn: psycopg.Connection, network: FeedNetwork) -> DiscoveryReport:
    return record(conn, network.name, network.discover())
