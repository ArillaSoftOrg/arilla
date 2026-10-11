"use client";

import {
  SearchComposer,
  type SearchComposerAttachment,
  type SearchComposerRecentProduct,
} from "@arilla/ui";
import { useId, useRef } from "react";
import { FloatingHomeComposer } from "./floating-composer-client.tsx";
import { useHomeComposerSubmission } from "./home-composer-submission.ts";
import { HOME_COPY } from "./home-copy.ts";
import { IMAGE_CHAT_COPY } from "./home-image-chat.ts";
import { LoginGateModal } from "./login-gate-modal-client.tsx";

/**
 * Ince istemci (CLAUDE.md kural 6): @arilla/ui'nin generic SearchComposer'ini
 * apps/web'e ozgu sohbet baslatma akisina ve ornek sorgu verisine baglar. Is mantigi tasimaz.
 *
 * Karar 0091: gorsel ayri bir akis DEGIL, normal mesajin ekidir. Metin, gorsel ve metin+gorsel
 * AYNI hattan gecer: `sendMessage` -> yeni sekmede `/sohbet/yeni` kabugu -> ayni sunucu eylemi.
 * Gorsel secmek hicbir sey gondermez; kutuda onizleme olur. Eski gorsel arama sayfasina hicbir
 * kosulda dusulmez: gorsel ekleme dugmesi yalnizca `imageChat` aciksa vardir.
 *
 * Karar 0093: gonderim durumu ve akislari `useHomeComposerSubmission`da TEK
 * ornektir; ana kutu ve yuzen hizli arama ayni ornegi kullanir (ortak kilit,
 * giris modali, hazirlanan gorsel, hata).
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
   * Karar 0078/0091: true ise "+" ile fotoğraf eklenebilir. Fotoğraf seçmek hemen
   * göndermez; kutuda önizleme olarak bekler ve Enter/Gönder ile metinle birlikte TEK
   * mesaj olarak, metinle aynı geçişle sohbete gider. false/verilmezse "+" hiç görünmez.
   */
  imageChat?: boolean;
}) {
  const submission = useHomeComposerSubmission({ chatInNewTab, imageChat });
  const { chatError, staged, sending, stageFile, removeStaged, startInNewTab, startImageMessage } =
    submission;
  const mainRef = useRef<HTMLDivElement>(null);
  const photoButtonId = useId();

  const attachment: SearchComposerAttachment | null =
    imageChat && staged
      ? {
          previewUrl: staged.url,
          alt: IMAGE_CHAT_COPY.previewAlt,
          removeLabel: IMAGE_CHAT_COPY.removeLabel,
          onRemove: removeStaged,
          onSubmit: (text) => startImageMessage(text, staged),
          pending: sending,
        }
      : null;
  const onSubmitText = chatInNewTab ? startInNewTab : undefined;

  return (
    <>
      <LoginGateModal open={submission.loginOpen} onClose={submission.closeLogin} />
      <div ref={mainRef}>
        <SearchComposer
          action={startChat}
          onSubmitText={onSubmitText}
          placeholder={HOME_COPY.searchPlaceholder}
          inputLabel={HOME_COPY.searchInputLabel}
          submitLabel={HOME_COPY.searchSubmitLabel}
          routeProductLinks
          recentProducts={recentProducts}
          offerCountLabel={(count) => `${count} mağaza`}
          chipsTitle={HOME_COPY.searchIdeasTitle}
          statusMessage={chatError}
          busyMessage={sending ? IMAGE_CHAT_COPY.sending : null}
          photoButtonId={photoButtonId}
          photo={
            imageChat
              ? {
                  label: staged ? IMAGE_CHAT_COPY.replaceLabel : IMAGE_CHAT_COPY.uploadLabel,
                  onFileSelected: stageFile,
                  disabled: sending,
                }
              : undefined
          }
          attachment={attachment}
        />
      </div>
      <FloatingHomeComposer
        mainRef={mainRef}
        mainPhotoButtonId={photoButtonId}
        action={startChat}
        onSubmitText={onSubmitText}
        attachment={attachment}
        statusMessage={chatError}
        showAttach={imageChat}
      />
    </>
  );
}
