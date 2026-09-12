"use client";

import { useState } from "react";
import { LoginGateModal } from "../login-gate-modal-client.tsx";

/**
 * decision 0002: modal kapatılabilir (sonuçlar zaten arkada okunur halde) -
 * kapatma yalnızca bu render için geçerli, bir sonraki `/ara` yüklemesinde
 * sunucu hâlâ limit aşıldığını görürse modal tekrar açılır. Bu kasıtlı:
 * "sürtünme, güvenlik değil".
 */
export function SearchWallGateClient({ show }: { show: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  return <LoginGateModal open={show && !dismissed} onClose={() => setDismissed(true)} />;
}
