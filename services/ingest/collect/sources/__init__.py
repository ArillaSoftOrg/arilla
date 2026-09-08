"""Tasima katmani: uc kaynak bicimi.

Her modul kendini `collect.connector` kaydina ekler. Bu paketi ice aktarmak
uc bicimi de kullanilabilir yapar.
"""

from collect.sources import network_dump, rest_api, xml_feed

__all__ = ["network_dump", "rest_api", "xml_feed"]
