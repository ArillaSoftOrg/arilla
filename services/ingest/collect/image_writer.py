"""`offer_image` yazimi (karar 0073). Tum gorsel SQL'i burada.

- **Idempotent.** `(offer_id, url_hash)` uzerinde upsert; ayni offer ayni
  gorsellerle yeniden yazilirsa satir eklenmez VE satir guncellenmez (degisim
  yoksa `DO UPDATE ... WHERE` atlar: gereksiz olu satir/bloat yok).
- **Toplu.** Gorsel basina ifade yok: bir cagri, kac offer olursa olsun TEK
  ifadedir (`unnest`). Toplu toplama kolu (chunk) tum chunk'i tek cagriyla
  yazabilsin diye imza liste alir.
- **Yasam dongusu.** Kaynaktan kalkan gorsel SILINMEZ: `status='removed'`,
  `display_rank=NULL`. Geri gelirse yeniden `active`. `broken` (ileride kaynak
  URL'si olu) YAZMA yolunda korunur, canlandirilmaz.
- **Indirme yok.** Burasi yalniz metadata yazar; `r2_url` / `image_hash` dokunulmaz.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import psycopg

from collect.images import SelectedImage

UPSERT_OFFER_IMAGES = """
WITH incoming AS (
    SELECT * FROM unnest(
        %(offer_id)s::bigint[], %(url_hash)s::bytea[], %(source_url)s::text[],
        %(source_position)s::int[], %(display_rank)s::int[], %(width)s::int[],
        %(height)s::int[], %(specific)s::boolean[]
    ) AS t(offer_id, url_hash, source_url, source_position, display_rank,
           width, height, is_variant_specific)
), upserted AS (
    INSERT INTO offer_image (
        offer_id, url_hash, source_url, source_position, display_rank,
        width, height, is_variant_specific
    )
    SELECT offer_id, url_hash, source_url, source_position, display_rank,
           width, height, is_variant_specific
      FROM incoming
    ON CONFLICT (offer_id, url_hash) DO UPDATE SET
        source_url          = EXCLUDED.source_url,
        source_position     = EXCLUDED.source_position,
        display_rank        = CASE WHEN offer_image.status = 'broken'
                                   THEN NULL ELSE EXCLUDED.display_rank END,
        width               = COALESCE(EXCLUDED.width, offer_image.width),
        height              = COALESCE(EXCLUDED.height, offer_image.height),
        is_variant_specific = EXCLUDED.is_variant_specific,
        status              = CASE WHEN offer_image.status = 'broken'
                                   THEN 'broken' ELSE 'active' END,
        updated_at          = now()
    WHERE (offer_image.source_url, offer_image.source_position, offer_image.display_rank,
           offer_image.width, offer_image.height, offer_image.is_variant_specific,
           offer_image.status)
          IS DISTINCT FROM
          (EXCLUDED.source_url, EXCLUDED.source_position,
           CASE WHEN offer_image.status = 'broken' THEN NULL ELSE EXCLUDED.display_rank END,
           COALESCE(EXCLUDED.width, offer_image.width),
           COALESCE(EXCLUDED.height, offer_image.height), EXCLUDED.is_variant_specific,
           CASE WHEN offer_image.status = 'broken' THEN 'broken' ELSE 'active' END)
    RETURNING 1
), removed AS (
    UPDATE offer_image oi
       SET status = 'removed', display_rank = NULL, updated_at = now()
     WHERE oi.offer_id = ANY(%(offer_ids)s::bigint[])
       AND oi.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM incoming i
                        WHERE i.offer_id = oi.offer_id AND i.url_hash = oi.url_hash)
    RETURNING 1
)
SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM removed)
"""


@dataclass
class ImageWriteCounts:
    written: int = 0
    removed: int = 0


def write_offer_images(
    conn: psycopg.Connection,
    items: Sequence[tuple[int, Sequence[SelectedImage]]],
) -> ImageWriteCounts:
    """`items`: (offer_id, o offer'in guncel gorselleri). Tek ifade, tek round-trip.

    Bir offer icin bos liste = kaynak artik gorsel vermiyor: mevcut aktif
    gorseller `removed` olur. Cagiran islemin icindedir; commit ona aittir.
    """
    if not items:
        return ImageWriteCounts()
    rows = [(offer_id, image) for offer_id, images in items for image in images]
    with conn.cursor() as cur:
        cur.execute(
            UPSERT_OFFER_IMAGES,
            {
                "offer_id": [offer_id for offer_id, _ in rows],
                "url_hash": [image.url_hash for _, image in rows],
                "source_url": [image.source_url for _, image in rows],
                "source_position": [image.source_position for _, image in rows],
                "display_rank": [image.display_rank for _, image in rows],
                "width": [image.width for _, image in rows],
                "height": [image.height for _, image in rows],
                "specific": [image.is_variant_specific for _, image in rows],
                "offer_ids": [offer_id for offer_id, _ in items],
            },
        )
        row = cur.fetchone()
    assert row is not None
    return ImageWriteCounts(written=int(row[0]), removed=int(row[1]))
