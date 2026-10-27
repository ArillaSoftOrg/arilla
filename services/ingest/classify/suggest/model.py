"""multilingual-e5-small ONNX INT8: kaynak/surum/butunluk dogrulamasi ve CPU gomme (embedding).

Model YALNIZCA arka plan toplu isinde calisir (karar 0155); web istek yolunda yuklenmez.
Calisma zamani bagimliligi yalniz `onnxruntime`, `tokenizers`, `numpy` (torch YOK); modeli ureten
`build_model` gelistirici araci olup `sentence-transformers` + `optimum` ister (tembel ice aktarim).

Butunluk: model dizini `manifest.json` tasir; yukleyici (1) manifestin kaynak depo/surumunun kodda
sabitlenmis degerlerle ayni oldugunu, (2) her dosyanin SHA-256'sinin hem manifestle hem kodda
sabitlenmis beklenen degerle ayni oldugunu dogrular. Uyusmazlikta yuklemeyi REDDEDER.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

SOURCE_REPO = "intfloat/multilingual-e5-small"
#: Hugging Face deposundaki degismez commit (dal degil): kaynak surumu.
SOURCE_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
MODEL_FILE = "model_qint8_avx512_vnni.onnx"
TOKENIZER_FILE = "tokenizer.json"
#: Beklenen dosya ozetleri. Tokenizer, kaynak depodaki dosyayla ayni; INT8 dosya `build_model`
#: ciktisidir (arac surumleri manifestte). Arac surumu degisip ozet degisirse bu sabit bir karar
#: (docs/decisions) ile guncellenir; sessizce kabul edilmez.
EXPECTED_SHA256 = {
    MODEL_FILE: "0bcc8ca76950ff46dcee56246e816fadada7ae06d50bc910e84e2d4f1cdf332c",
    TOKENIZER_FILE: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
}
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "
MAX_LENGTH = 64
DIM = 384
MANIFEST_FORMAT = 1


class ModelError(RuntimeError):
    """Model dizini eksik, bozuk ya da beklenen surum/ozetle uyusmuyor."""


class Embedder(Protocol):
    """Metin -> birim uzunlukta (L2) float32 vektorler. Onek cagiranda eklenir."""

    model_version: str

    def encode(self, texts: Sequence[str]) -> object: ...


@dataclass(frozen=True)
class Manifest:
    model_version: str
    source_repo: str
    source_revision: str
    files: dict[str, dict[str, object]]
    tooling: dict[str, str]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_dir(model_dir: str | Path) -> Manifest:
    """Dizini manifest ve kodda sabitlenmis degerlerle dogrular; `Manifest` dondurur."""
    root = Path(model_dir)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ModelError(f"manifest.json yok: {root}")
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ModelError(f"manifest.json bozuk: {exc}") from exc
    if raw.get("format") != MANIFEST_FORMAT:
        raise ModelError(f"manifest bicimi desteklenmiyor: {raw.get('format')!r}")
    if raw.get("source_repo") != SOURCE_REPO or raw.get("source_revision") != SOURCE_REVISION:
        raise ModelError("manifest kaynak deposu/surumu beklenenle ayni degil")
    files = raw.get("files") or {}
    for name, expected in EXPECTED_SHA256.items():
        entry = files.get(name)
        path = root / name
        if entry is None or not path.is_file():
            raise ModelError(f"dosya eksik: {name}")
        actual = sha256_file(path)
        if actual != expected:
            raise ModelError(f"{name}: SHA-256 beklenenle ayni degil ({actual[:12]}...)")
        if entry.get("sha256") != actual:
            raise ModelError(f"{name}: manifestteki ozet dosyayla ayni degil")
    return Manifest(
        model_version=str(raw["model_version"]),
        source_repo=SOURCE_REPO,
        source_revision=SOURCE_REVISION,
        files=files,
        tooling=dict(raw.get("tooling") or {}),
    )


class OnnxEmbedder:
    """CPU uzerinde ONNX INT8 gomme. `threads` ONNX Runtime ic parcacik sayisini sinirlar."""

    def __init__(
        self,
        model_dir: str | Path,
        *,
        threads: int = 2,
        batch_size: int = 64,
        prefix: str = "",
        verify: bool = True,
    ) -> None:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self._np = np
        root = Path(model_dir)
        manifest = verify_model_dir(root) if verify else None
        self.model_version = manifest.model_version if manifest else "unverified"
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, threads)
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self._session = ort.InferenceSession(
            str(root / MODEL_FILE), options, providers=["CPUExecutionProvider"]
        )
        self._input_names = {i.name for i in self._session.get_inputs()}
        tokenizer = Tokenizer.from_file(str(root / TOKENIZER_FILE))
        tokenizer.enable_truncation(max_length=MAX_LENGTH)
        tokenizer.enable_padding(pad_id=tokenizer.token_to_id("<pad>") or 1, pad_token="<pad>")
        self._tokenizer = tokenizer
        self.batch_size = max(1, batch_size)
        self.prefix = prefix

    def with_prefix(self, prefix: str) -> OnnxEmbedder:
        """Ayni oturumu paylasan, farkli onekli gorunum (`query: ` / `passage: `)."""
        clone = object.__new__(OnnxEmbedder)
        clone.__dict__.update(self.__dict__)
        clone.prefix = prefix
        return clone

    def encode(self, texts: Sequence[str]):  # noqa: ANN201 - numpy dizisi
        np = self._np
        out = np.zeros((len(texts), DIM), dtype=np.float32)
        # Uzunluga gore sirala: dolgu (padding) israfini azaltir; sonra eski sirayi geri koy.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        for start in range(0, len(order), self.batch_size):
            idx = order[start : start + self.batch_size]
            encodings = self._tokenizer.encode_batch([self.prefix + texts[i] for i in idx])
            ids = np.array([e.ids for e in encodings], dtype=np.int64)
            mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self._input_names:
                feed["token_type_ids"] = np.zeros_like(ids)
            hidden = self._session.run(None, feed)[0]
            weights = mask[:, :, None].astype(np.float32)
            pooled = (hidden * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1e-9)
            pooled /= np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
            out[idx] = pooled
        return out


def build_model(out_dir: str | Path) -> Manifest:
    """GELISTIRICI ARACI: kaynak modeli sabit surumden indirir, ONNX'e cevirir, dinamik INT8
    nicemler ve `manifest.json` yazar. Ag ve agir bagimliliklar ister; uretim imajinda kosmaz."""
    import importlib.metadata as md
    import shutil

    from huggingface_hub import snapshot_download
    from sentence_transformers import SentenceTransformer
    from sentence_transformers.backend import export_dynamic_quantized_onnx_model

    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    # Yalniz gereken dosyalar (degerlendirme/onnx klasorleri hic indirilmez).
    wanted = [
        "config.json",
        "model.safetensors",
        "modules.json",
        "sentence_bert_config.json",
        "config_sentence_transformers.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "sentencepiece.bpe.model",
        "1_Pooling/*",
    ]
    snap = Path(snapshot_download(SOURCE_REPO, revision=SOURCE_REVISION, allow_patterns=wanted))
    model = SentenceTransformer(str(snap), backend="onnx", device="cpu")
    work = root / "_work"
    model.save(str(work))
    export_dynamic_quantized_onnx_model(model, "avx512_vnni", str(work), push_to_hub=False)
    shutil.copyfile(work / "onnx" / MODEL_FILE, root / MODEL_FILE)
    shutil.copyfile(snap / TOKENIZER_FILE, root / TOKENIZER_FILE)
    shutil.rmtree(work, ignore_errors=True)
    files = {}
    for name in (MODEL_FILE, TOKENIZER_FILE):
        path = root / name
        files[name] = {"sha256": sha256_file(path), "size": path.stat().st_size}
    version = f"e5-small-int8-{files[MODEL_FILE]['sha256'][:12]}"
    tooling = {
        pkg: md.version(pkg)
        for pkg in ("onnxruntime", "sentence-transformers", "optimum", "torch", "tokenizers")
        if _installed(pkg)
    }
    manifest = {
        "format": MANIFEST_FORMAT,
        "model_version": version,
        "source_repo": SOURCE_REPO,
        "source_revision": SOURCE_REVISION,
        "quantization": "dynamic-int8-avx512_vnni",
        "pooling": "mean",
        "normalize": True,
        "max_length": MAX_LENGTH,
        "dim": DIM,
        "query_prefix": QUERY_PREFIX,
        "passage_prefix": PASSAGE_PREFIX,
        "files": files,
        "tooling": tooling,
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return verify_model_dir(root)


def _installed(pkg: str) -> bool:
    import importlib.metadata as md

    try:
        md.version(pkg)
    except md.PackageNotFoundError:
        return False
    return True
