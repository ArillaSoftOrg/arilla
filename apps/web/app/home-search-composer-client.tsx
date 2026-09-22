"use client";

import { ImageIcon, PhotoUploadButton, SearchComposer } from "@arilla/ui";
import { HOME_COPY } from "./home-copy.ts";
import { HOME_SEARCH_CHIPS } from "./home-search-chips.ts";
import { usePhotoSearchUpload } from "./photo-search-client.tsx";

const UPLOAD_LABEL = "Fotoğraf yükle"; // docs/copy.md action.upload_photo
const LOADING_LABEL = "Benzerlerini arıyoruz"; // docs/copy.md search.loading

/**
 * Ince istemci (CLAUDE.md kural 6): @arilla/ui'nin generic SearchComposer'ini
 * apps/web'e ozgu fotograf yukleme akisina ve demo chip verisine baglar. Is
 * mantigi tasimaz.
 */
export function HomeSearchComposer() {
  const { pending, error, handleFile } = usePhotoSearchUpload();

  return (
    <SearchComposer
      placeholder={HOME_COPY.searchPlaceholder}
      submitLabel={HOME_COPY.searchSubmitLabel}
      autoFocus
      chips={HOME_SEARCH_CHIPS}
      chipsTitle={HOME_COPY.continueShoppingTitle}
      statusMessage={error}
      photoTrigger={
        <PhotoUploadButton
          iconOnly
          icon={<ImageIcon />}
          label={pending ? LOADING_LABEL : UPLOAD_LABEL}
          onFileSelected={handleFile}
          disabled={pending}
        />
      }
    />
  );
}
