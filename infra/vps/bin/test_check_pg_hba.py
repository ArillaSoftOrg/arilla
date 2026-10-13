"""check-pg-hba.py testleri (ag ve docker yok): python3 infra/vps/bin/test_check_pg_hba.py"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_pg_hba", HERE / "check-pg-hba.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

REAL = (HERE.parent / "postgres" / "pg_hba.conf").read_text(encoding="utf-8")


class CheckPgHbaTest(unittest.TestCase):
    def rules(self, text: str = REAL):
        return mod.parse_rules(text)

    def test_repo_rules_cover_typical_docker_subnets(self) -> None:
        rules = self.rules()
        for subnet in ("172.16.1.0/24", "172.17.0.0/16", "172.18.0.0/16", "172.31.255.0/24", "192.168.48.0/20", "10.5.0.0/16"):
            self.assertTrue(mod.covered(subnet, rules, "arilla", ["arilla", "arilla_app"]), subnet)
        self.assertTrue(mod.covered("172.16.1.7", rules, "arilla", ["arilla"]))

    def test_repo_rules_do_not_cover_public_or_other_blocks(self) -> None:
        rules = self.rules()
        for target in ("8.8.8.0/24", "100.64.0.0/10", "172.32.0.0/16", "11.0.0.0/8", "169.254.0.0/16"):
            self.assertFalse(mod.covered(target, rules, "arilla", ["arilla"]), target)

    def test_other_database_or_role_is_not_covered(self) -> None:
        rules = self.rules()
        self.assertFalse(mod.covered("172.16.1.0/24", rules, "postgres", ["arilla"]))
        self.assertFalse(mod.covered("172.16.1.0/24", rules, "arilla", ["superuser_baska"]))

    def test_only_scram_host_rules_count(self) -> None:
        text = "host all all 0.0.0.0/0 trust\nhost all all 0.0.0.0/0 md5\nhostssl all all 0.0.0.0/0 scram-sha-256\nlocal all all trust\n"
        self.assertEqual(self.rules(text), [])

    def test_comments_and_blank_lines_are_ignored(self) -> None:
        text = "# host all all 0.0.0.0/0 scram-sha-256\n\nhost arilla arilla 10.0.0.0/8 scram-sha-256  # yorum\n"
        self.assertEqual(len(self.rules(text)), 1)

    def test_cli_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hba = Path(tmp) / "pg_hba.conf"
            hba.write_text(REAL, encoding="utf-8")
            self.assertEqual(mod.main([str(hba), "172.16.1.0/24"]), 0)
            self.assertEqual(mod.main([str(hba), "172.16.1.0/24", "100.64.0.0/10"]), 1)
            self.assertEqual(mod.main([str(hba), "bozuk"]), 2)
            self.assertEqual(mod.main([str(Path(tmp) / "yok.conf"), "10.0.0.0/8"]), 2)

    def test_ipv6_target_not_matched_by_ipv4_rules(self) -> None:
        self.assertFalse(mod.covered("fd00::/64", self.rules(), "arilla", ["arilla"]))


if __name__ == "__main__":
    unittest.main()
