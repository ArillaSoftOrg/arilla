"use client";

import {
  PlusIcon,
  SearchComposer,
  type SearchComposerAttachment,
  type SearchComposerRecentProduct,
} from "@arilla/ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { FloatingHomeComposer } from "./floating-composer-client.tsx";
import { selectHomeCategoryImages } from "./home-category-config.ts";
import {
  DEFAULT_HOME_CATEGORY,
  HOME_CATEGORY_OPTIONS,
  type HomeCategoryId,
  HomeCategoryPicker,
} from "./home-category-picker-client.tsx";
import { useHomeComposerSubmission } from "./home-composer-submission.ts";
import { HOME_COPY } from "./home-copy.ts";
import { IMAGE_CHAT_COPY } from "./home-image-chat.ts";
import styles from "./home-search-composer.module.css";
import { LoginGateModal } from "./login-gate-modal-client.tsx";

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

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
  imageEntryAvailable = false,
  imageConsent = false,
  recentProducts,
  beforeSearch,
  searchClassName,
  afterSearch,
  imageVariantSeed = 0,
}: {
  /** Ilk ekrandaki baslik; arama davranisindan bagimsiz sunum. */
  beforeSearch?: ReactNode;
  searchClassName?: string;
  /** Ana kutunun altinda, gecmis urunlerinden once gosterilen yardim baglantisi. */
  afterSearch?: ReactNode;
  /**
   * Kullanıcının gerçekten görüntülediği son ürünler (`product_view`, sunucuda
   * yüklenir). Boşsa "Alışverişe devam et" bölümü ve başlığı hiç çizilmez.
   */
  recentProducts?: readonly SearchComposerRecentProduct[];
  /**
   * Konuşmalı keşif açıkken (karar 0074) ve kullanıcı girişliyken: kutu arama turu
   * yerine bu sunucu eylemini çalıştırır (sohbet oluşturur, `/sohbet/[id]`ye
   * yönlendirir). Verilmezse: native GET `/sohbet?q=` (arama turu, karar 0176).
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
  /** Fotoğraf özelliği açık ama anonim kullanıcıysa giriş kapısını gösterir. */
  imageEntryAvailable?: boolean;
  /** Karar 0101: gecerli acik riza var mi (yoksa dosya secilince bilgilendirme sorulur). */
  imageConsent?: boolean;
  /** Sunucuda ziyaret başına üretilir; kategori görselleri ziyaret boyunca sabit kalır. */
  imageVariantSeed?: number;
}) {
  const submission = useHomeComposerSubmission({ chatInNewTab, imageChat, imageConsent });
  const { chatError, staged, sending, stageFile, removeStaged, startInNewTab, startImageMessage } =
    submission;
  const mainRef = useRef<HTMLDivElement>(null);
  const photoButtonId = useId();
  const [categoryId, setCategoryId] = useState<HomeCategoryId>(DEFAULT_HOME_CATEGORY);
  const [imageFailed, setImageFailed] = useState(false);
  const category =
    HOME_CATEGORY_OPTIONS.find((option) => option.id === categoryId) ?? HOME_CATEGORY_OPTIONS[0];
  const categoryImages = selectHomeCategoryImages(category, imageVariantSeed);

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
  function fillSuggestion(query: string) {
    const input = mainRef.current?.querySelector("textarea");
    if (!input) return;
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  const categorySuggestions = (
    <fieldset className={styles.suggestions} aria-label={`${category.label} için örnek aramalar`}>
      <legend className={styles.suggestionsLabel}>{category.label} için örnek aramalar</legend>
      <div className={styles.suggestionsRow}>
        {category.suggestions.map(({ label, query }) => (
          <button
            className={styles.suggestion}
            type="button"
            key={query}
            disabled={sending}
            onClick={() => fillSuggestion(query)}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
  const photoIcon = <PlusIcon />;

  return (
    <>
      <LoginGateModal
        open={submission.loginOpen}
        onClose={submission.closeLogin}
        title="Fotoğrafla aramaya devam et"
        description="Aynı ve benzer ürünleri bulup seçenekleri karşılaştırmak için giriş yap."
        compact
      />
      {submission.consentDialog}
      <div
        ref={mainRef}
        className={styles.categoryScene}
        data-home-category={category.id}
        data-image-failed={imageFailed ? "true" : undefined}
      >
        <SearchComposer
          action={startChat}
          onSubmitText={onSubmitText}
          placeholder={HOME_COPY.searchPlaceholder}
          inputLabel={HOME_COPY.searchInputLabel}
          submitLabel={HOME_COPY.searchSubmitLabel}
          routeProductLinks
          recentProducts={recentProducts}
          offerCountLabel={(count) => `${count} mağaza`}
          recentPriceLabel={HOME_COPY.recentPriceLabel}
          chipsTitle={HOME_COPY.searchIdeasTitle}
          beforeSearch={
            <div className={styles.mobileIntro}>
              <picture className={styles.heroPicture}>
                <source
                  media="(max-width: 639.98px)"
                  srcSet={imageFailed ? undefined : categoryImages.mobile}
                />
                <source
                  media="(min-width: 640px)"
                  srcSet={imageFailed ? undefined : categoryImages.desktop}
                />
                <img
                  className={styles.heroImage}
                  src={imageFailed ? TRANSPARENT_PIXEL : categoryImages.desktop}
                  alt=""
                  width="1600"
                  height="900"
                  loading="eager"
                  fetchPriority="high"
                  onError={() => setImageFailed(true)}
                />
              </picture>
              <span className={styles.heroOverlay} aria-hidden="true" />
              <div className={styles.heroHeading}>
                {beforeSearch}
                <HomeCategoryPicker
                  value={categoryId}
                  onChange={(nextCategory) => {
                    setImageFailed(false);
                    setCategoryId(nextCategory);
                  }}
                />
              </div>
            </div>
          }
          composerFooter={categorySuggestions}
          searchClassName={[searchClassName, styles.categorySearch].filter(Boolean).join(" ")}
          afterSearch={afterSearch}
          statusMessage={chatError}
          busyMessage={sending ? IMAGE_CHAT_COPY.sending : null}
          photoButtonId={photoButtonId}
          showPhotoLabel
          photo={
            imageChat
              ? {
                  label: staged ? IMAGE_CHAT_COPY.replaceLabel : IMAGE_CHAT_COPY.uploadLabel,
                  onFileSelected: stageFile,
                  disabled: sending,
                  icon: photoIcon,
                }
              : undefined
          }
          leadingAction={
            imageEntryAvailable && !imageChat
              ? {
                  label: IMAGE_CHAT_COPY.uploadLabel,
                  onClick: submission.openLogin,
                  icon: photoIcon,
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
        showAttach={imageChat || imageEntryAvailable}
      />
    </>
  );
}
