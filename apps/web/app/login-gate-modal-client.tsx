"use client";

import { LoginModal } from "@arilla/ui";
import type { RefObject } from "react";
import { LoginFormClient } from "./giris/login-form-client.tsx";

export interface LoginGateModalProps {
  open: boolean;
  onClose: () => void;
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
export function LoginGateModal({ open, onClose, returnFocusRef }: LoginGateModalProps) {
  return (
    <LoginModal
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Sonuçlarını kaydedelim mi?"
      description="Hesabın yok mu? Ücretsiz kaydol, bu sonuçları senin için saklayalım."
      closeLabel="Kapat"
    >
      <LoginFormClient />
    </LoginModal>
  );
}
