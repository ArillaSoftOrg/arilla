"use client";

import { LoginModal } from "@arilla/ui";
import type { RefObject } from "react";
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
  // Girişten sonra kullanıcı modalın açıldığı sayfaya (sorgusuyla) döner.
  // Modal yalnızca etkileşimle açılır; yol yalnızca açıkken istemcide okunur.
  const resolvedNext =
    next ??
    (open && typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}`
      : undefined);
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
