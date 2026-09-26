"use client";

import { SearchComposer } from "@arilla/ui";
import { HOME_COPY } from "./home-copy.ts";
import { HOME_SEARCH_CHIPS } from "./home-search-chips.ts";
import {
  PHOTO_SEARCH_LOADING_LABEL,
  PHOTO_SEARCH_UPLOAD_LABEL,
  usePhotoSearchUpload,
} from "./photo-search-client.tsx";

/**
 * Ince istemci (CLAUDE.md kural 6): @arilla/ui'nin generic SearchComposer'ini
 * apps/web'e ozgu fotograf yukleme akisina (server action, degismez) ve
 * ornek sorgu verisine baglar. Is mantigi tasimaz.
 *
 * autoFocus YOK: ilk odak SkipLink'te kalir ve mobilde klavye kendiliginden
 * acilmaz (docs/pages.md "Otomatik odaklanır" maddesi erisilebilirlik
 * lehine birakildi).
 */
export function HomeSearchComposer() {
  const { pending, error, handleFile } = usePhotoSearchUpload();

  return (
    <SearchComposer
      placeholder={HOME_COPY.searchPlaceholder}
      inputLabel={HOME_COPY.searchInputLabel}
      submitLabel={HOME_COPY.searchSubmitLabel}
      routeProductLinks
      chips={HOME_SEARCH_CHIPS}
      chipsTitle={HOME_COPY.searchIdeasTitle}
      statusMessage={error}
      busyMessage={pending ? PHOTO_SEARCH_LOADING_LABEL : null}
      photo={{
        label: pending ? PHOTO_SEARCH_LOADING_LABEL : PHOTO_SEARCH_UPLOAD_LABEL,
        onFileSelected: handleFile,
        disabled: pending,
      }}
    />
  );
}
