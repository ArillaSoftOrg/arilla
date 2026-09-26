"""Varyant duzeyinde kesin kimlik ile eslestirme (docs/decisions/0036).

Bir offer'in barkodlari iki yerden gelir:

- offer duzeyi (`attributes_raw.gtin`): yalnizca offer TEK ticari varyantsa
  (tum varyantlari ayni barkodu tasiyorsa) yazilir;
- varyant duzeyi (`offer_variant.gtin`): her boyutun kendi barkodu ve boyutu.

Kesin eslesme = ayni gecerli barkod + UYUMLU ticari varyant (hacim/boyut
iki tarafta biliniyorsa esit) + marka/renk/kademe vetosu yok. 60 ml barkodu
100 ml ile eslesemez: barkodlar zaten farklidir; ayni barkodun farkli hacim
etiketiyle gelmesi veri hatasidir ve kesin sayilmaz.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import psycopg

from resolve.candidates import Candidate
from resolve.normalize import ProductKey, extract_volume
from resolve.score import ScoreResult, veto_reason

OFFER_VARIANT_GTINS = """
SELECT gtin, size_label FROM offer_variant
 WHERE offer_id = %(offer_id)s AND gtin IS NOT NULL
"""

#: Barkodu tasiyan urunler: varyant satirindan (boyut etiketiyle) ya da
#: urunun kendi barkodundan (tek varyantli urun). Iki dal da indeksli.
BY_GTIN = """
SELECT p.id, p.title, b.name, p.color, p.gtin, p.mpn, x.gtin, x.size_label
  FROM (
    SELECT o.product_id, ov.gtin, ov.size_label
      FROM offer_variant ov JOIN offer o ON o.id = ov.offer_id
     WHERE ov.gtin = ANY(%(gtins)s) AND o.is_active AND o.product_id IS NOT NULL
       AND o.id <> %(offer_id)s
    UNION
    SELECT p2.id, p2.gtin, NULL FROM product p2 WHERE p2.gtin = ANY(%(gtins)s)
  ) x
  JOIN product p ON p.id = x.product_id
  LEFT JOIN brand b ON b.id = p.brand_id
"""

#: Adaylarin bilinen barkod kumesi ve kumenin TAM olup olmadigi: urunun her
#: aktif offer'i ya offer duzeyinde barkodlu ya da tum varyant satirlari
#: barkodlu. Tam kume, offer'in barkodunu icermiyorsa offer bu urunun hicbir
#: ticari varyanti degildir.
CANDIDATE_GTIN_SETS = """
SELECT o.product_id,
       array_remove(array_agg(DISTINCT COALESCE(ov.gtin, o.attributes_raw->>'gtin')), NULL),
       bool_and(COALESCE(ov.gtin, o.attributes_raw->>'gtin') IS NOT NULL)
  FROM offer o
  LEFT JOIN offer_variant ov ON ov.offer_id = o.id
 WHERE o.product_id = ANY(%(product_ids)s) AND o.is_active
 GROUP BY o.product_id
"""


@dataclass(frozen=True)
class OfferIdentity:
    """Offer'in barkodlari -> o barkodun hacmi (bilinmiyorsa None)."""

    gtins: dict[str, str | None]

    @property
    def values(self) -> list[str]:
        return list(self.gtins)


def offer_identity(conn: psycopg.Connection, offer_id: int, key: ProductKey) -> OfferIdentity:
    gtins: dict[str, str | None] = {}
    if key.gtin:
        gtins[key.gtin] = key.volume
    with conn.cursor() as cur:
        cur.execute(OFFER_VARIANT_GTINS, {"offer_id": offer_id})
        for gtin, size_label in cur.fetchall():
            gtins.setdefault(str(gtin), extract_volume(size_label or ""))
    return OfferIdentity(gtins=gtins)


def _without_volume(key: ProductKey) -> ProductKey:
    # Cok boyutlu offer/urun basliginin hacmi anlamsiz: hacim burada varyant
    # etiketinden karsilastirilir.
    return replace(key, volume=None, gtin=None, mpn=None)


def exact_variant_match(
    conn: psycopg.Connection,
    offer_id: int,
    key: ProductKey,
    identity: OfferIdentity,
) -> tuple[Candidate, ScoreResult] | None:
    """Ayni barkod + uyumlu varyant. Ayni merchant dislamasi UYGULANMAZ:
    barkod kimligi kanitlar (ayni magazanin ayni urunu iki kez listelemesi de
    ayni urundur)."""
    if not identity.gtins:
        return None
    with conn.cursor() as cur:
        cur.execute(BY_GTIN, {"gtins": identity.values, "offer_id": offer_id})
        rows = cur.fetchall()
    for pid, title, brand, color, p_gtin, p_mpn, matched, size_label in rows:
        candidate = Candidate(
            product_id=int(pid),
            title=title,
            brand=brand,
            color=color,
            gtin=p_gtin,
            mpn=p_mpn,
            channel="exact",
        )
        other = ProductKey.build(title=title, brand=brand, color=color)
        ours = identity.gtins.get(str(matched))
        theirs = extract_volume(size_label) if size_label else other.volume
        if ours and theirs and ours != theirs:
            continue  # ayni barkod, farkli hacim: veri hatasi, kesin degil
        if veto_reason(_without_volume(key), _without_volume(other)):
            continue
        return candidate, ScoreResult(score=1.0, method="gtin")
    return None


#: Adayin bilinen satilabilir hacimleri: varyant satiri etiketleri ve varyant
#: satiri olmayan tekliflerin basliklari. Hacim cikarimi Python tarafinda.
CANDIDATE_VARIANT_TEXTS = """
SELECT COALESCE(ov.size_label, o.title_raw)
  FROM offer o LEFT JOIN offer_variant ov ON ov.offer_id = o.id
 WHERE o.product_id = %(product_id)s AND o.is_active
"""


def unverified_variant_volume(
    conn: psycopg.Connection, key: ProductKey, product_id: int
) -> str | None:
    """Metin yolu (0033): offer'in hacmi, adayin bilinen satilabilir
    hacimleri arasinda yoksa eslesme urun AILESINE katilabilir ama ayni
    SATILABILIR varyant oldugu kanitlanmamistir: otomatik kabul yok, REVIEW.
    Aday hacmi hic bilinmiyorsa kural calismaz (bilgi yok != catisma)."""
    if not key.volume:
        return None
    with conn.cursor() as cur:
        cur.execute(CANDIDATE_VARIANT_TEXTS, {"product_id": product_id})
        volumes = {extract_volume(text or "") for (text,) in cur.fetchall()} - {None}
    if volumes and key.volume not in volumes:
        return f"hacim varyanti dogrulanamadi: {key.volume} / {sorted(volumes)}"
    return None


def disjoint_barcode_products(
    conn: psycopg.Connection, identity: OfferIdentity, product_ids: list[int]
) -> set[int]:
    """Offer'in barkodu, barkod kumesi TAM olan adayin hicbir varyantinda
    yoksa: farkli urun ya da satilmayan bir boyut. Aday elenir (veto)."""
    if not identity.gtins or not product_ids:
        return set()
    with conn.cursor() as cur:
        cur.execute(CANDIDATE_GTIN_SETS, {"product_ids": product_ids})
        rows = cur.fetchall()
    ours = set(identity.gtins)
    return {
        int(pid) for pid, gtins, complete in rows if complete and gtins and not (ours & set(gtins))
    }
