import { listAlerts } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import type { Metadata } from "next";
import styles from "../account-list-page.module.css";
import { requireProductUser } from "../lib/dal.ts";
import { AlertsListClient } from "./alerts-list-client.tsx";

export const metadata: Metadata = {
  title: "Alarmlarım",
  robots: { index: false, follow: false },
};

/** docs/pages.md: "/alarmlar üç alarm türünü tek listede gösterir; tür rozetle ayrılır." */
export default async function AlarmlarPage() {
  const user = await requireProductUser();
  const items = await listAlerts(getDatabase(), user.id);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Alarmlarım</h1>
      {items.length === 0 ? (
        <EmptyState
          title="Alarmın yok."
          description="Bir ürünün fiyatı düşünce ya da bedenin gelince haber verelim."
        />
      ) : (
        <AlertsListClient items={items} />
      )}
    </div>
  );
}
