#!/usr/bin/env python3
"""pg_hba.conf, verilen Docker alt aglarini / adreslerini KAPSIYOR mu? (karar 0109)

Docker `data` agi alt agi sabitlenmez; bu arac gercek alt agin pg_hba.conf'taki
scram-sha-256 `host` kurallarindan biriyle kapsandigini dogrular. Kapsanmiyorsa
(or. daemon `default-address-pools` ozel blok disina ayarlanmis) baglantilar
reddedilir ve web/migrate "no pg_hba.conf entry" hatasi verir; bu arac bunu
dagitimdan ONCE ve net bir mesajla yakalar.

    check-pg-hba.py <pg_hba.conf> <alt-ag-veya-adres> [...] [--database arilla] [--users arilla,arilla_app]

Cikis kodu 0: hepsi kapsanir. 1: kapsanmayan var. 2: kullanim/dosya hatasi.
Yalnizca `host` + `scram-sha-256` kurallari sayilir (trust/reject/md5 sayilmaz).
"""

from __future__ import annotations

import argparse
import ipaddress
import sys
from pathlib import Path


def parse_rules(text: str) -> list[tuple[set[str], set[str], ipaddress._BaseNetwork]]:
    """[(veritabanlari, kullanicilar, ag)] - yalnizca host + scram-sha-256."""
    rules = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.split()
        if len(fields) < 5 or fields[0] != "host" or fields[4] != "scram-sha-256":
            continue
        try:
            network = ipaddress.ip_network(fields[3], strict=False)
        except ValueError:
            continue
        rules.append((set(fields[1].split(",")), set(fields[2].split(",")), network))
    return rules


def covered(target: str, rules, database: str, users: list[str]) -> bool:
    """`target` (alt ag ya da adres) bir kuralin aginin icinde mi ve DB/kullanicilari kapsiyor mu."""
    net = ipaddress.ip_network(target, strict=False)
    for dbs, rule_users, rule_net in rules:
        if net.version != rule_net.version or not net.subnet_of(rule_net):
            continue
        if ("all" in dbs or database in dbs) and all("all" in rule_users or u in rule_users for u in users):
            return True
    return False


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("hba")
    parser.add_argument("targets", nargs="+")
    parser.add_argument("--database", default="arilla")
    parser.add_argument("--users", default="arilla,arilla_app")
    args = parser.parse_args(argv)
    try:
        rules = parse_rules(Path(args.hba).read_text(encoding="utf-8"))
    except OSError as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 2
    users = [u for u in args.users.split(",") if u]
    missing = []
    for target in args.targets:
        try:
            if not covered(target, rules, args.database, users):
                missing.append(target)
        except ValueError:
            print(f"HATA: gecersiz alt ag/adres: {target}", file=sys.stderr)
            return 2
    if missing:
        print(
            "HATA: pg_hba.conf bu aglari kapsamiyor (scram-sha-256 host kurali yok): "
            + ", ".join(missing)
            + "\n  -> infra/vps/postgres/pg_hba.conf'a ilgili blogu ekleyin ve postgres'i yeniden baslatin.",
            file=sys.stderr,
        )
        return 1
    print("pg_hba.conf kapsiyor: " + ", ".join(args.targets))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
