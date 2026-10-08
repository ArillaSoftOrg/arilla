"use client";

import { SearchComposer, type SearchComposerRecentProduct } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { HOME_COPY } from "./home-copy.ts";
import {
  IMAGE_CHAT_COPY,
  IMAGE_CHAT_ERROR_COPY,
  outcomeForNewChat,
  validateAttachmentFile,
} from "./home-image-chat.ts";
import { LoginGateModal } from "./login-gate-modal-client.tsx";
import { startChatBootstrapAction } from "./sohbet/actions.ts";
import { browserStorage } from "./sohbet/chat-bootstrap.ts";
import { type BootstrapImageStore, browserImageStore } from "./sohbet/chat-bootstrap-image.ts";
import { openChatInNewTab, openChatInNewTabWithImage } from "./sohbet/open-chat-tab.ts";

interface StagedImage {
  file: File;
  url: string;
  /** Her yeni secim yeni anahtar: ayni secimin yeniden gonderimi sunucuda tekillesir. */
  key: string;
}

/**
 * Ince istemci (CLAUDE.md kural 6): @arilla/ui'nin generic SearchComposer'ini
 * apps/web'e ozgu sohbet baslatma akisina ve ornek sorgu verisine baglar. Is mantigi tasimaz.
 *
 * Karar 0079: gorsel ayri bir akis DEGIL, normal mesajin ekidir. Metin, gorsel ve metin+gorsel
 * AYNI hattan gecer: `sendMessage` -> yeni sekmede `/sohbet/yeni` kabugu -> ayni sunucu eylemi.
 * Gorsel secmek hicbir sey gondermez; kutuda onizleme olur. Eski gorsel arama sayfasina hicbir
 * kosulda dusulmez: gorsel ekleme dugmesi yalnizca `imageChat` aciksa vardir.
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
   * true ise mesaj gönderimi (Enter, buton) yeni sekmede sohbet kabuğunu açar;
   * sohbeti o sekme oluşturur. Ana sayfa sekmesi yerinde kalır. Metin, görsel ve
   * metin+görsel için aynı.
   */
  chatInNewTab?: boolean;
  /**
   * Karar 0078/0079: true ise "+" ile fotoğraf eklenebilir. Fotoğraf seçmek hemen
   * göndermez; kutuda önizleme olarak bekler ve Enter/Gönder ile metinle birlikte TEK
   * mesaj olarak, metinle aynı geçişle sohbete gider. false/verilmezse "+" hiç görünmez.
   */
  imageChat?: boolean;
}) {
  const router = useRouter();
  const [chatError, setChatError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const [sending, setSending] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const sendingRef = useRef(false);
  const stagedUrlRef = useRef<string | null>(null);
  const imageStoreRef = useRef<BootstrapImageStore | null>(null);

  // Blob önizlemesi: değişince/kalkınca/unmount'ta serbest bırakılır.
  useEffect(() => {
    stagedUrlRef.current = staged?.url ?? null;
  }, [staged]);
  useEffect(
    () => () => {
      if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    },
    [],
  );

  // IndexedDB kullanılabilir mi? Süresi dolmuş geçici görsel kayıtları da burada süpürülür.
  useEffect(() => {
    if (!imageChat) return;
    const store = browserImageStore();
    imageStoreRef.current = store;
    if (!store) return;
    void store.sweep().then((usable) => {
      if (!usable) imageStoreRef.current = null;
    });
  }, [imageChat]);

  function stageFile(file: File) {
    setChatError(null);
    const invalid = validateAttachmentFile(file);
    if (invalid) {
      setChatError(IMAGE_CHAT_ERROR_COPY[invalid]);
      return;
    }
    if (sendingRef.current) return;
    if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    setStaged({ file, url: URL.createObjectURL(file), key: crypto.randomUUID() });
  }

  function clearStaged() {
    if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    stagedUrlRef.current = null;
    setStaged(null);
  }

  function removeStaged() {
    if (sendingRef.current) return;
    clearStaged();
    setChatError(null);
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

  /**
   * Gorselli mesaj, metinle AYNI hatta: sekme ayni sekilde (senkron) acilir, gorsel
   * IndexedDB'ye sonradan yazilir. Tasima yapilamazsa mesaj ayni sekmede ayni sunucu
   * eylemiyle gonderilir; her durumda mesaj ve gorsel kutuda korunur, sessizce kaybolmaz.
   */
  async function startImageMessage(text: string, image: StagedImage): Promise<boolean> {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setChatError(null);
    try {
      const via = chatInNewTab
        ? await openChatInNewTabWithImage(
            text,
            { blob: image.file, requestKey: image.key },
            {
              open: (href) => window.open(href, "_blank"),
              navigate: (href) => window.location.assign(href),
              storage: browserStorage(),
              images: imageStoreRef.current,
              closeTab: (tab) => {
                try {
                  (tab as Window).close();
                } catch {
                  // Kapatilamazsa sekme kendi zaman asimina dusup ana sayfaya doner.
                }
              },
            },
          )
        : "fallback";
      if (via === "opened") {
        clearStaged();
        return true; // ana sayfa sekmesi yerinde kalir, girdi temizlenir
      }
      if (via === "same_tab") return false; // sekme gezinti yapiyor: kilit acilmaz
      return await sendInThisTab(text, image);
    } catch {
      setChatError(IMAGE_CHAT_ERROR_COPY.error);
    }
    sendingRef.current = false;
    setSending(false);
    return false;
  }

  /** Ayni sunucu eylemi, ayni sekmede (IndexedDB/yeni sekme yok): `router.push` gecisi. */
  async function sendInThisTab(text: string, image: StagedImage): Promise<boolean> {
    const data = new FormData();
    data.set("q", text);
    data.set("photo", image.file);
    data.set("requestKey", image.key);
    const outcome = outcomeForNewChat(await startChatBootstrapAction(data));
    if (outcome.kind === "navigate") {
      // Gecis suresince kilit acilmaz: ikinci bir gonderim olmaz.
      router.push(outcome.href);
      return false;
    }
    if (outcome.kind === "login") setLoginOpen(true);
    else if (outcome.kind === "error") setChatError(outcome.message);
    else setChatError(IMAGE_CHAT_ERROR_COPY.error);
    sendingRef.current = false;
    setSending(false);
    return false;
  }

  return (
    <>
      <LoginGateModal open={loginOpen} onClose={() => setLoginOpen(false)} />
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
        statusMessage={chatError}
        busyMessage={sending ? IMAGE_CHAT_COPY.sending : null}
        photo={
          imageChat
            ? {
                label: staged ? IMAGE_CHAT_COPY.replaceLabel : IMAGE_CHAT_COPY.uploadLabel,
                onFileSelected: stageFile,
                disabled: sending,
              }
            : undefined
        }
        attachment={
          imageChat && staged
            ? {
                previewUrl: staged.url,
                alt: IMAGE_CHAT_COPY.previewAlt,
                removeLabel: IMAGE_CHAT_COPY.removeLabel,
                onRemove: removeStaged,
                onSubmit: (text) => startImageMessage(text, staged),
                pending: sending,
              }
            : null
        }
      />
    </>
  );
}
