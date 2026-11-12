"""Gelistirme/test icin sahte OpenAI uyumlu /v1/embeddings sunucusu (karar 0186).

Uretim imajina girmez (`tests/` .dockerignore'da). YALNIZ 127.0.0.1'e baglanir; baska adres
reddedilir (CLAUDE.md: Python herkese acik HTTP sunmaz). Gercek model yoktur:

- `deterministic` (varsayilan): metnin SHA-256'sindan turetilen birim vektor. Anlamsal DEGIL;
  yalniz sozlesme/ag/hata yolu icin.
- `golden`: verilen altin dosyadaki metinler icin altin vektoru aynen dondurur (kanaryanin
  gecmesi gereken durum); diger metinler deterministic.
- `wrong_pooling`: altin vektoru bozar (yanlis havuzlamayi taklit eder); kanarya REDDETMELI.

Elle kullanim (TEI olmadan gelistirme):

    python -m tests.fake_embed_server --model Qwen/Qwen3-Embedding-0.6B --dimensions 1024
    EMBED_QWEN3_06B_URL=http://127.0.0.1:<port>  # cikti satirindaki port
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOOPBACK = "127.0.0.1"


def deterministic_vector(text: str, dimensions: int) -> list[float]:
    raw: list[float] = []
    counter = 0
    while len(raw) < dimensions:
        digest = hashlib.sha256(f"{counter}:{text}".encode()).digest()
        raw += [(b - 127.5) / 127.5 for b in digest]
        counter += 1
    raw = raw[:dimensions]
    norm = math.sqrt(sum(v * v for v in raw)) or 1.0
    return [v / norm for v in raw]


def _corrupt(vector: list[float]) -> list[float]:
    """Yanlis havuzlamanin etkisini taklit eder: ayni norm, farkli yon (kosinus ~0.5)."""
    rotated = vector[1:] + vector[:1]
    mixed = [0.5 * a + 0.5 * b for a, b in zip(vector, rotated, strict=True)]
    norm = math.sqrt(sum(v * v for v in mixed)) or 1.0
    return [v / norm for v in mixed]


class FakeEmbedServer:
    def __init__(
        self,
        *,
        model: str,
        dimensions: int,
        mode: str = "deterministic",
        golden: dict[str, Any] | None = None,
        host: str = LOOPBACK,
        port: int = 0,
    ) -> None:
        if host != LOOPBACK:
            raise ValueError("sahte sunucu yalniz 127.0.0.1'e baglanir")
        if mode not in {"deterministic", "golden", "wrong_pooling"}:
            raise ValueError(f"bilinmeyen kip {mode!r}")
        self.model, self.dimensions, self.mode = model, dimensions, mode
        self.by_text: dict[str, list[float]] = {}
        # Gercek sunucu, istemcinin onek ekledigi metni alir (`Instruct: ...Query:` + metin).
        prefixes = (golden or {}).get("prefixes", {})
        for case in (golden or {}).get("cases", []):
            self.by_text[prefixes.get(case["purpose"], "") + case["text"]] = list(case["vector"])
        self.requests: list[dict[str, Any]] = []
        #: Testler hata yolunu denemek icin sirayla dondurulecek durum kodlarini koyabilir.
        self.fail_statuses: list[int] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # sessiz
                return

            def _send(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/health":
                    self._send(200, {"status": "ok"})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                if self.path != "/v1/embeddings":
                    self._send(404, {"error": "not found"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                server.requests.append(body)
                if server.fail_statuses:
                    self._send(server.fail_statuses.pop(0), {"error": "sahte hata"})
                    return
                texts = body.get("input") or []
                data = [
                    {"object": "embedding", "index": i, "embedding": server.vector_for(text)}
                    for i, text in enumerate(texts)
                ]
                tokens = sum(max(1, len(t) // 3) for t in texts)
                self._send(
                    200,
                    {
                        "object": "list",
                        "model": server.model,
                        "data": data,
                        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
                    },
                )

        self._httpd = ThreadingHTTPServer((host, port), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def vector_for(self, text: str) -> list[float]:
        if self.mode != "deterministic" and text in self.by_text:
            vector = self.by_text[text]
            return _corrupt(vector) if self.mode == "wrong_pooling" else vector
        return deterministic_vector(text, self.dimensions)

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> FakeEmbedServer:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m tests.fake_embed_server")
    parser.add_argument("--model", required=True, help="registry endpoint.served_model")
    parser.add_argument("--dimensions", type=int, required=True)
    parser.add_argument("--mode", default="deterministic")
    parser.add_argument("--golden", type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    golden = json.loads(args.golden.read_text(encoding="utf-8")) if args.golden else None
    with FakeEmbedServer(
        model=args.model, dimensions=args.dimensions, mode=args.mode, golden=golden, port=args.port
    ) as server:
        print(f"sahte cikarim sunucusu: {server.url} (Ctrl+C ile durur)", flush=True)
        with contextlib.suppress(KeyboardInterrupt):
            threading.Event().wait()


if __name__ == "__main__":
    main()
