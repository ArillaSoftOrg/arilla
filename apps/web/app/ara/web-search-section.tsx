import {
  attachCatalogImages,
  attachStoreImages,
  type CatalogImageCandidate,
  dropCatalogDuplicates,
  type WebProductGroup,
} from "@arilla/core";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { ErrorView } from "../error-view.tsx";
import chatStyles from "../sohbet/sohbet.module.css";
import styles from "./ara.module.css";
import type { WebSearchBundle } from "./web-search-start.ts";
import { WebPendingItems, WebResultItems, type WebViewVariant } from "./web-search-view.tsx";

type WebGroupsResult =
  | { kind: "groups"; groups: WebProductGroup[] }
  | { kind: "error" }
  | { kind: "none" };

/**
 * Internet sonuclari (karar 0102, 0106), sunucu tarafi. Katalog sonuclari bu
 * adimdan BAGIMSIZ ve once gorunur; internet aramasi bittiginde ayni izgaranin
 * sonuna eklenir. Sonuclar saklanmaz. Google Search Suggestions parcasi
 * cizilmez (karar 0106).
 */
async function loadWebGroups(
  promise: Promise<WebSearchBundle>,
  catalog: readonly CatalogImageCandidate[],
): Promise<WebGroupsResult> {
  const { outcome, catalogHosts } = await promise;
  if (outcome.status === "error" || outcome.status === "unavailable") return { kind: "error" };
  if (outcome.status !== "ok") return { kind: "none" };
  // Once katalog gorseli (kendi feed'imiz), kalanlar icin magaza sayfasindan dogrulanmis gorsel.
  const groups = await attachStoreImages(
    attachCatalogImages(
      dropCatalogDuplicates(outcome.groups, {
        hosts: catalogHosts,
        titles: catalog.map((item) => item.title),
      }),
      catalog,
    ),
  );
  return groups.length > 0 ? { kind: "groups", groups } : { kind: "none" };
}

interface WebItemsProps {
  promise: Promise<WebSearchBundle>;
  /** Veritabani sonuclari: yinelenen teklifi atmak ve ayni urunun katalog gorselini bulmak icin. */
  catalog: readonly CatalogImageCandidate[];
  variant?: WebViewVariant;
}

async function WebItems({ promise, catalog, variant = "ara" }: WebItemsProps) {
  const result = await loadWebGroups(promise, catalog);
  // Katalog sonuclari yerinde kalir; hata izgaranin sonunda tek satir olarak gorunur.
  if (result.kind === "error") {
    return (
      <li className={styles.gridNote}>
        <ErrorView error={{ code: "web_search_unavailable" }} />
      </li>
    );
  }
  if (result.kind === "none") return null;
  return <WebResultItems groups={result.groups} variant={variant} />;
}

/**
 * Katalog izgarasinin icine (`ResultGrid`/`ChatResultGrid` `extra`) girer:
 * internet kartlari geldikce ayni izgaranin sonuna eklenir; mevcut kartlar
 * yer degistirmez, siralama sonradan bozulmaz.
 */
export function WebGridItems({ promise, catalog, variant = "ara" }: WebItemsProps) {
  return (
    <Suspense fallback={<WebPendingItems variant={variant} />}>
      <WebItems promise={promise} catalog={catalog} variant={variant} />
    </Suspense>
  );
}

function WebOnlyGrid({
  variant = "ara",
  labelledBy,
  children,
}: {
  variant?: WebViewVariant;
  labelledBy?: string;
  children: ReactNode;
}) {
  const grid = variant === "chat" ? chatStyles.resultGrid : styles.grid;
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit/VoiceOver'da liste rolünü düşürür.
    <ul className={grid} role="list" aria-labelledby={labelledBy}>
      {children}
    </ul>
  );
}

async function WebOnlyOrEmpty({
  promise,
  catalog,
  variant,
  empty,
  labelledBy,
}: WebItemsProps & { empty: ReactNode; labelledBy?: string }) {
  const result = await loadWebGroups(promise, catalog);
  if (result.kind !== "groups") return <>{empty}</>;
  return (
    <WebOnlyGrid variant={variant} labelledBy={labelledBy}>
      <WebResultItems groups={result.groups} variant={variant} />
    </WebOnlyGrid>
  );
}

/**
 * Katalogda hic sonuc yoksa: internet kartlari gelene kadar iskelet, hic
 * kart gelmezse (ya da hata olursa) bos durum (`empty`) gosterilir.
 */
export function WebOnlyResults(props: WebItemsProps & { empty: ReactNode; labelledBy?: string }) {
  return (
    <Suspense
      fallback={
        <WebOnlyGrid variant={props.variant} labelledBy={props.labelledBy}>
          <WebPendingItems variant={props.variant} />
        </WebOnlyGrid>
      }
    >
      <WebOnlyOrEmpty {...props} />
    </Suspense>
  );
}
