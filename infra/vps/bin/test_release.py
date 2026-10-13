"""release.py testleri (ağ yok, docker yok): python3 infra/vps/bin/test_release.py"""

import json
import tempfile
import unittest
from pathlib import Path

import release

SHA_A = "a" * 40
SHA_B = "b" * 40


def manifest(sha: str, digest_char: str = "1", complete: bool = True) -> dict:
    return {
        "sha": sha,
        "tag": f"sha-{sha}",
        "complete": complete,
        "images": {
            name: {
                "image": f"ghcr.io/arillasoftorg/arilla-{name}",
                "tag": f"sha-{sha}",
                "digest": "sha256:" + digest_char * 64,
            }
            for name in release.NAMES
        },
    }


class ReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "compose.env").write_text(
            "ARILLA_SITE_ADDRESS=alan.example\n# yorum\nARILLA_TAG=eski\nBASKA=1\n", encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, m: dict) -> Path:
        path = self.root / f"in-{m['sha'][:4]}.json"
        path.write_text(json.dumps(m), encoding="utf-8")
        return path

    def env(self) -> dict[str, str]:
        out = {}
        for line in (self.root / "compose.env").read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                out[key] = value
        return out

    def run_cli(self, *args: str) -> int:
        return release.main([*args, "--dir", str(self.root)])

    def test_apply_pins_tag_and_digests_and_keeps_other_lines(self) -> None:
        self.assertEqual(self.run_cli("apply", str(self.write(manifest(SHA_A)))), 0)
        env = self.env()
        self.assertEqual(env["ARILLA_TAG"], f"sha-{SHA_A}")
        self.assertEqual(env["ARILLA_WEB_DIGEST"], "sha256:" + "1" * 64)
        self.assertEqual(env["ARILLA_CRON_IMAGE"], "ghcr.io/arillasoftorg/arilla-cron")
        self.assertEqual(env["ARILLA_SITE_ADDRESS"], "alan.example")
        self.assertEqual(env["BASKA"], "1")
        self.assertIn("# yorum", (self.root / "compose.env").read_text(encoding="utf-8"))
        self.assertEqual(sum(1 for line in (self.root / "compose.env").read_text().splitlines() if line.startswith("ARILLA_TAG=")), 1)

    def test_rollback_restores_previous_and_can_roll_forward(self) -> None:
        self.run_cli("apply", str(self.write(manifest(SHA_A, "1"))))
        self.run_cli("apply", str(self.write(manifest(SHA_B, "2"))))
        self.assertEqual(self.env()["ARILLA_WEB_DIGEST"], "sha256:" + "2" * 64)
        self.assertEqual(self.run_cli("rollback"), 0)
        self.assertEqual(self.env()["ARILLA_TAG"], f"sha-{SHA_A}")
        self.assertEqual(self.env()["ARILLA_WEB_DIGEST"], "sha256:" + "1" * 64)
        self.assertEqual((self.root / "releases" / "current").read_text().strip(), SHA_A)
        self.assertEqual((self.root / "releases" / "previous").read_text().strip(), SHA_B)
        self.assertEqual(self.run_cli("rollback"), 0)  # ileri
        self.assertEqual(self.env()["ARILLA_TAG"], f"sha-{SHA_B}")

    def test_rollback_without_previous_fails_and_changes_nothing(self) -> None:
        before = (self.root / "compose.env").read_text()
        self.assertEqual(self.run_cli("rollback"), 1)
        self.assertEqual((self.root / "compose.env").read_text(), before)

    def test_invalid_manifests_are_rejected_without_touching_files(self) -> None:
        before = (self.root / "compose.env").read_text()
        bad = [
            manifest(SHA_A, complete=False),
            {**manifest(SHA_A), "tag": "latest"},
            {**manifest(SHA_A), "sha": "abc"},
        ]
        m = manifest(SHA_A)
        m["images"]["web"]["digest"] = "sha256:xyz"
        bad.append(m)
        m = manifest(SHA_A)
        del m["images"]["cron"]
        bad.append(m)
        m = manifest(SHA_A)
        m["images"]["web"]["image"] = "docker.io/evil/arilla-web"
        bad.append(m)
        m = manifest(SHA_A)
        m["images"]["web"]["tag"] = "sha-" + "c" * 40
        bad.append(m)
        for index, item in enumerate(bad):
            path = self.root / f"bad{index}.json"
            path.write_text(json.dumps(item), encoding="utf-8")
            self.assertEqual(self.run_cli("apply", str(path)), 1, f"case {index}")
        self.assertEqual((self.root / "compose.env").read_text(), before)
        self.assertFalse((self.root / "releases").exists())

    def test_stored_manifest_is_immutable(self) -> None:
        self.run_cli("apply", str(self.write(manifest(SHA_A, "1"))))
        self.assertEqual(self.run_cli("apply", str(self.write(manifest(SHA_A, "9")))), 1)
        self.assertEqual(self.env()["ARILLA_WEB_DIGEST"], "sha256:" + "1" * 64)

    def test_reapplying_same_release_is_idempotent(self) -> None:
        path = self.write(manifest(SHA_A))
        self.run_cli("apply", str(path))
        self.run_cli("apply", str(path))
        self.assertFalse((self.root / "releases" / "previous").exists())


if __name__ == "__main__":
    unittest.main()
