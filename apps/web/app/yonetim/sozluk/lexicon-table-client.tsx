"use client";

import { Button, Input } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmButton } from "../confirm-button-client.tsx";
import { lexiconKindLabel } from "../format.ts";
import {
  deleteLexiconEntryAction,
  type LexiconActionResult,
  saveLexiconEntryAction,
} from "./actions.ts";

export interface LexiconRow {
  id: number;
  kind: "color" | "category" | "brand" | "size" | "material" | "style" | "synonym";
  surface: string;
  normalized: string;
  weight: number;
}

const KINDS: LexiconRow["kind"][] = [
  "color",
  "category",
  "brand",
  "size",
  "material",
  "style",
  "synonym",
];

/** Boş ya da sayı olmayan ağırlık sunucuya NaN gider ve orada reddedilir; sessizce 0 olmaz. */
function parseWeight(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Number(raw.replace(",", "."));
}

function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" style={{ margin: 0, color: "var(--alert)", fontSize: 13 }}>
      {message}
    </p>
  ) : null;
}

async function run(
  action: () => Promise<LexiconActionResult>,
  setError: (message: string | null) => void,
): Promise<boolean> {
  setError(null);
  try {
    const result = await action();
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    return true;
  } catch {
    setError("Kaydedilemedi. Tekrar dene.");
    return false;
  }
}

interface DraftFields {
  kind: LexiconRow["kind"];
  surface: string;
  normalized: string;
  weight: string;
}

function EditableFields({
  draft,
  onChange,
}: {
  draft: DraftFields;
  onChange: (next: DraftFields) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
        Tür
        <select
          value={draft.kind}
          onChange={(event) =>
            onChange({ ...draft, kind: event.target.value as LexiconRow["kind"] })
          }
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {lexiconKindLabel(kind)}
            </option>
          ))}
        </select>
      </label>
      <Input
        label="Yüzey"
        value={draft.surface}
        onChange={(event) => onChange({ ...draft, surface: event.target.value })}
      />
      <Input
        label="Normalize"
        value={draft.normalized}
        onChange={(event) => onChange({ ...draft, normalized: event.target.value })}
      />
      <Input
        label="Ağırlık"
        type="number"
        step="0.1"
        value={draft.weight}
        onChange={(event) => onChange({ ...draft, weight: event.target.value })}
      />
    </div>
  );
}

function LexiconRowView({ row }: { row: LexiconRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromRow = (): DraftFields => ({
    kind: row.kind,
    surface: row.surface,
    normalized: row.normalized,
    weight: String(row.weight),
  });
  const [draft, setDraft] = useState<DraftFields>(fromRow);

  async function handleSave() {
    setPending(true);
    const saved = await run(
      () =>
        saveLexiconEntryAction({
          id: row.id,
          kind: draft.kind,
          surface: draft.surface,
          normalized: draft.normalized,
          weight: parseWeight(draft.weight),
        }),
      setError,
    );
    setPending(false);
    if (saved) {
      setEditing(false);
      router.refresh();
    }
  }

  async function handleDelete() {
    setPending(true);
    const deleted = await run(() => deleteLexiconEntryAction(row.id), setError);
    setPending(false);
    if (deleted) router.refresh();
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={5} style={{ padding: "8px 0" }}>
          <div style={{ display: "grid", gap: 8 }}>
            <EditableFields draft={draft} onChange={setDraft} />
            <ErrorText message={error} />
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="button" variant="primary" disabled={pending} onClick={handleSave}>
                Kaydet
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  // Kaydedilmemiş taslak atılır; tekrar düzenlemede satırın
                  // kayıtlı değerleri gelir.
                  setError(null);
                  setDraft(fromRow());
                  setEditing(false);
                }}
              >
                Vazgeç
              </Button>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{lexiconKindLabel(row.kind)}</td>
      <td>{row.surface}</td>
      <td>{row.normalized}</td>
      <td>{row.weight}</td>
      <td>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setDraft(fromRow());
              setEditing(true);
            }}
          >
            Düzenle
          </Button>
          <ConfirmButton
            label="Sil"
            title="Satırı sil"
            description={`"${row.surface}" (${lexiconKindLabel(row.kind)}) sözlükten silinecek. Arama hemen etkilenir; silinen değer denetim kaydında kalır.`}
            confirmLabel="Sil"
            disabled={pending}
            onConfirm={() => void handleDelete()}
          />
        </div>
        <ErrorText message={error} />
      </td>
    </tr>
  );
}

/**
 * Sorunlu sorgulardan gelindiyse (`?ekle=kelime`) form açık ve yüzey dolu
 * gelir; kaydetmeden hiçbir şey yazılmaz. Kayıttan sonra sorguyu tanıda
 * doğrulama bağlantısı gösterilir.
 */
function NewLexiconRow({
  prefillSurface,
  verifyHref,
}: {
  prefillSurface: string | null;
  verifyHref: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(prefillSurface !== null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [draft, setDraft] = useState<DraftFields>({
    kind: prefillSurface !== null ? "synonym" : "category",
    surface: prefillSurface ?? "",
    normalized: "",
    weight: "1.0",
  });

  async function handleSave() {
    setPending(true);
    const saved = await run(
      () =>
        saveLexiconEntryAction({
          kind: draft.kind,
          surface: draft.surface,
          normalized: draft.normalized,
          weight: parseWeight(draft.weight),
        }),
      setError,
    );
    setPending(false);
    if (saved) {
      setDraft({ kind: draft.kind, surface: "", normalized: "", weight: "1.0" });
      setOpen(false);
      setSavedOnce(true);
      router.refresh();
    }
  }

  if (!open) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          Yeni satır ekle
        </Button>
        {savedOnce && verifyHref ? (
          <p role="status" style={{ margin: 0 }}>
            Kaydedildi. <a href={verifyHref}>Sorguyu tanıda doğrula</a>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
      <EditableFields draft={draft} onChange={setDraft} />
      <ErrorText message={error} />
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="button" variant="primary" disabled={pending} onClick={handleSave}>
          Kaydet
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Vazgeç
        </Button>
      </div>
    </div>
  );
}

export function LexiconTableClient({
  rows,
  prefillSurface = null,
  verifyHref = null,
}: {
  rows: LexiconRow[];
  prefillSurface?: string | null;
  verifyHref?: string | null;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <NewLexiconRow prefillSurface={prefillSurface} verifyHref={verifyHref} />
      {/* Dar ekranda tablo sayfayı taşırmasın: kendi içinde yatay kayar. */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Tür</th>
              <th>Yüzey</th>
              <th>Normalize</th>
              <th>Ağırlık</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <LexiconRowView key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
