"use client";

import { SearchComposer, type SearchComposerRecentProduct } from "@arilla/ui";
import { useState } from "react";
import { HOME_COPY } from "./home-copy.ts";
import { LoginGateModal } from "./login-gate-modal-client.tsx";
import {
  PHOTO_SEARCH_LOADING_LABEL,
  PHOTO_SEARCH_UPLOAD_LABEL,
  usePhotoSearchUpload,
} from "./photo-search-client.tsx";
import type { NewTabChatResult } from "./sohbet/actions.ts";
import { openChatInNewTab, type TabHandle } from "./sohbet/open-chat-tab.ts";

/**
 * Ince istemci (CLAUDE.md kural 6): @arilla/ui'nin generic SearchComposer'ini
 * apps/web'e ozgu fotograf yukleme akisina (server action, degismez) ve
 * ornek sorgu verisine baglar. Is mantigi tasimaz.
 *
 * autoFocus YOK: ilk odak SkipLink'te kalir ve mobilde klavye kendiliginden
 * acilmaz (docs/pages.md "Otomatik odaklanır" maddesi erisilebilirlik
 * lehine birakildi).
 */
export function HomeSearchComposer({
  startChat,
  startChatInNewTab,
  recentProducts,
}: {
  /**
   * Kullanıcının gerçekten görüntülediği son ürünler (`product_view`, sunucuda
   * yüklenir). Boşsa "Alışverişe devam et" bölümü ve başlığı hiç çizilmez.
   */
  recentProducts?: readonly SearchComposerRecentProduct[];
  /**
   * Konuşmalı keşif açıkken (karar 0074) ve kullanıcı girişliyken: kutu `/ara`
   * yerine bu sunucu eylemini çalıştırır (sohbet oluşturur, `/sohbet/[id]`ye
   * yönlendirir). Verilmezse eski davranış: native GET `/ara?q=`.
   */
  startChat?: (formData: FormData) => void | Promise<void>;
  /**
   * Sohbeti oluşturur ve hedefi döndürür (redirect yok). Verilirse metin gönderimi
   * (Enter, buton, örnek çip) yeni sekmede sohbeti açar; ana sayfa sekmesi yerinde kalır.
   */
  startChatInNewTab?: (text: string) => Promise<NewTabChatResult>;
}) {
  const { pending, error, handleFile, loginOpen, closeLogin } = usePhotoSearchUpload();
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  /** `openChatInNewTab`: `window.open` ilk senkron adım (popup engelleyici), hata -> sekme kapanır. */
  function startInNewTab(text: string): Promise<boolean> {
    if (!startChatInNewTab) return Promise.resolve(false);
    setChatBusy(true);
    setChatError(null);
    return openChatInNewTab(text, {
      open: () => window.open("", "_blank") as TabHandle | null,
      navigate: (href) => window.location.assign(href),
      start: startChatInNewTab,
    })
      .then((ok) => {
        if (!ok) setChatError("Sohbet başlatılamadı. Tekrar dener misin?");
        return ok;
      })
      .finally(() => setChatBusy(false));
  }

  return (
    <>
      <LoginGateModal open={loginOpen} onClose={closeLogin} />
      <SearchComposer
        action={startChat}
        onSubmitText={startChatInNewTab ? startInNewTab : undefined}
        placeholder={HOME_COPY.searchPlaceholder}
        inputLabel={HOME_COPY.searchInputLabel}
        submitLabel={HOME_COPY.searchSubmitLabel}
        routeProductLinks
        recentProducts={recentProducts}
        offerCountLabel={(count) => `${count} mağaza`}
        chipsTitle={HOME_COPY.searchIdeasTitle}
        statusMessage={error ?? chatError}
        busyMessage={pending ? PHOTO_SEARCH_LOADING_LABEL : chatBusy ? "Sohbet açılıyor" : null}
        photo={{
          label: pending ? PHOTO_SEARCH_LOADING_LABEL : PHOTO_SEARCH_UPLOAD_LABEL,
          onFileSelected: handleFile,
          disabled: pending,
        }}
      />
    </>
  );
}
