"use client";

import { Button, Input } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveLexiconEntryAction } from "./actions.ts";

export interface LexiconRow {
  id: number;
  kind: "color" | "category" | "brand" | "size" | "material" | "style";
  surface: string;
  normalized: string;
  weight: number;
}

const KINDS: LexiconRow["kind"][] = ["color", "category", "brand", "size", "material", "style"];

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
              {kind}
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
  const [draft, setDraft] = useState<DraftFields>({
    kind: row.kind,
    surface: row.surface,
    normalized: row.normalized,
    weight: String(row.weight),
  });

  async function handleSave() {
    setPending(true);
    try {
      await saveLexiconEntryAction({
        id: row.id,
        kind: draft.kind,
        surface: draft.surface,
        normalized: draft.normalized,
        weight: Number.parseFloat(draft.weight) || 0,
      });
      setEditing(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={5} style={{ padding: "8px 0" }}>
          <div style={{ display: "grid", gap: 8 }}>
            <EditableFields draft={draft} onChange={setDraft} />
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="button" variant="primary" disabled={pending} onClick={handleSave}>
                Kaydet
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setEditing(false)}
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
      <td>{row.kind}</td>
      <td>{row.surface}</td>
      <td>{row.normalized}</td>
      <td>{row.weight}</td>
      <td>
        <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
          Düzenle
        </Button>
      </td>
    </tr>
  );
}

function NewLexiconRow() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<DraftFields>({
    kind: "category",
    surface: "",
    normalized: "",
    weight: "1.0",
  });

  async function handleSave() {
    if (!draft.surface.trim() || !draft.normalized.trim()) return;
    setPending(true);
    try {
      await saveLexiconEntryAction({
        kind: draft.kind,
        surface: draft.surface.trim(),
        normalized: draft.normalized.trim(),
        weight: Number.parseFloat(draft.weight) || 0,
      });
      setDraft({ kind: draft.kind, surface: "", normalized: "", weight: "1.0" });
      setOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)}>
        Yeni satır ekle
      </Button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
      <EditableFields draft={draft} onChange={setDraft} />
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

export function LexiconTableClient({ rows }: { rows: LexiconRow[] }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <NewLexiconRow />
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
  );
}
