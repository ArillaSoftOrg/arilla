"""50 trendin profilleri migration tohumuyla ve arayuz kurallariyla tutarli mi."""

from __future__ import annotations

import re
from pathlib import Path

from curate.profiles import BY_SLUG, PROFILES
from curate.selection import MIN_PUBLIC_PRODUCTS
from curate.text import fold

ACRONYMS = frozenset({"KYK"})
ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "packages/db/migrations/0056_trend_collections.sql"
CORE_TYPES = ROOT / "packages/core/src/trends/types.ts"

#: ('slug', 'Baslik', 'Aciklama', 'kategori', 'tur', ...)
SEED_ROW = re.compile(
    r"^\s+\('([^']+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '([a-z-]+)', '([a-z]+)'", re.M
)


def seed() -> list[tuple[str, str, str, str, str]]:
    return [
        (m[1], m[2].replace("''", "'"), m[3].replace("''", "'"), m[4], m[5])
        for m in SEED_ROW.finditer(MIGRATION.read_text(encoding="utf-8"))
    ]


def test_fifty_seed_trends_with_unique_slugs():
    rows = seed()
    assert len(rows) == 50
    assert len({r[0] for r in rows}) == 50


def test_every_seed_trend_has_exactly_one_profile():
    assert {r[0] for r in seed()} == set(BY_SLUG)
    assert len(PROFILES) == len(BY_SLUG) == 50


def test_profiles_without_core_explain_themselves():
    for profile in PROFILES:
        if not profile.core:
            assert profile.note, f"{profile.slug}: bos profilin gerekcesi yok"


def test_terms_are_folded_ascii_lowercase():
    for profile in PROFILES:
        for term in (*profile.core, *profile.boost, *profile.exclude):
            plain = term.rstrip("$")
            assert plain == fold(plain), f"{profile.slug}: {term!r} katlanmamis"
            assert plain.isascii(), f"{profile.slug}: {term!r} ASCII degil"


def test_every_profile_excludes_preorders():
    for profile in PROFILES:
        if profile.core:
            assert "on siparis" in profile.exclude


def test_fashion_profiles_are_adult_focused_except_school_items():
    kids_ok = {"okula-donus-listesi", "universiteye-baslayanlar-icin"}
    for profile in PROFILES:
        if "moda" in profile.categories and profile.slug not in kids_ok:
            assert "cocuk" in profile.exclude, profile.slug


def test_seed_copy_follows_ui_rules():
    banned = re.compile(r"satın al|dupe|ucuz|\bedit\b|reset|layering", re.IGNORECASE)
    for slug, title, description, _category, _type in seed():
        for text in (title, description):
            assert not banned.search(text), f"{slug}: yasakli ifade: {text}"
            for word in re.findall(r"[A-ZÇĞİÖŞÜ]{3,}", text):
                # Kisaltma (KYK) buyuk harf yazilir; duz metin ALL CAPS olamaz.
                assert word in ACRONYMS, f"{slug}: ALL CAPS: {word}"
        assert len(description) <= 280
        assert description.endswith("."), f"{slug}: tek cumle degil"
        assert description.count(".") == 1 or slug.startswith("11-11"), f"{slug}: tek cumle degil"


def test_min_public_products_matches_core_constant():
    match = re.search(r"MIN_PUBLIC_TREND_PRODUCTS = (\d+)", CORE_TYPES.read_text(encoding="utf-8"))
    assert match and int(match.group(1)) == MIN_PUBLIC_PRODUCTS
