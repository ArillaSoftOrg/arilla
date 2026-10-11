import { listSavedItems } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import type { Metadata } from "next";
import { requireProductUser } from "../lib/dal.ts";
import styles from "./page.module.css";
import { SAVED_COPY } from "./saved-copy.ts";
import { SavedItemsListClient } from "./saved-items-list-client.tsx";

export const metadata: Metadata = {
  title: "Kaydettiklerim",
  robots: { index: false, follow: false },
};

/**
 * docs/pages.md: "Üçü de aynı kalıp: başlık, liste, boş durum." Public site
 * kabugunun icinde (layout.tsx); `<main>` ve yatay kenar boslugu kabuktan.
 */
export default async function KaydettiklerimPage() {
  const user = await requireProductUser();
  const items = await listSavedItems(getDatabase(), user.id);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{SAVED_COPY.title}</h1>
        {items.length > 0 ? <p className={styles.count}>{SAVED_COPY.count(items.length)}</p> : null}
      </header>
      {items.length === 0 ? (
        <EmptyState
          title={SAVED_COPY.emptyTitle}
          description={SAVED_COPY.emptyDescription}
          action={
            <a href="/kesfet" className={styles.emptyAction}>
              {SAVED_COPY.emptyAction}
            </a>
          }
        />
      ) : (
        <SavedItemsListClient items={items} />
      )}
    </div>
  );
}
