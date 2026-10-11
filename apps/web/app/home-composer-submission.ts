"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  IMAGE_CHAT_ERROR_COPY,
  outcomeForNewChat,
  validateAttachmentFile,
} from "./home-image-chat.ts";
import { startChatBootstrapAction } from "./sohbet/actions.ts";
import { browserStorage } from "./sohbet/chat-bootstrap.ts";
import { type BootstrapImageStore, browserImageStore } from "./sohbet/chat-bootstrap-image.ts";
import { openChatInNewTab, openChatInNewTabWithImage } from "./sohbet/open-chat-tab.ts";

export interface StagedImage {
  file: File;
  url: string;
  /** Her yeni secim yeni anahtar: ayni secimin yeniden gonderimi sunucuda tekillesir. */
  key: string;
}

export interface HomeComposerSubmissionOptions {
  chatInNewTab: boolean;
  imageChat: boolean;
}

export interface HomeComposerSubmission {
  chatError: string | null;
  staged: StagedImage | null;
  /** Ortak gonderim kilidi: ana kutu ve hizli arama ayni anda gonderemez. */
  sending: boolean;
  loginOpen: boolean;
  closeLogin: () => void;
  stageFile: (file: File) => void;
  removeStaged: () => void;
  startInNewTab: (text: string) => boolean;
  startImageMessage: (text: string, image: StagedImage) => Promise<boolean>;
}

/**
 * Ana sayfa gonderim durumu ve akislari - TEK kaynak (karar 0093). Ana kutu ve
 * yuzen hizli arama ayni ornegi paylasir: gonderim kilidi, giris modali,
 * hazirlanan gorsel ve hata mesaji ikisinde de aynidir. Is mantigi tasimaz;
 * sohbet/gorsel akislari karar 0091'deki mevcut yardimcilardir.
 *
 * Karar 0091: gorsel ayri bir akis DEGIL, normal mesajin ekidir. Metin, gorsel ve
 * metin+gorsel AYNI hattan gecer: yeni sekmede `/sohbet/yeni` kabugu -> ayni sunucu
 * eylemi. Gorsel secmek hicbir sey gondermez; kutuda onizleme olur.
 */
export function useHomeComposerSubmission({
  chatInNewTab,
  imageChat,
}: HomeComposerSubmissionOptions): HomeComposerSubmission {
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

  return {
    chatError,
    staged,
    sending,
    loginOpen,
    closeLogin: () => setLoginOpen(false),
    stageFile,
    removeStaged,
    startInNewTab,
    startImageMessage,
  };
}
