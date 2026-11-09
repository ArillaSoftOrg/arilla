"""Embedding indeks yasam dongusu: kayit, golge, atomik etkinlestirme, rollback (karar 0181).

    python -m enrich.index list
    python -m enrich.index register --model M            # building (yalniz kayit; vektor yok)
    python -m enrich.index shadow   --model M            # backfill bitti, golgede izleniyor
    python -m enrich.index compare  --model M --sample 50    # komsu ortusmesi (salt okunur)
    python -m enrich.index activate --model M --min-coverage 0.95
    python -m enrich.index rollback                      # en son retired -> active
    python -m enrich.index retire   --model M

Degistiren komutlar **varsayilan olarak kuru calisir** (plan yazdirir); `--execute` ile uygulanir.

Akis: `register` -> `enrich.products --model M --execute` (backfill, aktif indekse dokunmaz)
-> `shadow` -> `compare` -> `activate` (tek islem: eski active -> retired, M -> active).
Okuyan taraf (TS anlamsal arama) aktif satiri kisa sureli onbellekle okur; gecis aninda ya eskiyi
ya yeniyi gorur, ikisini karistirmaz. Rollback ayni islemin tersidir; vektorler silinmez.

`compare` HNSW indeksi yokken her ornek icin tam tarama yapar; uretimde kucuk orneklem ya da
yerel kopya kullanilir (sorgu basina `statement_timeout`).

Kurallar:
- Kayit defterinde olmayan, `disabled` ya da tablosu olmayan model kaydedilemez.
- `activate` yalniz `shadow` durumundaki, uretime hazir (active/shadow + dogrulanmis lisans) modeli
  ve uygun urunlerin en az `--min-coverage` oraninda guncel vektoru varsa kabul eder.
- Satir silinmez (arilla_app DELETE yetkisi yok); durum gecmisi `activated_at`/`retired_at`'te.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Any

import psycopg

from db import job_run
from db.connection import connect
from enrich.product_text import TEXT_VERSION
from enrich.registry import ModelSpec, Registry, RegistryError, registry, require_writable

TARGET = "product_text"
JOB = "embedding_index"
DEFAULT_MIN_COVERAGE = 0.95
#: Ayni anda tek gecis islemi (diger islerin anahtarlarindan ayri).
LOCK_KEY = 181_000_001

LIST_SQL = """
SELECT id, model_version, index_family, dimensions, storage_table, state,
       activated_at, retired_at
  FROM embedding_index
 WHERE target = %(target)s
 ORDER BY id
"""

ELIGIBLE_SQL = """
SELECT count(*)
  FROM product p
 WHERE p.publication_state = 'published' AND p.offer_count + p.foreign_offer_count > 0
"""

#: Tablo adi kayit defterinin beyaz listesinden gelir; kullanici girdisi degildir.
COVERED_SQL = """
SELECT count(*)
  FROM {table} e
  JOIN product p ON p.id = e.product_id
 WHERE e.model_version = %(model)s
   AND e.text_version = %(text_version)s
   AND p.publication_state = 'published' AND p.offer_count + p.foreign_offer_count > 0
"""

REGISTER_SQL = """
INSERT INTO embedding_index (target, model_version, index_family, dimensions, storage_table)
VALUES (%(target)s, %(model)s, %(family)s, %(dims)s, %(table)s)
ON CONFLICT (target, model_version) DO NOTHING
"""

SET_STATE_SQL = """
UPDATE embedding_index
   SET state = %(state)s, updated_at = now(),
       activated_at = CASE WHEN %(state)s = 'active' THEN now() ELSE activated_at END,
       retired_at   = CASE WHEN %(state)s = 'retired' THEN now() ELSE retired_at END
 WHERE id = %(id)s
"""


@dataclass(frozen=True)
class IndexRow:
    id: int
    model_version: str
    index_family: str
    dimensions: int
    storage_table: str
    state: str
    activated_at: Any
    retired_at: Any

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "model_version": self.model_version,
            "index_family": self.index_family,
            "dimensions": self.dimensions,
            "storage_table": self.storage_table,
            "state": self.state,
            "activated_at": self.activated_at.isoformat() if self.activated_at else None,
            "retired_at": self.retired_at.isoformat() if self.retired_at else None,
        }


class IndexTransitionError(RuntimeError):
    """Gecis kurallara aykiri; hicbir sey degismedi."""


@dataclass
class Plan:
    """Uygulanacak (ya da kuru calismada uygulanacak olan) degisiklik."""

    action: str
    changes: list[tuple[int, str, str]]  # (id, eski durum, yeni durum)
    detail: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "changes": [{"id": i, "from": a, "to": b} for i, a, b in self.changes],
            **self.detail,
        }


def rows(conn: psycopg.Connection, *, lock: bool = False) -> list[IndexRow]:
    sql = LIST_SQL + (" FOR UPDATE" if lock else "")
    with conn.cursor() as cur:
        cur.execute(sql, {"target": TARGET})
        return [IndexRow(*row) for row in cur.fetchall()]


def _find(found: list[IndexRow], model: str) -> IndexRow:
    for row in found:
        if row.model_version == model:
            return row
    raise IndexTransitionError(f"{model}: embedding_index'te kayitli degil (once register)")


def _active(found: list[IndexRow]) -> IndexRow | None:
    return next((row for row in found if row.state == "active"), None)


def _spec(model: str, reg: Registry) -> ModelSpec:
    spec = reg.get(model)
    if TARGET not in spec.roles or spec.state == "disabled":
        raise IndexTransitionError(f"{model}: urun metni indeksi olamaz")
    require_writable(spec, spec.index_family, reg=reg)
    return spec


def coverage(conn: psycopg.Connection, row: IndexRow, reg: Registry) -> tuple[int, int]:
    family = reg.families[row.index_family]
    if family.table != row.storage_table:
        raise IndexTransitionError(f"{row.model_version}: tablo kayit defteriyle uyusmuyor")
    with conn.cursor() as cur:
        cur.execute(ELIGIBLE_SQL)
        eligible = int(cur.fetchone()[0])
        cur.execute(
            COVERED_SQL.format(table=family.table),
            {"model": row.model_version, "text_version": TEXT_VERSION},
        )
        covered = int(cur.fetchone()[0])
    return covered, eligible


def plan_register(conn: psycopg.Connection, model: str, reg: Registry) -> Plan:
    spec = _spec(model, reg)
    family = reg.family(spec)
    existing = [row for row in rows(conn) if row.model_version == model]
    detail = {
        "model": model,
        "index_family": family.name,
        "storage_table": family.table,
        "dimensions": family.dimensions,
        "already_registered": bool(existing),
    }
    return Plan("register", [], detail)


def plan_shadow(conn: psycopg.Connection, model: str, reg: Registry) -> Plan:
    _spec(model, reg)
    row = _find(rows(conn, lock=True), model)
    if row.state not in {"building", "retired"}:
        raise IndexTransitionError(f"{model}: {row.state} durumundan shadow'a gecilemez")
    return Plan("shadow", [(row.id, row.state, "shadow")], {"model": model})


def plan_retire(conn: psycopg.Connection, model: str, reg: Registry) -> Plan:
    row = _find(rows(conn, lock=True), model)
    if row.state == "active":
        raise IndexTransitionError(f"{model}: aktif indeks emekli edilemez (activate/rollback)")
    if row.state == "retired":
        return Plan("retire", [], {"model": model, "already_retired": True})
    return Plan("retire", [(row.id, row.state, "retired")], {"model": model})


def plan_activate(conn: psycopg.Connection, model: str, reg: Registry, min_coverage: float) -> Plan:
    spec = _spec(model, reg)
    if not spec.production_ready:
        raise IndexTransitionError(
            f"{model}: kayit defterinde uretime hazir degil (durum {spec.state}, "
            f"lisans {'dogrulandi' if spec.license_verified else 'dogrulanmadi'})"
        )
    found = rows(conn, lock=True)
    row = _find(found, model)
    if row.state != "shadow":
        raise IndexTransitionError(f"{model}: yalniz shadow etkinlestirilir (simdi {row.state})")
    covered, eligible = coverage(conn, row, reg)
    ratio = covered / eligible if eligible else 0.0
    detail = {
        "model": model,
        "covered": covered,
        "eligible": eligible,
        "coverage": round(ratio, 4),
        "min_coverage": min_coverage,
    }
    if ratio < min_coverage:
        raise IndexTransitionError(
            f"{model}: kapsam {ratio:.2%} < {min_coverage:.2%} ({covered}/{eligible})"
        )
    changes: list[tuple[int, str, str]] = []
    current = _active(found)
    if current is not None:
        changes.append((current.id, "active", "retired"))
        detail["previous"] = current.model_version
    changes.append((row.id, "shadow", "active"))
    return Plan("activate", changes, detail)


def plan_rollback(conn: psycopg.Connection, reg: Registry) -> Plan:
    found = rows(conn, lock=True)
    current = _active(found)
    retired = [row for row in found if row.state == "retired" and row.retired_at is not None]
    if not retired:
        raise IndexTransitionError("geri donulecek emekli indeks yok")
    previous = max(retired, key=lambda row: (row.retired_at, row.id))
    _spec(previous.model_version, reg)
    changes: list[tuple[int, str, str]] = []
    if current is not None:
        changes.append((current.id, "active", "retired"))
    changes.append((previous.id, "retired", "active"))
    detail = {
        "model": previous.model_version,
        "previous": current.model_version if current else None,
    }
    return Plan("rollback", changes, detail)


def apply(conn: psycopg.Connection, plan: Plan, model: str | None, reg: Registry) -> None:
    """Plan tek islemde uygulanir. Once eski active emekli edilir (kismi unique indeks)."""
    with conn.cursor() as cur:
        if plan.action == "register":
            assert model is not None
            spec = reg.get(model)
            family = reg.family(spec)
            cur.execute(
                REGISTER_SQL,
                {
                    "target": TARGET,
                    "model": model,
                    "family": family.name,
                    "dims": family.dimensions,
                    "table": family.table,
                },
            )
        ordered = sorted(plan.changes, key=lambda change: change[2] == "active")
        for row_id, _, state in ordered:
            cur.execute(SET_STATE_SQL, {"id": row_id, "state": state})


def _locked(conn: psycopg.Connection) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_xact_lock(%s)", (LOCK_KEY,))
        return bool(cur.fetchone()[0])


def run(
    conn: psycopg.Connection,
    action: str,
    *,
    model: str | None = None,
    execute: bool = False,
    min_coverage: float = DEFAULT_MIN_COVERAGE,
    reg: Registry | None = None,
) -> Plan:
    """Plani kurar; `execute` ise ayni islemde uygular, degilse geri alir."""
    reg = reg or registry()
    try:
        if not _locked(conn):
            raise IndexTransitionError("baska bir indeks gecisi suruyor")
        if action == "register":
            plan = plan_register(conn, _need(model), reg)
        elif action == "shadow":
            plan = plan_shadow(conn, _need(model), reg)
        elif action == "retire":
            plan = plan_retire(conn, _need(model), reg)
        elif action == "activate":
            plan = plan_activate(conn, _need(model), reg, min_coverage)
        elif action == "rollback":
            plan = plan_rollback(conn, reg)
        else:
            raise IndexTransitionError(f"bilinmeyen islem: {action}")
        if execute:
            apply(conn, plan, model, reg)
            conn.commit()
        else:
            conn.rollback()
        return plan
    except (RegistryError, IndexTransitionError):
        conn.rollback()
        raise


def _need(model: str | None) -> str:
    if not model:
        raise IndexTransitionError("--model gerekli")
    return model


# --- compare: aktif ile aday indeksin komsu ortusmesi (salt okunur) ------------------------------

NEIGHBOURS_SQL = """
SELECT n.product_id
  FROM {table} n
 WHERE n.model_version = %(model)s AND n.product_id <> %(pid)s
 ORDER BY n.embedding <=> (SELECT embedding FROM {table}
                            WHERE product_id = %(pid)s AND model_version = %(model)s)
 LIMIT %(k)s
"""

SAMPLE_SQL = """
SELECT a.product_id
  FROM {active_table} a
  JOIN {candidate_table} c ON c.product_id = a.product_id AND c.model_version = %(candidate)s
 WHERE a.model_version = %(active)s
 ORDER BY md5(a.product_id::text)
 LIMIT %(sample)s
"""


def compare(
    conn: psycopg.Connection,
    candidate: str,
    *,
    sample: int,
    k: int,
    reg: Registry | None = None,
    statement_timeout_ms: int = 5000,
) -> dict[str, Any]:
    """Her iki indekste vektoru olan ornek urunlerde ilk-k komsu Jaccard ortusmesi."""
    reg = reg or registry()
    with conn.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
    found = rows(conn)
    active = _active(found)
    if active is None:
        raise IndexTransitionError("aktif indeks yok")
    cand = _find(found, candidate)
    for row in (active, cand):
        _spec(row.model_version, reg)
    with conn.cursor() as cur:
        timeout = str(statement_timeout_ms)
        cur.execute("SELECT set_config('statement_timeout', %s, true)", (timeout,))
        sample_sql = SAMPLE_SQL.format(
            active_table=active.storage_table, candidate_table=cand.storage_table
        )
        cur.execute(
            sample_sql,
            {"active": active.model_version, "candidate": candidate, "sample": sample},
        )
        ids = [int(row[0]) for row in cur.fetchall()]
        overlaps: list[float] = []
        for pid in ids:
            sets = []
            for row in (active, cand):
                cur.execute(
                    NEIGHBOURS_SQL.format(table=row.storage_table),
                    {"model": row.model_version, "pid": pid, "k": k},
                )
                sets.append({int(r[0]) for r in cur.fetchall()})
            union = sets[0] | sets[1]
            overlaps.append(len(sets[0] & sets[1]) / len(union) if union else 1.0)
    conn.rollback()
    overlaps.sort()
    return {
        "active": active.model_version,
        "candidate": candidate,
        "sampled": len(ids),
        "k": k,
        "jaccard_mean": round(sum(overlaps) / len(overlaps), 4) if overlaps else None,
        "jaccard_p10": round(overlaps[len(overlaps) // 10], 4) if overlaps else None,
    }


# --- CLI ---------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="enrich.index", description="Embedding indeks gecisleri")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    for name in ("register", "shadow", "retire", "activate"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--model", required=True)
        cmd.add_argument("--execute", action="store_true", help="uygula (varsayilan: kuru)")
        if name == "activate":
            cmd.add_argument("--min-coverage", type=float, default=DEFAULT_MIN_COVERAGE)
    rollback = sub.add_parser("rollback")
    rollback.add_argument("--execute", action="store_true", help="uygula (varsayilan: kuru)")
    cmp = sub.add_parser("compare")
    cmp.add_argument("--model", required=True)
    cmp.add_argument("--sample", type=int, default=50)
    cmp.add_argument("--k", type=int, default=10)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "list":
        with connect() as conn:
            print(json.dumps([row.as_dict() for row in rows(conn)], ensure_ascii=False, indent=2))
            conn.rollback()
        return 0
    if args.command == "compare":
        if not 1 <= args.sample <= 2000 or not 1 <= args.k <= 100:
            print("HATA: 1 <= --sample <= 2000, 1 <= --k <= 100", file=sys.stderr)
            return 2
        try:
            with connect() as conn:
                result = compare(conn, args.model, sample=args.sample, k=args.k)
        except (IndexTransitionError, RegistryError) as error:
            print(f"HATA: {error}", file=sys.stderr)
            return 2
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    min_coverage = getattr(args, "min_coverage", DEFAULT_MIN_COVERAGE)
    if not 0.0 <= min_coverage <= 1.0:
        print("HATA: --min-coverage 0 ile 1 arasinda olmali", file=sys.stderr)
        return 2
    model = getattr(args, "model", None)
    if not args.execute:
        try:
            with connect() as conn:
                plan = run(conn, args.command, model=model, min_coverage=min_coverage)
        except (IndexTransitionError, RegistryError) as error:
            print(f"HATA: {error}", file=sys.stderr)
            return 2
        print(json.dumps({**plan.as_dict(), "dry_run": True}, ensure_ascii=False, indent=2))
        return 0

    with job_run.track(JOB, outcomes=True) as tracked, connect() as conn:
        try:
            plan = run(conn, args.command, model=model, execute=True, min_coverage=min_coverage)
        except (IndexTransitionError, RegistryError) as error:
            tracked.detail.update(action=args.command, model=model)
            tracked.error_summary = str(error)[:300]
            code = tracked.set_outcome("failed", "transition_rejected")
            print(f"HATA: {error}", file=sys.stderr)
            return code
        tracked.detail.update(plan.as_dict())
        changed = bool(plan.changes) or plan.action == "register"
        code = tracked.set_outcome(*(("completed", None) if changed else ("no_input", "unchanged")))
    print(json.dumps(plan.as_dict(), ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
