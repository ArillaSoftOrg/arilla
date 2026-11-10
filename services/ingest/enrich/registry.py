"""Embedding model kayit defteri (karar 0180).

Model kimligi, saglayici, boyut, normalizasyon, on isleme surumu, gorev/onek ve hangi indeks
ailesine yazilabilecegi `model_registry.json` icindedir. Model degistirmek uygulama kodunu
degistirmeyi gerektirmez; yeni bir model once buraya (ve gerekiyorsa yeni indeks ailesine) girer.

Degismez kurallar:

- `id`, veritabanina yazilan `model_version`'dir. Ayni `id` iki farkli vektor uzayini gosteremez.
- Bir model YALNIZCA kendi `index_family`'sinin tablosuna yazilir; boyut ailenin boyutuyla ayni
  olmak zorundadir. Tablosu olmayan aile (`table: null`) yazilabilir degildir (henuz migration yok).
- `pilot`/`disabled` modeller uretim islerinde secilemez; `license_verified=false` olan model
  uretimde etkinlestirilemez.
- Saglayici yalniz destekledigi kipleri bildirebilir (`PROVIDER_MODALITIES`); ornegin yerel ONNX
  ve uzak HTTP saglayici bugun yalniz metin gomer (karar 0182).
- `online_query`: canli istek yolunun (TS) bu modelle sorgu vektoru uretebildigini bildirir.
  `false` olan model `enrich.index activate` ile etkinlestirilemez; aksi halde anlamsal arama
  sessizce kapanirdi (karar 0182). TS beyaz listesiyle parite testi `active-index.test.ts`'tedir.
- `remote_http` saglayicisinin `endpoint` alani zorunludur: adresin okunacagi ortam degiskeni ve
  sunucunun bildirmesi gereken model adi. Adres ve anahtar kayit defterine yazilmaz.

Yukleyici katidir: bilinmeyen ya da eksik alan, tanimsiz aile, cift kimlik -> `RegistryError`.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

REGISTRY_PATH = Path(__file__).with_name("model_registry.json")
REGISTRY_FORMAT = 1

PROVIDERS = frozenset({"jina", "local_onnx", "remote_http"})
STATES = frozenset({"active", "shadow", "pilot", "disabled"})
#: Uretim islerinde secilebilen durumlar.
PRODUCTION_STATES = frozenset({"active", "shadow"})
NORMALIZATIONS = frozenset({"provider_l2", "l2"})
MODALITIES = frozenset({"text", "image"})
ROLES = frozenset({"product_text", "offer_multimodal"})
PURPOSES = frozenset({"passage", "query"})
VECTOR_TYPES = frozenset({"vector", "halfvec"})
#: Saglayici -> gomebildigi kipler. Gorsel bugun yalniz Jina CLIP API'siyle (karar 0015, 0182).
PROVIDER_MODALITIES: Mapping[str, frozenset[str]] = {
    "jina": frozenset({"text", "image"}),
    "local_onnx": frozenset({"text"}),
    "remote_http": frozenset({"text"}),
}
#: Uzak saglayici adresinin okunacagi ortam degiskeni bicimi (ornek `EMBED_QWEN3_06B_URL`).
ENDPOINT_ENV_PATTERN = re.compile(r"^EMBED_[A-Z0-9_]{1,48}_URL$")
_ENDPOINT_FIELDS = frozenset({"url_env", "served_model"})

#: Urun metin isinin secimi icin ortam degiskeni (bos: kayit defterindeki varsayilan).
PRODUCT_TEXT_MODEL_ENV = "ENRICH_PRODUCT_TEXT_MODEL"

_MODEL_FIELDS = frozenset(
    {
        "id",
        "provider",
        "roles",
        "modalities",
        "dimensions",
        "normalization",
        "max_input_tokens",
        "chars_per_token",
        "preprocessing_version",
        "tasks",
        "prefixes",
        "index_family",
        "state",
        "license",
        "license_verified",
        "source",
        "decision",
        "online_query",
    }
)
#: Yalniz bazi saglayicilarda bulunan alanlar (varligi saglayiciyla birlikte denetlenir).
_OPTIONAL_MODEL_FIELDS = frozenset({"endpoint"})
_FAMILY_FIELDS = frozenset({"table", "dimensions", "vector_type"})
_TOP_FIELDS = frozenset({"format", "index_families", "defaults", "models"})


class RegistryError(ValueError):
    """Kayit defteri bozuk ya da istenen secim kurallara aykiri."""


@dataclass(frozen=True)
class IndexFamily:
    name: str
    #: None: depolama sozlesmesi henuz yok (migration gelmeden yazilamaz).
    table: str | None
    dimensions: int
    vector_type: str

    @property
    def writable(self) -> bool:
        return self.table is not None


@dataclass(frozen=True)
class ModelSpec:
    id: str
    provider: str
    roles: tuple[str, ...]
    modalities: tuple[str, ...]
    dimensions: int
    normalization: str
    max_input_tokens: int
    chars_per_token: float
    preprocessing_version: str
    tasks: Mapping[str, str]
    prefixes: Mapping[str, str]
    index_family: str
    state: str
    license: str
    license_verified: bool
    source: Mapping[str, str | None]
    decision: str
    online_query: bool = False
    #: Yalniz `remote_http`: {"url_env": ..., "served_model": ...}.
    endpoint: Mapping[str, str] | None = None

    @property
    def capabilities(self) -> frozenset[str]:
        """Bu kayitla gercekten gomulebilen kipler (bildirilen ∩ saglayicinin destekledigi)."""
        return frozenset(self.modalities) & PROVIDER_MODALITIES[self.provider]

    def same_space(self, other: ModelSpec | str) -> bool:
        """Iki vektor yalniz AYNI model kimligiyle uretildiyse karsilastirilabilir.

        Ayni boyut (ornegin BGE-M3 ile Qwen3-0.6B, ikisi de 1024) ayni uzay demek degildir.
        """
        other_id = other if isinstance(other, str) else other.id
        return self.id == other_id.removesuffix("-fake")

    def task(self, purpose: str) -> str | None:
        _check_purpose(purpose)
        return self.tasks.get(purpose)

    def prefix(self, purpose: str) -> str:
        _check_purpose(purpose)
        return self.prefixes.get(purpose, "")

    @property
    def production_ready(self) -> bool:
        return self.state in PRODUCTION_STATES and self.license_verified


@dataclass(frozen=True)
class Registry:
    families: Mapping[str, IndexFamily]
    models: Mapping[str, ModelSpec]
    defaults: Mapping[str, str]

    def get(self, model_id: str) -> ModelSpec:
        try:
            return self.models[model_id]
        except KeyError:
            raise RegistryError(f"kayit defterinde yok: {model_id!r}") from None

    def family(self, model: ModelSpec | str) -> IndexFamily:
        spec = self.get(model) if isinstance(model, str) else model
        return self.families[spec.index_family]

    def default(self, role: str) -> ModelSpec:
        if role not in self.defaults:
            raise RegistryError(f"rol icin varsayilan model yok: {role!r}")
        return self.get(self.defaults[role])

    def spec_for_version(self, model_version: str) -> ModelSpec | None:
        """Yazilan `model_version` -> kayit. Test istemcilerinin `-fake` eki ana modele baglanir."""
        base = model_version.removesuffix("-fake")
        return self.models.get(base)


def _check_purpose(purpose: str) -> None:
    if purpose not in PURPOSES:
        raise RegistryError(f"bilinmeyen amac: {purpose!r}")


def _require_keys(
    where: str,
    raw: Mapping[str, Any],
    allowed: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> None:
    keys = set(raw)
    unknown = keys - allowed - optional
    missing = allowed - keys
    if unknown:
        raise RegistryError(f"{where}: bilinmeyen alan {sorted(unknown)}")
    if missing:
        raise RegistryError(f"{where}: eksik alan {sorted(missing)}")


def _positive_int(where: str, value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise RegistryError(f"{where}: pozitif tamsayi olmali")
    return value


def _string_map(where: str, value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or not all(
        k in PURPOSES and isinstance(v, str) for k, v in value.items()
    ):
        raise RegistryError(f"{where}: {{passage|query: metin}} olmali")
    return dict(value)


def _parse_family(name: str, raw: Any) -> IndexFamily:
    where = f"index_families.{name}"
    if not isinstance(raw, dict):
        raise RegistryError(f"{where}: nesne olmali")
    _require_keys(where, raw, _FAMILY_FIELDS)
    if raw["vector_type"] not in VECTOR_TYPES:
        raise RegistryError(f"{where}: vector_type gecersiz")
    if raw["table"] is not None and not isinstance(raw["table"], str):
        raise RegistryError(f"{where}: table metin ya da null olmali")
    return IndexFamily(
        name=name,
        table=raw["table"],
        dimensions=_positive_int(where, raw["dimensions"]),
        vector_type=raw["vector_type"],
    )


def _parse_model(raw: Any, families: Mapping[str, IndexFamily]) -> ModelSpec:
    if not isinstance(raw, dict):
        raise RegistryError("models: her girdi nesne olmali")
    where = f"models.{raw.get('id', '?')}"
    _require_keys(where, raw, _MODEL_FIELDS, _OPTIONAL_MODEL_FIELDS)
    model_id = raw["id"]
    if not isinstance(model_id, str) or not model_id or model_id.endswith("-fake"):
        raise RegistryError(f"{where}: gecersiz kimlik")
    checks = (
        (raw["provider"] in PROVIDERS, "provider"),
        (raw["state"] in STATES, "state"),
        (raw["normalization"] in NORMALIZATIONS, "normalization"),
        (isinstance(raw["roles"], list) and set(raw["roles"]) <= ROLES and raw["roles"], "roles"),
        (
            isinstance(raw["modalities"], list)
            and set(raw["modalities"]) <= MODALITIES
            and raw["modalities"],
            "modalities",
        ),
        (isinstance(raw["license_verified"], bool), "license_verified"),
        (isinstance(raw["online_query"], bool), "online_query"),
        (isinstance(raw["preprocessing_version"], str), "preprocessing_version"),
        (isinstance(raw["license"], str), "license"),
        (isinstance(raw["decision"], str), "decision"),
        (isinstance(raw["source"], dict), "source"),
        (
            isinstance(raw["chars_per_token"], int | float) and raw["chars_per_token"] > 0,
            "chars_per_token",
        ),
    )
    for ok, name in checks:
        if not ok:
            raise RegistryError(f"{where}: {name} gecersiz")
    unsupported = set(raw["modalities"]) - PROVIDER_MODALITIES[raw["provider"]]
    if unsupported:
        raise RegistryError(
            f"{where}: {raw['provider']} saglayicisi {sorted(unsupported)} kipini desteklemiyor"
        )
    endpoint = _parse_endpoint(where, raw["provider"], raw.get("endpoint"))
    family = families.get(raw["index_family"])
    if family is None:
        raise RegistryError(f"{where}: tanimsiz indeks ailesi {raw['index_family']!r}")
    dimensions = _positive_int(f"{where}.dimensions", raw["dimensions"])
    if dimensions != family.dimensions:
        raise RegistryError(
            f"{where}: boyut {dimensions}, aile {family.name} boyutu {family.dimensions}"
        )
    return ModelSpec(
        id=model_id,
        provider=raw["provider"],
        roles=tuple(raw["roles"]),
        modalities=tuple(raw["modalities"]),
        dimensions=dimensions,
        normalization=raw["normalization"],
        max_input_tokens=_positive_int(f"{where}.max_input_tokens", raw["max_input_tokens"]),
        chars_per_token=float(raw["chars_per_token"]),
        preprocessing_version=raw["preprocessing_version"],
        tasks=_string_map(f"{where}.tasks", raw["tasks"]),
        prefixes=_string_map(f"{where}.prefixes", raw["prefixes"]),
        index_family=family.name,
        state=raw["state"],
        license=raw["license"],
        license_verified=raw["license_verified"],
        source=dict(raw["source"]),
        decision=raw["decision"],
        online_query=raw["online_query"],
        endpoint=endpoint,
    )


def _parse_endpoint(where: str, provider: str, raw: Any) -> dict[str, str] | None:
    """`remote_http` icin zorunlu, digerlerinde yasak. Adres degil, adresin ENV adi tutulur."""
    if provider != "remote_http":
        if raw is not None:
            raise RegistryError(f"{where}: endpoint yalniz remote_http saglayicisinda olur")
        return None
    if not isinstance(raw, dict):
        raise RegistryError(f"{where}: remote_http icin endpoint zorunlu")
    _require_keys(f"{where}.endpoint", raw, _ENDPOINT_FIELDS)
    url_env, served = raw["url_env"], raw["served_model"]
    if not isinstance(url_env, str) or not ENDPOINT_ENV_PATTERN.match(url_env):
        raise RegistryError(f"{where}.endpoint.url_env: EMBED_<AD>_URL biciminde olmali")
    if not isinstance(served, str) or not served.strip():
        raise RegistryError(f"{where}.endpoint.served_model: bos olamaz")
    return {"url_env": url_env, "served_model": served}


def parse_registry(raw: Any) -> Registry:
    if not isinstance(raw, dict):
        raise RegistryError("kayit defteri nesne olmali")
    _require_keys("kok", raw, _TOP_FIELDS)
    if raw["format"] != REGISTRY_FORMAT:
        raise RegistryError(f"desteklenmeyen bicim: {raw['format']!r}")
    if not isinstance(raw["index_families"], dict) or not isinstance(raw["models"], list):
        raise RegistryError("index_families nesne, models liste olmali")
    families = {name: _parse_family(name, value) for name, value in raw["index_families"].items()}
    tables: dict[tuple[str, int], str] = {}
    for family in families.values():
        if family.table is not None:
            key = (family.table, family.dimensions)
            if key in tables:
                raise RegistryError(f"iki aile ayni tabloyu gosteriyor: {family.table}")
            tables[key] = family.name
    models: dict[str, ModelSpec] = {}
    for item in raw["models"]:
        spec = _parse_model(item, families)
        if spec.id in models:
            raise RegistryError(f"cift kimlik: {spec.id}")
        models[spec.id] = spec
    defaults = raw["defaults"]
    if not isinstance(defaults, dict):
        raise RegistryError("defaults nesne olmali")
    for role, model_id in defaults.items():
        spec = models.get(model_id)
        if role not in ROLES or spec is None or role not in spec.roles:
            raise RegistryError(f"defaults.{role}: gecersiz model {model_id!r}")
        if not spec.production_ready or not families[spec.index_family].writable:
            raise RegistryError(f"defaults.{role}: uretime hazir ve yazilabilir olmali")
    return Registry(families=families, models=models, defaults=dict(defaults))


def load_registry(path: Path = REGISTRY_PATH) -> Registry:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RegistryError(f"kayit defteri okunamadi: {error}") from error
    return parse_registry(raw)


@lru_cache(maxsize=1)
def registry() -> Registry:
    """Paketle gelen kayit defteri (surec boyunca bir kez okunur)."""
    return load_registry()


def select_model(
    role: str,
    *,
    requested: str | None = None,
    env: Mapping[str, str] | None = None,
    env_name: str = PRODUCT_TEXT_MODEL_ENV,
    allow_pilot: bool = False,
    reg: Registry | None = None,
) -> ModelSpec:
    """Rol icin modeli secer: acik istek > ortam degiskeni > kayit defteri varsayilani.

    `allow_pilot=False` (uretim): yalnizca `active`/`shadow` ve lisansi dogrulanmis modeller.
    """
    reg = reg or registry()
    source = env if env is not None else os.environ
    chosen = (requested or source.get(env_name, "") or "").strip()
    spec = reg.get(chosen) if chosen else reg.default(role)
    if role not in spec.roles:
        raise RegistryError(f"{spec.id}: {role} rolu icin tanimli degil")
    if spec.state == "disabled":
        raise RegistryError(f"{spec.id}: devre disi")
    if not allow_pilot and not spec.production_ready:
        raise RegistryError(
            f"{spec.id}: uretimde secilemez (durum {spec.state}, "
            f"lisans {'dogrulandi' if spec.license_verified else 'dogrulanmadi'})"
        )
    return spec


def require_writable(spec: ModelSpec, family_name: str, *, reg: Registry | None = None) -> None:
    """Modelin vektorleri `family_name` tablosuna yazilabilir mi? Degilse `RegistryError`.

    Farkli boyut/uzaydaki vektorlerin ayni tabloya karismasini engelleyen tek kapi.
    """
    reg = reg or registry()
    family = reg.families.get(family_name)
    if family is None:
        raise RegistryError(f"tanimsiz indeks ailesi: {family_name!r}")
    if spec.index_family != family_name:
        raise RegistryError(
            f"{spec.id} ({spec.dimensions} boyut, {spec.index_family}) "
            f"{family_name} ailesine yazilamaz"
        )
    if not family.writable:
        raise RegistryError(f"{family_name}: depolama tablosu yok (migration gerekli)")
