import { listAlerts } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import { requireUser } from "../lib/dal.ts";
import { AlertsListClient } from "./alerts-list-client.tsx";

/** docs/pages.md: "/alarmlar üç alarm türünü tek listede gösterir; tür rozetle ayrılır." */
export default async function AlarmlarPage() {
  const user = await requireUser();
  const items = await listAlerts(getDatabase(), user.id);

  return (
    <main style={{ padding: 24, display: "grid", gap: 16, maxWidth: 720 }}>
      <h1 style={{ margin: 0 }}>Alarmlarım</h1>
      {items.length === 0 ? (
        <EmptyState
          title="Alarmın yok."
          description="Bir ürünün fiyatı düşünce ya da bedenin gelince haber verelim."
        />
      ) : (
        <AlertsListClient items={items} />
      )}
    </main>
  );
}
