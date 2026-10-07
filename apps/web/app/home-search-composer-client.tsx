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
import { browserStorage } from "./sohbet/chat-bootstrap.ts";
import { openChatInNewTab } from "./sohbet/open-chat-tab.ts";

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
  chatInNewTab = false,
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
   * true ise metin gönderimi (Enter, buton) yeni sekmede sohbet kabuğunu açar;
   * sohbeti o sekme oluşturur. Ana sayfa sekmesi yerinde kalır.
   */
  chatInNewTab?: boolean;
}) {
  const { pending, error, handleFile, loginOpen, closeLogin } = usePhotoSearchUpload();
  const [chatError, setChatError] = useState<string | null>(null);

  /**
   * Yeni sekme: mesaj tek kullanimlik kayda yazilir, sekme gercek sohbet kabugu olan
   * `/sohbet/yeni`yi acar (about:blank yok). Hepsi senkron (popup engelleyici).
   * Depolama kapaliysa sekme acilmaz, hata mesaji gorunur.
   */
  function startInNewTab(text: string): boolean {
    setChatError(null);
    const ok = openChatInNewTab(text, {
      open: (href) => window.open(href, "_blank"),
      navigate: (href) => window.location.assign(href),
      storage: browserStorage(),
    });
    if (!ok) setChatError("Sohbet başlatılamadı. Tekrar dener misin?");
    return ok;
  }

  return (
    <>
      <LoginGateModal open={loginOpen} onClose={closeLogin} />
      <SearchComposer
        action={startChat}
        onSubmitText={chatInNewTab ? startInNewTab : undefined}
        placeholder={HOME_COPY.searchPlaceholder}
        inputLabel={HOME_COPY.searchInputLabel}
        submitLabel={HOME_COPY.searchSubmitLabel}
        routeProductLinks
        recentProducts={recentProducts}
        offerCountLabel={(count) => `${count} mağaza`}
        chipsTitle={HOME_COPY.searchIdeasTitle}
        statusMessage={error ?? chatError}
        busyMessage={pending ? PHOTO_SEARCH_LOADING_LABEL : null}
        photo={{
          label: pending ? PHOTO_SEARCH_LOADING_LABEL : PHOTO_SEARCH_UPLOAD_LABEL,
          onFileSelected: handleFile,
          disabled: pending,
        }}
      />
    </>
  );
}
