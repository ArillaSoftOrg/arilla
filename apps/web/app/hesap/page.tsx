import { getConsents } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { requireUser } from "../lib/dal.ts";
import { readThemeCookie } from "../lib/theme.ts";
import { ThemeToggleClient } from "../theme-toggle-client.tsx";
import { ClearHistoryButtonClient } from "./clear-history-button-client.tsx";
import { ConsentTogglesClient } from "./consent-toggles-client.tsx";
import { DeleteAccountButtonClient } from "./delete-account-button-client.tsx";

/**
 * docs/pages.md "/hesap": Profil, Beden profili, Tema, İzinler, Verilerim.
 * Beden profili bu görevde yok - genel bir kategori/beden seçici arayüzü
 * gerektirir ve backlog.md E3'ün "Yap" satırında geçmiyor (rıza tercihleri,
 * veri indirme, geçmiş silme, hesap silme).
 */
export default async function HesapPage() {
  const user = await requireUser();
  const db = getDatabase();
  const [consents, theme] = await Promise.all([
    getConsents(db, user.id),
    (async () => readThemeCookie((await cookies()).get("theme")?.value))(),
  ]);

  return (
    <main style={{ padding: 24, display: "grid", gap: 32, maxWidth: 640 }}>
      <h1 style={{ margin: 0 }}>Hesap</h1>

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Profil</h2>
        <p style={{ margin: 0 }}>{user.email}</p>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Tema</h2>
        <ThemeToggleClient current={theme} />
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>İzinler</h2>
        <ConsentTogglesClient
          historyAndPersonalization={consents.browsing_history || consents.personalization}
          marketingEmail={consents.marketing_email}
          publicDiscovery={consents.public_discovery}
        />
      </section>

      <section style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Verilerim</h2>
        <div>
          <a href="/hesap/veri-indir">İndir (JSON)</a>
        </div>
        <ClearHistoryButtonClient />
        <DeleteAccountButtonClient />
      </section>
    </main>
  );
}
