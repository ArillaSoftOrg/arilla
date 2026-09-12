import { listSavedItems } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import { requireUser } from "../lib/dal.ts";
import { SavedItemsListClient } from "./saved-items-list-client.tsx";

/** docs/pages.md: "Üçü de aynı kalıp: başlık, liste, boş durum." */
export default async function KaydettiklerimPage() {
  const user = await requireUser();
  const items = await listSavedItems(getDatabase(), user.id);

  return (
    <main style={{ padding: 24, display: "grid", gap: 16, maxWidth: 960 }}>
      <h1 style={{ margin: 0 }}>Kaydettiklerim</h1>
      {items.length === 0 ? (
        <EmptyState
          title="Henüz kaydettiğin ürün yok."
          description="Beğendiğin bir ürünü kaydet, ucuzlayınca haber verelim."
        />
      ) : (
        <SavedItemsListClient items={items} />
      )}
    </main>
  );
}
