import { type LexiconKind, listLexicon, recentTier3Queries } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import { requireRole } from "../../lib/dal.ts";
import { LexiconTableClient } from "./lexicon-table-client.tsx";

const KINDS: LexiconKind[] = ["color", "category", "brand", "size", "material", "style"];

function isLexiconKind(value: string | undefined): value is LexiconKind {
  return KINDS.includes(value as LexiconKind);
}

interface SozlukSearchParams {
  tur?: string;
  q?: string;
}

/**
 * docs/pages.md "/yonetim/sozluk": tablo görünümü, satır içi düzenleme, tür
 * filtresi, arama; üstte son 7 günde kademe 3'e düşen sorgular. Kademe 3
 * henüz yazılmadı (C1 yalnızca kademe 2) — o liste şimdilik her zaman boş.
 */
export default async function LexiconPage({
  searchParams,
}: {
  searchParams: Promise<SozlukSearchParams>;
}) {
  await requireRole(["moderator", "admin"]);

  const { tur, q } = await searchParams;
  const kind = isLexiconKind(tur) ? tur : undefined;
  const search = q?.trim() || undefined;

  const db = getDatabase();
  const [rows, tier3] = await Promise.all([
    listLexicon(db, { kind, search }),
    recentTier3Queries(db),
  ]);

  function filterHref(nextKind?: string): string {
    const params = new URLSearchParams();
    if (nextKind) params.set("tur", nextKind);
    if (search) params.set("q", search);
    const qs = params.toString();
    return qs ? `/yonetim/sozluk?${qs}` : "/yonetim/sozluk";
  }

  return (
    <main style={{ padding: 24, display: "grid", gap: 24, maxWidth: 960 }}>
      <div>
        <h1 style={{ margin: 0 }}>Sözlük</h1>
      </div>

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Son 7 günde kademe 3'e düşen sorgular</h2>
        {tier3.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ink-muted)" }}>Şu an aday yok.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {tier3.map((row) => (
              <li key={row.queryNorm}>
                {row.queryNorm} — {row.hitCount} kez
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        action="/yonetim/sozluk"
        method="get"
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <select name="tur" defaultValue={kind ?? ""}>
          <option value="">Tümü</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input type="text" name="q" defaultValue={search ?? ""} placeholder="Ara" />
        <button type="submit">Filtrele</button>
        {kind || search ? <a href={filterHref()}>Temizle</a> : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="Sözlükte satır yok." description="Yeni bir satır ekleyerek başla." />
      ) : null}
      <LexiconTableClient rows={rows} />
    </main>
  );
}
