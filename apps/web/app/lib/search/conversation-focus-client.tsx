"use client";

import { useEffect } from "react";

/**
 * Konusma adimindan sonra odagi anlamli bir yere tasir. Yalnizca URL
 * `#konusma` ile geldiyse calisir: bu parca yalnizca netlestirme secenekleri,
 * cip kaldirma ve serbest yanit baglantilarinda bulunur. Siradan sayfa
 * acilisinda (arama kutusu, paylasilan link) odak calinmaz.
 *
 * Sira: bildirim ("anlayamadım") > yeni soru > aramada kullanilanlar >
 * sonuc sayisi > sayfa basligi. Hedef odaklanamiyorsa `tabindex=-1` alir.
 * Parca islendikten sonra adresten silinir; yenileme odagi tekrar tasimaz.
 */
export function ConversationFocusClient({ targets }: { targets: readonly string[] }) {
  useEffect(() => {
    if (window.location.hash !== "#konusma") return;
    for (const id of targets) {
      const element = document.getElementById(id);
      if (!element) continue;
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
      element.focus();
      break;
    }
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }, [targets]);

  return null;
}
