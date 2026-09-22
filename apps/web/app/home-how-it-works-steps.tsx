import type { HowItWorksStep } from "@arilla/ui";
import { ImageIcon, LinkIcon, SearchIcon } from "@arilla/ui";
import { HOME_COPY } from "./home-copy.ts";

/**
 * docs/pages.md "/" Faz 4: "Nasıl Çalışır" adimlarinin verisi - UI'dan
 * (`HowItWorksCard`) ayri, page.tsx icinde uc kere elle JSX yazilmiyor.
 * Baglanti/URL aramasi backend'de var (kok catch-all `/[...link]`) ama
 * arama kutusuna henuz baglanmadigi icin `statusLabel` ile acikca "Yakinda"
 * olarak isaretlenir - sahte CTA yok.
 */
export const HOME_HOW_IT_WORKS_STEPS: readonly HowItWorksStep[] = [
  {
    id: "text-search",
    number: "01",
    title: HOME_COPY.howItWorksTextSearchTitle,
    description: HOME_COPY.howItWorksTextSearchDescription,
    icon: <SearchIcon />,
  },
  {
    id: "photo-search",
    number: "02",
    title: HOME_COPY.howItWorksPhotoSearchTitle,
    description: HOME_COPY.howItWorksPhotoSearchDescription,
    icon: <ImageIcon />,
  },
  {
    id: "link-search",
    number: "03",
    title: HOME_COPY.howItWorksLinkSearchTitle,
    description: HOME_COPY.howItWorksLinkSearchDescription,
    icon: <LinkIcon />,
    statusLabel: HOME_COPY.howItWorksLinkSearchStatus,
  },
];
