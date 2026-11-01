"use client";

import { LoginModal } from "@arilla/ui";
import { type RefObject, useEffect, useState } from "react";
import { LoginFormClient } from "./giris/login-form-client.tsx";

export interface LoginGateModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  compact?: boolean;
  next?: string;
  /** Kapaninca odagin donecegi oge (bkz. `LoginModal.returnFocusRef`). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * docs/copy.md `auth.modal_title` / `auth.modal_body`, docs/design.md
 * "Giriş modali". `/ara` (search_limit) ve ürün sayfasındaki Kaydet/Alarm
 * eylemleri (save/alert) aynı modalı paylaşır - decision 0002 ve
 * docs/events.md `login_modal_shown.trigger` üçü için de aynı akışı
 * tanımlıyor.
 */
export function LoginGateModal({
  open,
  onClose,
  title = "Sonuçlarını kaydedelim mi?",
  description = "Hesabın yok mu? Ücretsiz kaydol, bu sonuçları senin için saklayalım.",
  compact = false,
  next,
  returnFocusRef,
}: LoginGateModalProps) {
  const [browserNext, setBrowserNext] = useState<string | undefined>(undefined);
  // Arama limiti modali sunucuda da acik gelebilir. Ilk istemci render'i
  // sunucuyla ayni kalir; sorgulu donus yolu hydration'dan sonra okunur.
  useEffect(() => {
    if (open && next === undefined) {
      setBrowserNext(`${window.location.pathname}${window.location.search}`);
    }
  }, [open, next]);
  const resolvedNext = next ?? (open ? browserNext : undefined);
  return (
    <LoginModal
      open={open}
      onClose={onClose}
      compact={compact}
      returnFocusRef={returnFocusRef}
      title={title}
      description={description}
      closeLabel="Kapat"
    >
      <LoginFormClient next={resolvedNext} compact={compact} />
    </LoginModal>
  );
}
