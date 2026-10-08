"""`product.primary_image_url`'i kaynak offer'in gorselini izleyecek sekilde tutar (karar 0073).

Sorun: urun, ilk offer'in `image_url`'i ile bir kez acilir ve sonra guncellenmezdi;
magaza ana gorseli degistirince liste karti (`primary_image_url`) ile galeri
(`offer_image`, rank 0) ayrisirdi.

Cozum: KAYNAK izi esitlikle bulunur. Bir offer'in `image_url`'i degisirken, urunun
`primary_image_url`'i o offer'in ESKI degerine esitse urun yeni degere gecer. Esit
degilse (urunun gorseli baska offer'dan geliyor ya da elle belirlenmis) dokunulmaz;
bu yuzden cok merchant'li kanonik urunde yalniz kaynagi olan offer urunu etkiler.

Toplu ve ucuz: chunk basina TEK ifade, yalnizca degisen offer'lar icin satir yazar.
Offer upsert'inden ONCE cagrilir (eski deger henuz okunabilir). Cagiran islemin
icindedir; commit/rollback ona aittir. Liste/arama sorgularina join EKLEMEZ.
"""

from __future__ import annotations

from collections.abc import Sequence

import psycopg

SYNC_PRIMARY_IMAGES = """
WITH incoming AS (
    SELECT * FROM unnest(%(external_id)s::text[], %(image_url)s::text[])
        AS t(external_id, image_url)
), changed AS (
    SELECT o.product_id, o.image_url AS old_url, i.image_url AS new_url
      FROM offer o
      JOIN incoming i ON i.external_id = o.external_id
     WHERE o.merchant_id = %(merchant_id)s
       AND o.product_id IS NOT NULL
       AND i.image_url IS NOT NULL
       AND o.image_url IS DISTINCT FROM i.image_url
)
UPDATE product p
   SET primary_image_url = c.new_url, updated_at = now()
  FROM changed c
 WHERE p.id = c.product_id
   AND p.primary_image_url IS NOT DISTINCT FROM c.old_url
"""


def sync_primary_images(
    conn: psycopg.Connection,
    merchant_id: int,
    offers: Sequence[tuple[str, str | None]],
) -> int:
    """`offers`: (external_id, yeni image_url). Guncellenen urun sayisini doner."""
    pairs = [(external_id, url) for external_id, url in offers if url]
    if not pairs:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            SYNC_PRIMARY_IMAGES,
            {
                "merchant_id": merchant_id,
                "external_id": [p[0] for p in pairs],
                "image_url": [p[1] for p in pairs],
            },
        )
        return cur.rowcount
