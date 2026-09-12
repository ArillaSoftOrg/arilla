import { exportUserData } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireUser } from "../../lib/dal.ts";

/** KVKK m.11 "Görüntüleme" hakkı (docs/kvkk.md, docs/pages.md `action.` "İndir (JSON)"). */
export async function GET(): Promise<Response> {
  const user = await requireUser();
  const data = await exportUserData(getDatabase(), user.id);

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": "attachment; filename=verilerim.json",
    },
  });
}
