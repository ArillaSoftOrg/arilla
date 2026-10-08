"use client";

import { SearchComposer, type SearchComposerRecentProduct } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { HOME_COPY } from "./home-copy.ts";
import {
  IMAGE_CHAT_COPY,
  IMAGE_CHAT_ERROR_COPY,
  outcomeForResult,
  validateAttachmentFile,
} from "./home-image-chat.ts";
import { LoginGateModal } from "./login-gate-modal-client.tsx";
import {
  PHOTO_SEARCH_LOADING_LABEL,
  PHOTO_SEARCH_UPLOAD_LABEL,
  usePhotoSearchUpload,
} from "./photo-search-client.tsx";
import { startConversationWithImageAction } from "./sohbet/actions.ts";
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
  imageChat = false,
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
  /**
   * Karar 0078: true ise fotoğraf seçmek hemen göndermez; kutuda önizleme olarak
   * bekler ve Enter/Gönder ile metinle birlikte TEK mesaj olarak sohbete gider.
   * false/verilmezse eski davranış (`/ara/gorsel` anlık fotoğraf araması).
   */
  imageChat?: boolean;
}) {
  const { pending, error, handleFile, loginOpen, closeLogin } = usePhotoSearchUpload();
  const [chatError, setChatError] = useState<string | null>(null);
  const router = useRouter();
  const [staged, setStaged] = useState<{ file: File; url: string; key: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [stagedLoginOpen, setStagedLoginOpen] = useState(false);
  const sendingRef = useRef(false);
  const stagedUrlRef = useRef<string | null>(null);

  // Blob onizlemesi: degisince/kalkinca/unmount'ta serbest birakilir.
  useEffect(() => {
    stagedUrlRef.current = staged?.url ?? null;
  }, [staged]);
  useEffect(
    () => () => {
      if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    },
    [],
  );

  function stageFile(file: File) {
    setChatError(null);
    const invalid = validateAttachmentFile(file);
    if (invalid) {
      setChatError(IMAGE_CHAT_ERROR_COPY[invalid]);
      return;
    }
    if (sendingRef.current) return;
    if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    // Her yeni secim yeni anahtar: ayni secimin yeniden gonderimi sunucuda tekillesir.
    setStaged({ file, url: URL.createObjectURL(file), key: crypto.randomUUID() });
  }

  function removeStaged() {
    if (sendingRef.current) return;
    if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    setStaged(null);
    setChatError(null);
  }

  /** Fotograf + metin TEK sunucu eylemi; tek-ucus kilidi cift gonderimi engeller. */
  async function sendStaged(text: string): Promise<boolean> {
    if (!staged || sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setChatError(null);
    try {
      const formData = new FormData();
      formData.set("photo", staged.file);
      formData.set("q", text);
      formData.set("requestKey", staged.key);
      const outcome = outcomeForResult(await startConversationWithImageAction(formData));
      if (outcome.kind === "navigate") {
        // Gecis suresince kilit acilmaz: ikinci bir gonderim olmaz.
        router.push(outcome.href);
        return false;
      }
      if (outcome.kind === "login") setStagedLoginOpen(true);
      else setChatError(outcome.message);
    } catch {
      setChatError(IMAGE_CHAT_ERROR_COPY.error);
    }
    sendingRef.current = false;
    setSending(false);
    return false;
  }

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
      <LoginGateModal
        open={loginOpen || stagedLoginOpen}
        onClose={() => {
          closeLogin();
          setStagedLoginOpen(false);
        }}
      />
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
        busyMessage={
          sending ? IMAGE_CHAT_COPY.sending : pending ? PHOTO_SEARCH_LOADING_LABEL : null
        }
        photo={
          imageChat
            ? {
                label: staged ? IMAGE_CHAT_COPY.replaceLabel : PHOTO_SEARCH_UPLOAD_LABEL,
                onFileSelected: stageFile,
                disabled: sending,
              }
            : {
                label: pending ? PHOTO_SEARCH_LOADING_LABEL : PHOTO_SEARCH_UPLOAD_LABEL,
                onFileSelected: handleFile,
                disabled: pending,
              }
        }
        attachment={
          imageChat && staged
            ? {
                previewUrl: staged.url,
                alt: IMAGE_CHAT_COPY.previewAlt,
                removeLabel: IMAGE_CHAT_COPY.removeLabel,
                onRemove: removeStaged,
                onSubmit: sendStaged,
                pending: sending,
              }
            : null
        }
      />
    </>
  );
}
