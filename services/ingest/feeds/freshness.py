"""Besleme fiyatlarinin tazeligi (karar 0142). YALNIZCA OKUR.

Iki ayri tarih vardir ve karistirilmaz:

- `source_updated_at`: KAYNAGIN (Admitad `admitad_last_update`) bu dosyayi son
  guncelledigi an. Fiyatin dunyadaki yasi bunun sinirindadir.
- `last_success_at`: biz o dosyayi veritabanina en son TAMAMLAYIP yazdigimiz an.

Bir offer'in fiyati, bagli oldugu beslemelerden en az biri "guncel" ise guncel
sayilir. Offer'in kendi `last_seen_at`'ine bakilmaz: degismeyen offer satiri
yeniden yazilmaz (karar 0114), "goruldu" bilgisi `feed_source_offer`'dadir.

Bu modul fiyat gizlemez, offer pasiflestirmez: gorunurluk karari okuma
yolundadir (karar 0142 "Sinirlar"). Burada yalnizca olcum ve siniflandirma var.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import StrEnum

import psycopg

#: Kaynak bu sureden eskiyse fiyatlar kaynakta bayat sayilir. Admitad'in guncelleme
#: sikligi olculmeden sabitlenemez; ilk haftanin `source_age_hours` verisiyle ayarlanir.
DEFAULT_MAX_SOURCE_AGE = timedelta(days=7)
#: Kaynak tarihi gelecekte ise (saat/saat dilimi sorunu) her kosuda yeniden indirmeyi
#: onlemek icin bu pay asilinca bayrak kalkar.
FUTURE_TOLERANCE = timedelta(hours=6)
#: `packages/core/src/pricing/fx.ts` `MAX_RATE_AGE_DAYS` ile AYNI olmali (testle sabitlenir).
MAX_FX_AGE_DAYS = 4


class FeedState(StrEnum):
    CURRENT = "current"
    #: Kaynak, son basarili yazimimizdan daha yeni: son surumu henuz yazmadik.
    BEHIND = "behind"
    #: Kaynagin kendisi uzun suredir guncellenmiyor.
    SOURCE_STALE = "source_stale"
    NEVER_SYNCED = "never_synced"
    #: Kaynak tarihi gelecekte: tarihe guvenilmez.
    SOURCE_DATE_INVALID = "source_date_invalid"


#: Sorunlu durumlar (calisma `partial` olur). `CURRENT` disindakilerin hepsi.
PROBLEM_STATES = frozenset(set(FeedState) - {FeedState.CURRENT})


def classify(
    *,
    now: datetime,
    source_updated_at: datetime | None,
    last_success_at: datetime | None,
    max_source_age: timedelta = DEFAULT_MAX_SOURCE_AGE,
) -> FeedState:
    if last_success_at is None:
        return FeedState.NEVER_SYNCED
    if source_updated_at is None:
        # Kaynak tarih bildirmiyor: yalnizca kendi yazimimizin yasina bakilir.
        return FeedState.CURRENT if now - last_success_at <= max_source_age else FeedState.BEHIND
    if source_updated_at > now + FUTURE_TOLERANCE:
        return FeedState.SOURCE_DATE_INVALID
    if source_updated_at > last_success_at:
        return FeedState.BEHIND
    if now - source_updated_at > max_source_age:
        return FeedState.SOURCE_STALE
    return FeedState.CURRENT


@dataclass(frozen=True)
class FeedFreshness:
    feed_id: int
    external_id: str
    status: str
    state: FeedState
    source_updated_at: datetime | None
    last_success_at: datetime | None
    last_error_code: str | None
    members: int


@dataclass
class FxFreshness:
    effective_date: date | None
    age_days: int | None

    @property
    def usable(self) -> bool:
        """Yaklasik TRY gosterimi icin kur kullanilabilir mi (fx.ts ile ayni kural)."""
        return (
            self.effective_date is not None
            and self.age_days is not None
            and 0 <= self.age_days <= MAX_FX_AGE_DAYS
        )


@dataclass
class Freshness:
    merchant: str
    now: datetime
    feeds: list[FeedFreshness] = field(default_factory=list)
    offers_active: int = 0
    #: Fiyati guncel bir beslemeye bagli farkli offer sayisi / geri kalani.
    offers_fresh: int = 0
    offers_stale: int = 0
    fx: FxFreshness = field(default_factory=lambda: FxFreshness(None, None))

    @property
    def problems(self) -> list[FeedFreshness]:
        return [f for f in self.feeds if f.state in PROBLEM_STATES]

    @property
    def newest_source_at(self) -> datetime | None:
        dates = [f.source_updated_at for f in self.feeds if f.source_updated_at]
        return max(dates) if dates else None

    @property
    def oldest_source_at(self) -> datetime | None:
        dates = [f.source_updated_at for f in self.feeds if f.source_updated_at]
        return min(dates) if dates else None

    @property
    def last_success_at(self) -> datetime | None:
        dates = [f.last_success_at for f in self.feeds if f.last_success_at]
        return max(dates) if dates else None

    def detail(self) -> dict[str, object]:
        """`job_run.detail` icin duz ozet (sir ve adres yok)."""
        out: dict[str, object] = {
            "feeds_active": len(self.feeds),
            "feeds_current": sum(1 for f in self.feeds if f.state is FeedState.CURRENT),
            "feeds_problem": len(self.problems),
            "offers_active": self.offers_active,
            "offers_fresh": self.offers_fresh,
            "offers_stale": self.offers_stale,
            "fx_ok": self.fx.usable,
        }
        if self.fx.effective_date:
            out["fx_date"] = self.fx.effective_date.isoformat()
            out["fx_age_days"] = self.fx.age_days
        if self.newest_source_at:
            out["source_updated_at"] = self.newest_source_at.isoformat(timespec="seconds")
            out["source_age_hours"] = round(
                (self.now - self.newest_source_at).total_seconds() / 3600, 1
            )
        if self.oldest_source_at:
            out["oldest_source_age_hours"] = round(
                (self.now - self.oldest_source_at).total_seconds() / 3600, 1
            )
        if self.last_success_at:
            out["last_success_at"] = self.last_success_at.isoformat(timespec="seconds")
        for state in PROBLEM_STATES:
            count = sum(1 for f in self.feeds if f.state is state)
            if count:
                out[f"feeds_{state.value}"] = count
        return out


FEEDS_SQL = """
SELECT f.id, f.external_id, f.status, f.source_updated_at, f.last_success_at,
       f.last_error_code,
       (SELECT count(*) FROM feed_source_offer m WHERE m.feed_source_id = f.id)
  FROM feed_source f JOIN merchant mer ON mer.id = f.merchant_id
 WHERE mer.slug = %s AND f.status IN ('active', 'paused')
 ORDER BY f.id
"""

ACTIVE_OFFERS_SQL = """
SELECT count(*) FROM offer o JOIN merchant mer ON mer.id = o.merchant_id
 WHERE mer.slug = %s AND o.is_active AND o.feed_source_id IS NOT NULL
"""

#: Guncel beslemelerde uyeligi olan ETKIN farkli offer sayisi.
FRESH_OFFERS_SQL = """
SELECT count(DISTINCT m.offer_id) FROM feed_source_offer m
  JOIN offer o ON o.id = m.offer_id AND o.is_active
 WHERE m.feed_source_id = ANY(%s)
"""

FX_SQL = """
SELECT max(effective_date) FROM fx_rate
 WHERE source = 'tcmb' AND base = %s AND quote = 'TRY' AND rate_kind = 'forex_selling'
"""


def measure_fx(conn: psycopg.Connection, now: datetime, base: str = "USD") -> FxFreshness:
    with conn.cursor() as cur:
        cur.execute(FX_SQL, (base,))
        row = cur.fetchone()
    effective = row[0] if row else None
    if effective is None:
        return FxFreshness(None, None)
    return FxFreshness(effective, (now.date() - effective).days)


def measure(
    conn: psycopg.Connection,
    merchant: str,
    *,
    now: datetime,
    max_source_age: timedelta = DEFAULT_MAX_SOURCE_AGE,
    fx_base: str = "USD",
) -> Freshness:
    """Bir merchant'in etkin/duraklatilmis beslemelerinin ve offer'larinin tazeligi."""
    report = Freshness(merchant=merchant, now=now)
    with conn.cursor() as cur:
        cur.execute(FEEDS_SQL, (merchant,))
        rows = cur.fetchall()
        for fid, ext, status, source_at, success_at, error_code, members in rows:
            report.feeds.append(
                FeedFreshness(
                    feed_id=int(fid),
                    external_id=str(ext),
                    status=str(status),
                    state=classify(
                        now=now,
                        source_updated_at=source_at,
                        last_success_at=success_at,
                        max_source_age=max_source_age,
                    ),
                    source_updated_at=source_at,
                    last_success_at=success_at,
                    last_error_code=error_code,
                    members=int(members),
                )
            )
        cur.execute(ACTIVE_OFFERS_SQL, (merchant,))
        report.offers_active = int(cur.fetchone()[0])  # type: ignore[index]
        fresh_ids = [f.feed_id for f in report.feeds if f.state is FeedState.CURRENT]
        fresh = 0
        if fresh_ids:
            cur.execute(FRESH_OFFERS_SQL, (fresh_ids,))
            fresh = int(cur.fetchone()[0])  # type: ignore[index]
    report.offers_fresh = fresh
    # Guncel bir beslemede uyeligi olmayan her etkin offer (bayat kaynak, geride kalan
    # besleme ya da deaktivasyon bekleme suresi) guncel DEGILDIR.
    report.offers_stale = max(report.offers_active - fresh, 0)
    report.fx = measure_fx(conn, now, fx_base)
    conn.rollback()
    return report
