"""Toplama — Katman 1 ve 2.

Katman 1: feed, API, affiliate ag dokumu. Katalogun omurgasi.
Katman 2: kullanici tetikli tek URL cozumleme (`discovery_source = 'user_link'`).
Katman 3 (toplu kazima) yoktur ve eklenmez.

Akis: connector -> ham kayit -> normalizasyon -> `offer` upsert ->
`price_point` INSERT. Idempotent: `(merchant_id, external_id)` unique.

Alan eslemesi `merchant.feed_config` icinden gelir; hicbir saglayicinin alan
semasi koda gomulu degildir. Bkz. docs/decisions/0012-connector-arayuzu.md.
"""
