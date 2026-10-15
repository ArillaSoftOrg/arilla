"""Besleme kesfi ve artimli senkronizasyon (karar 0111, 0112).

    python -m feeds discover            # yetkili aglarin beslemelerini kaydet
    python -m feeds bind --feed ID --merchant SLUG [--activate]
    python -m feeds sync --feed ID [--max-records N]
    python -m feeds sync-due            # etkin ve degismis beslemeler

Katmanlar: ag (kesif + indirme adresi) -> indirme (akis, disk tavani, sha256)
-> ayristirma (akis; YML/XML, CSV, JSON/NDJSON, gzip/ZIP) -> normalizasyon
-> parca parca birlestirme (COPY + kume tabanli upsert) -> tamlik kapisi ->
guvenli deaktivasyon. Ham besleme tamamen bellege alinmaz.
"""
