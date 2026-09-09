"""Gelistirme icin sahte gorsel sunucusu.

Tohum verisinin gorsel URL'leri `.example` alan adlarina isaret ediyor ve
cozulmuyor. Bu sunucu HERHANGI bir yolu, sabit sayida gercek PNG'den birine
esler (yolun hash'ine gore).

Boylece 400 offer -> az sayida FARKLI gorsel olur ve B3'un yineleme onleme
yolu gercekten sinanir: cok satir, az API cagrisi.

    python scripts/fixture_image_server.py --port 8099

Yalnizca gelistirme icindir; uretimde yeri yoktur.
"""

from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "images"


def load_images() -> list[bytes]:
    images = sorted(FIXTURES.glob("*.png"))
    if not images:
        raise SystemExit(f"fixture gorsel bulunamadi: {FIXTURES}")
    return [path.read_bytes() for path in images]


class Handler(BaseHTTPRequestHandler):
    images: list[bytes] = []

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler arayuzu
        # Yol -> sabit bir gorsel. Ayni yol her zaman ayni gorseli verir,
        # farkli yollar gorselleri paylasir; yineleme yolu boyle sinanir.
        digest = hashlib.sha256(self.path.encode("utf-8")).digest()
        payload = self.images[digest[0] % len(self.images)]

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args: object) -> None:
        """Sessiz: 400 istek gurultusu terminali doldurmasin."""


def main() -> None:
    parser = argparse.ArgumentParser(description="Fixture gorsel sunucusu")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    Handler.images = load_images()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"{len(Handler.images)} fixture gorsel, http://{args.host}:{args.port}/ "
        "(her yol birine eslenir)"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
