"""Hibrit kategori onerisi (karar 0155): V5 + dinamik motor + e5-small anlamsal adaylar.

YALNIZCA ONERI uretir; urun kategorisi YAZILMAZ ve V5/dinamik karari degismez. Uretim:
1. Kaynak kategori -> Trendyol bolgeleri (`dynamic.regions_for`): adaylar bu dallarla SINIRLANIR.
   Bolge yoksa aday uretilmez (inceleme).
2. Baslik (`query: `) ile kategori tam yolu / yaprak adi (`passage: `) kosinus benzerligi, kategori
   basina z-skorla duzeltilir (hubness: "sweatshirt" gibi dugumler her seye yakin cikar).
3. Cihaz/aksesuar/yedek parca ve oyuncak/gercek urun ayrimi icin kucuk, aciklanabilir cezalar.
4. Dinamik motorun `match` adayi (kural kaniti) once gelir; gomme adaylariyla ayni dalda
   uyusuyorsa `guclu`, tek basina ise `orta`, aksi halde `inceleme`.
En fazla 3 aday, her biri gerekceyle. Kanit yetersizse durum `inceleme`dir.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from classify.categories import is_within
from classify.dynamic import PART_HINTS, DynamicIndex, regions_for
from classify.suggest.model import PASSAGE_PREFIX, QUERY_PREFIX, Embedder
from classify.text import words

#: Oneri kurallari/esikleri surumu: cikti dosyalarina yazilir, degisince yeniden hesaplanir.
SUGGEST_VERSION = 1
MAX_CANDIDATES = 3
#: Bolge icinde degerlendirilen gomme adayi sayisi (birlesimden once).
POOL = 12
#: Gomme tek basina `orta` sayilmak icin: en iyi z ve baska daldaki rakiple fark. Esikler AI
#: etiketlerinin (insan degil) ilk 400'luk orneginde ayarlandi (ornek-ici); bkz. karar 0155.
OK_Z = 2.0
OK_MARGIN = 0.6
PART_PENALTY = 1.5
TOY_PENALTY = 1.0
#: Basligin parca/aksesuar oldugunu soyleyen sozcukler (genel "kit", "for" bilerek yok).
PART_TITLE_WORDS = frozenset(
    set(PART_HINTS) - {"kit", "mini"}
    | {"parts", "holder", "strap", "charger", "cable", "battery", "protector", "bracket", "mount"}
)
TOY_WORDS = frozenset(
    {"toy", "plush", "doll", "figure", "figurine", "puzzle", "diecast", "stuffed", "playset"}
)


@dataclass(frozen=True)
class CategoryRow:
    id: int
    path: str
    name: str


def tree_version(rows: Sequence[CategoryRow]) -> str:
    """Kategori agacinin parmak izi: (id, yol, ad) satirlarinin SHA-256'si (ilk 16 hex)."""
    digest = hashlib.sha256()
    for r in sorted(rows, key=lambda r: r.id):
        digest.update(f"{r.id}|{r.path}|{r.name}\n".encode())
    return digest.hexdigest()[:16]


def _chain(path: str, names: dict[str, str], last: int = 3) -> str:
    parts = path.split("/")
    chain = [names.get("/".join(parts[: i + 1]), parts[i]) for i in range(len(parts))]
    return " > ".join(chain[-last:])


def name_path(path: str, names: dict[str, str]) -> str:
    """Tam hiyerarsik yol, kategori adlariyla (gerekce/disa aktarim)."""
    return _chain(path, names, last=len(path.split("/")))


@dataclass
class TreeIndex:
    """Kategori gommeleri + z-skor istatistigi. `model_version`/`tree_version` ile etiketli."""

    model_version: str
    tree_version: str
    ids: list[int]
    paths: list[str]
    names: dict[str, str]
    ep: np.ndarray  # yol metni gommeleri
    el: np.ndarray  # yaprak ad gommeleri
    mean: np.ndarray | None = None
    std: np.ndarray | None = None
    calibration_n: int = 0

    @classmethod
    def build(cls, rows: Sequence[CategoryRow], passage: Embedder) -> TreeIndex:
        rows = sorted(rows, key=lambda r: r.path)
        names = {r.path: r.name for r in rows}
        ep = passage.encode([_chain(r.path, names) for r in rows])
        el = passage.encode([r.name for r in rows])
        return cls(
            model_version=passage.model_version,
            tree_version=tree_version(rows),
            ids=[r.id for r in rows],
            paths=[r.path for r in rows],
            names=names,
            ep=ep,
            el=el,
        )

    def similarity(self, e: np.ndarray) -> np.ndarray:
        return (e @ self.ep.T + e @ self.el.T) / 2

    def calibrate(self, query_embeddings: np.ndarray) -> None:
        s = self.similarity(query_embeddings)
        self.mean = s.mean(axis=0)
        self.std = s.std(axis=0) + 1e-6
        self.calibration_n = int(len(query_embeddings))

    def save(self, path: Path) -> None:
        np.savez_compressed(
            path,
            meta=json.dumps(
                {
                    "model_version": self.model_version,
                    "tree_version": self.tree_version,
                    "calibration_n": self.calibration_n,
                    "suggest_version": SUGGEST_VERSION,
                }
            ),
            ids=np.array(self.ids, dtype=np.int64),
            paths=np.array(self.paths),
            names_k=np.array(list(self.names)),
            names_v=np.array(list(self.names.values())),
            ep=self.ep,
            el=self.el,
            mean=self.mean if self.mean is not None else np.zeros(0),
            std=self.std if self.std is not None else np.zeros(0),
        )

    @classmethod
    def load(cls, path: Path, *, model_version: str, tree_ver: str) -> TreeIndex | None:
        """Onbellek gecerliyse (model + agac + kural surumu ayni) yukler; degilse None."""
        if not path.is_file():
            return None
        z = np.load(path, allow_pickle=False)
        meta = json.loads(str(z["meta"]))
        if (
            meta["model_version"] != model_version
            or meta["tree_version"] != tree_ver
            or meta["suggest_version"] != SUGGEST_VERSION
        ):
            return None
        idx = cls(
            model_version=meta["model_version"],
            tree_version=meta["tree_version"],
            ids=[int(i) for i in z["ids"]],
            paths=[str(p) for p in z["paths"]],
            names=dict(
                zip((str(k) for k in z["names_k"]), (str(v) for v in z["names_v"]), strict=True)
            ),
            ep=z["ep"],
            el=z["el"],
            calibration_n=int(meta["calibration_n"]),
        )
        if len(z["mean"]):
            idx.mean, idx.std = z["mean"], z["std"]
        return idx


@dataclass(frozen=True)
class Candidate:
    category_id: int
    path: str
    name_path: str
    z: float | None
    cosine: float | None
    source: str  # 'dinamik' | 'embedding' | 'ikisi'
    rationale: str


@dataclass(frozen=True)
class Suggestion:
    status: str  # 'guclu' | 'orta' | 'inceleme'
    reason: str
    candidates: tuple[Candidate, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class Item:
    title: str
    source_raw: str | None


def _related(a: str, b: str) -> bool:
    return is_within(a, b) or is_within(b, a)


class Suggester:
    def __init__(
        self,
        index: TreeIndex,
        dyn: DynamicIndex,
        query: Embedder,
        *,
        guards: bool = True,
        use_dynamic: bool = True,
    ) -> None:
        if index.mean is None or index.std is None:
            raise ValueError("TreeIndex kalibre edilmemis (z-skor istatistigi yok)")
        self.index = index
        self.dyn = dyn
        self.query = query
        self.guards = guards
        self.use_dynamic = use_dynamic
        self._pos = {p: i for i, p in enumerate(index.paths)}
        n = len(index.paths)
        self._eligible = np.zeros(n, dtype=bool)
        self._part = np.zeros(n, dtype=bool)
        self._toy = np.zeros(n, dtype=bool)
        for path, node in dyn.nodes.items():
            i = self._pos.get(path)
            if (
                i is None
                or node.depth < 2
                or "diger" in node.name.lower().replace("ğ", "g").split()
            ):
                continue
            self._eligible[i] = True
            self._part[i] = node.part
            self._toy[i] = "oyuncak" in path or "maket" in path
        self._region_masks: dict[tuple[str, ...], np.ndarray] = {}

    def _mask(self, regions: tuple[str, ...]) -> np.ndarray:
        mask = self._region_masks.get(regions)
        if mask is None:
            mask = np.array(
                [any(is_within(p, r) for r in regions) for p in self.index.paths], dtype=bool
            )
            mask &= self._eligible
            self._region_masks[regions] = mask
        return mask

    def suggest(self, items: Sequence[Item]) -> list[Suggestion]:
        if not items:
            return []
        queries = self.query.encode([i.title for i in items])
        sims = self.index.similarity(queries)
        zs = (sims - self.index.mean) / self.index.std
        return [self._one(item, sims[k], zs[k]) for k, item in enumerate(items)]

    def _one(self, item: Item, sim: np.ndarray, z: np.ndarray) -> Suggestion:
        regions = regions_for(item.source_raw)
        if not regions:
            return Suggestion("inceleme", "kaynak_bolgesi_yok")
        mask = self._mask(regions)
        if not mask.any():
            return Suggestion("inceleme", "bolgede_aday_yok")
        title_words = set(words(item.title))
        adj = z.copy()
        part_title = toy_title = False
        if self.guards:
            part_title = bool(title_words & PART_TITLE_WORDS)
            toy_title = bool(title_words & TOY_WORDS)
            if part_title:
                adj[~self._part] -= PART_PENALTY
            if toy_title:
                adj[~self._toy] -= TOY_PENALTY
        masked = np.where(mask, adj, -1e9)
        top = np.argsort(-masked)[:POOL]
        emb = [(int(i), float(adj[i])) for i in top if masked[i] > -1e8]

        guess = self.dyn.guess(item.title, item.source_raw) if self.use_dynamic else None
        dyn_path = guess.path if guess is not None and guess.kind == "match" else None
        chosen: list[Candidate] = []
        agree = False
        if dyn_path:
            near = [
                (i, v) for i, v in emb[:MAX_CANDIDATES] if _related(self.index.paths[i], dyn_path)
            ]
            agree = bool(near)
            chosen.append(
                self._cand(dyn_path, "ikisi" if agree else "dinamik", z, sim, guess, (False, False))
            )
        for i, _v in emb:
            if len(chosen) >= MAX_CANDIDATES:
                break
            path = self.index.paths[i]
            if any(_related(path, c.path) for c in chosen):
                continue
            chosen.append(self._cand(path, "embedding", z, sim, None, (part_title, toy_title)))
        if not chosen:
            return Suggestion("inceleme", "aday_yok")
        top_z = emb[0][1] if emb else 0.0
        top_path = self.index.paths[emb[0][0]] if emb else ""
        # Fark: en iyi aday ile ONUNLA AYNI DALDA OLMAYAN ilk rakip (alt/ust dugum rakip degildir).
        rival = next((v for i, v in emb[1:] if not _related(self.index.paths[i], top_path)), -9.0)
        margin = top_z - rival
        if dyn_path and agree:
            return Suggestion("guclu", "kural_ve_anlamsal_uyum", tuple(chosen))
        if dyn_path:
            return Suggestion("orta", "yalniz_kural_kaniti", tuple(chosen))
        if emb and top_z >= OK_Z and margin >= OK_MARGIN:
            return Suggestion("orta", "yalniz_anlamsal_kanit", tuple(chosen))
        return Suggestion("inceleme", "yetersiz_kanit", tuple(chosen))

    def _cand(
        self,
        path: str,
        source: str,
        z: np.ndarray,
        sim: np.ndarray,
        guess,  # noqa: ANN001 - DynamicGuess
        flags: tuple[bool, bool],
    ) -> Candidate:
        i = self._pos[path]
        parts = [f"yol: {name_path(path, self.index.names)}"]
        if source in ("dinamik", "ikisi") and guess is not None:
            parts.append(f"kural: {';'.join(guess.evidence)}")
        parts.append(f"anlamsal z={z[i]:.2f} kosinus={sim[i]:.3f}")
        if source == "ikisi":
            parts.append("kural ve anlamsal ayni dalda")
        penalties = []
        if flags[0] and not self._part[i]:
            penalties.append("parca_basligi_cihaz_dugumu")
        if flags[1] and not self._toy[i]:
            penalties.append("oyuncak_basligi_oyuncak_disi_dugum")
        if penalties:
            parts.append("ceza: " + ",".join(penalties))
        return Candidate(
            category_id=self.index.ids[i],
            path=path,
            name_path=name_path(path, self.index.names),
            z=round(float(z[i]), 3),
            cosine=round(float(sim[i]), 4),
            source=source,
            rationale=" | ".join(parts),
        )


def calibration_titles(titles: Sequence[str], query: Embedder) -> np.ndarray:
    return query.encode(list(titles))


__all__ = [
    "PASSAGE_PREFIX",
    "QUERY_PREFIX",
    "SUGGEST_VERSION",
    "Candidate",
    "CategoryRow",
    "Item",
    "Suggester",
    "Suggestion",
    "TreeIndex",
    "name_path",
    "tree_version",
]
