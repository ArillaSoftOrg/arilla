"use client";

import { useEffect } from "react";
import { trackEvent } from "../lib/track-event.ts";

const SENT_KEY = "arilla.ea-signup-tracked";

/**
 * Karar 0219: `early_access_signup` — "az önce katıldı" durumunda oturum başına tek kez.
 * Yalnızca kayıt yöntemi (`web_form`) gider; e-posta, ad, hesap kimliği gitmez.
 */
export function EarlyAccessSignupTracker() {
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(SENT_KEY) === "1") return;
      window.sessionStorage.setItem(SENT_KEY, "1");
    } catch {
      // depolama yok: yine tek seferlik render
    }
    trackEvent("early_access_signup", { method: "web_form" });
  }, []);
  return null;
}
