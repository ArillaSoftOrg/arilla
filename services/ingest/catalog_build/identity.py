"""Kaynak ilanindaki barkodu (GTIN) urune yazar (karar 0220).

Neden: `resolve` baska magazanin teklifini kesin kimlikle (`product.gtin`, yalniz
`published`) eslestirir; kaynak ilani urunleri (Hepsiburada) barkodsuz acildigi icin hicbir
teklif onlarla kesin kimlikle eslesemiyordu. Teklifteki barkod `feeds.normalize` ile
`identity_policy.classify_gtin`'den gecmis 14 haneli degerdir (`offer.attributes_raw.gtin`).

Kurallar (0111 kimlik duzeyi):

* Barkod burada YENIDEN siniflandirilir; yalniz `valid` (kontrol basamagi dogru, kisitli
  GS1 oneki degil) deger yazilir.
* GTIN kanonik VARYANTI tanimlar: yalniz kaynak adres turu varyant olan urune yazilir
  (`IdentityRule.gtin_url_kinds`; Hepsiburada `-p-`). Model/grup adresi (`-pm-`) atlanir.
* Ayni barkod kaynakta birden cok urunde varsa (cift kayit ya da yanlis barkod) HICBIRINE
  yazilmaz; baska bir urunde zaten varsa yazilmaz (`gtin_taken`).
* Var olan `product.gtin` ezilmez; farkli ise yalniz sayilir (`gtin_changed`).
* `product_identity` YAZILMAZ: GTIN satiri kanonik varyant (`canonical_variant_id`) ister ve
  varyant tablosunun yazicisi yoktur; varyant uydurmak 0111'e aykiridir.

Idempotent: ikinci kosu ayni sonucu verir (yalniz `gtin IS NULL` satira yazilir).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import psycopg

from catalog_build.policy import POLICIES, SourcePolicy
from platforms import registry
from resolve.identity_policy import classify_gtin

DEFAULT_BATCH = 2_000

#: Kaynak urunu + kaynak teklifinin barkodu + kaynakta ayni barkodlu urun sayisi.
SELECT_CANDIDATES = """
WITH c AS (
    SELECT p.id, p.gtin AS current, o.url, o.attributes_raw->>'gtin' AS gtin
      FROM product p
      JOIN offer o ON o.id = p.source_offer_id
     WHERE p.source_merchant_id = %(merchant_id)s
       AND o.attributes_raw ? 'gtin'
), d AS (
    SELECT id, current, url, gtin, count(*) OVER (PARTITION BY gtin) AS same_in_source FROM c
)
SELECT id, current, url, gtin, same_in_source
  FROM d
 WHERE id > %(after)s
 ORDER BY id
 LIMIT %(limit)s
"""

#: Kosullu yazim: hala bos ve barkod baska urunde yok. Yaris durumunda yazilmaz (0 satir).
WRITE_GTIN = """
UPDATE product p SET gtin = %(gtin)s, updated_at = now()
 WHERE p.id = %(id)s AND p.gtin IS NULL
   AND NOT EXISTS (SELECT 1 FROM product q WHERE q.gtin = %(gtin)s AND q.id <> p.id)
"""


@dataclass
class IdentityCounts:
    scanned: int = 0
    written: int = 0
    already: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    batches: int = 0
    completed: bool = False


def gtin_kinds(merchant_slug: str) -> frozenset[str]:
    definition = registry.get(merchant_slug)
    if definition is None or definition.identity is None:
        return frozenset()
    return definition.identity.gtin_url_kinds


def gtin_decision(
    *,
    url: str,
    raw_gtin: str | None,
    current: str | None,
    same_in_source: int,
    policy: SourcePolicy,
    kinds: frozenset[str],
) -> tuple[str | None, str | None]:
    """Saf karar: (yazilacak 14 haneli GTIN, atlama nedeni). Ikisi de None = zaten ayni."""
    kind = policy.url_kind(url) if policy.url_kind else None
    if kind not in kinds:
        return None, "not_variant_listing"
    info = classify_gtin(raw_gtin)
    if info.status != "valid" or info.value is None:
        return None, f"gtin_{info.status}"
    if current is not None:
        return (None, None) if current == info.value else (None, "gtin_changed")
    if same_in_source > 1:
        return None, "gtin_ambiguous_in_source"
    return info.value, None


def write_source_gtins(
    conn: psycopg.Connection,
    *,
    merchant_slug: str,
    batch_size: int = DEFAULT_BATCH,
    dry_run: bool = False,
) -> IdentityCounts:
    """Kaynak ilani urunlerine dogrulanmis barkodu yazar. `dry_run` yalnizca sayar."""
    policy = POLICIES.get(merchant_slug)
    kinds = gtin_kinds(merchant_slug)
    totals = IdentityCounts()
    if policy is None or not kinds:
        # Kaynak ilani varyant duzeyinde degil (or. AliExpress): hicbir sey yazilmaz.
        totals.completed = True
        return totals
    from catalog_build.build import merchant_id_for

    merchant_id = merchant_id_for(conn, merchant_slug)
    after = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(
                SELECT_CANDIDATES,
                {"merchant_id": merchant_id, "after": after, "limit": max(1, batch_size)},
            )
            rows = cur.fetchall()
            if not rows:
                conn.commit()
                totals.completed = True
                return totals
            totals.batches += 1
            for pid, current, url, raw, same in rows:
                totals.scanned += 1
                value, reason = gtin_decision(
                    url=str(url),
                    raw_gtin=raw,
                    current=current,
                    same_in_source=int(same),
                    policy=policy,
                    kinds=kinds,
                )
                if reason:
                    totals.skipped[reason] += 1
                elif value is None:
                    totals.already += 1
                elif dry_run:
                    totals.written += 1
                else:
                    cur.execute(WRITE_GTIN, {"gtin": value, "id": int(pid)})
                    if cur.rowcount == 1:
                        totals.written += 1
                    else:
                        totals.skipped["gtin_taken"] += 1
            after = int(rows[-1][0])
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
