"""Iki asamali kategori sonucu (karar 0157): kaynak ust eslemesi + hibrit oneri -> urun karari.

YALNIZCA DOSYA uretir; urun kategorisi YAZILMAZ, veritabanina baglanilmaz. Yeni model yok:
1. Asama 1 (`data/source_parent_map.tsv`): kaynak yolu -> guvenilir ust kategori (`yuksek`),
   ortak ust yok (`inceleme`) ya da urun degil/karsiliksiz (`eslesmedi`). AI onerisidir,
   `confirmed` degildir.
2. Asama 2: hibrit motorun (karar 0155) ilk adayi su kosullarda ALT kategori olur: durum
   `guclu`/`orta`, adayda cihaz/parca/oyuncak cezasi yok, aday guvenilir ustun icinde. Kaynak
   ustu belirsizse ya da V5 baslik-kaynak celiskisi (`conflict`) varsa yalniz `guclu` (kural +
   anlamsal ayni dalda) kabul edilir. Aksi halde guvenilir ustte kalinir; celiskide ya da ust
   yoksa `belirsiz` (zorla yerlestirme yok).
3. Mevcut `product.category_id` (yonetici/besleme/onceki is) korunur: `korunan`.

Cikti parca parca (`parca_NNNNN.tsv`, girdi sirasiyla `--shard` urun); her parca gecici dosyaya
yazilip yeniden adlandirilir ve `state.json`a islenir. Yeniden calistirma biten parcalari atlar;
hibrit kosunun kontrol noktasini (`last_id`) asan parca yazilmaz (bitmemis is bitmis gosterilmez).
"""

from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

from classify.categories import is_within
from classify.text import path_norm

DATA = Path(__file__).resolve().parents[1] / "data"
MAP_FILE = DATA / "source_parent_map.tsv"
#: Karar kurallari surumu: degisince eski parcalarla devam reddedilir.
FINALIZE_VERSION = 1
STATES = ("yuksek", "inceleme", "eslesmedi")
COLUMNS = (
    "product_id",
    "category_id",
    "category_path",
    "category_name_path",
    "seviye",
    "karar_kaynagi",
    "hibrit_durum",
    "kaynak_yolu",
    "kaynak_durumu",
    "kaynak_ust_yolu",
    "v5_yolu",
    "v5_dayanak",
    "adaylar",
)


@dataclass(frozen=True)
class SourceParent:
    source: str
    state: str
    path: str | None
    hint: str | None
    rationale: str


@dataclass(frozen=True)
class Final:
    category_path: str | None
    level: str  # 'alt' | 'ust' | 'belirsiz' | 'korunan'
    basis: str
    category_id: int | None = None


def load_source_map(path: Path = MAP_FILE) -> dict[str, SourceParent]:
    """path_norm(kaynak yolu) -> karar. Bicim bozuksa ya da yol iki kez yazildiysa hata."""
    out: dict[str, SourceParent] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        source, state, cat, hint, why = line.split("\t")
        if state not in STATES or (state == "yuksek") != bool(cat):
            raise ValueError(f"gecersiz esleme satiri: {line!r}")
        key = path_norm(source)
        if key in out:
            raise ValueError(f"kaynak yolu iki kez: {source!r}")
        out[key] = SourceParent(source, state, cat or None, hint or None, why)
    return out


def source_map_version(path: Path = MAP_FILE) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def _penalized(candidate: Mapping[str, object]) -> bool:
    return "ceza:" in str(candidate.get("rationale", ""))


def decide_final(
    *,
    current_path: str | None,
    parent: SourceParent | None,
    suggestion: Mapping[str, object] | None,
    v5_basis: str | None,
) -> Final:
    """Tek urunun nihai karari. Saf fonksiyon: ayni girdi her zaman ayni sonucu verir."""
    if current_path:
        return Final(current_path, "korunan", "mevcut_kategori")
    if parent is None:
        return Final(None, "belirsiz", "kaynak_eslemesi_yok")
    if parent.state == "eslesmedi":
        return Final(None, "belirsiz", "kaynak_eslesmedi")
    status = suggestion.get("status") if suggestion else None
    candidates = list(suggestion.get("candidates") or []) if suggestion else []
    top = candidates[0] if candidates else None
    ok = top is not None and status in ("guclu", "orta") and not _penalized(top)
    conflict = v5_basis == "conflict"
    # Kaynak ustu belirsizse ya da V5 baslik-kaynak celiskisi varsa yalniz `guclu` (kural +
    # anlamsal ayni dalda) kabul edilir; celiskide guvenilir uste DUSULMEZ (baslik yalanlayabilir).
    if ok and (parent.path is None or conflict):
        ok = status == "guclu"
    if conflict and not ok:
        return Final(None, "belirsiz", "baslik_kaynak_celiskisi")
    if ok and parent.path and not is_within(str(top["path"]), parent.path):
        return Final(None, "belirsiz", "aday_kaynak_ustu_disinda")
    if ok:
        level = "ust" if str(top["path"]) == parent.path else "alt"
        basis = f"hibrit_{status}" + ("_v5_celiskili" if conflict else "")
        return Final(str(top["path"]), level, basis, int(top["category_id"]))
    if parent.path:
        if top is None:
            why = "hibrit_aday_yok"
        elif _penalized(top) and status in ("guclu", "orta"):
            why = "aday_tur_cezali"
        else:
            why = f"hibrit_{status}"
        return Final(parent.path, "ust", f"kaynak_ust:{why}")
    if top is not None and status == "orta":
        return Final(None, "belirsiz", "kaynak_belirsiz_aday_orta")
    return Final(None, "belirsiz", "kaynak_belirsiz_kanit_yetersiz")


@dataclass(frozen=True)
class Category:
    id: int
    path: str
    name: str


def load_categories(path: str | Path) -> dict[str, Category]:
    with open(path, encoding="utf-8") as f:
        return {r["path"]: Category(int(r["id"]), r["path"], r["name"]) for r in csv.DictReader(f)}


def name_path(path: str, cats: Mapping[str, Category]) -> str:
    parts = path.split("/")
    return " > ".join(
        cats["/".join(parts[: i + 1])].name if "/".join(parts[: i + 1]) in cats else parts[i]
        for i in range(len(parts))
    )


def validate_source_map(smap: Mapping[str, SourceParent], cats: Mapping[str, Category]) -> None:
    missing = [
        p.path or p.hint
        for p in smap.values()
        if (p.path and p.path not in cats) or (p.hint and p.hint not in cats)
    ]
    if missing:
        raise ValueError(f"esleme agacta olmayan yol iceriyor: {missing[:5]}")


def hybrid_checkpoint(run_dir: Path) -> tuple[int, int]:
    """Hibrit kosunun (karar 0155) kontrol noktasi: (son urun kimligi, gecerli cikti bayti)."""
    db = sqlite3.connect(f"file:{run_dir / 'state.sqlite'}?mode=ro", uri=True)
    try:
        meta = dict(db.execute("SELECT k, v FROM meta").fetchall())
    finally:
        db.close()
    return int(meta.get("last_id", 0)), int(meta.get("out_bytes", 0))


def _suggestions(run_dir: Path, limit_bytes: int) -> Iterator[dict]:
    """Kontrol noktasina kadar (yarim satir okunmaz) oneriler, urun kimligi sirasiyla."""
    with open(run_dir / "suggestions.jsonl", "rb") as f:
        read = 0
        for raw in f:
            read += len(raw)
            if read > limit_bytes:
                return
            yield json.loads(raw)


def _items(path: str | Path) -> Iterator[tuple[int, str, str]]:
    with open(path, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            yield int(p[0]), p[1] if len(p) > 1 else "", p[2] if len(p) > 2 else ""


def _current(path: str | Path | None, by_id: Mapping[int, Category]) -> dict[int, str]:
    if not path:
        return {}
    out: dict[int, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            pid, _, cid = line.rstrip("\n").partition("\t")
            if cid and int(cid) in by_id:
                out[int(pid)] = by_id[int(cid)].path
    return out


def source_table(
    smap: Mapping[str, SourceParent], cats: Mapping[str, Category], counts: Counter[str]
) -> list[dict[str, object]]:
    """Asama 1 tablosu: her kaynak yolu tam bir satir (kimlik, tam yol, gerekce, urun sayisi)."""
    from classify.dynamic import regions_for

    rows = []
    for key, p in sorted(smap.items(), key=lambda kv: (-counts[kv[0]], kv[1].source)):
        cat = cats.get(p.path) if p.path else None
        hint = cats.get(p.hint) if p.hint else None
        rows.append(
            {
                "kaynak_yolu": p.source,
                "urun_sayisi": counts[key],
                "durum": p.state,
                "kategori_id": cat.id if cat else "",
                "kategori_yolu": p.path or "",
                "kategori_ad_yolu": name_path(p.path, cats) if p.path else "",
                "aday_id": hint.id if hint else "",
                "aday_ad_yolu": name_path(p.hint, cats) if p.hint else "",
                "motor_bolgeleri": ",".join(regions_for(p.source)),
                "gerekce": p.rationale,
                "dogrulama": "AI onerisi (insan dogrulamasi yok)",
            }
        )
    return rows


def finalize(
    *,
    run_dir: str | Path,
    items_tsv: str | Path,
    categories_csv: str | Path,
    dest: str | Path,
    current_tsv: str | Path | None = None,
    shard: int = 100_000,
    v5: bool = True,
    source_map: Path = MAP_FILE,
) -> dict[str, object]:
    """Biten hibrit sonuclarini parca parca nihai karara cevirir; yeniden baslatilabilir."""
    from classify.evaluate import LabeledRow, decide_row

    run_dir, dest = Path(run_dir), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    cats = load_categories(categories_csv)
    by_id = {c.id: c for c in cats.values()}
    smap = load_source_map(source_map)
    validate_source_map(smap, cats)
    current = _current(current_tsv, by_id)
    last_id, out_bytes = hybrid_checkpoint(run_dir)
    versions = {"finalize": FINALIZE_VERSION, "kaynak_esleme": source_map_version(source_map)}
    state_path = dest / "state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    if state and state.get("versions", {}).get("finalize") != FINALIZE_VERSION:
        raise SystemExit("farkli karar surumu; yeni --dest kullanin")
    if state and state.get("versions") != versions:
        raise SystemExit("kaynak eslemesi degisti; yeni --dest kullanin")
    done: dict[str, dict] = state.get("parcalar", {})
    counts: Counter[str] = Counter()
    sugg = _suggestions(run_dir, out_bytes)
    rec = next(sugg, None)
    v5_cache: dict = {}
    shard_no, buf, pending, written = 0, [], False, 0
    stop = False

    def flush(no: int, rows: list[list[str]], summary: Counter[str]) -> None:
        name = f"parca_{no:05d}.tsv"
        tmp = dest / (name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter="\t", lineterminator="\n")
            w.writerow(COLUMNS)
            w.writerows(rows)
        tmp.replace(dest / name)
        done[str(no)] = {
            "dosya": name,
            "urun": len(rows),
            "son_urun_id": int(rows[-1][0]),
            **summary,
        }
        state.update(versions=versions, parcalar=done)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    summary: Counter[str] = Counter()
    for index, (pid, title, source) in enumerate(_items(items_tsv)):
        counts[path_norm(source)] += 1
        if index and index % shard == 0:
            if pending:
                flush(shard_no, buf, summary)
                written += 1
            shard_no, buf, pending, summary = shard_no + 1, [], False, Counter()
        if stop or str(shard_no) in done:
            continue
        if pid > last_id:
            stop, pending = True, False  # hibrit bu urune ulasmadi: parca yazilmaz
            continue
        while rec is not None and rec["product_id"] < pid:
            rec = next(sugg, None)
        h = rec if rec is not None and rec["product_id"] == pid else None
        if h is not None and state.setdefault("hibrit_surum", h.get("v")) != h.get("v"):
            raise SystemExit("hibrit oneri surumu degisti; yeni --dest kullanin")
        v5d = decide_row(LabeledRow(str(pid), title, source, None, None), v5_cache) if v5 else None
        parent = smap.get(path_norm(source))
        f = decide_final(
            current_path=current.get(pid),
            parent=parent,
            suggestion=h,
            v5_basis=v5d.category_basis if v5d else None,
        )
        cat = cats.get(f.category_path) if f.category_path else None
        cands = (h or {}).get("candidates") or []
        buf.append(
            [
                str(pid),
                str(cat.id) if cat else "",
                f.category_path or "",
                name_path(f.category_path, cats) if f.category_path else "",
                f.level,
                f.basis,
                (h or {}).get("status", "kayit_yok"),
                source,
                parent.state if parent else "yok",
                (parent.path or "") if parent else "",
                (v5d.category_path or "") if v5d else "",
                v5d.category_basis if v5d else "",
                ";".join(f"{c['category_id']}:{c['path']}" for c in cands),
            ]
        )
        summary[f.level] += 1
        pending = True
    if pending and not stop:
        flush(shard_no, buf, summary)
        written += 1
    total = Counter()
    for part in done.values():
        for k in ("alt", "ust", "belirsiz", "korunan"):
            total[k] += int(part.get(k, 0))
    n_items = sum(counts.values())
    processed = sum(int(p["urun"]) for p in done.values())
    with open(dest / "kaynak_eslesme.csv", "w", encoding="utf-8", newline="") as f:
        table = source_table(smap, cats, counts)
        w = csv.DictWriter(f, fieldnames=list(table[0]))
        w.writeheader()
        w.writerows(table)
    result = {
        "durum": "bitti" if processed == n_items else "suruyor",
        "girdi_urun": n_items,
        "islenen_urun": processed,
        "hibrit_kontrol_noktasi_son_urun_id": last_id,
        "bu_calismada_yazilan_parca": written,
        "tamamlanan_parca": len(done),
        "seviye": dict(total),
    }
    state["ozet"] = result
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
